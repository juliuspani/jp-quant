// Paso 23: el universo no responde antes de que la fuente traiga las bajas (2023 en Kraken), las bajas del final salen de
// las velas y no de la lista de pares de hoy, y las dos fuentes de cada par se unen sin solaparse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JoinError, joinParts, type DatasetPart } from '../../../src/historical/join.ts';
import { KRAKEN_DELISTINGS_FROM_UTC } from '../../../src/historical/kraken.ts';
import type { DatasetManifest } from '../../../src/historical/store.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { limitedUniverseAt, listingsFromSpans, SurvivorshipBiasError, universeAt, type Coverage } from '../../../src/historical/universe.ts';
import { parseUtcIso, toUtcIso } from '../../../src/shared/time.ts';
import { at, candle, HOUR, LATENCY_MS } from './helpers.ts';

const COVERAGE: Coverage = { source: 'kraken', start: at(0), end: at(100), delistingsFrom: at(50), activeSince: at(98) };

test('universo: no responde antes de que la fuente traiga las bajas; un universo limitado sí, con el sesgo declarado', () => {
  const history = listingsFromSpans(new Map([
    ['BTC/EUR', { first: at(0), last: at(100) }],
    ['OLD/EUR', { first: at(10), last: at(60) }], // baja en la hora 60
    ['NEW/EUR', { first: at(70), last: at(99) }],
  ]), COVERAGE);
  assert.throws(() => universeAt(history, at(49)), SurvivorshipBiasError);
  assert.deepEqual(universeAt(history, at(55)), ['BTC/EUR', 'OLD/EUR']);
  assert.deepEqual(universeAt(history, at(80)), ['BTC/EUR', 'NEW/EUR']);
  const early = limitedUniverseAt(history, ['BTC/EUR', 'OLD/EUR'], at(5));
  assert.deepEqual(early.symbols, ['BTC/EUR'], 'OLD/EUR aún no existía');
  assert.match(early.survivorshipBias ?? '', /sesgo de supervivencia/);
  assert.equal(limitedUniverseAt(history, ['BTC/EUR'], at(60)).survivorshipBias, null);
  assert.throws(() => limitedUniverseAt(history, ['XRP/EUR'], at(60)), RangeError);
});

test('las bajas del final salen de las velas: sin operaciones después de activeSince, el par se da de baja al cerrar su última vela', () => {
  const history = listingsFromSpans(new Map([
    ['ACTIVO/EUR', { first: at(0), last: at(99) }],
    ['QUIETO/EUR', { first: at(0), last: at(98) }], // su última vela cierra justo en activeSince: no cuenta
  ]), COVERAGE);
  assert.deepEqual(history.listings.map((l) => [l.symbol, l.delistedAt]), [['ACTIVO/EUR', null], ['QUIETO/EUR', at(98)]]);
  assert.equal(KRAKEN_DELISTINGS_FROM_UTC, '2023-01-01T00:00:00Z');
});

function manifest(dataset: string, candles: readonly HistoricalCandle[], overrides: Partial<DatasetManifest> = {}): DatasetManifest {
  const first = candles[0];
  const last = candles.at(-1);
  if (first === undefined || last === undefined) throw new Error('sin velas');
  return {
    formatVersion: 1,
    dataset,
    version: '0123456789abcdef',
    createdAtUtc: '2026-10-08T00:00:00Z',
    source: { provider: 'kraken', url: 'https://example.invalid', retrievedAtUtc: '2026-10-08T00:00:00Z', originalSha256: '0'.repeat(64), terms: null },
    timeframe: '1h',
    receivedLatencyMs: LATENCY_MS,
    symbols: [first.symbol],
    rangeUtc: { start: toUtcIso(first.openTime), endExclusive: toUtcIso(last.closeTime) },
    rows: candles.length,
    contentSha256: '0'.repeat(64),
    fileSha256: '0'.repeat(64),
    quality: { inputRows: candles.length, validRows: candles.length, invalidRows: [], duplicatesRemoved: 0, conflicts: [], gaps: [] },
    ...overrides,
  } as DatasetManifest;
}

function part(dataset: string, hours: readonly number[], overrides: Partial<DatasetManifest> = {}): DatasetPart {
  const candles = hours.map((h) => candle('BTC/EUR', at(h)));
  return { manifest: manifest(dataset, candles, overrides), candles };
}

test('unión de fuentes: el completo y el trimestral se concatenan en orden; solapados, de otro par o incompletos, no', () => {
  const full = part('kraken-xbteur-1h-full2026q2', [0, 1, 2]);
  const quarter = part('kraken-xbteur-1h-2026q3', [3, 4]);
  assert.deepEqual(joinParts([quarter, full]).map((c) => (c.openTime - at(0)) / HOUR), [0, 1, 2, 3, 4]);
  assert.throws(() => joinParts([full, part('solapado', [2, 3])]), JoinError);
  assert.throws(() => joinParts([full, part('otro', [3], { symbols: ['ETH/EUR'] })]), JoinError);
  assert.throws(() => joinParts([full, part('latencia', [3], { receivedLatencyMs: 1 })]), JoinError);
  assert.throws(() => joinParts([{ ...quarter, candles: quarter.candles.slice(1) }]), JoinError);
  assert.throws(() => joinParts([]), JoinError);
  assert.equal(parseUtcIso(full.manifest.rangeUtc.endExclusive), at(3));
});
