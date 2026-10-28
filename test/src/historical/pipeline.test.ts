// Núcleo del pipeline histórico: lector de Kraken, calidad, deduplicación, huecos, universo point-in-time con
// altas y bajas, y lectura sin look-ahead (quant-research §3, ARCHITECTURE.md §5.1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKrakenOhlcvt } from '../../../src/historical/kraken.ts';
import { PointInTimeCandles } from '../../../src/historical/point-in-time.ts';
import { cleanCandles } from '../../../src/historical/quality.ts';
import { deriveListings, SurvivorshipBiasError, universeAt } from '../../../src/historical/universe.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { at, candle, HOUR, LATENCY_MS, T0 } from './helpers.ts';

test('Kraken OHLCVT: segundos UTC, valores como texto decimal y filas malas rechazadas con su motivo', () => {
  const t = T0 / 1000;
  const csv = [
    `${t},7000.1,7100,6900.00000001,7050.5,12.25,40`,
    `${t + 3600},7050.5,7060,7000,7010,0.1,3`,
    `${t + 7200},NaN,1,1,1,1,1`,
    `${t + 10800},1,1,1,1`,
    `${t}.5,1,1,1,1,1,1`,
    '',
  ].join('\n');
  const { candles, rejected } = parseKrakenOhlcvt(csv, { symbol: 'BTC/EUR', timeframe: '1h', receivedLatencyMs: LATENCY_MS });
  assert.equal(candles.length, 2);
  const [first] = candles;
  assert.equal(first?.openTime, T0);
  assert.equal(first?.closeTime, T0 + HOUR);
  assert.equal(first?.receivedTime, T0 + HOUR + LATENCY_MS);
  assert.equal(first?.low.toString(), '6900.00000001');
  assert.ok(first?.open instanceof Decimal);
  assert.deepEqual(rejected.map((r) => r.row), [2, 3, 4]);
});

test('Kraken OHLCVT: la notación científica de los valores pequeños se lee exacta (ADR 0022)', () => {
  const csv = `${String(T0 / 1000)},2.333e-07,2.4e-07,2.2e-07,2.351e-07,123456789.5,9
`;
  const { candles, rejected } = parseKrakenOhlcvt(csv, { symbol: 'PEPE/EUR', timeframe: '1h', receivedLatencyMs: LATENCY_MS });
  assert.deepEqual(rejected, []);
  assert.deepEqual([candles[0]?.open, candles[0]?.high, candles[0]?.close].map(String), ['0.0000002333', '0.00000024', '0.0000002351']);
});

test('calidad: excluye lo inválido con su motivo, también un received_time anterior al cierre', () => {
  const bad = [
    candle('A', at(0), { h: '99' }), // high por debajo de close
    candle('A', at(1), { l: '106' }), // low por encima de close
    candle('A', at(2), { o: '0' }),
    candle('A', at(3), { v: '-1' }),
    { ...candle('A', at(4)), openTime: at(4) + 1 },
    { ...candle('A', at(5)), closeTime: at(5) + 2 * HOUR },
    { ...candle('A', at(6)), receivedTime: at(6) },
    candle('A', at(7), {}, '4h'),
  ];
  const { candles, report } = cleanCandles([...bad, candle('A', at(8))], '1h');
  assert.deepEqual(candles.map((c) => c.openTime), [at(8)]);
  assert.equal(report.invalid.length, bad.length);
  assert.match(report.invalid[6]?.reason ?? '', /look-ahead/);
});

test('deduplicación: una copia de los duplicados idénticos; los que discrepan se excluyen y dejan hueco', () => {
  const input = [candle('A', at(0)), candle('A', at(0)), candle('A', at(1)), candle('A', at(1), { c: '104' }), candle('A', at(2))];
  const { candles, report } = cleanCandles(input, '1h');
  assert.deepEqual(candles.map((c) => c.openTime), [at(0), at(2)]);
  assert.equal(report.duplicatesRemoved, 1);
  assert.equal(report.conflicts.length, 1);
  assert.deepEqual(report.gaps, [{ symbol: 'A', from: at(1), to: at(2), missingBars: 1 }]);
  assert.equal(report.inputRows, 5);
  assert.equal(report.validRows, 2);
});

test('huecos: se detectan por símbolo, se cuentan y nunca se rellenan', () => {
  const input = [candle('B', at(0)), candle('A', at(5)), candle('A', at(0)), candle('A', at(1)), candle('B', at(1))];
  const { candles, report } = cleanCandles(input, '1h');
  assert.deepEqual(candles.map((c) => `${c.symbol}@${String((c.openTime - T0) / HOUR)}`), ['A@0', 'A@1', 'A@5', 'B@0', 'B@1']);
  assert.deepEqual(report.gaps, [{ symbol: 'A', from: at(2), to: at(5), missingBars: 3 }]);
});

test('universo point-in-time: altas y bajas con su fecha, y los deslistados siguen en el pasado', () => {
  const candles = [
    candle('BTC/EUR', at(0)), candle('BTC/EUR', at(9)),
    candle('OLD/EUR', at(0)), candle('OLD/EUR', at(3)), // deslistado al cerrar la vela de las 3
    candle('NEW/EUR', at(5)), candle('NEW/EUR', at(9)),
  ];
  // Sigue listado al final quien tiene una vela que cierra después de activeSince (las 8): BTC y NEW.
  const history = deriveListings(candles, { source: 'kraken', start: at(0), end: at(10), delistingsFrom: at(0), activeSince: at(8) });
  assert.equal(history.includesDelisted, true);
  assert.deepEqual(history.listings.find((l) => l.symbol === 'OLD/EUR'), { symbol: 'OLD/EUR', listedAt: at(0), delistedAt: at(4) });
  assert.deepEqual(universeAt(history, at(2)), ['BTC/EUR', 'OLD/EUR']);
  assert.deepEqual(universeAt(history, at(4)), ['BTC/EUR']);
  assert.deepEqual(universeAt(history, at(5)), ['BTC/EUR', 'NEW/EUR']);
  assert.throws(() => universeAt(history, at(10)), RangeError);
  assert.throws(() => universeAt(history, at(-1)), RangeError);
});

test('prohibido reconstruir el pasado solo con los supervivientes: sin deslistados, el universo no responde', () => {
  const candles = [candle('BTC/EUR', at(0)), candle('ETH/EUR', at(1))];
  // Los dos pares tienen velas después de activeSince: ninguno se da de baja.
  const survivors = deriveListings(candles, { source: 'lista de hoy', start: at(0), end: at(10), delistingsFrom: at(0), activeSince: at(0) + 1 });
  assert.equal(survivors.includesDelisted, false);
  assert.throws(() => universeAt(survivors, at(2)), SurvivorshipBiasError);
  // Velas fuera de la cobertura o una cobertura imposible son un error.
  assert.throws(() => deriveListings(candles, { source: 'x', start: at(1), end: at(10), delistingsFrom: at(1), activeSince: at(5) }), RangeError);
  assert.throws(() => deriveListings(candles, { source: 'x', start: at(0), end: at(10), delistingsFrom: at(0), activeSince: at(10) }), RangeError);
});

test('look-ahead: ningún dato está disponible antes de su received_time, en ningún instante', () => {
  const candles = [candle('A', at(0)), candle('A', at(1)), candle('B', at(0)), candle('A', at(2), {}, '1h')];
  const view = new PointInTimeCandles(candles);
  for (let t = at(0) - HOUR; t <= at(4); t += 250) {
    for (const c of view.availableAt(t)) assert.ok(c.receivedTime <= t, `vela de ${c.symbol} vista antes de su received_time`);
    // La vela en curso (abierta y sin cerrar) nunca está disponible.
    assert.ok(view.availableAt(t).every((c) => c.closeTime < t), 'una vela aparece antes de cerrar');
  }
  assert.deepEqual(view.availableAt(at(1) + LATENCY_MS - 1), []);
  assert.equal(view.availableAt(at(1) + LATENCY_MS).length, 2);
  assert.equal(view.latestAt(at(2) + LATENCY_MS, 'A')?.openTime, at(1));
  assert.equal(view.latestAt(at(0), 'A'), null);
});

test('el replay entrega los datos en orden de received_time', () => {
  const view = new PointInTimeCandles([candle('B', at(2)), candle('A', at(0)), candle('C', at(1), {}, '1h'), candle('A', at(2))]);
  const order = [...view.replay()];
  assert.ok(order.every((c, i) => i === 0 || (order[i - 1]?.receivedTime ?? 0) <= c.receivedTime));
  assert.deepEqual(order.map((c) => c.symbol), ['A', 'C', 'A', 'B']);
});
