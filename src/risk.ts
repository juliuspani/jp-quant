import type { RiskConfig } from './config.ts';
import type { Store } from './store.ts';
import { utcDay } from './util.ts';

export interface SizeLimits {
  equity: number;
  cash: number;
  /** Valor actual de todas las posiciones abiertas. */
  exposure: number;
  entry: number;
  maxPositionPct: number;
  maxExposurePct: number;
  /** Mínimo por orden: el mayor entre el nuestro y el del exchange. */
  minNotional: number;
}

export type SizeResult = { ok: true; amount: number; notional: number } | { ok: false; reason: string };

function capNotional(wanted: number, l: SizeLimits): SizeResult {
  const room = (l.equity * l.maxExposurePct) / 100 - l.exposure;
  // Se deja un 1 % de caja sin usar para absorber comisión y deslizamiento.
  const notional = Math.min(wanted, (l.equity * l.maxPositionPct) / 100, room, l.cash * 0.99);
  if (!(notional > 0)) return { ok: false, reason: 'sin margen de exposición o de caja' };
  if (notional < l.minNotional) return { ok: false, reason: `importe ${notional.toFixed(2)} por debajo del mínimo ${l.minNotional.toFixed(2)}` };
  return { ok: true, amount: notional / l.entry, notional };
}

/**
 * Tamaño tal que, si salta el stop, se pierde `riskPct` del patrimonio.
 * `multiplier` (0–1) lo reduce cuando el módulo de inteligencia ve riesgo.
 */
export function sizeByRisk(l: SizeLimits & { stop: number; riskPct: number; multiplier: number }): SizeResult {
  const perUnit = l.entry - l.stop;
  if (!(perUnit > 0)) return { ok: false, reason: 'el stop no está por debajo del precio de entrada' };
  if (!(l.multiplier > 0)) return { ok: false, reason: 'riesgo reducido a cero por el módulo de inteligencia' };
  const riskQuote = ((l.equity * l.riskPct) / 100) * Math.min(l.multiplier, 1);
  return capNotional((riskQuote / perUnit) * l.entry, l);
}

/** Tamaño fijo como porcentaje del patrimonio (explorador). */
export function sizeByPct(l: SizeLimits & { pct: number; multiplier: number }): SizeResult {
  if (!(l.multiplier > 0)) return { ok: false, reason: 'riesgo reducido a cero por el módulo de inteligencia' };
  return capNotional(((l.equity * l.pct) / 100) * Math.min(l.multiplier, 1), l);
}

interface DayState {
  day: string;
  startEquity: number;
  blocked: boolean;
}

export interface RiskStatus {
  paused: boolean;
  halted: string | null;
  dayBlocked: boolean;
  cooldownUntil: number;
  peak: number;
  drawdownPct: number;
  dayStartEquity: number;
  dayPnlPct: number;
  lossStreak: number;
}

/**
 * Interruptores de seguridad. Solo deciden si se pueden ABRIR posiciones;
 * las salidas (stops) nunca se bloquean.
 */
export class RiskManager {
  private cfg: RiskConfig;
  private store: Store;
  private lastEquity: number;

  constructor(cfg: RiskConfig, store: Store) {
    this.cfg = cfg;
    this.store = store;
    this.lastEquity = store.lastEquity()?.equity ?? 0;
  }

  /** Actualiza pico y día con el patrimonio actual. Devuelve avisos para notificar. */
  onEquity(equity: number, now: number): string[] {
    const alerts: string[] = [];
    this.lastEquity = equity;

    const peak = Math.max(this.store.get('risk.peak', equity), equity);
    this.store.set('risk.peak', peak);

    const today = utcDay(now);
    let day = this.store.get<DayState | null>('risk.day', null);
    if (!day || day.day !== today) {
      day = { day: today, startEquity: equity, blocked: false };
      this.store.set('risk.day', day);
    }

    const dayPnlPct = ((equity - day.startEquity) / day.startEquity) * 100;
    if (!day.blocked && dayPnlPct <= -this.cfg.dailyLossLimitPct) {
      day.blocked = true;
      this.store.set('risk.day', day);
      alerts.push(`Límite de pérdida diaria alcanzado (${dayPnlPct.toFixed(2)}%). No se abrirán más operaciones hasta mañana (UTC).`);
    }

    const ddPct = ((peak - equity) / peak) * 100;
    if (ddPct >= this.cfg.maxDrawdownPct && !this.store.get<string | null>('risk.halted', null)) {
      const reason = `caída del ${ddPct.toFixed(2)}% desde el máximo`;
      this.store.set('risk.halted', reason);
      alerts.push(`BOT DETENIDO: ${reason}. No abrirá posiciones hasta que envíes /reanudar. Los stops siguen activos.`);
    }
    return alerts;
  }

  entryGate(now: number): { ok: true } | { ok: false; reason: string } {
    if (this.store.get('bot.paused', false)) return { ok: false, reason: 'bot en pausa manual' };
    const halted = this.store.get<string | null>('risk.halted', null);
    if (halted) return { ok: false, reason: `bot detenido: ${halted}` };
    const day = this.store.get<DayState | null>('risk.day', null);
    if (day?.blocked && day.day === utcDay(now)) return { ok: false, reason: 'límite de pérdida diaria alcanzado' };
    const cooldownUntil = this.store.get('risk.cooldownUntil', 0);
    if (now < cooldownUntil) return { ok: false, reason: 'enfriamiento tras racha de pérdidas' };
    return { ok: true };
  }

  /** Registra el resultado de una posición cerrada para la racha de pérdidas. */
  onClosedTrade(pnl: number, now: number): string | null {
    if (pnl >= 0) {
      this.store.set('risk.lossStreak', 0);
      return null;
    }
    const streak = this.store.get('risk.lossStreak', 0) + 1;
    if (streak < this.cfg.cooldownAfterLosses) {
      this.store.set('risk.lossStreak', streak);
      return null;
    }
    this.store.set('risk.lossStreak', 0);
    this.store.set('risk.cooldownUntil', now + this.cfg.cooldownHours * 3_600_000);
    return `${streak} pérdidas seguidas: pausa de ${this.cfg.cooldownHours} h antes de abrir nuevas operaciones.`;
  }

  pause(): void {
    this.store.set('bot.paused', true);
  }

  /** Quita la pausa manual y la parada por drawdown; el pico se reinicia para no volver a saltar al instante. */
  resume(): void {
    this.store.set('bot.paused', false);
    if (this.store.get<string | null>('risk.halted', null)) {
      this.store.set('risk.halted', null);
      if (this.lastEquity > 0) this.store.set('risk.peak', this.lastEquity);
    }
    this.store.set('risk.cooldownUntil', 0);
  }

  status(now: number): RiskStatus {
    const equity = this.lastEquity;
    const peak = this.store.get('risk.peak', equity);
    const day = this.store.get<DayState | null>('risk.day', null);
    return {
      paused: this.store.get('bot.paused', false),
      halted: this.store.get<string | null>('risk.halted', null),
      dayBlocked: !!day?.blocked && day.day === utcDay(now),
      cooldownUntil: this.store.get('risk.cooldownUntil', 0),
      peak,
      drawdownPct: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
      dayStartEquity: day?.startEquity ?? equity,
      dayPnlPct: day && day.startEquity > 0 ? ((equity - day.startEquity) / day.startEquity) * 100 : 0,
      lossStreak: this.store.get('risk.lossStreak', 0),
    };
  }
}
