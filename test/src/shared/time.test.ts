// Tiempo de negocio en UTC (src/shared/time.ts): solo instantes UTC explícitos y aritmética validada.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMs,
  barsBetween,
  closeTimeOf,
  floorToTimeframe,
  isAligned,
  isTimeframe,
  parseEpochMillis,
  parseUnixSeconds,
  parseUnixSecondsFraction,
  parseUtcIso,
  scaledDurationMs,
  toUtcIso,
} from '../../../src/shared/time.ts';

test('parseUtcIso solo acepta UTC explícito con «Z» y fechas posibles', () => {
  assert.equal(parseUtcIso('2026-10-01T00:00:00Z'), Date.UTC(2026, 9, 1));
  assert.equal(parseUtcIso('2026-10-01T00:00Z'), Date.UTC(2026, 9, 1));
  assert.equal(parseUtcIso('2026-09-30T23:59:59.5Z'), Date.UTC(2026, 8, 30, 23, 59, 59, 500));
  for (const bad of ['2026-10-01T00:00:00', '2026-10-01T00:00:00+00:00', '2026-10-01T02:00:00+02:00', '2026-10-01', '1696118400', '']) {
    assert.throws(() => parseUtcIso(bad), SyntaxError, bad);
  }
  for (const impossible of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-01T24:00:00Z']) {
    assert.throws(() => parseUtcIso(impossible), RangeError, impossible);
  }
  assert.equal(toUtcIso(Date.UTC(2026, 9, 1)), '2026-10-01T00:00:00.000Z');
});

test('segundos y milisegundos Unix en texto: solo enteros sin signo', () => {
  assert.equal(parseUnixSeconds('1609459200'), Date.UTC(2021, 0, 1));
  for (const bad of ['-1', '1.5', '1e9', ' 1', '']) assert.throws(() => parseUnixSeconds(bad), SyntaxError, bad);
  assert.equal(parseEpochMillis(1609459200000n), Date.UTC(2021, 0, 1));
  assert.equal(parseEpochMillis('1609459200000'), Date.UTC(2021, 0, 1));
  assert.throws(() => parseEpochMillis(-1n), SyntaxError);
});

test('segundos Unix con decimales: se truncan al milisegundo, sin pasar por float', () => {
  assert.equal(parseUnixSecondsFraction('1781481600.1256185'), Date.UTC(2026, 5, 15) + 125);
  assert.equal(parseUnixSecondsFraction('1781481600.9999999'), Date.UTC(2026, 5, 15) + 999);
  assert.equal(parseUnixSecondsFraction('1781481600.5'), Date.UTC(2026, 5, 15) + 500);
  assert.equal(parseUnixSecondsFraction('1781481600'), Date.UTC(2026, 5, 15));
  for (const bad of ['-1', '1.', '.5', '1e9', '1,5', '']) assert.throws(() => parseUnixSecondsFraction(bad), SyntaxError, bad);
});

test('floorToTimeframe: apertura de la vela que contiene un instante', () => {
  assert.equal(floorToTimeframe(Date.UTC(2026, 0, 1, 5, 59, 59, 999), '4h'), Date.UTC(2026, 0, 1, 4));
  assert.equal(floorToTimeframe(Date.UTC(2026, 0, 1, 4), '4h'), Date.UTC(2026, 0, 1, 4));
  assert.equal(floorToTimeframe(Date.UTC(2026, 0, 1, 23, 30), '1d'), Date.UTC(2026, 0, 1));
});

test('marcos: cierre, alineación en UTC y velas entre dos instantes', () => {
  const midnight = Date.UTC(2026, 0, 1);
  assert.equal(closeTimeOf(midnight, '4h'), Date.UTC(2026, 0, 1, 4));
  assert.equal(isAligned(midnight, '1d'), true);
  assert.equal(isAligned(Date.UTC(2026, 0, 1, 1), '1d'), false);
  assert.equal(isAligned(Date.UTC(2026, 0, 1, 8), '4h'), true);
  assert.equal(barsBetween(midnight, Date.UTC(2026, 0, 2), '4h'), 6);
  assert.throws(() => barsBetween(Date.UTC(2026, 0, 2), midnight, '1h'), RangeError);
  assert.throws(() => addMs(midnight, 0.5), RangeError);
  assert.equal(isTimeframe('4h'), true);
  assert.equal(isTimeframe('2h'), false);
});

test('scaledDurationMs: espera de pared para un tramo a una velocidad, solo con velocidades finitas > 0', () => {
  assert.equal(scaledDurationMs(0, 3_600_000, 3600), 1000);
  assert.equal(scaledDurationMs(10, 10, 2), 0);
  assert.equal(scaledDurationMs(0, 1000, 0.5), 2000);
  assert.throws(() => scaledDurationMs(10, 0, 1), RangeError);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => scaledDurationMs(0, 1, bad), RangeError);
});
