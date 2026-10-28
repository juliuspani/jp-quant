// Backtester event-driven (paso 23, ADR 0026): el sistema real (Strategy → Risk → Execution) sobre el replay, con el reloj
// simulado, velas de historical/ y el venue simulado como únicas piezas cambiadas.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { BacktestError, runBacktest } from '../../../src/app/backtest.ts';
import { CostModelError } from '../../../src/backtest/costs.ts';
import type { ReplayEvent } from '../../../src/backtest/replay.ts';
import type { Fill } from '../../../src/kernel/execution.ts';
import { canonicalJson } from '../../../src/shared/canonical.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import type { Strategy } from '../../../src/strategy/types.ts';
import { candles, CROSS, HOUR, spec, T0, type CrossParams } from './scenario.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
// Hash del diario del escenario. Cambia si cambia a propósito el modelo, el escenario o el formato del diario: ese
// cambio actualiza el valor y lo explica en su commit. Si cambia sin eso, el backtest dejó de ser reproducible.
const GOLDEN_SHA256 = '32a8a87902534c96957ad25c560d613febe83e38e5169cdf55986b2b69953823';

const types = (journal: readonly ReplayEvent[]): string[] => journal.map((e) => e.type);
const ofType = (journal: readonly ReplayEvent[], type: string): ReplayEvent[] => journal.filter((e) => e.type === type);
// En memoria, el diario guarda los valores tal cual (los Decimal, como Decimal); en el JSONL van como texto canónico.
const fillOf = (event: ReplayEvent | undefined): Fill => event?.payload as Fill;

/** Entra en cuanto puede y sale a la vela siguiente: en precios planos, cada ida y vuelta solo paga costes. */
const PING_PONG: Strategy<CrossParams> = {
  ...CROSS,
  id: 'vaiven-prueba',
  evaluate: ({ features, position, params }) => {
    const c = features.values.close ?? null;
    if (c === null) return { action: 'hold', reason: 'sin features' };
    return position === null ? { action: 'enter', stopPrice: c * (1 - params.stopFraction), reason: 'entra' } : { action: 'exit', reason: 'sale' };
  },
};

test('camino completo: cada operación pasa por Strategy, Risk y Execution hasta el venue y vuelve como fill a la cartera', () => {
  const result = runBacktest(spec());
  assert.equal(result.halted, null);
  assert.ok(result.metrics.closedTrades >= 1, 'el escenario sube y baja: entra y sale al menos una vez');
  const first = result.journal.findIndex((e) => e.type === 'OrderIntentCreated');
  const chain = types(result.journal.slice(first)).filter((t) => t !== 'StrategyEvaluated' && t !== 'RawMarketDataReceived');
  assert.deepEqual(chain.slice(0, 8), [
    'OrderIntentCreated', 'RiskDecisionMade', 'OrderApproved', 'OrderStateChanged', 'TimerFired', 'TimerFired',
    'VenueOrderUpdate', 'FillRecorded',
  ]);
  for (const fill of ofType(result.journal, 'FillRecorded')) assert.ok(fillOf(fill).fee.isPositive());
  assert.ok(Decimal.parse(result.metrics.feesPaid).isPositive());
  assert.ok(!JSON.stringify(result.journal).includes('"signature"'), 'el diario no lleva firmas: cambian en cada arranque');
});

test('la orden se ejecuta con la apertura de la vela siguiente a la de la señal, más medio spread y slippage', () => {
  const result = runBacktest(spec());
  const [intent] = ofType(result.journal, 'OrderIntentCreated');
  const [fill] = ofType(result.journal, 'FillRecorded');
  assert.equal((intent?.payload as { signalTime: number }).signalTime, T0 + 4 * HOUR, 'señal al cierre de la vela de las 3:00 (cierre 103)');
  // La vela de las 4:00 abre en 103,30: × 1,00075 → 103,38 (al alza, paso 0,01); × 1,0005 → 103,44. Con el cierre de la
  // señal habría sido 103,14.
  assert.equal(fillOf(fill).price.toString(), '103.44');
  assert.equal(fillOf(fill).exchangeTime, T0 + 4 * HOUR + 61_000, 'el fill ocurre al llegar la orden: cierre + 60 s de datos + 1 s de ida');
  assert.equal(fill?.receivedTime, T0 + 4 * HOUR + 62_000, 'y el sistema lo sabe tras el segundo de vuelta');
});

test('calentamiento: las velas anteriores al tramo solo calculan features; la estrategia empieza en el tramo y ya caliente', () => {
  const result = runBacktest(spec());
  assert.equal(result.warmupFrom, T0 + HOUR);
  const evaluated = ofType(result.journal, 'StrategyEvaluated');
  assert.ok(evaluated.every((e) => e.receivedTime >= T0 + 4 * HOUR));
  assert.notEqual((evaluated[0]?.payload as { reason: string }).reason, 'sin features');
  assert.ok(result.equityCurve.every((p) => p.at >= T0 + 4 * HOUR));
});

test('ningún resultado sin costes: en precios planos cada ida y vuelta pierde y el estrés pierde más; el informe declara el modelo', () => {
  const flat = Array.from({ length: 30 }, () => 100);
  const base = runBacktest(spec({ strategy: PING_PONG, candles: candles(flat, { jump: 0 }), to: T0 + 30 * HOUR }));
  const stressed = runBacktest(spec({ strategy: PING_PONG, candles: candles(flat, { jump: 0 }), to: T0 + 30 * HOUR, costs: { ...spec().costs, multiplier: 2 } }));
  assert.ok(base.metrics.closedTrades >= 5);
  assert.ok(Decimal.parse(base.metrics.netReturn).isNegative(), base.metrics.netReturn);
  assert.ok(base.roundTrips.every((t) => t.pnl === null || Decimal.parse(t.pnl).isNegative()));
  assert.ok(Decimal.parse(stressed.metrics.endEquity).lt(Decimal.parse(base.metrics.endEquity)));
  assert.match(base.execution.declaration, /^Sin datos de libro de órdenes/);
  assert.equal(base.execution.bookData, false);
  assert.ok(base.assumptions.some((a) => a.startsWith('Cotización del sistema')));
  assert.throws(() => runBacktest(spec({ costs: { ...spec().costs, commission: '0.001' } })), CostModelError);
});

test('un hueco en las velas se avisa, no se rellena, y la media de tres no se calcula mientras el hueco esté en sus velas', () => {
  const result = runBacktest(spec({ candles: candles(Array.from({ length: 20 }, (_, i) => 100 + i), { skip: [8] }), to: T0 + 20 * HOUR }));
  const [gap] = ofType(result.journal, 'MarketDataGap');
  assert.deepEqual([(gap?.payload as { from: number }).from, (gap?.payload as { to: number }).to], [T0 + 8 * HOUR, T0 + 9 * HOUR]);
  const after = ofType(result.journal, 'StrategyEvaluated').filter((e) => e.receivedTime > T0 + 9 * HOUR);
  assert.deepEqual(after.slice(0, 2).map((e) => (e.payload as { reason: string | null; note: string | null }).reason ?? (e.payload as { note: string }).note), ['sin features', 'sin features']);
});

test('fail closed: velas de otro timeframe o una estrategia con menos calentamiento que sus features no se ejecutan', () => {
  const fourHours = candles([100, 101]).map((c) => ({ ...c, timeframe: '4h' as const }));
  assert.throws(() => runBacktest(spec({ candles: fourHours })), BacktestError);
  assert.throws(() => runBacktest(spec({ strategy: { ...CROSS, warmupBars: 2 } })), RangeError);
});

test('determinismo: el mismo diario byte a byte en cada ejecución, con claves de firma distintas, y otro con otra semilla', () => {
  const runs = [runBacktest(spec()), runBacktest(spec())];
  const [a, b] = runs;
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.journalSha256, b.journalSha256);
  const summary = (r: typeof a): string => canonicalJson({ metrics: r.metrics, curve: r.equityCurve, trips: r.roundTrips, execution: r.execution });
  assert.equal(summary(a), summary(b));
  assert.notEqual(runBacktest(spec({ seed: 7 })).journalSha256, a.journalSha256, 'otra semilla, otros ids');
  assert.equal(a.journalSha256, GOLDEN_SHA256);
});

test('determinismo en procesos aparte: el mismo hash, el fijado', () => {
  const script = join(ROOT, 'test', 'fixtures', 'backtest', 'run.ts');
  const hashes = [1, 2].map(() => execFileSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' }).trim());
  assert.deepEqual(hashes, [GOLDEN_SHA256, GOLDEN_SHA256]);
});

// Stops de protección (paso 23): la entrada de las 4:00 (apertura 103,30) deja un stop a 97,85 que espera en el exchange.
function rising(mutate: (c: ReturnType<typeof candles>[number]) => ReturnType<typeof candles>[number]) {
  return candles(Array.from({ length: 12 }, (_, i) => 100 + i)).map((c) => (c.openTime === T0 + 6 * HOUR ? mutate(c) : c));
}
const sells = (journal: readonly ReplayEvent[]) => ofType(journal, 'FillRecorded').map(fillOf).filter((f) => f.side === 'sell');

test('stop por toque: si el mínimo de la vela lo toca, se vende desde el stop dentro de esa vela, antes de que decida la estrategia', () => {
  const result = runBacktest(spec({ candles: rising((c) => ({ ...c, low: Decimal.parse('95') })), to: T0 + 12 * HOUR }));
  const [sell] = sells(result.journal);
  // 97,85 × 0,99925 → 97,776 (a la baja, paso 0,001); × 0,9995 → 97,727. Al cierre de la vela de las 6:00.
  assert.deepEqual([sell?.price.toString(), sell?.exchangeTime], ['97.727', T0 + 7 * HOUR]);
  assert.equal(ofType(result.journal, 'OrderIntentCreated').filter((e) => (e.payload as { kind: string }).kind === 'exit').length, 0);
});

test('stop por hueco: si la vela abre por debajo del stop, se vende desde la apertura', () => {
  const gap = (c: ReturnType<typeof candles>[number]) => ({ ...c, open: Decimal.parse('96'), low: Decimal.parse('95.5') });
  const result = runBacktest(spec({ candles: rising(gap), to: T0 + 12 * HOUR }));
  const [sell] = sells(result.journal);
  // 96 × 0,99925 → 95,928; × 0,9995 → 95,880 (a la baja).
  assert.deepEqual([sell?.price.toString(), sell?.exchangeTime], ['95.88', T0 + 7 * HOUR]);
});

test('una salida con el stop esperando: primero se cancela el stop y, confirmado, sale la venta aprobada', () => {
  const result = runBacktest(spec());
  const exitAt = result.journal.findIndex((e) => e.type === 'OrderIntentCreated' && (e.payload as { kind: string }).kind === 'exit');
  assert.ok(exitAt > 0);
  const after = ofType(result.journal.slice(exitAt), 'OrderStateChanged').map((e) => e.payload as { clientOrderId: string; state: string });
  const stop = after[0];
  assert.equal(stop?.state, 'CANCEL_PENDING');
  const canceled = after.findIndex((s) => s.clientOrderId === stop?.clientOrderId && s.state === 'CANCELED');
  const sent = after.findIndex((s) => s.clientOrderId !== stop?.clientOrderId && s.state === 'SENT');
  assert.ok(canceled >= 0 && sent > canceled, 'la venta sale después de cancelar el stop');
  assert.equal(sells(result.journal).length, 1, 'una sola venta');
});

test('el stop sube con la estrategia: se sustituye, sin dos stops esperando a la vez', () => {
  const TRAIL: Strategy<CrossParams> = {
    ...CROSS,
    id: 'stop-que-sube',
    evaluate: (input) => {
      const decision = CROSS.evaluate(input);
      const c = input.features.values.close ?? null;
      return decision.action === 'hold' && input.position !== null && c !== null ? { ...decision, stopPrice: c * 0.97 } : decision;
    },
  };
  const result = runBacktest(spec({ strategy: TRAIL, candles: candles(Array.from({ length: 20 }, (_, i) => 100 + i)), to: T0 + 20 * HOUR }));
  const intents = ofType(result.journal, 'OrderIntentCreated').map((e) => e.payload as { kind: string; stopPrice: { toString(): string } | null });
  const updates = intents.filter((i) => i.kind === 'stop_update').map((i) => Number(i.stopPrice?.toString()));
  assert.ok(updates.length >= 3, `sustituciones: ${String(updates.length)}`);
  assert.ok(updates.every((s, i) => i === 0 || s > (updates[i - 1] ?? 0)), 'cada stop, más alto que el anterior');
  const open = new Set<string>();
  let most = 0;
  for (const e of ofType(result.journal, 'OrderStateChanged')) {
    const { clientOrderId, state } = e.payload as { clientOrderId: string; state: string };
    if (state === 'OPEN') open.add(clientOrderId);
    if (['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(state)) open.delete(clientOrderId);
    most = Math.max(most, open.size);
  }
  assert.equal(most, 1);
});
