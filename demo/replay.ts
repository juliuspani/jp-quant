// Replay de demostración del dashboard (paso 41B, ADR 0045): dos pares con precios sintéticos (un paseo aleatorio con
// semilla, sin datos de mercado reales) y la estrategia de referencia BASELINE, que no es una estrategia para operar
// (strategy/baselines.ts). Vive en demo/, fuera de src/, porque en src/ solo el ejecutor de experimentos lanza backtests
// (INV-14a): esto no es un resultado de investigación, como los escenarios sintéticos de las pruebas del backtester. Hasta
// el paso 49 vivía en test/; desde entonces lo usa también el comando de la demo pública (demo.ts, ADR 0048).
// Lo usan las pruebas de monitoring/ y la prueba que comprueba que los archivos de demostración de demo/fixtures/ son los
// que salen de aquí.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { journalText, runBacktest, type BacktestResult, type BacktestSpec } from '../src/app/backtest.ts';
import { clientOrderIdFor } from '../src/execution/client-order-id.ts';
import type { HistoricalCandle } from '../src/historical/types.ts';
import type { DashboardContext } from '../src/monitoring/dashboard.ts';
import { seededRng } from '../src/kernel/random.ts';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../src/risk/limits.ts';
import { Decimal } from '../src/shared/decimal.ts';
import { closeTimeOf, timeframeMs } from '../src/shared/time.ts';
import { baseline, type BaselineParams } from '../src/strategy/baselines.ts';

export const DEMO_SEED = 20261023;
export const DEMO_T0 = Date.UTC(2024, 0, 1);
const DAY = timeframeMs('1d');
const DAYS = 150;
const WARMUP = 20;
const LATENCY_MS = 60_000;
const STARTS: readonly (readonly [string, number])[] = [['BTC/EUR', 40_000], ['ETH/EUR', 2_200]];
const GAP: readonly [string, number] = ['ETH/EUR', 100];
export const DEMO_PARAMS: BaselineParams = { emaPeriod: 20, stopFraction: 0.08 };
// Más estricto que el valor por defecto, para que la demostración tenga rechazos o reducciones de Risk que mostrar.
const DEMO_LIMITS: RiskLimits = { ...DEFAULT_RISK_LIMITS, maxExposureFraction: Decimal.parse('0.3') };
// La demo pública (demo.ts, paso 49) usa un tope aún más bajo, para que en la reproducción se vean órdenes rechazadas y
// reducidas por Risk. Las pruebas usan DEMO_LIMITS, con el diario de demo/fixtures/ que fijan sus cifras.
export const PUBLIC_DEMO_LIMITS: RiskLimits = { ...DEFAULT_RISK_LIMITS, maxExposureFraction: Decimal.parse('0.1') };
export const DEMO_COSTS = { commission: '0.0025', halfSpread: '0.00075', minSlippage: '0.0005', multiplier: 1 } as const;

/** Velas diarias de un paseo aleatorio por tramos: subidas, bajadas y laterales, para que haya entradas y salidas. */
export function demoCandles(days: number = DAYS): HistoricalCandle[] {
  const out: HistoricalCandle[] = [];
  for (const [symbol, start] of STARTS) {
    const rng = seededRng(DEMO_SEED, symbol);
    let previous = start;
    for (let i = 0; i < days; i++) {
      const drift = [0.004, -0.006, 0.0005, -0.003, 0.005][Math.floor(i / 30) % 5] ?? 0; // cada 150 días, otra vuelta
      const shock = (rng.next() + rng.next() + rng.next() - 1.5) * 0.05;
      const close = previous * (1 + drift + shock);
      const open = previous;
      const openTime = DEMO_T0 + i * DAY;
      const closeTime = closeTimeOf(openTime, '1d');
      const high = Math.max(open, close) * (1 + rng.next() * 0.01);
      const low = Math.min(open, close) * (1 - rng.next() * 0.01);
      previous = close;
      if (symbol === GAP[0] && i === GAP[1]) continue; // un hueco en los datos: el dashboard lo muestra como aviso
      out.push({
        symbol,
        timeframe: '1d',
        openTime,
        closeTime,
        receivedTime: closeTime + LATENCY_MS,
        open: Decimal.parse(open.toFixed(2)),
        high: Decimal.parse(high.toFixed(2)),
        low: Decimal.parse(low.toFixed(2)),
        close: Decimal.parse(close.toFixed(2)),
        volume: Decimal.parse('1000000'),
      });
    }
  }
  return out;
}

export function demoSpec(riskLimits: RiskLimits = DEMO_LIMITS): BacktestSpec<BaselineParams> {
  const kit = baseline(DEMO_PARAMS, '1d');
  return {
    runId: 'demo-dashboard',
    seed: DEMO_SEED,
    commit: 'demo',
    candles: demoCandles(),
    listings: new Map(STARTS.map(([symbol]) => [symbol, { listedAt: DEMO_T0, delistedAt: null }])),
    from: DEMO_T0 + WARMUP * DAY,
    to: DEMO_T0 + DAYS * DAY + DAY,
    featureSet: kit.featureSet,
    strategy: kit.strategy,
    params: kit.params,
    costs: DEMO_COSTS,
    startingCash: Decimal.parse('10000'),
    quoteCurrency: 'EUR',
    riskLimits,
  };
}

// La demo pública (paso 49, revisión): 300 días y el calentamiento de la estrategia dentro de los datos. El replay empieza
// en la primera vela y opera desde que las features están listas; con DAYS y WARMUP, el replay empezaba antes del primer
// dato (la primera reconciliación salía fechada antes del periodo) y la estrategia no podía operar hasta el día 100.
// El tramo acaba una vela antes del último dato: una orden decidida en la última vela evaluada todavía tiene mercado en
// el venue simulado. Si no, caducaba sin ejecutarse y la posición quedaba al final sin stop, un efecto del borde de los
// datos y no del sistema.
const PUBLIC_DAYS = 300;

export function publicDemoSpec(): BacktestSpec<BaselineParams> {
  const base = demoSpec(PUBLIC_DEMO_LIMITS);
  return { ...base, candles: demoCandles(PUBLIC_DAYS), from: DEMO_T0 + base.strategy.warmupBars * DAY, to: DEMO_T0 + (PUBLIC_DAYS - 1) * DAY };
}

export interface DemoRun {
  readonly result: BacktestResult;
  readonly jsonl: string; // el diario, con la cabecera y el cierre del formato inversor-replay/1
}

/**
 * El diario del replay como texto. runBacktest da los eventos, no el JSONL del motor: la cabecera lleva lo que se conoce
 * aquí (sin la huella de la entrada) y el SHA-256 del diario que calculó el motor.
 */
export function demoRun(spec: BacktestSpec<BaselineParams> = demoSpec()): DemoRun {
  const result = runBacktest(spec);
  return { result, jsonl: journalText(spec.runId, spec.seed, result) };
}

/** Lo que app/ saca de la ficha de demostración (demo/fixtures/demo.ficha.json); lo comprueba su prueba. */
export const DEMO_CONTEXT: DashboardContext = Object.freeze({
  mode: 'REPLAY',
  label: 'Demostración con datos sintéticos: BASELINE, una estrategia de referencia que no es para operar',
  synthetic: true,
  strategy: Object.freeze({ id: 'baseline-cierre-ema', version: '1.0.0', params: Object.freeze({ ...DEMO_PARAMS }) }),
  benchmark: Object.freeze({ symbol: 'BTC/EUR', costRate: 0.00375, maxStaleMs: 2 * DAY }), // comisión + medio spread + slippage mínimo
  planB: Object.freeze({ target: null, nextRebalanceAt: null }),
  feedMaxAgeMs: 2 * DAY,
  clientOrderIdOf: clientOrderIdFor,
});

export const DEMO_DIR = resolve(import.meta.dirname, 'fixtures');
export const DEMO_JOURNAL = join(DEMO_DIR, 'demo.jsonl');
export const DEMO_CARD = join(DEMO_DIR, 'demo.ficha.json');

// Regenera el diario de demostración si cambia a propósito el backtester o este escenario:
// node demo/replay.ts
if (import.meta.main) writeFileSync(DEMO_JOURNAL, demoRun().jsonl, 'utf8');
