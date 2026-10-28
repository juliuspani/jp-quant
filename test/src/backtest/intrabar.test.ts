// Disparo dentro de la vela (paso 23, ADR 0026): una prueba por caso. Stop a 95 y objetivo a 110 de una posición larga.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sellTrigger } from '../../../src/backtest/intrabar.ts';
import { bar, d, HOUR, T0 } from './venue-bench.ts';

const LEVELS = { stop: d('95'), target: d('110') };
const BEFORE_OPEN = T0 - 1000; // la orden ya esperaba al abrir la vela
const prices = (o: string, h: string, l: string, c: string) => bar(T0, { o, h, l, c });
const show = (t: ReturnType<typeof sellTrigger>) => (t === null ? null : `${t.level} ${t.reason} ${t.reference.toString()}`);

test('el mínimo toca el stop: se ejecuta desde el precio del stop', () => {
  assert.equal(show(sellTrigger(prices('100', '101', '94', '99'), LEVELS, BEFORE_OPEN)), 'stop touch 95');
  assert.equal(show(sellTrigger(prices('100', '101', '95', '99'), LEVELS, BEFORE_OPEN)), 'stop touch 95', 'justo en el stop también');
});

test('la vela abre más allá del stop (hueco): se ejecuta desde la apertura', () => {
  assert.equal(show(sellTrigger(prices('93', '96', '92', '95.5'), LEVELS, BEFORE_OPEN)), 'stop gap 93');
});

test('un stop que llega con la vela ya abierta no puede ejecutarse a una apertura que no vio: toque desde el stop', () => {
  assert.equal(show(sellTrigger(prices('93', '96', '92', '95.5'), LEVELS, T0 + HOUR / 2)), 'stop touch 95');
});

test('stop y objetivo en la misma vela: se asume lo peor, primero el stop', () => {
  assert.equal(show(sellTrigger(prices('100', '111', '94', '105'), LEVELS, BEFORE_OPEN)), 'stop touch 95');
});

test('el máximo toca el objetivo: se ejecuta desde el objetivo, nunca desde un precio mejor', () => {
  assert.equal(show(sellTrigger(prices('100', '112', '99', '111'), LEVELS, BEFORE_OPEN)), 'target touch 110');
  assert.equal(show(sellTrigger(prices('113', '115', '112', '114'), LEVELS, BEFORE_OPEN)), 'target touch 110', 'aunque abra por encima');
});

test('ni stop ni objetivo tocados: nada salta', () => {
  assert.equal(sellTrigger(prices('100', '109', '96', '105'), LEVELS, BEFORE_OPEN), null);
  assert.equal(sellTrigger(prices('100', '120', '96', '105'), { stop: d('95'), target: null }, BEFORE_OPEN), null);
});
