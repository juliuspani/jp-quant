// Une por par las fuentes de un mismo par y timeframe (paso 23): el ZIP completo hasta el 2026-07-01 y el trimestral
// 2026Q3 (DATA.md §5). Las partes tienen el mismo par, timeframe y latencia, no se solapan y se concatenan en orden. Un
// solapamiento o una vela repetida son un error, no algo que se arregla: no se elige cuál de las dos fuentes vale.
import { parseUtcIso, toUtcIso } from '../shared/time.ts';
import type { DatasetManifest } from './store.ts';
import type { HistoricalCandle } from './types.ts';

export interface DatasetPart {
  readonly manifest: DatasetManifest;
  readonly candles: readonly HistoricalCandle[];
}

export class JoinError extends Error {
  override readonly name = 'JoinError';
}

function signature(manifest: DatasetManifest): string {
  return `${manifest.symbols.join(',')} ${manifest.timeframe} ${String(manifest.receivedLatencyMs)} ms`;
}

/** Velas de las partes, en orden de apertura. Lanza JoinError si no son del mismo par o si se solapan. */
export function joinParts(parts: readonly DatasetPart[]): HistoricalCandle[] {
  const [first] = parts;
  if (first === undefined) throw new JoinError('sin partes que unir');
  if (first.manifest.symbols.length !== 1) throw new JoinError(`${first.manifest.dataset}: una parte es de un solo par`);
  const expected = signature(first.manifest);
  const startOf = (part: DatasetPart): number => parseUtcIso(part.manifest.rangeUtc.start);
  const ordered = [...parts].sort((a, b) => (startOf(a) < startOf(b) ? -1 : 1));
  const joined: HistoricalCandle[] = [];
  let previous: DatasetPart | null = null;
  for (const part of ordered) {
    const { manifest } = part;
    if (signature(manifest) !== expected) throw new JoinError(`${manifest.dataset}: ${signature(manifest)}, se esperaba ${expected}`);
    if (previous !== null && startOf(part) < parseUtcIso(previous.manifest.rangeUtc.endExclusive)) {
      throw new JoinError(`${manifest.dataset} empieza el ${manifest.rangeUtc.start}, antes de que acabe ${previous.manifest.dataset} (${previous.manifest.rangeUtc.endExclusive})`);
    }
    if (part.candles.length !== manifest.rows) throw new JoinError(`${manifest.dataset}: ${String(part.candles.length)} velas, el manifiesto dice ${String(manifest.rows)}`);
    for (const candle of [...part.candles].sort((a, b) => (a.openTime === b.openTime ? 0 : a.openTime < b.openTime ? -1 : 1))) {
      const last = joined.at(-1);
      if (last !== undefined && candle.openTime <= last.openTime) throw new JoinError(`${candle.symbol} ${toUtcIso(candle.openTime)}: vela repetida o desordenada al unir`);
      joined.push(candle);
    }
    previous = part;
  }
  return joined;
}
