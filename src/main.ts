import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exchange } from 'ccxt';
import { LiveBroker, PaperBroker } from './broker.ts';
import { assertSafeStartup, loadConfig, loadSecrets, resolveEnvironment } from './config.ts';
import type { Config } from './config.ts';
import { startDashboard } from './dashboard.ts';
import { Engine } from './engine.ts';
import { Intel } from './intel.ts';
import { log, setLogSink } from './log.ts';
import { CcxtMarket, createExchange } from './market.ts';
import { Portfolio } from './portfolio.ts';
import { Reporter } from './report.ts';
import { RiskManager } from './risk.ts';
import { Scout } from './scout.ts';
import { Store } from './store.ts';
import { ConsoleNotifier, TelegramNotifier } from './telegram.ts';
import type { Notifier } from './types.ts';
import { errMsg, sleep, utcDay } from './util.ts';

/** Cada modo tiene su propia base de datos: las operaciones simuladas nunca se mezclan con las reales. */
function profile(cfg: Config): string {
  if (cfg.mode === 'paper') return 'paper';
  return `${cfg.exchange.sandbox ? 'testnet' : 'live'}-${cfg.exchange.id}`;
}

/** Dos instancias a la vez duplicarían órdenes: un archivo de bloqueo lo impide. */
function acquireLock(path: string): void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // El proceso anterior ya no existe: el bloqueo es un resto de un cierre brusco.
    }
    if (alive && pid !== process.pid) throw new Error(`Ya hay un bot en marcha (PID ${pid}). Ciérralo antes de arrancar otro.`);
  }
  writeFileSync(path, String(process.pid));
}

/** En real o testnet, comprueba que la cuenta tiene lo que el libro interno cree tener. */
async function reconcile(ex: Exchange, store: Store, portfolio: Portfolio, quote: string): Promise<string[]> {
  const problems: string[] = [];
  const balance = await ex.fetchBalance();
  const free = (asset: string) => Number((balance.free as unknown as Record<string, number | undefined>)[asset] ?? 0);
  if (free(quote) < portfolio.cash() * 0.999) {
    problems.push(`Saldo libre de ${quote} (${free(quote).toFixed(2)}) menor que la caja asignada al bot (${portfolio.cash().toFixed(2)}).`);
  }
  const held = new Map<string, number>();
  for (const p of store.openPositions()) {
    const base = p.symbol.split('/')[0]!;
    held.set(base, (held.get(base) ?? 0) + p.amount);
  }
  for (const [base, amount] of held) {
    if (free(base) < amount * 0.999) problems.push(`Saldo de ${base} (${free(base)}) menor que la posición registrada (${amount}).`);
  }
  return problems;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const environment = resolveEnvironment(process.env, cfg.environment);
  const secrets = loadSecrets({ environment });
  // El código previo no lee los permisos de la clave (llega con exchange/, paso 32): en shadow y production
  // eso basta para que la guarda no deje arrancar.
  assertSafeStartup({ environment, config: cfg, secrets });
  if (cfg.mode === 'shadow') throw new Error('El modo shadow llega con exchange/ (paso 32): el código previo no lo tiene.');
  const live = cfg.mode === 'live';

  mkdirSync(cfg.dataDir, { recursive: true });
  const name = profile(cfg);
  const lockPath = join(cfg.dataDir, `${name}.lock`);
  acquireLock(lockPath);

  const store = new Store(join(cfg.dataDir, `${name}.db`));
  store.prune(Date.now());
  setLogSink((level, kind, message) => store.event(level, kind, message));

  const ex = createExchange(cfg, secrets, live);
  const market = new CcxtMarket(ex);
  await market.init();
  for (const s of [...cfg.core.symbols, cfg.core.regime.symbol]) {
    if (!market.market(s)?.active) throw new Error(`El símbolo ${s} no existe o no está activo en ${cfg.exchange.id}`);
  }

  const telegram = cfg.telegram.enabled && secrets.telegramToken ? new TelegramNotifier(secrets.telegramToken, secrets.telegramChatId) : null;
  const notifier: Notifier = telegram ?? new ConsoleNotifier();
  const broker = live ? new LiveBroker(ex, cfg.quote, cfg.paper.feeRate) : new PaperBroker(market, cfg.paper.feeRate, cfg.paper.slippageBps);
  const portfolio = new Portfolio(store, name, cfg.capital.startingQuote);
  const risk = new RiskManager(cfg.risk, store);
  const intel = new Intel(cfg.intel, store, null);
  const scout = new Scout(cfg, market, store);
  const reporter = new Reporter(cfg, store, portfolio, risk, intel);
  const engine = new Engine({ cfg, store, market, broker, notifier, risk, portfolio, intel, scout });

  if (live) {
    const problems = await reconcile(ex, store, portfolio, cfg.quote);
    if (problems.length) {
      risk.pause();
      await notifier.send(`⚠️ La cuenta no cuadra con el registro del bot. Queda EN PAUSA hasta que lo revises y envíes /reanudar.\n${problems.join('\n')}`);
    }
  }

  const abort = new AbortController();
  let running = true;
  const shutdown = (signal: string) => {
    if (!running) return;
    running = false;
    log('info', 'bot', `Señal ${signal} recibida: cerrando de forma ordenada.`);
    abort.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log('error', 'bot', `Promesa rechazada sin tratar: ${errMsg(e)}`));
  const pause = (ms: number) => Promise.race([sleep(ms), new Promise<void>((r) => abort.signal.addEventListener('abort', () => r(), { once: true }))]);

  const dashboard = cfg.dashboard.enabled ? startDashboard(reporter, cfg.dashboard.host, cfg.dashboard.port, secrets.dashboardPassword) : null;

  if (telegram) {
    const commands: Record<string, () => string> = {
      '/estado': () => reporter.statusText(),
      '/posiciones': () => reporter.positionsText(),
      '/operaciones': () => reporter.tradesText(),
      '/pausa': () => {
        risk.pause();
        return '⏸ Bot en pausa: no abrirá posiciones nuevas. Los stops de las abiertas siguen activos.';
      },
      '/reanudar': () => {
        risk.resume();
        return '▶️ Bot reanudado.';
      },
    };
    const help = 'Órdenes disponibles:\n/estado — resumen de la cuenta\n/posiciones — posiciones abiertas\n/operaciones — últimas operaciones\n/pausa — dejar de abrir posiciones\n/reanudar — volver a operar';
    void telegram.listen((cmd) => commands[cmd]?.() ?? help, abort.signal);
  }

  // La inteligencia va en su propio bucle: una fuente lenta no debe retrasar la vigilancia de stops.
  void (async () => {
    while (running) {
      try {
        await intel.refresh(Date.now());
      } catch (e) {
        log('warn', 'intel', errMsg(e));
      }
      await pause(cfg.intel.refreshMinutes * 60_000);
    }
  })();

  const label = cfg.mode === 'paper' ? 'SIMULADO (sin dinero real)' : cfg.exchange.sandbox ? 'TESTNET (dinero ficticio)' : 'REAL';
  await notifier.send(`🤖 Bot iniciado en modo ${label}.\n${reporter.statusText()}`);

  let lastPing = 0;
  while (running) {
    const started = Date.now();
    try {
      await engine.tick(started);

      const today = utcDay(started);
      const summaryDay = store.get<string | null>('bot.summaryDay', null);
      if (summaryDay !== today) {
        if (summaryDay) await notifier.send(`🗓 Resumen diario\n${reporter.statusText(started)}`);
        store.set('bot.summaryDay', today);
      }

      // Vigilante externo: si el bot deja de llamar, el servicio avisa al móvil.
      if (secrets.healthcheckUrl && started - lastPing >= 5 * 60_000) {
        lastPing = started;
        fetch(secrets.healthcheckUrl, { signal: AbortSignal.timeout(10_000) }).catch((e: unknown) => {
          log('warn', 'bot', `Aviso al vigilante externo fallido: ${errMsg(e)}`);
        });
      }
    } catch (e) {
      log('error', 'bot', `Ciclo fallido: ${errMsg(e)}`);
    }
    await pause(Math.max(1_000, cfg.loop.tickSeconds * 1_000 - (Date.now() - started)));
  }

  log('info', 'bot', 'Bot detenido.');
  dashboard?.close();
  setLogSink(null);
  store.close();
  rmSync(lockPath, { force: true });
}

main().catch((e) => {
  log('error', 'arranque', errMsg(e));
  process.exit(1);
});
