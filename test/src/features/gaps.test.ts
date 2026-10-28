// Velas que faltan (ADR 0036): cuántas admite un cálculo según la longitud de su fórmula, y cómo se cuentan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gapTolerance, missingCandles } from '../../../src/features/gaps.ts';

test('admite ⌊√n / 2⌋ velas de menos: ninguna con n ≤ 3, y crece despacio con la ventana', () => {
  assert.deepEqual([1, 2, 3, 4, 15, 16, 21, 56, 200].map(gapTolerance), [0, 0, 0, 1, 1, 2, 2, 3, 7]);
});

test('las velas que faltan se cuentan entre la primera y la última observadas', () => {
  const hour = 3_600_000;
  assert.equal(missingCandles(0, 9 * hour, 10, hour), 0, 'diez velas seguidas');
  assert.equal(missingCandles(0, 10 * hour, 10, hour), 1, 'diez velas en once horas');
  assert.equal(missingCandles(0, 12 * hour, 10, hour), 3);
});
