// Azar e ids con semilla (ADR 0021): vector de referencia de xoshiro128**, reproducibilidad, flujos independientes
// y rango.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSeed, seededIds, seededRng, seededUnit, seededUuids, xoshiro128ss } from '../../../src/kernel/random.ts';

test('xoshiro128** da el vector de referencia con el estado {1, 2, 3, 4}', () => {
  const next = xoshiro128ss([1, 2, 3, 4]);
  const first = Array.from({ length: 10 }, () => next());
  assert.deepEqual(first, [
    11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
  ]);
  assert.throws(() => xoshiro128ss([0, 0, 0, 0]), RangeError);
});

test('la misma semilla y el mismo flujo dan la misma secuencia; otra semilla u otro flujo, otra', () => {
  const take = (seed: number, stream: string): number[] => {
    const rng = seededRng(seed, stream);
    return Array.from({ length: 50 }, () => rng.next());
  };
  assert.deepEqual(take(42, 'a'), take(42, 'a'));
  assert.notDeepEqual(take(42, 'a'), take(43, 'a'));
  assert.notDeepEqual(take(42, 'a'), take(42, 'b'));
  for (const x of take(7, 'rango')) assert.ok(x >= 0 && x < 1, `fuera de [0, 1): ${String(x)}`);
});

test('las semillas válidas son enteros de 32 bits sin signo', () => {
  assert.equal(checkSeed(0), 0);
  assert.equal(checkSeed(4_294_967_295), 4_294_967_295);
  for (const bad of [-1, 4_294_967_296, 1.5, Number.NaN]) assert.throws(() => checkSeed(bad), RangeError);
});

test('los ids son únicos, reproducibles y dependen de la semilla', () => {
  const take = (seed: number): string[] => {
    const ids = seededIds(seed, 'ev');
    return Array.from({ length: 1000 }, () => ids.next());
  };
  const ids = take(1);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(ids[0] ?? '', /^ev-1-[0-9a-f]{8}$/);
  assert.deepEqual(take(1), ids);
  assert.notDeepEqual(take(2), ids);
});

test('seededUuids da UUID de versión 4 reproducibles y distintos entre sí', () => {
  const take = (seed: number, stream: string): string[] => {
    const ids = seededUuids(seed, stream);
    return Array.from({ length: 200 }, () => ids.next());
  };
  const a = take(42, 'approvals');
  assert.deepEqual(a, take(42, 'approvals'));
  assert.notDeepEqual(a, take(43, 'approvals'));
  assert.notDeepEqual(a, take(42, 'otro'));
  assert.equal(new Set(a).size, a.length);
  for (const id of a) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('seededUnit es una función pura de la semilla y la clave, en [0, 1) y sin sesgo apreciable', () => {
  assert.equal(seededUnit(7, 'BTC/EUR|1700000000000'), seededUnit(7, 'BTC/EUR|1700000000000'));
  assert.notEqual(seededUnit(7, 'BTC/EUR|1700000000000'), seededUnit(8, 'BTC/EUR|1700000000000'));
  assert.notEqual(seededUnit(7, 'BTC/EUR|1700000000000'), seededUnit(7, 'BTC/EUR|1700003600000'));
  const values = Array.from({ length: 10_000 }, (_, i) => seededUnit(20261014, `clave-${String(i)}`));
  assert.ok(values.every((u) => u >= 0 && u < 1));
  // Media de 10 000 uniformes: 0,5 con un error típico de 0,0029; claves consecutivas no dan valores correlacionados.
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.012, String(mean));
  assert.equal(values.filter((u) => u < 0.1).length > 900 && values.filter((u) => u < 0.1).length < 1100, true);
  assert.throws(() => seededUnit(-1, 'x'), RangeError);
});
