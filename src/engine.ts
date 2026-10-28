import type { Broker } from './broker.ts';
import type { Config } from './config.ts';
import type { IntelSource } from './intel.ts';
import { log } from './log.ts';
import type { MarketData } from './market.ts';
import type { Portfolio, Valuation } from './portfolio.ts';
import { sizeByPct, sizeByRisk } from './risk.ts';
import type { RiskManager, SizeResult } from './risk.ts';
import { manageScoutPosition } from './scout.ts';
import type { Scout, ScoutCandidate } from './scout.ts';
import type { Store } from './store.ts';
import { candlesNeeded, evaluateTrend, regimeOk } from './strategy/trend.ts';
import type { Bucket, Notifier, Position, Quote } from './types.ts';
import { errMsg, fmt, fmtPct, fmtPrice, newClientOrderId, tfToMs } from './util.ts';

export interface EngineDeps {
  cfg: Config;
  store: Store;
  market: MarketData;
  broker: Broker;
  notifier: Notifier;
  risk: RiskManager;
  portfolio: Portfolio;
  intel: IntelSource;
  scout: Scout;
}

const EQUITY_SNAPSHOT_MS = 5 * 60_000;
/** Margen tras el cierre de una vela para que el exchange la publique completa. */
const CANDLE_GRACE_MS = 5_000;

export class Engine {
  private d: EngineDeps;
  private quotes = new Map<string, Quote>();
  private valuation: Valuation | null = null;
  private regime: { day: number; ok: boolean } | null = null;
  private nextScoutAt = 0;
  private lastSnapshotAt = 0;
  private quoteFailures = 0;
  private lastAlertAt = new Map<string, number>();

  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  /**
   * Un ciclo completo. El orden importa: primero se protegen las posiciones
   * abiertas (stops), después se valora la cartera y solo al final se buscan
   * nuevas entradas. Un fallo en una fase no impide las demás.
   */
  async tick(now = Date.now()): Promise<void> {
    await this.phase('posiciones', () => this.managePositions(now));
    this.snapshot(now);
    if (this.d.cfg.core.enabled) await this.phase('nucleo', () => this.evaluateCore(now));
    if (this.d.cfg.scout.enabled) await this.phase('explorador', () => this.runScout(now));
    this.d.store.set('bot.heartbeat', now);
  }

  private async phase(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      log('error', name, errMsg(e));
    }
  }

  /** Avisa por Telegram como mucho una vez cada `everyMs` por clave, para no inundar el móvil. */
  private async alert(key: string, text: string, everyMs = 30 * 60_000): Promise<void> {
    const now = Date.now();
    if (now - (this.lastAlertAt.get(key) ?? 0) < everyMs) return;
    this.lastAlertAt.set(key, now);
    await this.d.notifier.send(text);
  }

  // ---------------------------------------------------------------- posiciones

  private async managePositions(now: number): Promise<void> {
    const open = this.d.store.openPositions();
    if (open.length === 0) return;

    let quotes: Map<string, Quote>;
    try {
      quotes = await this.d.market.quotes([...new Set(open.map((p) => p.symbol))]);
      this.quoteFailures = 0;
    } catch (e) {
      this.quoteFailures++;
      if (this.quoteFailures >= 5) {
        await this.alert('sin-precios', `⚠️ Sin precios del exchange desde hace ${this.quoteFailures} ciclos con ${open.length} posiciones abiertas. Los stops no se pueden vigilar.`);
      }
      throw e;
    }
    for (const [s, q] of quotes) this.quotes.set(s, q);

    for (const original of open) {
      const q = quotes.get(original.symbol);
      if (!q) {
        log('warn', 'posiciones', `Sin precio para ${original.symbol}`);
        continue;
      }
      let pos: Position | null = original;
      if (q.bid > pos.highestPrice) {
        pos = { ...pos, highestPrice: q.bid };
        this.d.store.savePosition(pos);
      }

      if (pos.bucket === 'scout') {
        const act = manageScoutPosition(pos, q.bid, now, this.d.cfg.scout);
        if (act.stopPrice !== undefined || act.meta) {
          pos = { ...pos, stopPrice: Math.max(pos.stopPrice, act.stopPrice ?? 0), meta: { ...pos.meta, ...act.meta } };
          this.d.store.savePosition(pos);
        }
        if (act.sellFraction) pos = await this.sell(pos, act.sellFraction, act.reason ?? 'explorador', q.bid, now);
      }

      if (pos && pos.status === 'open' && q.bid <= pos.stopPrice) await this.sell(pos, 1, 'stop', q.bid, now);
    }
  }

  /**
   * Vende toda la posición o una fracción. Devuelve la posición actualizada,
   * o `null` si la orden falló (seguirá abierta y se reintentará en el próximo ciclo).
   */
  private async sell(pos: Position, fraction: number, reason: string, refPrice: number, now: number): Promise<Position | null> {
    const full = fraction >= 1;
    const amount = this.d.market.roundAmount(pos.symbol, full ? pos.amount : pos.amount * fraction);
    const minCost = this.d.market.market(pos.symbol)?.minCost ?? 0;
    const tooSmall = !(amount > 0) || amount * refPrice < minCost;

    if (tooSmall && !full) return pos;
    if (tooSmall) {
      // El exchange no admite una orden tan pequeña: se da por perdida y se avisa.
      const closed: Position = { ...pos, status: 'closed', amount: 0, costBasis: 0, realizedPnl: pos.realizedPnl - pos.costBasis, exitTs: now, exitReason: `${reason} (resto no vendible)` };
      this.d.store.savePosition(closed);
      await this.d.notifier.send(`⚠️ ${pos.symbol}: el resto de la posición (${fmt(pos.amount * refPrice)} ${this.d.cfg.quote}) está por debajo del mínimo del exchange y no se puede vender. Se da por cerrada.`);
      return closed;
    }

    try {
      const fill = await this.d.broker.sell(pos.symbol, amount, newClientOrderId(pos.bucket));
      const res = this.d.portfolio.applySell(pos, fill, reason);
      this.quotes.set(pos.symbol, { bid: fill.price, ask: fill.price, last: fill.price });
      this.revalue(now);

      const initialCost = Number(pos.meta.initialCost ?? pos.costBasis);
      if (res.closed) {
        const total = res.position.realizedPnl;
        const pct = initialCost > 0 ? (total / initialCost) * 100 : 0;
        log('info', 'venta', `${pos.symbol} cerrada por ${reason} a ${fmtPrice(fill.price)}: ${fmt(total)} ${this.d.cfg.quote} (${fmtPct(pct)})`);
        await this.d.notifier.send(`${total >= 0 ? '🟢' : '🔴'} VENTA ${pos.symbol} a ${fmtPrice(fill.price)}\nMotivo: ${reason}\nResultado: ${fmt(total)} ${this.d.cfg.quote} (${fmtPct(pct)})`);
        const cooldown = this.d.risk.onClosedTrade(total, now);
        if (cooldown) await this.d.notifier.send(`⏸ ${cooldown}`);
        if (pos.bucket === 'scout') this.d.scout.startCooldown(pos.symbol, now);
      } else {
        log('info', 'venta', `${pos.symbol} venta parcial por ${reason} a ${fmtPrice(fill.price)}: ${fmt(res.pnl)} ${this.d.cfg.quote}`);
        await this.d.notifier.send(`🟢 VENTA PARCIAL ${pos.symbol} a ${fmtPrice(fill.price)}\nMotivo: ${reason}\nResultado de esta parte: ${fmt(res.pnl)} ${this.d.cfg.quote}`);
      }
      return res.position;
    } catch (e) {
      log('error', 'venta', `Fallo al vender ${pos.symbol} (${reason}): ${errMsg(e)}`);
      await this.alert(`venta-${pos.id}`, `⚠️ No se pudo vender ${pos.symbol} (${reason}): ${errMsg(e)}. Se reintentará en el próximo ciclo.`);
      return null;
    }
  }

  // ---------------------------------------------------------------- valoración

  private revalue(now: number): Valuation {
    const val = this.d.portfolio.valuation(this.quotes, now);
    this.valuation = val;
    this.d.store.set('state.valuation', val);
    return val;
  }

  private snapshot(now: number): void {
    const val = this.revalue(now);
    if (now - this.lastSnapshotAt >= EQUITY_SNAPSHOT_MS) {
      this.d.store.snapshotEquity({ ts: now, equity: val.equity, cash: val.cash, exposure: val.exposure });
      this.lastSnapshotAt = now;
    }
    for (const a of this.d.risk.onEquity(val.equity, now)) {
      log('warn', 'riesgo', a);
      void this.d.notifier.send(`🛑 ${a}`);
    }
  }

  // ---------------------------------------------------------------- núcleo

  /** Evalúa cada símbolo una sola vez por vela cerrada. */
  private async evaluateCore(now: number): Promise<void> {
    const { core } = this.d.cfg;
    const tfMs = tfToMs(core.timeframe);
    const lastClosedOpen = Math.floor(now / tfMs) * tfMs - tfMs;
    if (now - (lastClosedOpen + tfMs) < CANDLE_GRACE_MS) return;

    for (const symbol of core.symbols) {
      const key = `core.last.${symbol}`;
      if (this.d.store.get(key, 0) >= lastClosedOpen) continue;
      try {
        const candles = await this.d.market.candles(symbol, core.timeframe, candlesNeeded(core.strategy));
        const last = candles.at(-1);
        // Si el exchange aún no ha publicado la vela recién cerrada, se reintenta en el próximo ciclo.
        if (!last || last.ts < lastClosedOpen) continue;

        const pos = this.d.store.openPositions('core').find((p) => p.symbol === symbol) ?? null;
        const decision = evaluateTrend(candles, pos, await this.regimeOk(now), core.strategy);

        if (pos) {
          if (decision.action === 'exit') {
            const bid = this.quotes.get(symbol)?.bid ?? last.close;
            // Si la venta falla no se marca la vela como procesada, para reintentar.
            if (!(await this.sell(pos, 1, decision.reason, bid, now))) continue;
          } else if (decision.action === 'hold' && decision.stopPrice !== undefined && decision.stopPrice > pos.stopPrice) {
            this.d.store.savePosition({ ...pos, stopPrice: decision.stopPrice });
            log('info', 'nucleo', `${symbol}: stop subido a ${fmtPrice(decision.stopPrice)}`);
          }
        } else if (decision.action === 'enter') {
          const ageMin = (now - (last.ts + tfMs)) / 60_000;
          if (ageMin > core.maxSignalAgeMinutes) {
            log('info', 'nucleo', `${symbol}: señal de entrada descartada por antigua (${ageMin.toFixed(0)} min)`);
          } else {
            await this.enter('core', symbol, decision.stopPrice, decision.reason, now);
          }
        }
        this.d.store.set(key, last.ts);
      } catch (e) {
        log('error', 'nucleo', `${symbol}: ${errMsg(e)}`);
      }
    }
  }

  /** Régimen de mercado, recalculado una vez por vela diaria. */
  private async regimeOk(now: number): Promise<boolean> {
    const { regime } = this.d.cfg.core;
    const day = Math.floor(now / tfToMs(regime.timeframe));
    if (this.regime?.day === day) return this.regime.ok;
    const daily = await this.d.market.candles(regime.symbol, regime.timeframe, regime.smaPeriod + 5);
    const ok = regimeOk(daily, regime.smaPeriod);
    if (this.regime && this.regime.ok !== ok) {
      void this.d.notifier.send(ok ? '📈 Régimen de mercado: ALCISTA. Se permiten nuevas entradas.' : '📉 Régimen de mercado: BAJISTA. No se abrirán posiciones nuevas.');
    }
    this.regime = { day, ok };
    this.d.store.set('state.regime', { ok, ts: now });
    return ok;
  }

  // ---------------------------------------------------------------- explorador

  private async runScout(now: number): Promise<void> {
    const cfg = this.d.cfg.scout;
    if (now < this.nextScoutAt) return;
    this.nextScoutAt = now + cfg.scanMinutes * 60_000;

    if (!this.d.risk.entryGate(now).ok || this.d.intel.snapshot().blockEntries) return;
    // Las monedas pequeñas caen mucho más que BTC en mercado bajista: sin régimen alcista no se explora.
    if (!(await this.regimeOk(now))) return;

    let slots = cfg.maxPositions - this.d.store.openPositions('scout').length;
    if (slots <= 0) return;

    const held = new Set(this.d.store.openPositions().map((p) => p.symbol));
    const candidates = await this.d.scout.scan(now, held);
    this.d.store.set('state.scout', { ts: now, candidates: candidates.slice(0, 5) });

    for (const c of candidates) {
      if (slots <= 0) break;
      if (await this.enterScout(c, now)) slots--;
    }
  }

  private enterScout(c: ScoutCandidate, now: number): Promise<boolean> {
    const stop = c.price * (1 - this.d.cfg.scout.stopPct / 100);
    const reason = `explorador: +${fmt(c.changePct, 1)}% en 24 h con volumen ×${fmt(c.relVolume, 1)}`;
    return this.enter('scout', c.symbol, stop, reason, now);
  }

  // ---------------------------------------------------------------- entradas

  private async enter(bucket: Bucket, symbol: string, stopPrice: number, reason: string, now: number): Promise<boolean> {
    const { cfg, risk, intel, market, store } = this.d;
    const skip = (why: string): false => {
      log('info', 'entrada', `${symbol}: entrada descartada (${why})`);
      return false;
    };

    const gate = risk.entryGate(now);
    if (!gate.ok) return skip(gate.reason);
    const info = intel.snapshot();
    if (info.blockEntries) return skip('entradas bloqueadas por el módulo de inteligencia');
    if (store.openPositions().length >= cfg.risk.maxOpenPositions) return skip('máximo de posiciones abiertas');

    const m = market.market(symbol);
    if (!m || !m.active) return skip('mercado no disponible');
    const q = (await market.quotes([symbol])).get(symbol);
    if (!q) return skip('sin precio');
    this.quotes.set(symbol, q);
    const val = this.revalue(now);

    const limits = {
      equity: val.equity,
      cash: val.cash,
      exposure: val.exposure,
      entry: q.ask,
      maxExposurePct: cfg.risk.maxExposurePct,
      minNotional: Math.max(cfg.risk.minOrderQuote, m.minCost),
    };
    let size: SizeResult;
    if (bucket === 'core') {
      size = sizeByRisk({ ...limits, maxPositionPct: cfg.risk.maxPositionPct, stop: stopPrice, riskPct: cfg.risk.riskPerTradePct, multiplier: info.riskMultiplier });
    } else {
      const bucketRoom = (val.equity * cfg.scout.bucketPct) / 100 - val.exposureByBucket.scout;
      if (bucketRoom < limits.minNotional) return skip('cupo del explorador agotado');
      size = sizeByPct({ ...limits, maxPositionPct: Math.min(cfg.scout.positionPct, (bucketRoom / val.equity) * 100), pct: cfg.scout.positionPct, multiplier: info.riskMultiplier });
    }
    if (!size.ok) return skip(size.reason);

    const amount = market.roundAmount(symbol, size.amount);
    if (!(amount > 0) || amount < m.minAmount || amount * q.ask < m.minCost) return skip('cantidad por debajo del mínimo del exchange');

    try {
      const fill = await this.d.broker.buy(symbol, amount, newClientOrderId(bucket));
      this.d.portfolio.applyBuy(fill, bucket, stopPrice, reason, { initialCost: fill.quote });
      this.quotes.set(symbol, q);
      this.revalue(now);
      const riskPct = ((fill.price - stopPrice) / fill.price) * 100;
      log('info', 'compra', `${symbol} ${amount} a ${fmtPrice(fill.price)} (${fmt(fill.quote)} ${cfg.quote}), stop ${fmtPrice(stopPrice)}: ${reason}`);
      await this.d.notifier.send(`🔵 COMPRA ${symbol} a ${fmtPrice(fill.price)}\nImporte: ${fmt(fill.quote)} ${cfg.quote}\nStop: ${fmtPrice(stopPrice)} (−${fmt(riskPct, 1)}%)\nMotivo: ${reason}`);
      return true;
    } catch (e) {
      log('error', 'compra', `Fallo al comprar ${symbol}: ${errMsg(e)}`);
      await this.alert(`compra-${symbol}`, `⚠️ No se pudo comprar ${symbol}: ${errMsg(e)}`);
      return false;
    }
  }
}
