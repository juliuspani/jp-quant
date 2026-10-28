// Curvas del control aleatorio (paso 41C, ADR 0047): las mismas colocaciones que A.3.12 y, si el simulador no representaría
// ese control, ninguna curva. Con el replay sintético de la demo del dashboard: no son datos reales ni van al registro.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomPlacements, simulatedSharpe, simulateTrades } from '../../../src/analytics/random-control.ts';
import { periodsPerYear } from '../../../src/analytics/performance.ts';
import { controlCurves, CURVE_SAMPLES, type ControlCurvesInput } from '../../../src/app/control-curves.ts';
import { controlInputs, RANDOM_CONTROL_STREAM } from '../../../src/app/criteria-evidence.ts';
import { seededRng } from '../../../src/kernel/random.ts';
import { demoCandles, demoRun, demoSpec } from '../../../demo/replay.ts';

const spec = demoSpec();
const { result } = demoRun(spec);
const base: Omit<ControlCurvesInput, 'actualSharpe'> = {
  folds: [{ from: spec.from, to: spec.to, result, survivorshipBias: null }],
  candles: demoCandles(),
  symbols: ['BTC/EUR', 'ETH/EUR'],
  costRate: 0.00375,
  timeframe: '1d',
  maxStaleMs: 2 * 86_400_000,
  seed: 11,
  simulations: 60,
};
const inputs = controlInputs(base.folds, base.candles, base.symbols, base.costRate, periodsPerYear('1d'), base.maxStaleMs);
const replica = simulatedSharpe(inputs.market, inputs.trades);

test('con el simulador válido: curvas en base 100 de las mismas colocaciones que A.3.12, con su banda y su muestra', () => {
  assert.ok(replica !== null);
  const { curvas, motivo } = controlCurves({ ...base, actualSharpe: replica });
  assert.equal(motivo, null);
  assert.ok(curvas !== null);
  assert.equal(curvas.simulaciones, base.simulations);
  assert.equal(curvas.estrategia[0], 100);
  assert.equal(curvas.muestras.length, Math.min(CURVE_SAMPLES, base.simulations));
  // La primera muestra es la primera colocación del flujo de A.3.12, con la misma semilla.
  const [first] = randomPlacements(inputs.market, inputs.trades, base.simulations, seededRng(base.seed, RANDOM_CONTROL_STREAM));
  assert.ok(first !== undefined);
  const path = [100];
  for (const r of simulateTrades(inputs.market, first)) path.push((path.at(-1) ?? 100) * (1 + r));
  assert.ok(path.length <= 400, 'el replay de la demo es corto: no se reduce');
  assert.deepEqual(curvas.muestras[0], path.map((v) => Math.round(v * 100) / 100));
  assert.deepEqual(controlCurves({ ...base, actualSharpe: replica }), { curvas, motivo }, 'determinista');
  assert.ok(curvas.p05.every((v, i) => v <= (curvas.p95[i] ?? -Infinity)));
});

test('si el simulador se aleja más de un 10 % del backtester, no hay curvas y queda el motivo', () => {
  assert.ok(replica !== null);
  for (const actual of [replica * 2, null]) {
    const { curvas, motivo } = controlCurves({ ...base, actualSharpe: actual });
    assert.equal(curvas, null);
    assert.match(motivo ?? '', /simulador/);
  }
});
