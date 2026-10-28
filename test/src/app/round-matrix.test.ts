// Matriz del PBO de la ronda (ADR 0034): configuraciones de las salidas guardadas, PBO dentro de cada familia y en la
// ronda. Datos sintéticos de resultado conocido.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pboAcross, type ConfigurationSeries } from '../../../src/analytics/robustness.ts';
import { deflatedSharpeOf } from '../../../src/analytics/report.ts';
import { outputConfigurations, roundDeflatedSharpe, roundMatrix, RoundMatrixError } from '../../../src/app/round-matrix.ts';
import { REGISTRY_FILE } from '../../../src/research/registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DAY = 86_400_000;

function synthetic(id: string, family: string, seed: number, periods = 64): { id: string; familia: string; fines: number[]; rendimientos: number[] } {
  let x = seed;
  const rendimientos = Array.from({ length: periods }, () => {
    x = (x * 16_807) % 2_147_483_647;
    return (x / 2_147_483_647 - 0.5) / 50;
  });
  return { id, familia: family, fines: rendimientos.map((_, i) => (i + 1) * DAY), rendimientos };
}

function asConfiguration(s: ReturnType<typeof synthetic>): ConfigurationSeries {
  return { id: s.id, family: s.familia, times: s.fines, returns: s.rendimientos };
}

test('las configuraciones de una salida son los puntos de su rejilla, o su única serie si no hubo barrido', () => {
  const a = synthetic('a', 'f', 1);
  const b = synthetic('b', 'f', 2);
  const grid = outputConfigurations('EXP-1', { series_rejilla: [a, b], serie_configuracion: synthetic('elegida', 'f', 3) });
  assert.deepEqual(grid.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(grid[0]?.returns, a.rendimientos);
  const single = outputConfigurations('EXP-2', { series_rejilla: [], serie_configuracion: synthetic('unica', 'g', 4) });
  assert.deepEqual(single.map((c) => [c.id, c.family]), [['unica', 'g']]);
});

test('fail closed: una salida sin la forma del ejecutor lanza', () => {
  const ok = synthetic('a', 'f', 1);
  for (const bad of [
    null,
    {},
    { series_rejilla: [{ ...ok, id: '' }] },
    { series_rejilla: [{ ...ok, familia: 3 }] },
    { series_rejilla: [{ ...ok, rendimientos: ok.rendimientos.slice(1) }] },
    { series_rejilla: [{ ...ok, rendimientos: [...ok.rendimientos.slice(1), Number.NaN] }] },
    { series_rejilla: [{ ...ok, fines: [...ok.fines].reverse() }] },
    { series_rejilla: [], serie_configuracion: null },
  ]) {
    assert.throws(() => outputConfigurations('EXP-X', bad), RoundMatrixError, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('PBO dentro de cada familia y en la ronda, el mismo que pboAcross con esas configuraciones', () => {
  const series = [synthetic('t1', 'tendencia', 11), synthetic('t2', 'tendencia', 12), synthetic('r1', 'reversion', 13), synthetic('r2', 'reversion', 14), synthetic('r3', 'reversion', 15)];
  const configurations = series.map(asConfiguration);
  const matrix = roundMatrix(configurations);
  assert.deepEqual(matrix.families.map((f) => f.family), ['reversion', 'tendencia']);
  assert.deepEqual(matrix.families[0]?.outcome, pboAcross(configurations.filter((c) => c.family === 'reversion')));
  assert.deepEqual(matrix.families[1]?.outcome, pboAcross(configurations.filter((c) => c.family === 'tendencia')));
  assert.deepEqual(matrix.round, pboAcross(configurations));
  assert.ok(matrix.round.measured && matrix.round.result.configurations === 5);
  assert.deepEqual(matrix.configurations.map((c) => c.periods), [64, 64, 64, 64, 64]);
});

test('una familia con una sola configuración no se mide en la familia, pero cuenta en la ronda', () => {
  const matrix = roundMatrix([asConfiguration(synthetic('t1', 'tendencia', 11)), asConfiguration(synthetic('r1', 'reversion', 12))]);
  assert.ok(matrix.families.every((f) => !f.outcome.measured));
  assert.ok(matrix.round.measured);
});

test('el comando se niega sin ids y con un experimento que no está completado, sin tocar el registro', () => {
  const registry = join(ROOT, ...REGISTRY_FILE.split('/'));
  const before = readFileSync(registry, 'utf8');
  const empty = spawnSync(process.execPath, ['src/app/round-pbo-command.ts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(empty.status, 2, empty.stderr);
  const unknown = spawnSync(process.execPath, ['src/app/round-pbo-command.ts', '--id', 'EXP-9999'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stderr, /EXP-9999: no es un experimento completado/);
  assert.equal(readFileSync(registry, 'utf8'), before, 'el registro no cambia');
});

test('DSR global en la decisión (ADR 0039): la serie de lo elegido de cada candidato, con la misma N para todos', () => {
  const chosen = synthetic('elegida', 'f', 7, 400);
  const salida = { series_rejilla: [synthetic('a', 'f', 1, 400)], serie_configuracion: chosen };
  const atDecision = roundDeflatedSharpe('EXP-1', salida, 177, 8);
  assert.deepEqual(atDecision, deflatedSharpeOf(chosen.rendimientos, 177, 8), 'el mismo cálculo que el DSR de la familia, con la N de todo el registro');
  assert.equal(atDecision.report?.trials, 177);
  const fewer = roundDeflatedSharpe('EXP-1', salida, 10, 8);
  assert.ok(atDecision.report !== null && fewer.report !== null && atDecision.report.dsr < fewer.report.dsr, 'más pruebas en el registro, más exigencia');
  assert.throws(() => roundDeflatedSharpe('EXP-1', salida, 177, 0), RoundMatrixError);
  assert.throws(() => roundDeflatedSharpe('EXP-1', { series_rejilla: [] }, 177, 8), RoundMatrixError);
});
