// Strategy Library, primera ronda (paso 25, ADR 0028): tendencia (Turtle, sistema 2) y reversión a la media (RSI(2) de
// Connors). Decisiones puras con valores calculados a mano, sin parámetros por defecto, estado RESEARCH y ficha completa.
// El camino completo con Risk y Execution está en test/src/app/library.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { FeatureVector } from '../../../src/features/types.ts';
import { LibraryParamsError, literatureParams, RESEARCH, STRATEGY_LIBRARY, type LibraryEntry } from '../../../src/strategy/library.ts';
import { meanReversion } from '../../../src/strategy/mean-reversion.ts';
import { trendFollowing } from '../../../src/strategy/trend-following.ts';
import type { PositionView, Strategy, StrategyDecision } from '../../../src/strategy/types.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const T0 = Date.UTC(2024, 0, 1);
const HELD: PositionView = { quantity: 1, entryPrice: 100, stopPrice: 90, highestPrice: 100 };

function decide<P>(strategy: Strategy<P>, params: P, values: Record<string, number | null>, position: PositionView | null = null): StrategyDecision {
  const features: FeatureVector = {
    symbol: 'BTC/EUR', timeframe: '1d', asOf: T0, computedAt: T0 + 60_000,
    featureSetId: strategy.featureSet.id, featureSetVersion: strategy.featureSet.version, values,
  };
  return strategy.evaluate({ asOf: T0, symbol: 'BTC/EUR', features, regime: null, position, params });
}

test('tendencia: entra al superar el máximo de 55 velas con stop a 2 ATR y sale bajo el mínimo de 20', () => {
  const { strategy, featureSet, params } = trendFollowing(STRATEGY_LIBRARY.trendFollowing.literatura, '1d');
  assert.deepEqual(featureSet.features.map((f) => f.id), ['close', 'donchmax_55', 'donchmin_20', 'atr_20']);
  assert.equal(strategy.warmupBars, 101, 'el ATR de 20: 5·20 + 1 velas');
  const base = { close: 110, donchmax_55: 105, donchmin_20: 90, atr_20: 4 };
  // 110 − 2·4 = 102.
  assert.deepEqual(decide(strategy, params, base), { action: 'enter', stopPrice: 102, reason: 'cierre sobre el máximo del canal de entrada' });
  assert.equal(decide(strategy, params, { ...base, close: 105 }).action, 'hold', 'igualar el máximo no es romperlo');
  assert.equal(decide(strategy, params, { ...base, atr_20: 60 }).reason, 'stop no positivo');
  assert.equal(decide(strategy, params, { ...base, atr_20: null }).reason, 'sin features');
  // Con posición: solo el canal de salida decide; el de entrada y el ATR no cuentan.
  assert.equal(decide(strategy, params, { ...base, close: 89.9, donchmax_55: null, atr_20: null }, HELD).action, 'exit');
  assert.equal(decide(strategy, params, { ...base, close: 90 }, HELD).action, 'hold');
  assert.equal(decide(strategy, params, { ...base, donchmin_20: null }, HELD).reason, 'sin features');
});

test('reversión: entra con RSI(2) bajo 10 sobre la SMA 200, con stop a 2 ATR, y sale sobre la SMA 5', () => {
  const { strategy, featureSet, params } = meanReversion(STRATEGY_LIBRARY.meanReversion.literatura, '1d');
  assert.deepEqual(featureSet.features.map((f) => f.id), ['close', 'sma_200', 'rsi_2', 'sma_5', 'atr_20']);
  assert.equal(strategy.warmupBars, 200, 'la SMA 200');
  const base = { close: 100, sma_200: 80, rsi_2: 5, sma_5: 104, atr_20: 3 };
  assert.deepEqual(decide(strategy, params, base), { action: 'enter', stopPrice: 94, reason: 'RSI en sobreventa sobre la media de tendencia' });
  assert.equal(decide(strategy, params, { ...base, rsi_2: 0 }).action, 'enter', 'un RSI de 0 es válido');
  assert.equal(decide(strategy, params, { ...base, rsi_2: 10 }).action, 'hold', 'el umbral es estricto');
  assert.equal(decide(strategy, params, { ...base, sma_200: 100 }).reason, 'cierre bajo la media de tendencia');
  assert.equal(decide(strategy, params, { ...base, rsi_2: null }).reason, 'sin features');
  // Con posición: solo la SMA 5 decide, aunque el cierre haya caído bajo la SMA 200.
  assert.equal(decide(strategy, params, { ...base, close: 104.5, sma_200: 200, rsi_2: null }, HELD).action, 'exit');
  assert.equal(decide(strategy, params, { ...base, close: 104 }, HELD).action, 'hold');
});

test('sin parámetros por defecto: valores inválidos se rechazan al construirlas', () => {
  const trend = STRATEGY_LIBRARY.trendFollowing.literatura;
  for (const stopAtr of [0, -1, Number.NaN]) assert.throws(() => trendFollowing({ ...trend, stopAtr }, '1d'), RangeError);
  assert.throws(() => trendFollowing({ ...trend, entryPeriod: 0 }, '1d'), RangeError);
  const reversion = STRATEGY_LIBRARY.meanReversion.literatura;
  for (const rsiEntry of [0, 100, Number.NaN]) assert.throws(() => meanReversion({ ...reversion, rsiEntry }, '1d'), RangeError);
  assert.throws(() => meanReversion({ ...reversion, exitPeriod: 200 }, '1d'), RangeError);
  assert.throws(() => meanReversion({ ...reversion, rsiPeriod: 1 }, '1d'), RangeError);
});

test('primera ronda sin optimizar: solo se aceptan los parámetros de la literatura', () => {
  const entry = STRATEGY_LIBRARY.trendFollowing;
  assert.deepEqual(literatureParams(entry, { ...entry.literatura }), entry.literatura);
  assert.throws(() => literatureParams(entry, { ...entry.literatura, entryPeriod: 60 }), LibraryParamsError);
  assert.throws(() => literatureParams(entry, { ...entry.literatura, extra: 1 }), LibraryParamsError);
  const { stopAtr: _omit, ...missing } = entry.literatura;
  assert.throws(() => literatureParams(entry, missing), LibraryParamsError);
});

test('catálogo: estado RESEARCH, familias distintas, versión de la estrategia y ficha con todas sus secciones', () => {
  const entries = Object.values(STRATEGY_LIBRARY);
  assert.equal(new Set(entries.map((e) => e.familia)).size, entries.length, 'hipótesis opuestas, familias distintas');
  checkEntry(STRATEGY_LIBRARY.trendFollowing);
  checkEntry(STRATEGY_LIBRARY.meanReversion);
});

function checkEntry<P extends object>(entry: LibraryEntry<P>): void {
  assert.equal(entry.estado, RESEARCH);
  const { strategy } = entry.build(entry.literatura, entry.timeframe);
  assert.deepEqual([strategy.id, strategy.version], [entry.id, entry.version]);
  const path = resolve(REPO, entry.ficha);
  assert.ok(existsSync(path), entry.ficha);
  const text = readFileSync(path, 'utf8');
  for (const section of ['Hipótesis económica', 'Entradas', 'Salidas', 'Features', 'Parámetros y grados de libertad', 'Supuestos', 'Riesgos', 'Tests']) {
    assert.match(text, new RegExp(`^## \\d+\\. ${section}$`, 'm'), `${entry.ficha}: sección «${section}»`);
  }
  assert.ok(text.includes('RESEARCH'), `${entry.ficha}: estado`);
  assert.doesNotMatch(text, /\b(es|son) rentables?\b|\bvalidada\b|\bganadora\b/i, `${entry.ficha}: ninguna estrategia se etiqueta como rentable`);
}

test('paso 27B: ablación; sin un componente, la regla deja de usarlo y el resto queda igual; un componente desconocido se rechaza', () => {
  const trend = STRATEGY_LIBRARY.trendFollowing;
  const full = trendFollowing(trend.literatura, '1d');
  const noExit = trendFollowing(trend.literatura, '1d', ['salida-canal']);
  const below = { close: 95, donchmax_55: 120, donchmin_20: 96, atr_20: 3 };
  assert.equal(decide(full.strategy, full.params, below, HELD).action, 'exit');
  assert.equal(decide(noExit.strategy, noExit.params, below, HELD).action, 'hold', 'sin salida por canal: solo el stop');
  const breakout = { close: 125, donchmax_55: 120, donchmin_20: 96, atr_20: 3 };
  assert.deepEqual(decide(noExit.strategy, noExit.params, breakout), decide(full.strategy, full.params, breakout), 'la entrada no cambia');
  assert.equal(noExit.featureSet.id, full.featureSet.id, 'mismas features y mismo calentamiento');

  const rev = STRATEGY_LIBRARY.meanReversion;
  const base = meanReversion(rev.literatura, '1d');
  const noFilter = meanReversion(rev.literatura, '1d', ['filtro-tendencia']);
  const noTarget = meanReversion(rev.literatura, '1d', ['salida-media']);
  const underTrend = { close: 90, sma_200: 100, rsi_2: 5, sma_5: 95, atr_20: 2 };
  assert.equal(decide(base.strategy, base.params, underTrend).action, 'hold');
  assert.equal(decide(noFilter.strategy, noFilter.params, underTrend).action, 'enter', 'sin filtro de tendencia entra bajo la media de 200');
  const reverted = { close: 99, sma_200: 90, rsi_2: 50, sma_5: 95, atr_20: 2 };
  assert.equal(decide(base.strategy, base.params, reverted, HELD).action, 'exit');
  assert.equal(decide(noTarget.strategy, noTarget.params, reverted, HELD).action, 'hold', 'sin salida por la media corta: solo el stop');
  assert.deepEqual(trend.componentes, ['salida-canal']);
  assert.deepEqual(rev.componentes, ['filtro-tendencia', 'salida-media']);
  assert.throws(() => trendFollowing(trend.literatura, '1d', ['stop']), RangeError);
});
