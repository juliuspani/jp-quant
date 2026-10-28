// Evidencia de los criterios (paso 27B, ADR 0031): el plan de variantes que cuentan en N, el paso de un backtest al
// simulador del control aleatorio y las velas barajadas de la prueba de humo. Datos sintéticos de resultado conocido.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../../../src/app/backtest.ts';
import {
  controlInputs, randomControlOf, robustnessPlan, STRESS_VARIANTS, stressRun, type FoldRun, type KitVariant, type RunOptions,
} from '../../../src/app/criteria-evidence.ts';
import { shuffledCandles } from '../../../src/app/smoke-data.ts';
import { periodsPerYear } from '../../../src/analytics/performance.ts';
import { seededRng } from '../../../src/kernel/random.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { baseline } from '../../../src/strategy/baselines.ts';
import { HOUR, T0 } from './scenario.ts';
import { kitSpec, walkCandles, walkCloses } from './walk.ts';

test('plan de robustez: 3 de estrés, 4 por parámetro numérico, 1 sin el mejor activo, 1 por componente y 1 con el universo alternativo', () => {
  assert.equal(STRESS_VARIANTS, 3);
  const values = { entryPeriod: 55, exitPeriod: 20, stopAtr: 2, salida: 'canal' };
  const plan = (integers: readonly string[] | null, symbols: readonly string[], components: readonly string[] | null = null, alternatives: readonly string[] = []) =>
    robustnessPlan({ values, integers, symbols, components, alternatives });
  assert.equal(plan(['entryPeriod', 'exitPeriod'], ['BTC/EUR']).total, 3 + 3 * 4);
  const two = plan(['entryPeriod', 'exitPeriod'], ['BTC/EUR', 'ETH/EUR']);
  assert.deepEqual([two.total, two.bestAsset, two.sensitivity.length], [3 + 12 + 1, true, 12]);
  assert.equal(plan(null, ['BTC/EUR']).total, 3, 'sin constructor de variantes no hay sensibilidad que contar');
  assert.equal(plan(null, ['BTC/EUR'], ['salida-canal'], ['SOL/EUR', 'ADA/EUR']).total, 3 + 1 + 1);
  // Las dos estrategias de la biblioteca, con su universo de dos pares, su ablación y un universo alternativo.
  const library = (v: Readonly<Record<string, unknown>>, components: readonly string[]) =>
    robustnessPlan({ values: v, integers: [], symbols: ['BTC/EUR', 'ETH/EUR'], components, alternatives: ['SOL/EUR'] }).total;
  assert.equal(library({ entryPeriod: 55, exitPeriod: 20, atrPeriod: 20, stopAtr: 2 }, ['salida-canal']), 3 + 16 + 1 + 1 + 1);
  assert.equal(library({ trendPeriod: 200, rsiPeriod: 2, rsiEntry: 10, exitPeriod: 5, atrPeriod: 20, stopAtr: 2 }, ['filtro-tendencia', 'salida-media']), 3 + 24 + 1 + 2 + 1);
});

function fold(): FoldRun {
  const candles = walkCandles(walkCloses(4, 300));
  const kit = baseline({ emaPeriod: 10, stopFraction: 0.5 }, '1h');
  const result = runBacktest(kitSpec(kit, candles, 1));
  return { from: T0 + kit.strategy.warmupBars * HOUR, to: T0 + 300 * HOUR, result, survivorshipBias: null };
}

test('del backtest al control aleatorio: cada operación ocupa los periodos entre sus marcas, con la fracción invertida al abrir', () => {
  const f = fold();
  const candles = walkCandles(walkCloses(4, 300));
  const { market, trades } = controlInputs([f], candles, ['BTC/EUR'], 0.004, periodsPerYear('1h'), 3 * HOUR);
  const curve = f.result.analysis.curve;
  assert.equal(market.folds[0]?.bars, curve.length);
  assert.ok(trades.length >= f.result.roundTrips.length - 1 && trades.length > 3, `${String(trades.length)} operaciones`);
  for (const t of trades) {
    assert.ok(t.start >= 0 && t.start + t.bars <= curve.length - 1);
    assert.ok(t.fraction > 0 && t.fraction <= 1, `fracción ${String(t.fraction)}`);
  }
  // Los precios del simulador son los cierres de las velas en cada marca.
  const prices = market.folds[0]?.prices.get('BTC/EUR') ?? [];
  const last = candles.filter((c) => c.closeTime <= (curve[5]?.at ?? 0)).at(-1);
  assert.equal(prices[5], last?.close.toAnalysis());
  const s = stressRun([f], periodsPerYear('1h'));
  assert.equal(s.netPnl, Decimal.parse(f.result.metrics.endEquity).toAnalysis() - 1000);
});

test('velas barajadas: misma forma de cada vela, en otro orden; mismas marcas de tiempo, mismo precio final y deterministas por semilla', () => {
  const candles = walkCandles(walkCloses(9, 200));
  const shuffled = shuffledCandles(candles, seededRng(1, 'paseo'));
  assert.equal(shuffled.length, candles.length);
  assert.deepEqual(shuffled.map((c) => c.openTime), candles.map((c) => c.openTime));
  assert.deepEqual(shuffled[0], candles[0], 'la primera ancla el camino');
  const ratios = (cs: typeof candles): number[] => cs.slice(1).map((c, i) => c.close.toAnalysis() / (cs[i]?.close.toAnalysis() ?? 1)).sort((a, b) => a - b);
  const a = ratios(candles);
  const b = ratios(shuffled);
  for (const [i, r] of a.entries()) assert.ok(Math.abs(r - (b[i] ?? 0)) < 1e-6, `rentabilidad ${String(i)}`);
  assert.ok(Math.abs((shuffled.at(-1)?.close.toAnalysis() ?? 0) - (candles.at(-1)?.close.toAnalysis() ?? 0)) < 1e-4, 'mismo precio final');
  assert.notDeepEqual(shuffled.map((c) => c.close.toString()), candles.map((c) => c.close.toString()), 'otro orden');
  for (const c of shuffled) assert.ok(!c.high.lt(c.open) && !c.high.lt(c.close) && !c.low.gt(c.open) && !c.low.gt(c.close), 'vela coherente');
  assert.deepEqual(shuffledCandles(candles, seededRng(1, 'paseo')), shuffled);
});

/** Un tramo de backtest sobre estas velas, como los del ejecutor. */
function foldOf<P>(kit: KitVariant<P>, candles: ReturnType<typeof walkCandles>, multiplier = 1): FoldRun {
  const spec = kitSpec({ strategy: kit.strategy, featureSet: kit.featureSet, params: kit.params }, candles, 1, 11);
  const result = runBacktest({ ...spec, costs: { ...spec.costs, multiplier } });
  return { from: spec.from, to: spec.to, result, survivorshipBias: null };
}

test('control aleatorio: con la réplica a ≤ 10 % decide el simulador; si se aleja más, las mismas colocaciones se repiten con el backtester real', () => {
  const candles = walkCandles(walkCloses(4, 300));
  const kit = baseline({ emaPeriod: 10, stopFraction: 0.5 }, '1h');
  const base = foldOf(kit, candles);
  const actual = stressRun([base], periodsPerYear('1h')).sharpe;
  let runs = 0;
  const ctx = {
    seed: 3, symbols: ['BTC/EUR'], costRate: 0.004, timeframe: '1h' as const, maxStaleMs: 3 * HOUR, simulations: 12,
    run: <Q>(variants: readonly KitVariant<Q>[], _options: RunOptions): FoldRun[] => {
      runs++;
      const [variant] = variants;
      assert.ok(variant !== undefined && variants.length === 1, 'una regla por tramo');
      return [foldOf(variant, candles)];
    },
  };
  const close = randomControlOf(ctx, [base], candles, 'c', null, { symbols: ['BTC/EUR'], multiplier: 1 });
  assert.ok(close.ok);
  // Sin Sharpe real no se puede comprobar la réplica: el simulador no decide y se repite con el backtester.
  assert.equal(close.value.method, 'backtester');
  assert.equal(runs, 12, 'una ejecución del backtester por colocación');
  assert.equal(close.value.summary.simulations, 12);
  runs = 0;
  const replica = close.value.replica ?? 0;
  const valid = randomControlOf(ctx, [base], candles, 'c', replica * 1.05, { symbols: ['BTC/EUR'], multiplier: 1 });
  assert.ok(valid.ok);
  assert.deepEqual([valid.value.method, runs], ['simulador', 0]);
  assert.ok(Math.abs((valid.value.deviation ?? 1) - 0.05 / 1.05) < 1e-9);
  const far = randomControlOf(ctx, [base], candles, 'c', replica * 1.2, { symbols: ['BTC/EUR'], multiplier: 1 });
  assert.ok(far.ok);
  assert.equal(far.value.method, 'backtester');
  assert.ok(far.value.summary.sharpes.length > 0);
  assert.ok(actual !== null, 'el paseo opera');
});
