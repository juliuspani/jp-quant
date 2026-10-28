// Todo run pasa por el Experiment Registry (paso 23): runExperiment con el DatasetPort real sobre un almacén de prueba, el
// ejecutor del backtester y un registro temporal. Datos sintéticos: nunca van al registro real. Desde el paso 27B, el
// ejecutor hace las variantes de robustez registradas y da el veredicto con los criterios congelados.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FROZEN_DOCUMENTS, WORST_CASE_INTRABAR, type CriteriaReport } from '../../../src/analytics/criteria.ts';
import { DatasetError, HistoricalDatasets } from '../../../src/app/datasets.ts';
import { CURVE_POINTS, CURVE_SAMPLES, type ControlCurves } from '../../../src/app/control-curves.ts';
import { dashboardHtml } from '../../../src/app/dashboard-command.ts';
import { journalCard } from '../../../src/app/experiment-artefacts.ts';
import { backtestRunner, RunnerError, type StrategyEntry } from '../../../src/app/research-runner.ts';
import { CostModelError } from '../../../src/backtest/costs.ts';
import { INTRABAR_POLICY } from '../../../src/backtest/intrabar.ts';
import { TEST_FINAL_START_UTC, TestFinalLockedError } from '../../../src/historical/guard.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { familyEvidence, reproduceExperiment, runExperiment, runnerKey, type ExperimentSpec, type ResearchContext, type RunInput } from '../../../src/research/experiment.ts';
import { readRegistry, RegistryError } from '../../../src/research/registry.ts';
import { chooseConfiguration } from '../../../src/analytics/selection.ts';
import { canonicalJson, sha256Hex } from '../../../src/shared/canonical.ts';
import { parseUtcIso, toUtcIso } from '../../../src/shared/time.ts';
import { fakeGit, tempRegistry } from '../research/helpers.ts';
import type { Strategy } from '../../../src/strategy/types.ts';
import { candles, CROSS, FEATURES, HOUR, T0, type CrossParams } from './scenario.ts';
import { CLOSES, storeFixture, type StoreFixture } from './store-fixture.ts';

/** El cruce sin su salida (ablación): solo sale por el stop. */
const NO_EXIT: Strategy<CrossParams> = { ...CROSS, evaluate: (input) => (input.position === null ? CROSS.evaluate(input) : { action: 'hold', reason: 'sin salida (ablación)' }) };

function crossParams(values: Readonly<Record<string, unknown>>): CrossParams {
  const stopFraction = values.stopFraction;
  if (typeof stopFraction !== 'number' || !(stopFraction > 0 && stopFraction < 1)) throw new RangeError('stopFraction en (0, 1)');
  return { stopFraction };
}

const ENTRY: StrategyEntry<CrossParams> = {
  strategy: CROSS,
  configure: (values) => ({ strategy: CROSS, params: crossParams(values), featureSet: FEATURES }),
  sensitivity: { integers: [], build: (values) => ({ strategy: CROSS, params: crossParams(values), featureSet: FEATURES }) },
  ablation: { components: ['salida-cruce'], build: (_component, values) => ({ strategy: NO_EXIT, params: crossParams(values), featureSet: FEATURES }) },
};
// Costes ×2, ×3 y retraso de una vela, stopFraction a ±25 % y ±50 % y la ablación de la salida; un solo símbolo, sin la
// variante del mejor activo, y sin universo alternativo salvo que se registre.
const VARIANTS = 3 + 4 + 1;
const TEST_CONTROLS = { simulations: 20, shifts: 5 };

const iso = (hours: number): string => toUtcIso(T0 + hours * HOUR);
let tick = 0;

function experiment(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    autor: 'prueba',
    familia: 'cruce-prueba',
    familia_nueva: true,
    hipotesis: 'el cruce con la media anticipa el sentido de la vela siguiente',
    metrica_primaria: 'rentabilidad neta por tramo',
    criterios: 'quant-research §9',
    estrategia: { nombre: CROSS.id, version: CROSS.version },
    datos: { fuente: 'sintético', dataset: 'prueba', version: 'full+q3', timeframe: '1h', rango: { desde: iso(0), hasta: iso(120) } },
    universo: { regla: 'fija', simbolos: ['BTC/EUR'] },
    particiones: {
      tramos: [
        { train: { desde: iso(0), hasta: iso(40) }, validation: { desde: iso(40), hasta: iso(80) } },
        { train: { desde: iso(40), hasta: iso(80) }, validation: { desde: iso(80), hasta: iso(120) } },
      ],
      test: null,
      purging_velas: 3,
      embargo_velas: 3,
    },
    costes: { comision: '0.0025', spread: '0.00075', slippage: '0.0005', multiplicador: 1 },
    parametros: { tipo: 'valores', valores: { stopFraction: 0.05 } },
    semilla: 7,
    variantes: VARIANTS,
    informe: null,
    notas: null,
    ...overrides,
  };
}

async function context(withSecondPair = false): Promise<ResearchContext> {
  const { datasets } = await storeFixture({ withScenario: true, withSecondPair });
  return {
    registryPath: tempRegistry(),
    git: fakeGit(),
    datasets,
    // Controles reducidos para que la prueba vaya deprisa: con menos de 1000 simulaciones, A.3.12 da NO CONCLUYENTE.
    runners: new Map([[runnerKey(CROSS.id, CROSS.version), backtestRunner(ENTRY, TEST_CONTROLS)]]),
    now: () => Date.UTC(2026, 9, 13) + 1000 * tick++,
  };
}

test('un backtest solo da resultado a través del registro: pre-registro, datos con su hash, tramos y cierre neto de costes', async () => {
  const ctx = await context();
  const { registered, closed } = await runExperiment(ctx, experiment());
  assert.equal(closed.estado, 'completado');
  assert.equal(registered.datos.hash, ctx.datasets.hash({ ...experiment().datos }));
  const metricas = closed.resultado?.metricas ?? {};
  assert.deepEqual(
    [metricas.comision, metricas.medio_spread, metricas.slippage_minimo, metricas.multiplicador_costes, metricas.tramos, metricas.detenido],
    ['0.0025', '0.00075', '0.0005', 1, 2, null],
  );
  assert.equal(metricas.libro_de_ordenes, 'sintético');
  assert.ok(typeof metricas.operaciones_cerradas === 'number' && metricas.operaciones_cerradas > 0, 'el escenario opera en los dos tramos');
  assert.ok(typeof metricas.comisiones_pagadas === 'string' && Number(metricas.comisiones_pagadas) > 0);
  assert.match(String(metricas.modelo_de_ejecucion), /^Sin datos de libro de órdenes: modelo sintético conservador/);
  // El primer tramo empieza antes de que la fuente traiga las bajas (hora 60): el sesgo queda declarado en el registro.
  assert.match(String(metricas.sesgo_de_supervivencia), /sesgo de supervivencia/);
  assert.equal(closed.resultado?.veredicto, 'RECHAZADA', 'dos tramos de validación: A.3.1 pide al menos tres');
  assert.equal(readRegistry(ctx.registryPath).experiments.size, 1);
});

test('reproducción exacta por id: los mismos datos, el mismo ejecutor y el mismo hash de salida', async () => {
  const ctx = await context();
  const { closed } = await runExperiment(ctx, experiment());
  const again = await reproduceExperiment(ctx, closed.id);
  assert.equal(again.hash_salida, closed.resultado?.hash_salida);
});

test('sin costes válidos para el backtester no hay resultado: el experimento se cierra como fallido y sigue contando', async () => {
  const ctx = await context();
  // 0,10 % vale para el registro (quant-research §5), pero no llega a la comisión taker de Bitvavo que exige el backtester.
  const { closed } = await runExperiment(ctx, experiment({ costes: { comision: '0.001', spread: '0.00075', slippage: '0.0005', multiplicador: 1 } })).then(
    () => assert.fail('debía fallar'),
    () => {
      const experiments = [...readRegistry(ctx.registryPath).experiments.values()];
      return { closed: experiments[0]?.closings[0] };
    },
  );
  assert.equal(closed?.estado, 'fallido');
  assert.match(closed?.notas ?? '', /CostModelError/);
});

test('el ejecutor se niega a un barrido, a datos que no son del DatasetPort, a otra estrategia y a un calentamiento sin datos', async () => {
  const { datasets } = await storeFixture({ withScenario: true });
  const spec = experiment();
  const { data } = await datasets.load(spec.datos);
  const input = (overrides: Partial<RunInput>): RunInput => ({
    familia: spec.familia,
    estrategia: spec.estrategia,
    datos: { ...spec.datos, hash: null },
    universo: spec.universo,
    particiones: spec.particiones,
    costes: spec.costes,
    parametros: spec.parametros as RunInput['parametros'],
    semilla: spec.semilla,
    variantes: VARIANTS,
    pruebas_familia: { n: 1 },
    data,
    ...overrides,
  });
  const runner = backtestRunner(ENTRY, TEST_CONTROLS);
  await assert.rejects(runner(input({ parametros: { tipo: 'rejilla', rejilla: { stopFraction: [0.05, 0.1] } } })), RunnerError);
  await assert.rejects(runner(input({ data: ['100', '101'] })), RunnerError);
  await assert.rejects(runner(input({ estrategia: { nombre: 'otra', version: '1.0.0' } })), RunnerError);
  const early = { tramos: [{ train: { desde: iso(0), hasta: iso(1) }, validation: { desde: iso(1), hasta: iso(40) } }], test: null, purging_velas: 0, embargo_velas: 0 };
  await assert.rejects(runner(input({ particiones: early })), RunnerError, 'tres velas de calentamiento antes de la hora 1 no existen');
  await assert.rejects(runner(input({ costes: { ...spec.costes, spread: '0.0001' } })), CostModelError);
  await assert.rejects(runner(input({ parametros: { tipo: 'valores', valores: { stopFraction: 2 } } })), RangeError);
  await assert.rejects(runner(input({ universo: { regla: 'fija', simbolos: ['BTC/USD'] } })), RunnerError, 'todas las métricas en EUR');
});

test('paso 26: el cierre lleva el informe de analytics en EUR, con el DSR del N del registro, los IC del bootstrap y el PBO en null', async () => {
  const ctx = await context();
  const first = await runExperiment(ctx, experiment());
  const second = await runExperiment(ctx, experiment({ familia_nueva: false, semilla: 8 }));
  const a = first.closed.resultado?.metricas ?? {};
  const b = second.closed.resultado?.metricas ?? {};
  assert.equal(a.moneda, 'EUR');
  // N sale del registro: cada experimento cuenta su configuración y sus variantes de robustez (paso 27B).
  assert.deepEqual([a.n_familia, b.n_familia], [1 + VARIANTS, 2 * (1 + VARIANTS)], 'N sale del registro');
  assert.ok(typeof a.sr0 === 'number' && a.sr0 > 0, 'con N > 1, SR₀ > 0');
  assert.equal(a.pbo, null);
  for (const key of ['sharpe_periodo', 'dsr', 'psr', 'pnl_neto', 'caida_maxima', 'beta', 'ic95_sharpe_anualizado_inferior', 'ic95_caida_maxima_superior']) {
    assert.equal(typeof a[key], 'number', key);
  }
  // La N de la familia es la de su línea de pre-registro; su V[SRₙ] ya no depende de otras pruebas (ADR 0039).
  assert.deepEqual(familyEvidence(second.registered), { n: 2 * (1 + VARIANTS) });
  assert.deepEqual(familyEvidence(first.registered), { n: 1 + VARIANTS }, 'lo posterior al pre-registro no cuenta');
  // La salida completa lleva el informe con sus desgloses; la reproducción da el mismo hash.
  const again = await reproduceExperiment(ctx, second.closed.id);
  assert.equal(again.hash_salida, second.closed.resultado?.hash_salida);
});

test('paso 27B: si las variantes registradas no son las que hará el ejecutor, el experimento falla y sigue contando en N', async () => {
  const ctx = await context();
  await assert.rejects(runExperiment(ctx, experiment({ variantes: 3 })), RunnerError);
  const [only] = [...readRegistry(ctx.registryPath).experiments.values()];
  assert.equal(only?.registered.n_pruebas, 1 + 3);
  assert.equal(only?.closings[0]?.estado, 'fallido');
  assert.match(only?.closings[0]?.notas ?? '', /declara 3 variantes de robustez y el ejecutor hará 8/);
});

test('paso 27B: el cierre da el veredicto de los criterios congelados, con cada criterio, su valor, su umbral y la huella de los documentos', async () => {
  const ctx = await context();
  const { registered, closed, salida } = await runExperiment(ctx, experiment());
  assert.equal(registered.n_pruebas, 1 + VARIANTS, 'las variantes cuentan en N');
  assert.equal(registered.variantes, VARIANTS);
  const metricas = closed.resultado?.metricas ?? {};
  assert.equal(metricas.variantes, VARIANTS);
  assert.equal(metricas.dsr_global, undefined, 'el DSR global se calcula en la decisión (ADR 0039)');
  const report = (salida as { criterios: CriteriaReport }).criterios;
  assert.deepEqual(report.documents, FROZEN_DOCUMENTS);
  assert.equal(closed.resultado?.veredicto, report.verdict);
  const status = Object.fromEntries(report.criteria.map((c) => [c.id, c.status]));
  for (const c of report.criteria) assert.equal(metricas[`criterio_${c.id}`], c.status);
  // Resultados conocidos de este escenario sintético (120 velas horarias de 2024, dos tramos, un símbolo):
  assert.equal(status['A.3.1'], 'FAIL', 'dos tramos de validación');
  assert.equal(status['A.3.5'], 'FAIL', 'pocas operaciones (y ningún bajista de 2018 ni 2022, que no se puede medir)');
  assert.equal(status['A.3.6'], 'NO CONCLUYENTE', 'una sola configuración');
  assert.equal(status['A.3.9'], 'NO CONCLUYENTE', 'la familia de prueba no tiene perfil');
  assert.equal(status['A.3.14'], 'NO CONCLUYENTE', 'sin universo alternativo pre-registrado');
  assert.equal(report.verdict, 'RECHAZADA');
  const value = (id: string, key: string): unknown => report.criteria.find((c) => c.id === id)?.value[key];
  assert.equal(typeof value('A.3.14', 'sharpe_sin_salida-cruce'), 'number', 'la ablación se ejecutó');
  // Con la exposición controlada (ADR 0037): su propio control aleatorio, y su exposición junto al Sharpe.
  assert.equal(typeof value('A.3.14', 'exceso_sin_salida-cruce'), 'number', 'exceso sobre su control aleatorio');
  assert.equal(typeof value('A.3.14', 'exceso_base'), 'number');
  const time = value('A.3.14', 'tiempo_en_mercado_sin_salida-cruce');
  assert.ok(typeof time === 'number' && time >= 0 && time <= 1, 'tiempo en mercado de la variante');
  assert.match(String(value('A.3.12', 'metodo')), /^(simulador|backtester)$/);
  // Cada variante de robustez se ejecutó: costes ×2 y ×3, retraso y las cuatro de stopFraction.
  assert.equal(typeof value('A.3.3', 'sharpe_costes_x2'), 'number');
  assert.equal(typeof value('A.3.3', 'sharpe_costes_x3'), 'number');
  assert.equal(typeof value('A.3.7', 'sharpe_retraso_una_vela'), 'number');
  for (const step of ['-50%', '-25%', '+25%', '+50%']) assert.equal(typeof value('A.3.8', `sharpe_stopFraction_${step}`), 'number', step);
  assert.equal(value('A.3.7', 'politica_dentro_de_la_vela'), WORST_CASE_INTRABAR);
  assert.equal(value('A.3.12', 'simulaciones'), TEST_CONTROLS.simulations);
  assert.equal(status['A.3.12'], 'NO CONCLUYENTE', 'menos de 1000 simulaciones nunca deciden');
  assert.equal(typeof value('A.3.15', 'senal_desplazada_mediana'), 'number');
  assert.match(report.criteria.find((c) => c.id === 'A.3.13')?.note ?? '', /un solo activo/);
  // La serie de la configuración va en la salida para la matriz del PBO de la ronda.
  const serie = (salida as { serie_configuracion: { fines: number[]; rendimientos: number[] } }).serie_configuracion;
  assert.equal(serie.fines.length, serie.rendimientos.length);
  assert.equal(serie.rendimientos.length, metricas.periodos);
  // La reproducción exige el mismo veredicto y el mismo hash.
  const again = await reproduceExperiment(ctx, closed.id);
  assert.equal(again.veredicto, 'RECHAZADA');
  assert.equal(again.hash_salida, closed.resultado?.hash_salida);
});

test('paso 27B: la política dentro de la vela del backtester es la de peor caso que exige A.3.7', () => {
  assert.equal(INTRABAR_POLICY, WORST_CASE_INTRABAR);
});

test('paso 27B: el universo alternativo pre-registrado se ejecuta y cuenta en N; tiene que ser disjunto del de diseño', async () => {
  const ctx = await context(true);
  const universo = { regla: 'fija', simbolos: ['BTC/EUR'], alternativos: ['ETH/EUR'] };
  const { registered, salida } = await runExperiment(ctx, experiment({ universo, variantes: VARIANTS + 1 }));
  assert.equal(registered.n_pruebas, 1 + VARIANTS + 1);
  const a314 = (salida as { criterios: CriteriaReport }).criterios.criteria.find((c) => c.id === 'A.3.14');
  assert.equal(a314?.value['universo_alternativo'], 'ETH/EUR');
  assert.equal(typeof a314?.value['sharpe_universo_alternativo'], 'number');
  await assert.rejects(runExperiment(ctx, experiment({ familia_nueva: false, universo, variantes: VARIANTS })), RunnerError, 'sin contar el alternativo');
  await assert.rejects(
    runExperiment(ctx, experiment({ familia_nueva: false, universo: { ...universo, alternativos: ['BTC/EUR'] }, variantes: VARIANTS + 1 })),
    RegistryError,
    'el alternativo no puede repetir el de diseño',
  );
});

// Paso 28 (ADR 0032): barrido con elección en train. La regla de prueba admite una rejilla de stopFraction.
const GRID_ENTRY: StrategyEntry<CrossParams> = {
  ...ENTRY,
  grid: (rejilla) => {
    if (Object.keys(rejilla).join() !== 'stopFraction') throw new RangeError('la rejilla de prueba solo tiene stopFraction');
  },
};
const GRID = { tipo: 'rejilla' as const, rejilla: { stopFraction: [0.02, 0.05, 0.3] } };
// Tres tramos: el tercero entrena sobre la validación del primero, así que su embargo se aplica.
const SWEEP_FOLDS = {
  tramos: [
    { train: { desde: iso(5), hasta: iso(30) }, validation: { desde: iso(30), hasta: iso(60) } },
    { train: { desde: iso(5), hasta: iso(60) }, validation: { desde: iso(60), hasta: iso(90) } },
    { train: { desde: iso(30), hasta: iso(90) }, validation: { desde: iso(90), hasta: iso(120) } },
  ],
  test: null,
  purging_velas: 3,
  embargo_velas: 4,
};

interface SweepOutput {
  readonly seleccion: {
    readonly configuraciones: readonly Record<string, unknown>[];
    readonly tramos: readonly {
      readonly train_desde: string;
      readonly train_hasta: string;
      readonly embargos: readonly unknown[];
      readonly sharpe_train: readonly (number | null)[];
      readonly elegida: number;
    }[];
  };
  readonly criterios: CriteriaReport;
  readonly serie_configuracion: { readonly fines: readonly number[]; readonly rendimientos: readonly number[] };
  readonly series_rejilla: readonly { readonly id: string; readonly fines: readonly number[]; readonly rendimientos: readonly number[] }[];
}

function sweepInput(spec: ExperimentSpec, parametros: RunInput['parametros'], data: unknown): RunInput {
  return {
    familia: spec.familia, estrategia: spec.estrategia, datos: { ...spec.datos, hash: null }, universo: spec.universo,
    particiones: SWEEP_FOLDS, costes: spec.costes, parametros, semilla: spec.semilla, variantes: VARIANTS,
    pruebas_familia: { n: 3 + VARIANTS }, data,
  };
}

test('paso 28: un barrido elige en el train de cada tramo, con purging y embargo, y mide lo elegido fuera de muestra', async () => {
  const ctx: ResearchContext = { ...(await context()), runners: new Map([[runnerKey(CROSS.id, CROSS.version), backtestRunner(GRID_ENTRY, TEST_CONTROLS)]]) };
  const { registered, closed, salida } = await runExperiment(ctx, experiment({ parametros: GRID, particiones: SWEEP_FOLDS }));
  assert.equal(registered.n_pruebas, 3 + VARIANTS, 'cada punto de la rejilla cuenta en N, más las variantes');
  const out = salida as SweepOutput;
  // Purging: el train acaba 3 velas antes; embargo: 4 velas tras la validación del primer tramo, dentro del tercer train.
  assert.deepEqual(out.seleccion.tramos.map((t) => [t.train_desde, t.train_hasta]), [[iso(5), iso(27)], [iso(5), iso(57)], [iso(30), iso(87)]]);
  assert.deepEqual(out.seleccion.tramos.map((t) => t.embargos), [[], [], [{ desde: iso(60), hasta: iso(64) }]]);
  assert.deepEqual(out.seleccion.configuraciones, [{ stopFraction: 0.02 }, { stopFraction: 0.05 }, { stopFraction: 0.3 }]);
  const metricas = closed.resultado?.metricas ?? {};
  assert.equal(metricas.configuraciones, 3);
  for (const [i, t] of out.seleccion.tramos.entries()) {
    assert.equal(t.sharpe_train.length, 3);
    assert.equal(t.elegida, chooseConfiguration(t.sharpe_train), `tramo ${String(i)}: el mejor en train`);
    assert.equal(metricas[`tramo_${String(i)}_elegida`], canonicalJson(out.seleccion.configuraciones[t.elegida]));
  }
  // La serie fuera de muestra es, periodo a periodo, la del punto elegido en cada tramo.
  assert.equal(out.series_rejilla.length, 3);
  const foldOfPeriod = (at: number): number => SWEEP_FOLDS.tramos.findIndex((f) => at > Date.parse(f.validation.desde) && at <= Date.parse(f.validation.hasta) + HOUR);
  out.serie_configuracion.fines.forEach((at, k) => {
    const chosen = out.series_rejilla[out.seleccion.tramos[foldOfPeriod(at)]?.elegida ?? -1];
    const j = chosen?.fines.indexOf(at) ?? -1;
    assert.ok(j >= 0, `periodo ${String(k)} en la serie del elegido`);
    assert.equal(out.serie_configuracion.rendimientos[k], chosen?.rendimientos[j]);
  });
  // A.3.6 con todos los puntos de la rejilla; entre familias, pendiente de la matriz de la ronda. A.3.8 mide la estabilidad.
  const a36 = out.criterios.criteria.find((c) => c.id === 'A.3.6');
  assert.equal(typeof a36?.value['pbo_familia'], 'number');
  assert.equal(a36?.value['configuraciones_familia'], 3);
  assert.equal(a36?.value['pbo_global'], null);
  assert.match(a36?.note ?? '', /matriz de la ronda/);
  assert.notEqual(a36?.status, 'PASS', 'sin la matriz entre familias, A.3.6 no pasa');
  assert.equal(metricas.pbo, a36?.value['pbo_familia']);
  assert.equal(typeof out.criterios.criteria.find((c) => c.id === 'A.3.8')?.value['estabilidad_barrido_stopFraction'], 'number');
  const again = await reproduceExperiment(ctx, closed.id);
  assert.equal(again.hash_salida, closed.resultado?.hash_salida);
});

async function sweepSelection(closes: readonly number[]): Promise<SweepOutput['seleccion']> {
  const store = await storeFixture();
  const all = candles(closes);
  await store.write('prueba-xbteur-1h-full', all.filter((c) => c.openTime < T0 + 80 * HOUR));
  await store.write('prueba-xbteur-1h-q3', all.filter((c) => c.openTime >= T0 + 80 * HOUR));
  const spec = experiment({ parametros: GRID, particiones: SWEEP_FOLDS });
  const { data } = await store.datasets.load(spec.datos);
  const output = await backtestRunner(GRID_ENTRY, TEST_CONTROLS)(sweepInput(spec, GRID, data));
  return (output.salida as SweepOutput).seleccion;
}

test('paso 28, sin fugas: cambiar las velas de validación o las purgadas no cambia lo elegido en los train anteriores', async () => {
  const base = await sweepSelection(CLOSES);
  const late = await sweepSelection(CLOSES.map((c, i) => (i >= 90 ? c * 1.3 + 5 * Math.sin(i) : c)));
  assert.deepEqual(late.tramos, base.tramos, 'la última validación no la ve ningún train');
  // Las velas 57 a 59 son las purgadas del segundo train y las 60 a 89, su validación: los dos primeros tramos no cambian.
  const middle = await sweepSelection(CLOSES.map((c, i) => (i >= 57 && i < 90 ? c * 0.8 + 3 * Math.cos(i) : c)));
  assert.deepEqual(middle.tramos.slice(0, 2), base.tramos.slice(0, 2));
  assert.notDeepEqual(middle.tramos[2]?.sharpe_train, base.tramos[2]?.sharpe_train, 'el tercer train sí entrena sobre ellas');
});

test('paso 28: el ejecutor se niega a una rejilla de más de 20 puntos y a un barrido que la estrategia no admite', async () => {
  const { datasets } = await storeFixture({ withScenario: true });
  const spec = experiment({ parametros: GRID, particiones: SWEEP_FOLDS });
  const { data } = await datasets.load(spec.datos);
  const run = (entry: StrategyEntry<CrossParams>, parametros: RunInput['parametros']): Promise<unknown> => backtestRunner(entry, TEST_CONTROLS)(sweepInput(spec, parametros, data));
  const big = { tipo: 'rejilla' as const, rejilla: { stopFraction: Array.from({ length: 21 }, (_, i) => 0.01 + i / 100) } };
  await assert.rejects(run(GRID_ENTRY, big), RunnerError);
  await assert.rejects(run(ENTRY, GRID), RunnerError, 'sin grid, la estrategia no admite barridos');
  await assert.rejects(run(GRID_ENTRY, { tipo: 'rejilla', rejilla: { otro: [1, 2] } }), RangeError, 'la estrategia rechaza la rejilla');
});

// Paso 31 (ADR 0044): un experimento que solo elige en train, con un tramo más cuya validación cae fuera de los datos.
test('paso 31: solo elegir repite la elección del barrido, no mide ninguna validación, no da veredicto y se reproduce', async () => {
  const ctx: ResearchContext = { ...(await context()), runners: new Map([[runnerKey(CROSS.id, CROSS.version), backtestRunner(GRID_ENTRY, TEST_CONTROLS)]]) };
  const sweep = await runExperiment(ctx, experiment({ parametros: GRID, particiones: SWEEP_FOLDS }));
  // Los datos llegan a la hora 120; con purging de 3 velas, lo que puntúa de este train también.
  const forward = { train: { desde: iso(60), hasta: iso(123) }, validation: { desde: iso(123), hasta: iso(150) } };
  const { registered, closed, salida } = await runExperiment(ctx, experiment({
    familia_nueva: false, parametros: GRID, variantes: 0, solo_eleccion: true, particiones: { ...SWEEP_FOLDS, tramos: [...SWEEP_FOLDS.tramos, forward] },
  }));
  assert.equal(registered.solo_eleccion, true);
  assert.equal(registered.n_pruebas, 3, 'cada punto de la rejilla cuenta en N, y no hay variantes');
  assert.equal(closed.estado, 'completado');
  assert.equal(closed.resultado?.veredicto, null);
  const { seleccion } = salida as Pick<SweepOutput, 'seleccion'>;
  assert.deepEqual(seleccion.tramos.slice(0, 3), (sweep.salida as SweepOutput).seleccion.tramos, 'los tramos del barrido eligen igual');
  const last = seleccion.tramos[3] ?? assert.fail('falta el tramo de más');
  assert.deepEqual([last.train_desde, last.train_hasta], [iso(60), iso(120)], 'el purging deja fuera las 3 últimas velas del train');
  assert.deepEqual(last.embargos, [{ desde: iso(90), hasta: iso(94) }], 'el embargo tras la validación del segundo tramo');
  assert.equal(last.elegida, chooseConfiguration(last.sharpe_train));
  const metricas = closed.resultado?.metricas ?? {};
  assert.equal(metricas.tramo_3_elegida, canonicalJson(seleccion.configuraciones[last.elegida] ?? assert.fail('elegida fuera de la rejilla')));
  for (const measured of ['sharpe_anualizado', 'operaciones_cerradas', 'caida_maxima']) assert.ok(!(measured in metricas), `no mide la validación: ${measured}`);
  const again = await reproduceExperiment(ctx, closed.id);
  assert.equal(again.hash_salida, closed.resultado?.hash_salida);
});

// Paso 31 (ADR 0044): solo elegir nunca lee nada posterior a researchDataEndUtc. Va con fechas reales, porque la guarda
// fija en el código que el test final empieza el 2026-10-01; el último tramo valida en el test final, con sus datos en disco.
const RESEARCH_DATA_END = parseUtcIso('2026-09-30T23:59:59Z'); // researchDataEndUtc del candado (ADR 0019, anexo A)

test('paso 31: solo elegir nunca lee datos posteriores a researchDataEndUtc, aunque su último tramo valide en el test final', async () => {
  const start = parseUtcIso(TEST_FINAL_START_UTC);
  // El escenario, movido para que su última vela se reciba justo antes del test final: abre el 30 a las 22:00 y se recibe
  // a las 23:01. La de las 23:00 ya se recibe el 1 de octubre.
  const from = start - 121 * HOUR;
  const moved = (list: readonly HistoricalCandle[], to: number): HistoricalCandle[] =>
    list.map((c) => ({ ...c, openTime: c.openTime - T0 + to, closeTime: c.closeTime - T0 + to, receivedTime: c.receivedTime - T0 + to }));
  const period = moved(candles(Array.from({ length: 48 }, (_, i) => 1000 + 50 * Math.sin(i / 3))), start - HOUR);
  const coverage = { delistingsFrom: from + 60 * HOUR, activeSince: from + 119 * HOUR, end: start };
  async function store(periodData: 'ninguno' | 'protegido' | 'en investigación'): Promise<StoreFixture> {
    const s = await storeFixture();
    const btc = moved(candles(CLOSES), from);
    await s.write('prueba-xbteur-1h-full', btc.filter((c) => c.openTime < from + 80 * HOUR));
    await s.write('prueba-xbteur-1h-q3', btc.filter((c) => c.openTime >= from + 80 * HOUR));
    await s.write('prueba-oldeur-1h-full', moved(candles(CLOSES.slice(0, 30)), from).map((c) => ({ ...c, symbol: 'OLD/EUR' })));
    if (periodData === 'protegido') await s.writeTestFinal('prueba-xbteur-1h-q4', period);
    if (periodData === 'en investigación') await s.write('prueba-xbteur-1h-q4', period); // mal colocado, sin pasar por la guarda
    return s;
  }
  let latest = Number.NEGATIVE_INFINITY; // el instante más tardío que llega a ver la estrategia
  const spy: Strategy<CrossParams> = {
    ...CROSS,
    evaluate: (input) => {
      latest = Math.max(latest, input.asOf, input.features.computedAt);
      return CROSS.evaluate(input);
    },
  };
  const entry: StrategyEntry<CrossParams> = { ...GRID_ENTRY, strategy: spy, configure: (values) => ({ strategy: spy, params: crossParams(values), featureSet: FEATURES }) };
  const contextOf = (s: StoreFixture, end = coverage.end): ResearchContext => ({
    registryPath: tempRegistry(),
    git: fakeGit(),
    datasets: new HistoricalDatasets({ guard: s.guard, researchRoot: s.paths.researchRoot, coverage: { ...coverage, end } }),
    runners: new Map([[runnerKey(CROSS.id, CROSS.version), backtestRunner(entry, TEST_CONTROLS)]]),
    now: () => Date.UTC(2026, 9, 13) + 1000 * tick++,
  });
  const at = (hours: number): string => toUtcIso(from + hours * HOUR);
  const spec = (hasta: string, version = 'full+q3'): ExperimentSpec => experiment({
    datos: { fuente: 'sintético', dataset: 'prueba', version, timeframe: '1h', rango: { desde: at(0), hasta } },
    parametros: GRID,
    variantes: 0,
    solo_eleccion: true,
    particiones: {
      tramos: [
        { train: { desde: at(5), hasta: at(60) }, validation: { desde: at(60), hasta: at(120) } },
        // Lo que puntúa de este train acaba donde empieza el test final (purging de 3 velas), y su validación es el test final.
        { train: { desde: at(60), hasta: toUtcIso(start + 3 * HOUR) }, validation: { desde: toUtcIso(start + 3 * HOUR), hasta: toUtcIso(start + 48 * HOUR) } },
      ],
      test: null,
      purging_velas: 3,
      embargo_velas: 4,
    },
  });

  // (a) Con los datos del periodo en su carpeta protegida, no se leen: la estrategia no ve nada recibido después de
  // researchDataEndUtc, y la elección es exactamente la misma que sin ellos.
  const protectedRun = await runExperiment(contextOf(await store('protegido')), spec(TEST_FINAL_START_UTC));
  assert.equal(protectedRun.closed.estado, 'completado');
  assert.ok(latest > Number.NEGATIVE_INFINITY, 'la estrategia evalúa velas de investigación');
  assert.ok(latest <= RESEARCH_DATA_END, `la estrategia vio el ${toUtcIso(latest)}`);
  const { seleccion } = protectedRun.salida as Pick<SweepOutput, 'seleccion'>;
  assert.equal(seleccion.tramos[1]?.train_hasta, toUtcIso(start), 'lo que puntúa del último train acaba donde empieza el test final');
  const withoutPeriod = await runExperiment(contextOf(await store('ninguno')), spec(TEST_FINAL_START_UTC));
  assert.equal(withoutPeriod.closed.resultado?.hash_salida, protectedRun.closed.resultado?.hash_salida, 'los datos del periodo en disco no cambian nada');

  // (b) Un rango registrado que pasa del inicio del test final no llega a registrarse: se niega antes de leer nada.
  const refused = contextOf(await store('ninguno'));
  await assert.rejects(runExperiment(refused, spec(toUtcIso(start + 3 * HOUR))), DatasetError);
  assert.equal(readRegistry(refused.registryPath).experiments.size, 0);

  // (c) Ni con velas del periodo mal colocadas en investigación y una regla del universo que lo dejaría: la guarda corta
  // antes de que la estrategia vea nada, y el intento queda en el registro como fallido, contando en N.
  latest = Number.NEGATIVE_INFINITY;
  const leaky = contextOf(await store('en investigación'), start + 48 * HOUR);
  await assert.rejects(runExperiment(leaky, spec(toUtcIso(start + 3 * HOUR), 'full+q3+q4')), TestFinalLockedError);
  assert.equal(latest, Number.NEGATIVE_INFINITY, 'la estrategia no ve ninguna vela');
  assert.deepEqual(readRegistry(leaky.registryPath).experiments.get('EXP-0001')?.closings.map((c) => c.estado), ['fallido']);
});

test('paso 41C: las curvas del control de A.3.12 y el diario de cada tramo van aparte, con su huella en la salida', async () => {
  const ctx = await context();
  const { closed, salida, artefactos } = await runExperiment(ctx, experiment());
  assert.ok(artefactos !== null);
  const files = (salida as { archivos: { controles: { sha256: string | null; motivo: string | null }; diarios_sha256: string[] } }).archivos;
  const report = (salida as { criterios: CriteriaReport }).criterios;
  const control = report.criteria.find((c) => c.id === 'A.3.12')?.value;
  const curves = artefactos.controles as ControlCurves | null;
  if (control?.['metodo'] === 'simulador') {
    // Las mismas colocaciones que midió A.3.12: mismo número, y su huella en la salida.
    assert.ok(curves !== null);
    assert.equal(curves.simulaciones, control['simulaciones']);
    assert.equal(sha256Hex(canonicalJson(curves)), files.controles.sha256);
    assert.equal(files.controles.motivo, null);
    assert.equal(curves.estrategia[0], 100, 'base 100');
    assert.ok(curves.estrategia.length <= CURVE_POINTS && curves.p05.length === curves.estrategia.length && curves.p95.length === curves.estrategia.length);
    assert.equal(curves.muestras.length, Math.min(CURVE_SAMPLES, TEST_CONTROLS.simulations));
    assert.ok(curves.p05.every((v, i) => v <= (curves.p95[i] ?? -Infinity)));
    assert.ok(curves.percentil >= 0 && curves.percentil <= 100);
  } else {
    assert.equal(curves, null, 'con el backtester, las curvas del simulador no representarían A.3.12');
    assert.equal(files.controles.sha256, null);
    assert.match(files.controles.motivo ?? '', /simulador|control/);
  }
  // Un diario por tramo, con su huella, el hash del motor en la cabecera y los parámetros con que se ejecutó.
  const tramos = (salida as { tramos: { diario_sha256: string }[] }).tramos;
  assert.equal(artefactos.diarios.length, tramos.length);
  artefactos.diarios.forEach((journal, i) => {
    assert.equal(sha256Hex(journal.texto), files.diarios_sha256[i]);
    assert.equal((JSON.parse(journal.texto.split('\n')[0] ?? '{}') as { journalSha256?: string }).journalSha256, tramos[i]?.diario_sha256);
    assert.deepEqual(journal.parametros, { stopFraction: 0.05 });
  });
  // El dashboard lo lee tal cual, con la ficha que se escribe a su lado.
  const first = artefactos.diarios[0];
  assert.ok(first !== undefined);
  const page = dashboardHtml(first.texto, journalCard(closed.id, 0, experiment(), first.parametros));
  assert.ok(page.includes(`${closed.id} · tramo 0`));
  assert.ok(!page.includes('DATOS DE DEMOSTRACIÓN'), 'datos reales: sin marca de demostración');
  // La reproducción da la misma salida, también las huellas de los archivos.
  const again = await reproduceExperiment(ctx, closed.id);
  assert.equal(again.hash_salida, closed.resultado?.hash_salida);
});
