// Vista de investigación del dashboard (paso 41C): desenlaces, N global, embudo y fallos salen del registro tal cual, y
// lo incoherente no se pinta (fail closed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { experimentsFromRegistry } from '../../../src/app/research-view.ts';
import { expectedMaxSharpe } from '../../../src/analytics/statistics.ts';
import { DashboardError } from '../../../src/monitoring/journal.ts';
import { buildResearch, CRITERIA, outcomeOf, type LuckCurves, type ResearchExperiment } from '../../../src/monitoring/research.ts';
import { readRegistry, REGISTRY_FILE, trialsByFamily } from '../../../src/research/registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const T = Date.UTC(2026, 0, 1);

function experiment(id: string, overrides: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return { id, family: 'demo-a', registeredAt: T, trials: 2, state: 'completado', closedAt: T + 1, verdict: 'RECHAZADA', criteria: {}, ...overrides };
}

const allPass = Object.fromEntries(CRITERIA.map((c) => [c.id, 'PASS' as const]));

test('los nombres y el orden de los criterios son los de analytics/criteria.ts', () => {
  const source = readFileSync(join(ROOT, 'src', 'analytics', 'criteria.ts'), 'utf8');
  const found = [...source.matchAll(/'(A\.3\.\d+)', '([^']+)'/g)].map((m) => ({ id: m[1], label: m[2] }));
  const unique = found.filter((c, i) => found.findIndex((d) => d.id === c.id) === i);
  assert.deepEqual(unique, CRITERIA.map(({ id, label }) => ({ id, label })));
});

test('desenlace de cada experimento según su estado y su veredicto', () => {
  assert.equal(outcomeOf({ state: 'registrado', verdict: null }), 'en curso');
  for (const state of ['fallido', 'abortado', 'invalidado'] as const) assert.equal(outcomeOf({ state, verdict: null }), 'abortado');
  assert.equal(outcomeOf({ state: 'completado', verdict: 'RECHAZADA' }), 'rechazado');
  assert.equal(outcomeOf({ state: 'completado', verdict: 'CANDIDATA A PAPER' }), 'aceptado');
  assert.equal(outcomeOf({ state: 'completado', verdict: 'CANDIDATA A TEST FINAL' }), 'aceptado');
  assert.equal(outcomeOf({ state: 'completado', verdict: 'NO CONCLUYENTE' }), 'no concluyente');
  assert.equal(outcomeOf({ state: 'completado', verdict: null }), 'no concluyente', 'sin veredicto (solo elige en train) no es un rechazo');
});

test('un punto por experimento, la N global suma todas las pruebas y el embudo es acumulado y en orden', () => {
  const r = buildResearch({
    experiments: [
      experiment('EXP-0003', { criteria: { ...allPass, 'A.3.2': 'FAIL', 'A.3.9': 'FAIL' } }),
      experiment('EXP-0001', { criteria: allPass, verdict: 'CANDIDATA A PAPER', trials: 5, family: 'demo-b' }),
      experiment('EXP-0002', { criteria: { ...allPass, 'A.3.6': 'NO CONCLUYENTE' }, verdict: 'NO CONCLUYENTE' }),
      experiment('EXP-0004', { state: 'abortado', verdict: null, trials: 7 }),
      experiment('EXP-0005', { state: 'registrado', closedAt: null, verdict: null, criteria: { 'A.3.1': 'PASS' } }),
    ],
    luck: [],
  });
  assert.deepEqual(r.points.map((p) => p.id), ['EXP-0001', 'EXP-0002', 'EXP-0003', 'EXP-0004', 'EXP-0005']);
  assert.equal(r.globalN, 5 + 2 + 2 + 7 + 2);
  assert.deepEqual(r.families, [{ family: 'demo-a', experiments: 4, trials: 13 }, { family: 'demo-b', experiments: 1, trials: 5 }]);
  assert.deepEqual(r.outcomes.map((o) => [o.outcome, o.count]), [['aceptado', 1], ['rechazado', 1], ['no concluyente', 1], ['abortado', 1], ['en curso', 1]]);
  assert.equal(r.evaluated, 3, 'solo cuentan los que tienen todos los criterios');
  const steps = new Map(r.funnel.map((s) => [s.criterion ?? s.label, s.count]));
  assert.equal(steps.get('En el registro'), 5);
  assert.equal(steps.get('A.3.1'), 3);
  assert.equal(steps.get('A.3.2'), 2, 'EXP-0003 cae en A.3.2');
  assert.equal(steps.get('A.3.6'), 1, 'un NO CONCLUYENTE no supera el criterio');
  assert.equal(steps.get('A.3.15'), 1);
  assert.equal(r.funnel.length, 2 + CRITERIA.length);
  assert.deepEqual(r.failures.map((f) => [f.criterion, f.fail, f.inconclusive]), [['A.3.2', 1, 0], ['A.3.9', 1, 0], ['A.3.6', 0, 1]]);
  assert.equal(r.expectedMaxSharpe, expectedMaxSharpe(r.globalN, 1));
  assert.equal(r.events.length, 5 + 4, 'cinco altas y cuatro cierres');
  assert.equal(r.events[0]?.at, T + 1, 'lo más reciente primero: los cierres');
  assert.ok(r.events.some((ev) => ev.text === 'EXP-0001 · completado · CANDIDATA A PAPER · demo-b'));
});

test('con el registro real: un punto por experimento y la N global, la suma de las pruebas de todas las familias', () => {
  // Sin cifras fijas: el registro real crece con cada experimento (241 al decidir el paso 31; EXP-0030 suma 26).
  const registry = readRegistry(join(ROOT, REGISTRY_FILE));
  const r = buildResearch({ experiments: experimentsFromRegistry(registry), luck: [] });
  assert.equal(r.points.length, registry.experiments.size);
  assert.equal(r.globalN, [...trialsByFamily(registry).values()].reduce((a, b) => a + b, 0));
  assert.ok(r.globalN >= 241, 'nunca baja de la N con la que se decidió el paso 31');
  assert.equal(r.outcomes.find((o) => o.outcome === 'aceptado')?.count, 0, 'el paso 31 no aprobó ninguna estrategia');
  assert.equal(r.funnel.at(-1)?.count, 0);
});

test('fail closed: ids repetidos, criterios desconocidos o curvas del control incoherentes no se pintan', () => {
  const luck = (overrides: Partial<LuckCurves> = {}): LuckCurves => ({
    experimentId: 'EXP-0001', simulations: 10, percentile: 50, strategy: [100, 101, 102], low: [99, 99, 99], high: [101, 102, 103], samples: [[100, 100, 100]], ...overrides,
  });
  const base = [experiment('EXP-0001')];
  assert.equal(buildResearch({ experiments: base, luck: [luck()] }).luck.length, 1);
  const cases: readonly [string, Parameters<typeof buildResearch>[0]][] = [
    ['id repetido', { experiments: [...base, experiment('EXP-0001')], luck: [] }],
    ['criterio desconocido', { experiments: [experiment('EXP-0001', { criteria: { 'A.9.9': 'PASS' } })], luck: [] }],
    ['n_pruebas 0', { experiments: [experiment('EXP-0001', { trials: 0 })], luck: [] }],
    ['control de otro experimento', { experiments: base, luck: [luck({ experimentId: 'EXP-0002' })] }],
    ['longitudes distintas', { experiments: base, luck: [luck({ low: [99, 99] })] }],
    ['muestra corta', { experiments: base, luck: [luck({ samples: [[100]] })] }],
    ['p5 por encima del p95', { experiments: base, luck: [luck({ low: [102, 99, 99] })] }],
    ['percentil fuera de rango', { experiments: base, luck: [luck({ percentile: 101 })] }],
    ['valor no finito', { experiments: base, luck: [luck({ strategy: [100, Number.NaN, 102] })] }],
  ];
  for (const [name, input] of cases) assert.throws(() => buildResearch(input), DashboardError, name);
});
