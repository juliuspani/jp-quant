// Datos de la vista de investigación (paso 41C): app/ traduce el registro a datos planos y lee las curvas guardadas del
// control aleatorio, fail closed y sin repetir el contenido de un archivo que no entiende.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { experimentsFromRegistry, LUCK_FORMAT, parseLuckFile, ResearchViewError } from '../../../src/app/research-view.ts';
import { parseRegistry, type Registry } from '../../../src/research/registry.ts';
import { DEMO_CONTROLS, DEMO_REGISTRY } from '../../../demo/research.ts';

const registry = parseRegistry(readFileSync(DEMO_REGISTRY, 'utf8'));

test('cada experimento con su alta, su último cierre y los criterios de A.3 de sus métricas', () => {
  const experiments = experimentsFromRegistry(registry);
  assert.equal(experiments.length, registry.experiments.size);
  for (const e of experiments) {
    const source = registry.experiments.get(e.id);
    assert.ok(source !== undefined);
    assert.equal(e.family, source.registered.familia);
    assert.equal(e.trials, source.registered.n_pruebas);
    assert.equal(e.state, source.closings.at(-1)?.estado ?? 'registrado');
    assert.equal(e.verdict, source.closings.at(-1)?.resultado?.veredicto ?? null);
    const metrics = source.closings.at(-1)?.resultado?.metricas ?? {};
    for (const [criterion, value] of Object.entries(e.criteria)) assert.equal(metrics[`criterio_${criterion}`], value);
  }
  assert.ok(experiments.some((e) => Object.keys(e.criteria).length === 15));
});

test('un criterio con un valor que no es PASS, FAIL ni NO CONCLUYENTE no se interpreta', () => {
  const [id, experiment] = [...registry.experiments.entries()].find(([, x]) => x.closings.at(-1)?.resultado != null) ?? [];
  assert.ok(id !== undefined && experiment !== undefined);
  const last = experiment.closings.at(-1);
  assert.ok(last?.resultado != null);
  const broken: Registry = {
    ...registry,
    experiments: new Map([[id, { ...experiment, closings: [{ ...last, resultado: { ...last.resultado, metricas: { 'criterio_A.3.1': 'QUIZÁ' } } }] }]]),
  };
  assert.throws(() => experimentsFromRegistry(broken), ResearchViewError);
});

test('las curvas del control: formato fijo, mismas longitudes y sin repetir el contenido si no es JSON', () => {
  const luck = parseLuckFile(readFileSync(DEMO_CONTROLS, 'utf8'));
  assert.equal(luck.length, 3);
  assert.ok(luck.every((l) => l.samples.length === 48 && l.low.length === l.strategy.length));
  assert.throws(() => parseLuckFile('secreto123:AAAA'), (error: unknown) => error instanceof ResearchViewError && !error.message.includes('secreto'));
  assert.throws(() => parseLuckFile(JSON.stringify({ formato: 'otro', experimentos: [] })), ResearchViewError);
  const one = { id: 'EXP-0001', simulaciones: 10, percentil: 50, estrategia: [100, 101], p05: [99, 99], p95: [101, 102], muestras: [] };
  assert.equal(parseLuckFile(JSON.stringify({ formato: LUCK_FORMAT, experimentos: [one] })).length, 1);
  assert.throws(() => parseLuckFile(JSON.stringify({ formato: LUCK_FORMAT, experimentos: [{ ...one, extra: 1 }] })), ResearchViewError);
  assert.throws(() => parseLuckFile(JSON.stringify({ formato: LUCK_FORMAT, experimentos: [{ ...one, percentil: 120 }] })), ResearchViewError);
});
