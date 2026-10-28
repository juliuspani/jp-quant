// Contrato del reloj del kernel (ADR 0021): reglas de los temporizadores, comunes a los dos relojes, y el reloj de
// tiempo real con esperas cortas.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimerError, TimerTable } from '../../../src/kernel/clock.ts';
import { SystemClock } from '../../../src/kernel/system-clock.ts';

test('TimerTable: vence por instante y, en empate, por orden de programación', () => {
  const timers = new TimerTable();
  timers.add('b', 20, 0);
  timers.add('a', 10, 0);
  timers.add('c', 10, 0);
  assert.deepEqual(timers.next(), { timerId: 'a', at: 10 });
  assert.equal(timers.remove('a'), true);
  assert.deepEqual(timers.next(), { timerId: 'c', at: 10 });
  timers.remove('c');
  assert.deepEqual(timers.next(), { timerId: 'b', at: 20 });
  timers.remove('b');
  assert.equal(timers.next(), null);
  assert.equal(timers.size, 0);
});

test('TimerTable: rechaza el pasado, un id pendiente, un id vacío y un instante inválido', () => {
  const timers = new TimerTable();
  assert.throws(() => timers.add('x', 99, 100), TimerError);
  timers.add('x', 100, 100); // ahora mismo sí
  assert.throws(() => timers.add('x', 200, 100), TimerError);
  assert.throws(() => timers.add('', 200, 100), TimerError);
  assert.throws(() => timers.add('y', 1.5, 0), RangeError);
  assert.throws(() => timers.add('y', -1, 0), RangeError);
  assert.equal(timers.remove('desconocido'), false);
});

test('SystemClock: hora UTC entera, monótono creciente y temporizador que vence una sola vez', async () => {
  const fired: string[] = [];
  let resolveFired: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveFired = resolve;
  });
  const clock = new SystemClock((timerId) => {
    fired.push(timerId);
    resolveFired();
  });
  assert.ok(Number.isSafeInteger(clock.now()));
  const t0 = clock.monotonic();
  assert.ok(clock.monotonic() >= t0);

  clock.schedule(clock.now() + 1000, 'cancelado');
  clock.cancel('cancelado');
  clock.cancel('cancelado'); // idempotente
  clock.schedule(clock.now() + 5, 'corto');
  assert.throws(() => clock.schedule(clock.now() + 50, 'corto'), TimerError);
  assert.throws(() => clock.schedule(clock.now() - 1000, 'pasado'), TimerError);
  await done;
  assert.deepEqual(fired, ['corto']);
  // Ya vencido: el mismo id se puede volver a programar.
  clock.schedule(clock.now() + 1000, 'corto');
  clock.cancel('corto');
});
