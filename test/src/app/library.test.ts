// Paso 25 (ADR 0028): las estrategias de la biblioteca sobre el sistema compuesto. Camino completo Data → Features →
// Strategy → Risk → Execution → Fill → Portfolio sobre un paseo aleatorio, y su alta como ejecutores de investigación.
// Datos sintéticos: no cuentan como pruebas del registro (quant-research §10) ni dicen nada de la ventaja.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runBacktest } from '../../../src/app/backtest.ts';
import { robustnessPlan } from '../../../src/app/criteria-evidence.ts';
import { libraryRunners } from '../../../src/app/research-runner.ts';
import { runnerKey, type ExperimentSpec } from '../../../src/research/experiment.ts';
import { gridPoints } from '../../../src/research/registry.ts';
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import type { StrategyKit } from '../../../src/strategy/baselines.ts';
import {
  acceptedParams, LibraryParamsError, literatureGrid, literatureParams, MAX_GRID_CONFIGURATIONS, STRATEGY_LIBRARY, variantParams, type LibraryEntry,
} from '../../../src/strategy/library.ts';
import { traceOrders } from './trace.ts';
import { kitSpec, walkCandles, walkCloses } from './walk.ts';

const SPECS = resolve(import.meta.dirname, '..', '..', '..', 'docs', 'research', 'experiments', 'specs');

// Velas horarias del paseo: las reglas no dependen del marco, solo del número de velas.
function kitOf<P extends object>(entry: LibraryEntry<P>): StrategyKit<P> {
  return entry.build(entry.literatura, '1h');
}

function checkPipeline<P>(kit: StrategyKit<P>, closes: readonly number[]): void {
  const name = kit.strategy.id;
  const result = runBacktest(kitSpec(kit, walkCandles(closes), 1));
  assert.equal(result.halted, null, name);
  assert.equal(result.journal.filter((e) => e.type === 'StrategyEvaluated').length, closes.length - kit.strategy.warmupBars, `${name}: una evaluación por vela`);
  // Strategy → Risk → Execution → Fill: cada orden tiene intención, decisión aprobada y token previos.
  const orders = traceOrders(result.journal);
  const fills = orders.flatMap((o) => o.fills);
  assert.ok(result.metrics.closedTrades >= 2, `${name}: entra y sale (${String(result.metrics.closedTrades)} operaciones)`);
  assert.equal(fills.length, result.metrics.fills, `${name}: todos los fills están en el diario`);
  assert.ok(orders.every((o) => o.intent.strategyId === name));
  // Fill → Portfolio: la caja cuadra con los fills y sus comisiones.
  let cash = Decimal.parse('1000');
  for (const fill of fills) {
    const notional = fill.quantity.times(fill.price);
    cash = fill.side === 'buy' ? cash.minus(notional).minus(fill.fee) : cash.plus(notional).minus(fill.fee);
  }
  const last = result.equityCurve.at(-1);
  assert.ok(last !== undefined);
  if (result.metrics.openPositions === 0) assert.equal(last.equity, cash.toString(), `${name}: sin posiciones, patrimonio = caja`);
  assert.ok(result.performance.totalCosts > 0, `${name}: paga costes`);
}

test('camino completo para las dos familias: cada orden pasa por Risk y la cartera cuadra con los fills', () => {
  const closes = walkCloses(25, 1500, 0.01);
  checkPipeline(kitOf(STRATEGY_LIBRARY.trendFollowing), closes);
  checkPipeline(kitOf(STRATEGY_LIBRARY.meanReversion), closes);
});

test('ejecutores de investigación: las dos estrategias de la biblioteca, por nombre@versión', () => {
  const { trendFollowing, meanReversion } = STRATEGY_LIBRARY;
  assert.deepEqual(
    [...libraryRunners().keys()].sort(),
    [runnerKey(trendFollowing.id, trendFollowing.version), runnerKey(meanReversion.id, meanReversion.version)].sort(),
  );
});

function checkSpec<P extends object>(entry: LibraryEntry<P>): void {
  const file = resolve(SPECS, `${entry.id}-${entry.version}.json`);
  const spec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(spec.estrategia, { nombre: entry.id, version: entry.version }, file);
  assert.equal(spec.familia, entry.familia, `${file}: la familia de la biblioteca`);
  assert.equal(spec.familia_nueva, false, `${file}: la familia ya existe y no se abre otra`);
  const datos = spec.datos as { timeframe: string };
  assert.equal(datos.timeframe, entry.timeframe, `${file}: el marco de la literatura`);
  const parametros = spec.parametros as { tipo: string; valores: Record<string, unknown> };
  assert.equal(parametros.tipo, 'valores', `${file}: sin barridos`);
  assert.deepEqual(literatureParams(entry, parametros.valores), entry.literatura, `${file}: los parámetros de la literatura`);
}

test('especificaciones del primer experimento: familia existente, marco y parámetros de la literatura', () => {
  checkSpec(STRATEGY_LIBRARY.trendFollowing);
  checkSpec(STRATEGY_LIBRARY.meanReversion);
});

test('paso 27B: las variantes de sensibilidad construyen la regla con otros valores; los enteros declarados son los periodos', () => {
  const { trendFollowing, meanReversion } = STRATEGY_LIBRARY;
  assert.deepEqual(trendFollowing.enteros, ['entryPeriod', 'exitPeriod', 'atrPeriod']);
  assert.deepEqual(meanReversion.enteros, ['trendPeriod', 'rsiPeriod', 'exitPeriod', 'atrPeriod']);
  for (const entry of [trendFollowing, meanReversion] as const) {
    for (const key of entry.enteros) assert.ok(Number.isSafeInteger((entry.literatura as Readonly<Record<string, unknown>>)[key]), `${entry.id}: ${key}`);
  }
  const variant = variantParams(trendFollowing, { entryPeriod: 69, exitPeriod: 20, atrPeriod: 20, stopAtr: 2 });
  assert.equal(trendFollowing.build(variant, '1d').featureSet.features.some((f) => f.id === 'donchmax_69'), true);
  assert.throws(() => literatureParams(trendFollowing, { ...variant }), LibraryParamsError, 'el experimento sigue registrando los de la literatura');
  assert.throws(() => variantParams(trendFollowing, { entryPeriod: 69, exitPeriod: 20, atrPeriod: 20 }), LibraryParamsError);
  assert.throws(() => variantParams(trendFollowing, { entryPeriod: '69', exitPeriod: 20, atrPeriod: 20, stopAtr: 2 }), LibraryParamsError);
  // RSI de 1: la variante se construye y la regla la rechaza al construirse (queda sin medir, no se inventa un valor).
  assert.throws(() => meanReversion.build(variantParams(meanReversion, { ...meanReversion.literatura, rsiPeriod: 1 }), '1d'), RangeError);
});

test('paso 28: la rejilla de la tendencia es la de los Turtle, cabe en el límite y solo se admite tal cual', () => {
  const { trendFollowing, meanReversion } = STRATEGY_LIBRARY;
  const grid = { atrPeriod: [20], entryPeriod: [20, 55], exitPeriod: [10, 20], stopAtr: [2] };
  assert.deepEqual(trendFollowing.rejilla?.valores, grid);
  literatureGrid(trendFollowing, grid);
  assert.throws(() => literatureGrid(trendFollowing, { ...grid, entryPeriod: [55, 20] }), LibraryParamsError, 'en el mismo orden');
  assert.throws(() => literatureGrid(trendFollowing, { ...grid, entryPeriod: [20, 40, 55] }), LibraryParamsError);
  assert.throws(() => literatureGrid(trendFollowing, { entryPeriod: [20, 55] }), LibraryParamsError);
  assert.throws(() => literatureGrid(meanReversion, { rsiEntry: [5, 10] }), LibraryParamsError, 'la rejilla de la reversión tiene otras claves');
  literatureGrid(meanReversion, { atrPeriod: [20], exitPeriod: [5], rsiEntry: [2, 5, 10], rsiPeriod: [2], stopAtr: [2], trendPeriod: [200] });
  const points = gridPoints({ tipo: 'rejilla', rejilla: grid });
  assert.ok(points.length <= MAX_GRID_CONFIGURATIONS);
  assert.ok(points.some((p) => canonicalJson(p) === canonicalJson(trendFollowing.literatura)), 'el sistema 2 es un punto de la rejilla');
  // Cada punto se admite y monta su regla, con sus propias features; fuera de la rejilla, solo la literatura.
  for (const point of points) {
    const kit = trendFollowing.build(acceptedParams(trendFollowing, point), '1d');
    assert.ok(kit.featureSet.features.some((f) => f.id === `donchmax_${String(point['entryPeriod'])}`));
  }
  assert.throws(() => acceptedParams(trendFollowing, { entryPeriod: 40, exitPeriod: 10, atrPeriod: 20, stopAtr: 2 }), LibraryParamsError);
  assert.deepEqual(acceptedParams(meanReversion, meanReversion.literatura), meanReversion.literatura);
});

function checkGridSpec<P extends object>(entry: LibraryEntry<P>, variants: number, horizon: number): void {
  const file = resolve(SPECS, `${entry.id}-${entry.version}-rejilla.json`);
  const spec = JSON.parse(readFileSync(file, 'utf8')) as ExperimentSpec;
  assert.deepEqual(spec.estrategia, { nombre: entry.id, version: entry.version });
  assert.deepEqual([spec.familia, spec.familia_nueva, spec.datos.timeframe], [entry.familia, false, entry.timeframe]);
  assert.equal(spec.parametros.tipo, 'rejilla');
  if (spec.parametros.tipo !== 'rejilla') return;
  literatureGrid(entry, spec.parametros.rejilla);
  const [first] = gridPoints(spec.parametros);
  const alternatives = spec.universo.alternativos ?? [];
  const plan = robustnessPlan({ values: first ?? {}, integers: entry.enteros, symbols: spec.universo.simbolos, components: entry.componentes, alternatives });
  assert.equal(spec.variantes, plan.total, 'las variantes registradas son las que hará el ejecutor');
  assert.equal(spec.variantes, variants);
  assert.ok(alternatives.length > 0 && alternatives.every((s) => !spec.universo.simbolos.includes(s)), 'universo alternativo disjunto');
  // Purging y embargo fijados en el pre-registro, con e ≥ h.
  const { particiones } = spec;
  assert.deepEqual([particiones.purging_velas, particiones.embargo_velas], [horizon, horizon]);
  assert.equal(particiones.test, null, 'el test final no se abre');
  // Los bajistas de 2018 y 2022 caen enteros en validación, y el último tramo acaba antes del test final.
  const validations = particiones.tramos.map((t) => t.validation);
  for (const year of ['2018', '2022']) assert.ok(validations.some((v) => v.desde === `${year}-01-01T00:00:00Z` && v.hasta === `${String(Number(year) + 1)}-01-01T00:00:00Z`), year);
  assert.ok(Date.parse(validations.at(-1)?.hasta ?? '') <= Date.parse('2026-10-01T00:00:00Z'));
  // El calentamiento del primer train cabe en el rango de datos.
  const kit = entry.build(acceptedParams(entry, first ?? {}), '1d');
  assert.ok(Date.parse(particiones.tramos[0]?.train.desde ?? '') - kit.strategy.warmupBars * 86_400_000 >= Date.parse(spec.datos.rango.desde));
}

test('paso 28: las especificaciones de los barridos usan la rejilla de la biblioteca y declaran lo que hará el ejecutor', () => {
  checkGridSpec(STRATEGY_LIBRARY.trendFollowing, 3 + 16 + 1 + 1 + 1, 55);
  checkGridSpec(STRATEGY_LIBRARY.meanReversion, 3 + 24 + 1 + 2 + 1, 20);
});
