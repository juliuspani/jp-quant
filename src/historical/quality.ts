// Validación de calidad, deduplicación y detección de huecos (quant-research §3). Lo inválido se excluye con su
// motivo, los duplicados idénticos se quedan en una copia, los que discrepan se excluyen todos (no se elige uno), y
// los huecos se informan sin rellenarlos nunca.
import { Decimal } from '../shared/decimal.ts';
import { barsBetween, closeTimeOf, isAligned, type Timeframe, type UtcMillis } from '../shared/time.ts';
import type { HistoricalCandle, SymbolId } from './types.ts';

export interface QualityIssue {
  readonly symbol: SymbolId;
  readonly openTime: UtcMillis;
  readonly reason: string;
}

export interface Gap {
  readonly symbol: SymbolId;
  readonly from: UtcMillis; // cierre de la última vela antes del hueco
  readonly to: UtcMillis; // apertura de la primera vela después
  readonly missingBars: number;
}

export interface QualityReport {
  readonly inputRows: number;
  readonly validRows: number;
  readonly duplicatesRemoved: number;
  readonly conflicts: readonly QualityIssue[];
  readonly invalid: readonly QualityIssue[];
  readonly gaps: readonly Gap[];
}

const ZERO = Decimal.parse('0');

function invalidReason(c: HistoricalCandle, timeframe: Timeframe): string | null {
  if (c.timeframe !== timeframe) return `timeframe ${c.timeframe}, se esperaba ${timeframe}`;
  if (!isAligned(c.openTime, timeframe)) return 'apertura no alineada con el marco en UTC';
  if (c.closeTime !== closeTimeOf(c.openTime, timeframe)) return 'el cierre no es apertura + duración del marco';
  if (c.receivedTime < c.closeTime) return 'received_time anterior al cierre: sería look-ahead';
  if (![c.open, c.high, c.low, c.close].every((p) => p.isPositive())) return 'precio no positivo';
  if (c.volume.lt(ZERO)) return 'volumen negativo';
  if (c.high.lt(Decimal.max(c.open, c.close, c.low))) return 'high por debajo de open, close o low';
  if (c.low.gt(Decimal.min(c.open, c.close))) return 'low por encima de open o close';
  return null;
}

function sameValues(a: HistoricalCandle, b: HistoricalCandle): boolean {
  return (
    a.closeTime === b.closeTime &&
    a.receivedTime === b.receivedTime &&
    a.open.eq(b.open) &&
    a.high.eq(b.high) &&
    a.low.eq(b.low) &&
    a.close.eq(b.close) &&
    a.volume.eq(b.volume)
  );
}

function byKey(a: HistoricalCandle, b: HistoricalCandle): number {
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  return a.openTime === b.openTime ? 0 : a.openTime < b.openTime ? -1 : 1;
}

export function cleanCandles(
  input: readonly HistoricalCandle[],
  timeframe: Timeframe,
): { candles: HistoricalCandle[]; report: QualityReport } {
  const invalid: QualityIssue[] = [];
  const groups = new Map<string, HistoricalCandle[]>();
  for (const c of input) {
    const reason = invalidReason(c, timeframe);
    if (reason !== null) {
      invalid.push({ symbol: c.symbol, openTime: c.openTime, reason });
      continue;
    }
    const key = `${c.symbol}\u0000${String(c.openTime)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [c]);
    else group.push(c);
  }

  const candles: HistoricalCandle[] = [];
  const removed: HistoricalCandle[] = [];
  const conflicts: QualityIssue[] = [];
  for (const [first, ...rest] of groups.values()) {
    if (first === undefined) continue;
    if (rest.every((c) => sameValues(first, c))) {
      candles.push(first);
      removed.push(...rest);
    } else {
      conflicts.push({ symbol: first.symbol, openTime: first.openTime, reason: 'copias de la misma vela con valores distintos' });
    }
  }
  candles.sort(byKey);

  const gaps: Gap[] = [];
  // Pares consecutivos: candles[i] y la siguiente.
  for (const [prev, next] of candles.slice(1).map((c, i) => [candles[i], c] as const)) {
    if (prev === undefined || prev.symbol !== next.symbol || prev.closeTime === next.openTime) continue;
    gaps.push({ symbol: next.symbol, from: prev.closeTime, to: next.openTime, missingBars: barsBetween(prev.closeTime, next.openTime, timeframe) });
  }

  return {
    candles,
    report: {
      inputRows: input.length,
      validRows: candles.length,
      duplicatesRemoved: removed.length,
      conflicts,
      invalid,
      gaps,
    },
  };
}
