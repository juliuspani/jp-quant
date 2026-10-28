// Lectura point-in-time (ARCHITECTURE.md §5.1): un dato nunca está disponible antes de su received_time. El replay
// entrega las velas en orden de received_time; en caso de empate, por símbolo y apertura.
import type { UtcMillis } from '../shared/time.ts';
import type { HistoricalCandle, SymbolId } from './types.ts';

function byReceived(a: HistoricalCandle, b: HistoricalCandle): number {
  if (a.receivedTime !== b.receivedTime) return a.receivedTime < b.receivedTime ? -1 : 1;
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  return a.openTime === b.openTime ? 0 : a.openTime < b.openTime ? -1 : 1;
}

export class PointInTimeCandles {
  readonly #candles: readonly HistoricalCandle[];

  constructor(candles: readonly HistoricalCandle[]) {
    this.#candles = Object.freeze([...candles].sort(byReceived));
  }

  /** Lo que el sistema tenía en `at`: velas con received_time ≤ at, en orden de llegada. */
  availableAt(at: UtcMillis, symbol?: SymbolId): HistoricalCandle[] {
    return this.#candles.filter((c) => c.receivedTime <= at && (symbol === undefined || c.symbol === symbol));
  }

  /** La última vela de `symbol` que se conocía en `at`, o null. */
  latestAt(at: UtcMillis, symbol: SymbolId): HistoricalCandle | null {
    return this.availableAt(at, symbol).at(-1) ?? null;
  }

  /** Orden del replay: por received_time (ARCHITECTURE.md §5.1). */
  *replay(): Generator<HistoricalCandle> {
    yield* this.#candles;
  }
}
