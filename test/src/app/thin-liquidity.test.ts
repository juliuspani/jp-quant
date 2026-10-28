// Paso 28: liquidez fina en el sistema compuesto. Con poco volumen, el venue simulado llena las órdenes en parte (como mucho
// el 2 % del volumen de la vela) y quedan restos por debajo del mínimo del mercado (polvo). EXP-0024 falló así: un resto en
// polvo perdía su stop y, al volver a ser vendible con la subida del precio, el Strategy Engine lanzaba. Y un stop que el
// precio ya había cruzado se reintentaba en cada temporizador, con miles de eventos por vela. Datos sintéticos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest } from '../../../src/app/backtest.ts';
import { DEFAULT_INSTRUMENT_RULES } from '../../../src/backtest/instrument-model.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { seededRng } from '../../../src/kernel/random.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf } from '../../../src/shared/time.ts';
import { trendFollowing } from '../../../src/strategy/trend-following.ts';
import { HOUR, LATENCY, SYMBOL, T0 } from './scenario.ts';
import { COSTS } from './walk.ts';

const BARS = 1500;
const WARMUP = 200;
const KIT = trendFollowing({ entryPeriod: 20, exitPeriod: 10, atrPeriod: 20, stopAtr: 2 }, '1h');

/** Paseo con saltos de `sigma` por vela y un volumen al azar de hasta `maxVolume` unidades: muchas órdenes no caben enteras. */
function thinCandles(seed: number, sigma = 0.03, maxVolume = 40, bars = BARS): HistoricalCandle[] {
  const rng = seededRng(seed, 'liquidez-fina');
  let price = 100;
  return Array.from({ length: bars }, (_, i) => {
    const open = price;
    price *= 1 + sigma * ((rng.next() + rng.next() + rng.next() - 1.5) * 2);
    const openTime = T0 + i * HOUR;
    const closeTime = closeTimeOf(openTime, '1h');
    return {
      symbol: SYMBOL,
      timeframe: '1h',
      openTime,
      closeTime,
      receivedTime: closeTime + LATENCY,
      open: Decimal.parse(open.toFixed(4)),
      high: Decimal.parse((Math.max(open, price) * 1.002).toFixed(4)),
      low: Decimal.parse((Math.min(open, price) * 0.998).toFixed(4)),
      close: Decimal.parse(price.toFixed(4)),
      volume: Decimal.parse((maxVolume * rng.next()).toFixed(4)),
    };
  });
}

function run(seed: number, candles: readonly HistoricalCandle[]): ReturnType<typeof runBacktest> {
  return runBacktest({
    runId: `liquidez-fina-${String(seed)}`,
    seed,
    commit: 'prueba',
    candles,
    listings: new Map([[SYMBOL, { listedAt: T0, delistedAt: null }]]),
    from: T0 + WARMUP * HOUR,
    to: T0 + candles.length * HOUR,
    featureSet: KIT.featureSet,
    strategy: KIT.strategy,
    params: KIT.params,
    costs: COSTS,
    startingCash: Decimal.parse('1000'),
    quoteCurrency: 'EUR',
  });
}

const rejections = (result: ReturnType<typeof runBacktest>): number => result.journal.filter((e) => e.type === 'VenueRequestFailed').length;

test('paso 28: un stop que el exchange rechaza porque el precio ya lo cruzó no se reintenta hasta la vela siguiente', () => {
  // En este camino, alguna entrada se llena tras un hueco por debajo de su stop. Antes, el stop se reintentaba unas 30
  // veces dentro de la misma vela, una por cada respuesta del venue.
  const result = run(1, thinCandles(1, 0.02, 60, 400));
  const crossed = result.journal.flatMap((e, i) => (e.type === 'VenueRequestFailed' && JSON.stringify(e.payload).includes('STOP_WOULD_TRIGGER') ? [i] : []));
  assert.ok(crossed.length > 0, 'el caso se da');
  for (let k = 1; k < crossed.length; k++) {
    const between = result.journal.slice(crossed[k - 1], crossed[k]);
    assert.ok(between.some((e) => e.type === 'StrategyEvaluated'), `rechazos ${String(k - 1)} y ${String(k)} en la misma vela`);
  }
});

test('paso 28: con fills parciales y restos en polvo, el sistema no lanza, ningún stop se reintenta sin fin y un stop cruzado sale a mercado', () => {
  let partial = 0;
  let urgent = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const result = run(seed, thinCandles(seed));
    assert.equal(result.halted, null, `semilla ${String(seed)}`);
    partial += result.execution.orders.partial;
    const candles = BARS - WARMUP;
    assert.ok(rejections(result) <= candles, `semilla ${String(seed)}: ${String(rejections(result))} rechazos del venue en ${String(candles)} velas`);
    assert.ok(result.journalEvents < 40 * candles, `semilla ${String(seed)}: ${String(result.journalEvents)} eventos en ${String(candles)} velas`);
    urgent += result.journal.filter((e) => {
      if (e.type !== 'OrderIntentCreated' || typeof e.payload !== 'object' || e.payload === null) return false;
      const p = e.payload as { readonly origin?: unknown; readonly kind?: unknown };
      return p.origin === 'system' && p.kind === 'exit';
    }).length;
  }
  assert.ok(partial > 0, 'el escenario llena órdenes en parte');
  assert.ok(urgent > 0, 'algún stop ya cruzado sale como salida urgente a mercado');
});

test('ADR 0042: la curva del backtest guarda la exposición sin polvo, que A.3.9 usa; un resto en polvo solo cuenta en la exposición', () => {
  const minNotional = DEFAULT_INSTRUMENT_RULES.minNotional.toAnalysis();
  let withDust = 0;
  let withPosition = 0;
  for (let seed = 1; seed <= 6; seed++) {
    for (const p of run(seed, thinCandles(seed)).analysis.curve) {
      assert.ok(p.exposureWithoutDust >= 0 && p.exposureWithoutDust <= p.exposure, `${String(p.exposureWithoutDust)} frente a ${String(p.exposure)}`);
      // Con un solo par, lo que falta es como mucho un resto por debajo del importe mínimo del mercado.
      assert.ok(p.exposure - p.exposureWithoutDust < minNotional);
      if (p.exposureWithoutDust < p.exposure) withDust += 1;
      if (p.exposureWithoutDust > 0) withPosition += 1;
    }
  }
  assert.ok(withDust > 0, 'el escenario deja restos en polvo');
  assert.ok(withPosition > 0, 'y posiciones que se pueden vender');
});
