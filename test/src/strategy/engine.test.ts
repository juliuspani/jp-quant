// Strategy Engine (paso 23): convierte decisiones puras en intenciones para Risk, lleva el stop y el máximo de cada
// posición y no deja salir dos intenciones a la vez para el mismo símbolo. No envía nada.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeatureVector } from '../../../src/features/types.ts';
import { seededIds } from '../../../src/kernel/random.ts';
import { StrategyEngine, StrategyStateError, stopToPrice } from '../../../src/strategy/engine.ts';
import type { Strategy, StrategyDecision, StrategyInput } from '../../../src/strategy/types.ts';
import { d, instrument, position, quote, SYMBOL, T0, TestMarket, TestPortfolio } from '../harness/trading.ts';

function vector(asOf = T0, overrides: Partial<FeatureVector> = {}): FeatureVector {
  return { symbol: SYMBOL, timeframe: '1h', asOf, computedAt: asOf + 60_000, featureSetId: 'prueba', featureSetVersion: 1, values: { close: 40000 }, ...overrides };
}

/** Estrategia guionizada: devuelve las decisiones en orden y guarda lo que recibió. */
function scripted(decisions: StrategyDecision[]) {
  const seen: StrategyInput<{ readonly n: number }>[] = [];
  const strategy: Strategy<{ readonly n: number }> = {
    id: 'guion',
    version: '1.0.0',
    featureSet: { id: 'prueba', version: 1 },
    warmupBars: 2,
    evaluate: (input) => {
      seen.push(input);
      const next = decisions.shift();
      if (next === undefined) throw new Error('guion agotado');
      return next;
    },
  };
  return { strategy, seen };
}

function engineWith(decisions: StrategyDecision[]) {
  const market = new TestMarket();
  const portfolio = new TestPortfolio();
  const { strategy, seen } = scripted(decisions);
  const engine = new StrategyEngine({ strategy, params: { n: 1 }, bucket: 'core', market, portfolio, ids: seededIds(3, 'intent') });
  return { engine, market, portfolio, seen };
}

test('una entrada sale dimensionada por riesgo, con el stop al alza y al paso de precio, y bloquea el símbolo hasta resolverse', () => {
  const { engine, seen } = engineWith([{ action: 'enter', stopPrice: 38000.123, reason: 'ruptura' }, { action: 'hold', reason: 'nada' }]);
  const step = engine.onFeatures(vector(), null);
  const intent = step.intent;
  assert.ok(intent !== null);
  assert.deepEqual(
    [intent.kind, intent.side, intent.reduceOnly, intent.sizing.mode, intent.stopPrice?.toString(), intent.signalTime, intent.strategyId, intent.origin],
    ['entry', 'buy', false, 'risk', '38000.2', T0, 'guion', 'strategy'],
  );
  assert.equal(seen[0]?.position, null);
  const blocked = engine.onFeatures(vector(T0 + 3_600_000), null);
  assert.deepEqual([blocked.decision, blocked.note], [null, 'intención anterior sin resolver']);
  engine.onIntentResolved(SYMBOL);
  assert.equal(engine.onFeatures(vector(T0 + 7_200_000), null).decision?.action, 'hold');
});

test('con la posición abierta, la estrategia ve su stop, el precio de entrada y el máximo; el stop solo sube', () => {
  const { engine, portfolio, market, seen } = engineWith([
    { action: 'enter', stopPrice: 38000, reason: 'entra' },
    { action: 'hold', reason: 'sube el stop', stopPrice: 39000 },
    { action: 'hold', reason: 'intenta bajarlo', stopPrice: 37000 },
    { action: 'exit', reason: 'sale' },
  ]);
  engine.onFeatures(vector(), null);
  portfolio.current = { ...portfolio.current, positions: [position({ quantity: d('0.01'), averageEntry: d('40000') })] };
  engine.onIntentResolved(SYMBOL);
  market.quotes.set(SYMBOL, quote(T0, '41010')); // bid 41.000
  engine.onFeatures(vector(T0 + 3_600_000), null);
  engine.onFeatures(vector(T0 + 7_200_000), null);
  const exit = engine.onFeatures(vector(T0 + 10_800_000), null).intent;
  assert.deepEqual(seen.slice(1).map((i) => [i.position?.stopPrice, i.position?.entryPrice, i.position?.highestPrice]), [
    [38000, 40000, 41000],
    [39000, 40000, 41000],
    [39000, 40000, 41000],
  ]);
  assert.deepEqual([exit?.kind, exit?.side, exit?.reduceOnly, exit?.sizing.mode, exit?.stopPrice], ['exit', 'sell', true, 'all', null]);
});

test('decisiones sin sentido no dan intención: entrar con posición o salir sin ella', () => {
  const { engine, portfolio } = engineWith([{ action: 'exit', reason: 'sin posición' }, { action: 'enter', stopPrice: 38000, reason: 'ya dentro' }]);
  assert.deepEqual([engine.onFeatures(vector(), null).intent, engine.isPending(SYMBOL)], [null, false]);
  portfolio.current = { ...portfolio.current, positions: [position()] };
  assert.throws(() => engine.onFeatures(vector(T0 + 3_600_000), null), StrategyStateError, 'una posición sin el stop de su entrada es un estado imposible');
});

test('fail closed: otras features que las de la estrategia lanzan, y un stop que no es un número positivo llega a Risk sin stop', () => {
  const { engine } = engineWith([{ action: 'enter', stopPrice: Number.NaN, reason: 'stop roto' }]);
  assert.throws(() => engine.onFeatures(vector(T0, { featureSetVersion: 2 }), null), StrategyStateError);
  assert.equal(engine.onFeatures(vector(), null).intent?.stopPrice, null, 'Risk la rechaza con STOP_INVALID');
  assert.equal(stopToPrice(-1, instrument()), null);
  assert.equal(stopToPrice(123.456, null)?.toString(), '123.456');
});

test('régimen (paso 26): la estrategia recibe el del símbolo a la misma vela; uno de otro símbolo o de otra vela es un estado imposible', () => {
  const { engine, seen } = engineWith([{ action: 'hold', reason: 'nada' }]);
  const regime = { scope: SYMBOL, timeframe: '1h' as const, asOf: T0, volatility: 'ALTA' as const, trend: 'BAJISTA' as const, classifierId: 'regimen-precio@1' };
  engine.onFeatures(vector(), regime);
  assert.deepEqual(seen[0]?.regime, regime);
  assert.throws(() => engine.onFeatures(vector(T0 + 3_600_000), regime), StrategyStateError, 'régimen de una vela anterior');
  assert.throws(() => engine.onFeatures(vector(), { ...regime, asOf: T0 + 3_600_000 }), StrategyStateError, 'régimen del futuro');
  assert.throws(() => engine.onFeatures(vector(), { ...regime, scope: 'ETH/EUR' }), StrategyStateError);
});

// Paso 28 (EXP-0024 falló así): un fill parcial deja un resto por debajo del mínimo (polvo), que no se puede vender; si el
// precio sube y vuelve a ser vendible, la posición tiene que seguir con su stop.
const H = 3_600_000;
const held = (quantity: string, dust = '0') => [position({ quantity: d(quantity), averageEntry: d('40000'), dust: d(dust) })];

test('paso 28: el resto en polvo de una salida parcial conserva su stop y lo recupera al volver a ser vendible', () => {
  const { engine, portfolio, market, seen } = engineWith([
    { action: 'enter', stopPrice: 38000, reason: 'entra' },
    { action: 'exit', reason: 'sale' },
    { action: 'hold', reason: 'solo queda polvo' },
    { action: 'hold', reason: 'el resto vuelve a ser vendible' },
  ]);
  engine.onFeatures(vector(), null);
  portfolio.current = { ...portfolio.current, positions: held('0.01') };
  engine.onIntentResolved(SYMBOL);
  engine.onFeatures(vector(T0 + H), null);
  // La salida solo se llena en parte y el precio cae: queda 0,0002 BTC, unos 4 EUR, por debajo del mínimo.
  market.quotes.set(SYMBOL, quote(T0, '20010'));
  portfolio.current = { ...portfolio.current, positions: held('0.0002', '0.0002') };
  engine.onIntentResolved(SYMBOL);
  engine.onFeatures(vector(T0 + 2 * H), null);
  assert.equal(seen[2]?.position, null, 'el polvo no es una posición para la estrategia');
  assert.equal(engine.protectiveStop(SYMBOL, null, T0 + 2 * H), null, 'ni lleva stop de protección');
  // El precio sube: el resto vuelve a valer más que el mínimo (unos 8 EUR), y su stop también (7,6 EUR).
  market.quotes.set(SYMBOL, quote(T0, '40010'));
  portfolio.current = { ...portfolio.current, positions: held('0.0002') };
  engine.onFeatures(vector(T0 + 3 * H), null);
  assert.equal(seen[3]?.position?.stopPrice, 38000, 'el stop de su entrada');
  assert.equal(engine.protectiveStop(SYMBOL, null, T0 + 3 * H)?.stopPrice?.toString(), '38000');
});

test('paso 28: una entrada que solo llena polvo conserva su stop hasta que la posición es vendible', () => {
  const { engine, portfolio, seen } = engineWith([
    { action: 'enter', stopPrice: 38000, reason: 'entra' },
    { action: 'hold', reason: 'solo hay polvo' },
    { action: 'hold', reason: 'ya es vendible' },
  ]);
  engine.onFeatures(vector(), null);
  portfolio.current = { ...portfolio.current, positions: held('0.0001', '0.0001') };
  engine.onIntentResolved(SYMBOL);
  engine.onFeatures(vector(T0 + H), null);
  portfolio.current = { ...portfolio.current, positions: held('0.0001') };
  engine.onFeatures(vector(T0 + 2 * H), null);
  assert.equal(seen[2]?.position?.stopPrice, 38000);
});

test('paso 28: una entrada nueva sobre un resto en polvo lleva el stop de la entrada nueva; sin nada en cartera, el stop se olvida', () => {
  const { engine, portfolio, seen } = engineWith([
    { action: 'enter', stopPrice: 38000, reason: 'entra' },
    { action: 'exit', reason: 'sale' },
    { action: 'enter', stopPrice: 39500, reason: 'entra otra vez' },
    { action: 'hold', reason: 'dentro' },
    { action: 'exit', reason: 'sale del todo' },
    { action: 'hold', reason: 'fuera' },
  ]);
  engine.onFeatures(vector(), null);
  portfolio.current = { ...portfolio.current, positions: held('0.01') };
  engine.onIntentResolved(SYMBOL);
  engine.onFeatures(vector(T0 + H), null);
  portfolio.current = { ...portfolio.current, positions: held('0.0001', '0.0001') };
  engine.onIntentResolved(SYMBOL);
  assert.equal(engine.onFeatures(vector(T0 + 2 * H), null).intent?.kind, 'entry', 'con solo polvo, la estrategia puede volver a entrar');
  portfolio.current = { ...portfolio.current, positions: held('0.0101') };
  engine.onIntentResolved(SYMBOL);
  engine.onFeatures(vector(T0 + 3 * H), null);
  assert.equal(seen[3]?.position?.stopPrice, 39500, 'el resto y la entrada nueva van con el stop nuevo');
  engine.onFeatures(vector(T0 + 4 * H), null);
  portfolio.current = { ...portfolio.current, positions: [] };
  engine.onIntentResolved(SYMBOL);
  engine.onFeatures(vector(T0 + 5 * H), null);
  // Sin nada en cartera, una posición que aparece sin entrada sigue siendo un estado imposible.
  portfolio.current = { ...portfolio.current, positions: held('0.01') };
  assert.throws(() => engine.onFeatures(vector(T0 + 6 * H), null), StrategyStateError);
});

test('paso 28: un stop ya cruzado o por debajo del mínimo del mercado no se coloca: sale a mercado, reduce_only, y bloquea el símbolo', () => {
  const { engine, portfolio, market } = engineWith([{ action: 'enter', stopPrice: 38000, reason: 'entra' }]);
  engine.onFeatures(vector(), null);
  portfolio.current = { ...portfolio.current, positions: held('0.01') };
  engine.onIntentResolved(SYMBOL);
  market.quotes.set(SYMBOL, quote(T0, '40010')); // bid 40.000, por encima del stop
  assert.equal(engine.protectiveStop(SYMBOL, null, T0)?.kind, 'protective_stop');
  market.quotes.set(SYMBOL, quote(T0, '38010')); // bid 38.000: el precio ya está en el stop
  const urgent = engine.protectiveStop(SYMBOL, null, T0);
  assert.deepEqual(
    [urgent?.kind, urgent?.origin, urgent?.side, urgent?.reduceOnly, urgent?.sizing.mode, urgent?.stopPrice],
    ['exit', 'system', 'sell', true, 'all', null],
  );
  assert.match(urgent?.reason ?? '', /ya cruzó el stop/);
  assert.equal(engine.isPending(SYMBOL), true, 'bloquea el símbolo hasta resolverse');
  assert.equal(engine.protectiveStop(SYMBOL, null, T0), null, 'y no se repite mientras tanto');
  assert.equal(engine.onFeatures(vector(T0 + H), null).note, 'intención anterior sin resolver');
  engine.onIntentResolved(SYMBOL);
  // Un resto vendible (0,00013 × 40.000 = 5,2 EUR) cuyo stop no llega al mínimo (0,00013 × 38.000 = 4,94 EUR).
  portfolio.current = { ...portfolio.current, positions: held('0.00013') };
  market.quotes.set(SYMBOL, quote(T0, '40010'));
  const small = engine.protectiveStop(SYMBOL, null, T0 + 2 * H);
  assert.deepEqual([small?.kind, small?.reduceOnly], ['exit', true]);
  assert.match(small?.reason ?? '', /no llega al mínimo/);
});
