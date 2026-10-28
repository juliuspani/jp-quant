import type { Config } from './config.ts';
import type { IntelSource } from './intel.ts';
import type { Portfolio, Valuation } from './portfolio.ts';
import type { RiskManager } from './risk.ts';
import type { Store } from './store.ts';
import { fmt, fmtPct, fmtPrice } from './util.ts';

const DAY_MS = 86_400_000;

function when(ts: number): string {
  return new Date(ts).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Única fuente de verdad de lo que se enseña al usuario, tanto en Telegram como en el panel web. */
export class Reporter {
  private cfg: Config;
  private store: Store;
  private portfolio: Portfolio;
  private risk: RiskManager;
  private intel: IntelSource;

  constructor(cfg: Config, store: Store, portfolio: Portfolio, risk: RiskManager, intel: IntelSource) {
    this.cfg = cfg;
    this.store = store;
    this.portfolio = portfolio;
    this.risk = risk;
    this.intel = intel;
  }

  private valuation(now: number): Valuation {
    return this.store.get<Valuation | null>('state.valuation', null) ?? this.portfolio.valuation(new Map(), now);
  }

  private positions(val: Valuation) {
    return this.store.openPositions().map((p) => {
      const price = val.prices[p.symbol] ?? p.entryPrice;
      const value = p.amount * price;
      return {
        symbol: p.symbol,
        bucket: p.bucket,
        amount: p.amount,
        entryPrice: p.entryPrice,
        entryTs: p.entryTs,
        price,
        value,
        stopPrice: p.stopPrice,
        pnl: value - p.costBasis + p.realizedPnl,
        pnlPct: p.costBasis > 0 ? ((value - p.costBasis) / p.costBasis) * 100 : 0,
      };
    });
  }

  state(now = Date.now()) {
    const val = this.valuation(now);
    const initial = this.portfolio.initialCapital();
    const series = this.store.equitySince(now - 30 * DAY_MS);
    // El panel no necesita más de ~300 puntos para dibujar la curva.
    const step = Math.max(1, Math.ceil(series.length / 300));
    return {
      now,
      mode: this.cfg.mode,
      sandbox: this.cfg.exchange.sandbox,
      exchange: this.cfg.exchange.id,
      quote: this.cfg.quote,
      heartbeat: this.store.get('bot.heartbeat', 0),
      valuation: val,
      initial,
      totalPnl: val.equity - initial,
      totalPnlPct: initial > 0 ? ((val.equity - initial) / initial) * 100 : 0,
      risk: this.risk.status(now),
      regime: this.store.get<{ ok: boolean; ts: number } | null>('state.regime', null),
      positions: this.positions(val),
      closed: this.store.closedPositions(20).map((p) => ({
        symbol: p.symbol,
        bucket: p.bucket,
        entryTs: p.entryTs,
        exitTs: p.exitTs,
        exitReason: p.exitReason,
        pnl: p.realizedPnl,
        pnlPct: Number(p.meta.initialCost) > 0 ? (p.realizedPnl / Number(p.meta.initialCost)) * 100 : 0,
      })),
      fills: this.store.recentFills(30),
      events: this.store.recentEvents(40),
      equity: series.filter((_, i) => i % step === 0 || i === series.length - 1).map((r) => [r.ts, r.equity]),
      stats: this.store.stats(),
      intel: this.intel.snapshot(),
      scout: this.store.get<unknown>('state.scout', null),
    };
  }

  statusText(now = Date.now()): string {
    const s = this.state(now);
    const q = s.quote;
    const flags: string[] = [];
    if (s.risk.paused) flags.push('⏸ en pausa manual');
    if (s.risk.halted) flags.push(`🛑 detenido: ${s.risk.halted}`);
    if (s.risk.dayBlocked) flags.push('🚫 límite diario alcanzado');
    if (now < s.risk.cooldownUntil) flags.push(`🧊 enfriamiento hasta ${when(s.risk.cooldownUntil)}`);
    const mode = s.mode === 'paper' ? 'SIMULADO' : s.sandbox ? 'TESTNET' : 'REAL';
    const winRate = s.stats.trades > 0 ? `${fmt((s.stats.wins / s.stats.trades) * 100, 0)}% ganadoras` : 'sin operaciones cerradas';
    return [
      `📊 Estado (${mode}, ${s.exchange})`,
      `Patrimonio: ${fmt(s.valuation.equity)} ${q} (${fmtPct(s.totalPnlPct)} desde el inicio)`,
      `Hoy: ${fmtPct(s.risk.dayPnlPct)} · Caída desde máximo: ${fmt(s.risk.drawdownPct)}%`,
      `Caja: ${fmt(s.valuation.cash)} ${q} · Invertido: ${fmt(s.valuation.exposure)} ${q}`,
      `Posiciones abiertas: ${s.positions.length} · Cerradas: ${s.stats.trades} (${winRate})`,
      `Régimen: ${s.regime ? (s.regime.ok ? 'alcista' : 'bajista (sin entradas nuevas)') : 'pendiente'}`,
      `Inteligencia: riesgo ×${fmt(s.intel.riskMultiplier)}${s.intel.fearGreed ? ` · Miedo/Codicia ${s.intel.fearGreed.value}` : ''}`,
      ...(flags.length ? ['', ...flags] : []),
    ].join('\n');
  }

  positionsText(now = Date.now()): string {
    const rows = this.state(now).positions;
    if (rows.length === 0) return 'No hay posiciones abiertas.';
    return rows
      .map((p) => `${p.symbol} [${p.bucket === 'core' ? 'núcleo' : 'explorador'}]\n  entrada ${fmtPrice(p.entryPrice)} → ahora ${fmtPrice(p.price)} (${fmtPct(p.pnlPct)})\n  valor ${fmt(p.value)} · stop ${fmtPrice(p.stopPrice)}`)
      .join('\n\n');
  }

  tradesText(): string {
    const fills = this.store.recentFills(10);
    if (fills.length === 0) return 'Todavía no hay operaciones.';
    return fills.map((f) => `${when(f.ts)} ${f.side === 'buy' ? 'COMPRA' : 'VENTA'} ${f.symbol} a ${fmtPrice(f.price)} (${fmt(f.quote)}) — ${f.reason}`).join('\n');
  }
}
