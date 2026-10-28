// Escenario de backtest para las pruebas de app/: velas sintéticas de BTC/EUR, un conjunto de features mínimo (cierre y
// media de tres cierres) y una estrategia pura de cruce con la media. Lo importan backtest.test.ts y el proceso aparte
// de la prueba de determinismo.
import type { BacktestSpec } from '../../../src/app/backtest.ts';
import type { FeatureDefinition, FeatureSet } from '../../../src/features/types.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf } from '../../../src/shared/time.ts';
import type { Strategy } from '../../../src/strategy/types.ts';

export const HOUR = 3_600_000;
export const T0 = Date.UTC(2024, 0, 1);
export const LATENCY = 60_000;
export const SYMBOL = 'BTC/EUR';

const close: FeatureDefinition = {
  id: 'close',
  version: 1,
  formula: 'C[t]',
  window: 1,
  warmupBars: 1,
  missingData: 'null sin vela',
  compute: (w) => w.close.at(-1) ?? null,
};

const sma3: FeatureDefinition = {
  id: 'sma_3',
  version: 1,
  formula: '(C[t] + C[t−1] + C[t−2]) / 3',
  window: 3,
  warmupBars: 3,
  missingData: 'null sin 3 velas contiguas',
  compute: (w) => w.close.reduce((a, b) => a + b, 0) / w.close.length,
};

export const FEATURES: FeatureSet = { id: 'prueba', version: 1, timeframe: '1h', features: [close, sma3] };

export interface CrossParams {
  readonly stopFraction: number;
}

/** Entra cuando el cierre supera su media de tres velas y sale cuando cae por debajo. Stop a stopFraction del cierre. */
export const CROSS: Strategy<CrossParams> = {
  id: 'cruce-prueba',
  version: '1.0.0',
  featureSet: { id: 'prueba', version: 1 },
  warmupBars: 3,
  evaluate: ({ features, position, params }) => {
    const c = features.values.close ?? null;
    const m = features.values.sma_3 ?? null;
    if (c === null || m === null) return { action: 'hold', reason: 'sin features' };
    if (position === null) {
      return c > m ? { action: 'enter', stopPrice: c * (1 - params.stopFraction), reason: 'cierre sobre la media' } : { action: 'hold', reason: 'fuera' };
    }
    return c < m ? { action: 'exit', reason: 'cierre bajo la media' } : { action: 'hold', reason: 'dentro' };
  },
};

/**
 * Velas horarias con estos cierres. Cada vela abre `jump` por encima del cierre anterior, para distinguir la apertura
 * siguiente del cierre de la señal. received_time: cierre más un minuto.
 */
export function candles(closes: readonly number[], options: { jump?: number; volume?: string; skip?: readonly number[] } = {}): HistoricalCandle[] {
  const jump = options.jump ?? 0.3;
  const result: HistoricalCandle[] = [];
  let previous = closes[0] ?? 100;
  closes.forEach((c, i) => {
    const open = i === 0 ? c : previous + jump;
    previous = c;
    if (options.skip?.includes(i) === true) return;
    const openTime = T0 + i * HOUR;
    const closeTime = closeTimeOf(openTime, '1h');
    result.push({
      symbol: SYMBOL,
      timeframe: '1h',
      openTime,
      closeTime,
      receivedTime: closeTime + LATENCY,
      open: Decimal.parse(open.toFixed(2)),
      high: Decimal.parse((Math.max(open, c) + 0.5).toFixed(2)),
      low: Decimal.parse((Math.min(open, c) - 0.5).toFixed(2)),
      close: Decimal.parse(c.toFixed(2)),
      volume: Decimal.parse(options.volume ?? '1000'),
    });
  });
  return result;
}

/** Sube de 100 a 119 en 20 horas y baja a 90 en otras 20: al menos una entrada y una salida. */
export function upAndDown(): number[] {
  return [...Array.from({ length: 20 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 118 - i * 1.5)];
}

export function spec(overrides: Partial<BacktestSpec<CrossParams>> = {}): BacktestSpec<CrossParams> {
  return {
    runId: 'prueba',
    seed: 20261013,
    commit: 'prueba',
    candles: candles(upAndDown()),
    listings: new Map([[SYMBOL, { listedAt: T0, delistedAt: null }]]),
    from: T0 + 4 * HOUR,
    to: T0 + 40 * HOUR,
    featureSet: FEATURES,
    strategy: CROSS,
    params: { stopFraction: 0.05 },
    costs: { commission: '0.0025', halfSpread: '0.00075', minSlippage: '0.0005', multiplier: 1 },
    startingCash: Decimal.parse('1000'),
    quoteCurrency: 'EUR',
    ...overrides,
  };
}
