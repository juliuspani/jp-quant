import type { TrendParams } from '../config.ts';
import { atr, ema, sma } from '../indicators.ts';
import type { Candle } from '../types.ts';

export interface PositionView {
  stopPrice: number;
  highestPrice: number;
}

export type Decision =
  | { action: 'hold'; stopPrice?: number }
  | { action: 'enter'; stopPrice: number; reason: string }
  | { action: 'exit'; reason: string };

/** Velas necesarias para que la EMA lenta haya convergido. */
export function candlesNeeded(p: TrendParams): number {
  return Math.ceil(p.emaSlow * 2.5);
}

/**
 * Seguimiento de tendencia con ruptura, solo largos.
 *
 * Entrada: mercado general alcista (`regimeOk`), precio sobre la EMA lenta,
 * EMA rápida sobre la lenta y cierre por encima del máximo de las últimas
 * `breakoutLookback` velas. Stop inicial a `atrStopMult` ATR.
 * Salida: stop dinámico a `atrTrailMult` ATR del máximo alcanzado (solo sube),
 * o cierre por debajo de la EMA lenta.
 *
 * Función pura: recibe únicamente velas cerradas y decide sobre la última,
 * así el backtest y el bot en vivo ejecutan exactamente la misma lógica.
 */
export function evaluateTrend(candles: Candle[], pos: PositionView | null, regimeOk: boolean, p: TrendParams): Decision {
  const i = candles.length - 1;
  if (i < p.emaSlow + p.breakoutLookback) return { action: 'hold' };

  const closes = candles.map((c) => c.close);
  const close = closes[i]!;
  const fast = ema(closes, p.emaFast)[i]!;
  const slow = ema(closes, p.emaSlow)[i]!;
  const vol = atr(candles, p.atrPeriod)[i]!;
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || !(vol > 0)) return { action: 'hold' };

  if (pos) {
    if (close < slow) return { action: 'exit', reason: 'tendencia rota (cierre bajo la EMA lenta)' };
    const peak = Math.max(pos.highestPrice, candles[i]!.high);
    return { action: 'hold', stopPrice: Math.max(pos.stopPrice, peak - p.atrTrailMult * vol) };
  }

  if (!regimeOk) return { action: 'hold' };

  let priorHigh = -Infinity;
  for (let j = i - p.breakoutLookback; j < i; j++) priorHigh = Math.max(priorHigh, candles[j]!.high);

  if (close > slow && fast > slow && close > priorHigh) {
    return { action: 'enter', stopPrice: close - p.atrStopMult * vol, reason: `ruptura de máximos de ${p.breakoutLookback} velas en tendencia alcista` };
  }
  return { action: 'hold' };
}

/**
 * Filtro de régimen: solo se abren posiciones si el activo de referencia
 * (BTC) cierra por encima de su media de largo plazo. Sin datos suficientes
 * se responde `false`, que es el lado prudente.
 */
export function regimeOk(daily: Candle[], smaPeriod: number): boolean {
  if (daily.length < smaPeriod) return false;
  const closes = daily.map((c) => c.close);
  const avg = sma(closes, smaPeriod).at(-1)!;
  return closes.at(-1)! > avg;
}
