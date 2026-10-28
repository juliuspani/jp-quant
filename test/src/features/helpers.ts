// Velas y ventanas de prueba para el Feature Engine. Datos sintéticos: no son un experimento (quant-research §10).
import type { CandleWindow } from '../../../src/features/types.ts';
import type { Rng } from '../../../src/kernel/random.ts';
import type { Candle } from '../../../src/kernel/market-data.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf, timeframeMs, type Timeframe, type UtcMillis } from '../../../src/shared/time.ts';

export const T0: UtcMillis = Date.UTC(2024, 0, 1);
export const LATENCY_MS = 60_000;

export interface Received {
  readonly candle: Candle;
  readonly receivedTime: UtcMillis;
}

export interface Bar {
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/** Vela `index` del símbolo (abre en T0 + index·timeframe), recibida LATENCY_MS después de cerrar. */
export function received(symbol: string, timeframe: Timeframe, index: number, bar: Bar): Received {
  const openTime = T0 + index * timeframeMs(timeframe);
  const closeTime = closeTimeOf(openTime, timeframe);
  const candle: Candle = {
    symbol,
    timeframe,
    openTime,
    closeTime,
    open: Decimal.parse(bar.open),
    high: Decimal.parse(bar.high),
    low: Decimal.parse(bar.low),
    close: Decimal.parse(bar.close),
    volume: Decimal.parse(bar.volume),
  };
  return { candle, receivedTime: closeTime + LATENCY_MS };
}

/** Vela plana en `close` (apertura, máximo, mínimo y cierre iguales). */
export function flat(close: string, volume = '1'): Bar {
  return { open: close, high: close, low: close, close, volume };
}

/** Ventana para llamar a compute directamente. Lo que no se da copia el cierre (precios) o vale 1 (volumen). */
export function windowOf(series: { close: readonly number[]; high?: readonly number[]; low?: readonly number[]; volume?: readonly number[] }): CandleWindow {
  return {
    symbol: 'TEST/EUR',
    timeframe: '1h',
    asOf: T0,
    open: series.close,
    high: series.high ?? series.close,
    low: series.low ?? series.close,
    close: series.close,
    volume: series.volume ?? series.close.map(() => 1),
  };
}

function dec(value: number): string {
  return Decimal.fromAnalysis(value, 8, 'HALF_EVEN').toString();
}

/**
 * Paseo aleatorio de `count` velas desde la vela `from`, con máximos y mínimos coherentes y algún volumen 0.
 * `skip` deja huecos: esas velas no se emiten.
 */
export function randomWalk(rng: Rng, symbol: string, timeframe: Timeframe, from: number, count: number, startPrice: number, skip: ReadonlySet<number> = new Set()): Received[] {
  const out: Received[] = [];
  let close = startPrice;
  for (let i = from; i < from + count; i++) {
    const open = close;
    close = Math.max(0.01, open * (1 + (rng.next() - 0.5) * 0.04));
    const high = Math.max(open, close) * (1 + rng.next() * 0.01);
    const low = Math.min(open, close) * (1 - rng.next() * 0.01);
    const volume = rng.next() < 0.1 ? 0 : rng.next() * 100;
    if (skip.has(i)) continue;
    // Redondear a 8 decimales puede cruzar máximo y mínimo con apertura y cierre: se recolocan para que la vela sea válida.
    const [o, c] = [dec(open), dec(close)];
    const h = Decimal.max(Decimal.parse(dec(high)), Decimal.parse(o), Decimal.parse(c)).toString();
    const l = Decimal.min(Decimal.parse(dec(low)), Decimal.parse(o), Decimal.parse(c)).toString();
    out.push(received(symbol, timeframe, i, { open: o, high: h, low: l, close: c, volume: dec(volume) }));
  }
  return out;
}
