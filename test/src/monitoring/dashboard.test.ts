// Estado del dashboard (paso 41B, ADR 0045): cuadra con lo que dio el backtest y cuenta lo que dice el diario, también
// los rechazos, las paradas y las alertas.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDashboard } from '../../../src/monitoring/dashboard.ts';
import { renderDashboard } from '../../../src/monitoring/dashboard-html.ts';
import { DashboardError, parseJournal } from '../../../src/monitoring/journal.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { DEMO_CONTEXT, demoRun } from '../../../demo/replay.ts';

const { result, jsonl } = demoRun();
const context = DEMO_CONTEXT;
const snapshot = buildDashboard(parseJournal(jsonl), context);
const dec = (text: string): Decimal => Decimal.parse(text);

test('cuadra con el backtest: comisiones, fills, posiciones abiertas, P&L realizado e instantes de la curva', () => {
  assert.equal(snapshot.mode, 'REPLAY');
  assert.equal(snapshot.quoteCurrency, 'EUR');
  assert.equal(snapshot.account.startingCash, '10000');
  assert.ok(dec(snapshot.account.fees).eq(dec(result.metrics.feesPaid)), 'mismas comisiones, al céntimo y más');
  assert.equal(snapshot.tradesTotal, result.metrics.fills);
  assert.equal(snapshot.positions.length, result.metrics.openPositions);
  const closed = result.roundTrips.filter((t) => t.pnl !== null).reduce((total, t) => total.plus(dec(t.pnl ?? '0')), dec('0'));
  assert.ok(dec(snapshot.account.realizedPnl).eq(closed), 'el P&L realizado es el de las operaciones cerradas');
  assert.deepEqual(snapshot.curve.at, result.equityCurve.map((p) => p.at), 'una marca por instante evaluado, como la cartera');
  // La cartera valora al bid y el dashboard al cierre: difieren como mucho en el medio spread de lo expuesto.
  for (const [i, point] of result.equityCurve.entries()) {
    const gap = Math.abs((snapshot.curve.equity[i] ?? 0) - dec(point.equity).toAnalysis());
    assert.ok(gap <= 0.00075 * 10_000 + 1e-6, `instante ${String(i)}: ${String(gap)}`);
  }
  const equity = dec(snapshot.account.cash).plus(dec(snapshot.account.exposure));
  assert.ok(dec(snapshot.account.equity).eq(equity), 'patrimonio = liquidez + exposición');
});

test('comprar y mantener BTC: una marca por instante de la curva, empezando con el capital menos el coste de la compra', () => {
  const benchmark = snapshot.curve.benchmark;
  assert.ok(benchmark !== null);
  assert.equal(benchmark.length, snapshot.curve.equity.length);
  assert.equal(snapshot.curve.benchmarkSymbol, 'BTC/EUR');
  assert.ok((benchmark[0] ?? 0) < 10_000 && (benchmark[0] ?? 0) > 9_900);
  const missing = buildDashboard(parseJournal(jsonl), { ...context, benchmark: { ...context.benchmark, symbol: 'SOL/EUR' } });
  assert.equal(missing.curve.benchmark, null);
  assert.match(missing.curve.benchmarkNote ?? '', /SOL\/EUR no está en el diario/);
});

test('salud: feeds con su hueco, reconciliación, Execution y stops de protección de cada posición', () => {
  const feeds = new Map(snapshot.health.feeds.map((f) => [f.symbol, f]));
  assert.equal(feeds.get('ETH/EUR')?.gaps, 1);
  assert.equal(feeds.get('BTC/EUR')?.gaps, 0);
  assert.ok(snapshot.health.feeds.every((f) => !f.stale));
  assert.equal(snapshot.health.trading, 'operando');
  assert.equal(snapshot.health.executionMode, 'NORMAL');
  assert.deepEqual(snapshot.health.reconciliation.lastResolved, true);
  assert.deepEqual(snapshot.alerts.map((a) => [a.level, a.message]), [['WARNING', 'Hueco de datos en ETH/EUR']]);
  // Al final del diario, la salida de BTC caducó tras cancelar su stop: la posición queda sin proteger, y se ve.
  const stops = new Map(snapshot.positions.map((p) => [p.symbol, p.protectiveStop]));
  assert.equal(stops.get('BTC/EUR'), null);
  assert.equal(stops.get('ETH/EUR'), snapshot.orders.open.find((o) => o.symbol === 'ETH/EUR')?.triggerPrice);
  assert.ok(snapshot.trades.every((t) => t.reason !== 'sin motivo en el diario'), 'cada operación lleva el motivo de su intención');
});

test('lo que requiere atención, en lenguaje claro: el hueco de ETH y la posición de BTC sin stop; y la marca de datos sintéticos', () => {
  assert.deepEqual(snapshot.attention, [
    { level: 'WARNING', message: '1 hueco en los datos de ETH/EUR' },
    { level: 'WARNING', message: 'la posición en BTC/EUR no tiene stop de protección' },
  ]);
  assert.equal(snapshot.synthetic, true);
  assert.equal(buildDashboard(parseJournal(jsonl), { ...context, synthetic: false }).synthetic, false);
});

test('plan B: aportaciones, reparto actual y, con objetivo, la desviación de cada activo', () => {
  assert.equal(snapshot.planB.contributions, '10000');
  assert.equal(snapshot.planB.hasTarget, false);
  const total = snapshot.planB.allocation.reduce((sum, row) => sum.plus(dec(row.current)), dec('0'));
  assert.ok(total.minus(dec('1')).abs().lt(dec('0.000001')), 'el reparto actual suma 1');
  const withTarget = buildDashboard(parseJournal(jsonl), { ...context, planB: { target: { BTC: '0.5', SOL: '0.1' }, nextRebalanceAt: Date.UTC(2024, 6, 1) } });
  const rows = new Map(withTarget.planB.allocation.map((row) => [row.asset, row]));
  assert.equal(rows.get('SOL')?.current, '0');
  assert.equal(rows.get('SOL')?.deviation, '-0.1');
  assert.equal(rows.get('EUR')?.target, '0', 'sin objetivo para un activo: objetivo 0');
  assert.ok(dec(rows.get('BTC')?.deviation ?? '0').eq(dec(rows.get('BTC')?.current ?? '0').minus(dec('0.5'))));
  assert.equal(withTarget.planB.nextRebalanceAt, Date.UTC(2024, 6, 1));
});

// Diario mínimo hecho a mano, para los casos que el replay de demostración no tiene.
function journalOf(events: readonly { type: string; at: number; payload: Record<string, unknown> }[]): string {
  const lines = events.map((e, seq) => JSON.stringify({ seq, runId: 'a-mano', type: e.type, eventTime: e.at, receivedTime: e.at, payload: e.payload }));
  return `${[JSON.stringify({ format: 'inversor-replay/1', runId: 'a-mano', seed: 1 }), ...lines, JSON.stringify({ events: events.length })].join('\n')}\n`;
}

const T = Date.UTC(2024, 0, 1);
const START = [
  { type: 'AccountSnapshotReceived', at: T, payload: { balances: { EUR: '1000' }, orders: [], fills: [], exchangeTime: T } },
  { type: 'ReconciliationCompleted', at: T, payload: { resolved: true, mode: 'NORMAL', reason: null } },
  { type: 'RawMarketDataReceived', at: T + 60_000, payload: { symbol: 'BTC/EUR', close: '100', closeTime: T } },
  { type: 'StrategyEvaluated', at: T + 60_000, payload: { symbol: 'BTC/EUR', action: 'enter', reason: 'señal', note: null } },
  { type: 'OrderIntentCreated', at: T + 60_000, payload: { intentId: 'i-1', symbol: 'BTC/EUR', side: 'buy', kind: 'entry', reason: 'señal' } },
];

test('rechazos de Risk y de Execution con su reason_code, y las paradas como alertas CRITICAL', () => {
  const s = buildDashboard(parseJournal(journalOf([
    ...START,
    { type: 'RiskDecisionMade', at: T + 60_000, payload: { intentId: 'i-1', decision: 'REJECTED', reasonCode: 'MAX_EXPOSURE', reasonCodes: ['MAX_EXPOSURE', 'CONCENTRATION_LIMIT'] } },
    { type: 'ExecutionRejected', at: T + 61_000, payload: { intentId: 'i-1', layer: 'execution', reasonCode: 'APPROVAL_EXPIRED', symbol: 'BTC/EUR', side: 'buy' } },
    { type: 'ExecutionModeChanged', at: T + 62_000, payload: { mode: 'UNKNOWN', reason: 'sin respuesta' } },
    { type: 'KillSwitchChanged', at: T + 63_000, payload: { active: true } },
    { type: 'TradingHalted', at: T + 63_000, payload: { reason: 'kill switch activo' } },
  ])), context);
  assert.deepEqual(s.rejections.map((r) => [r.layer, r.reasonCode, r.symbol, r.kind]), [
    ['execution', 'APPROVAL_EXPIRED', 'BTC/EUR', 'entry'],
    ['risk', 'MAX_EXPOSURE', 'BTC/EUR', 'entry'],
  ]);
  assert.deepEqual(s.rejections[1]?.reasonCodes, ['MAX_EXPOSURE', 'CONCENTRATION_LIMIT']);
  assert.equal(s.health.trading, 'detenido');
  assert.equal(s.health.haltedReason, 'kill switch activo');
  assert.equal(s.health.killSwitch, true);
  assert.equal(s.health.executionMode, 'UNKNOWN');
  assert.equal(s.strategies[0]?.state, 'detenida');
  assert.deepEqual(s.alertCounts, { CRITICAL: 3, WARNING: 1, INFO: 1 });
  assert.equal(s.alerts[0]?.level, 'CRITICAL', 'lo más reciente primero');
  assert.deepEqual(s.attention.filter((a) => a.level === 'CRITICAL').map((a) => a.message), [
    'el sistema se ha detenido (kill switch activo)',
    'el freno de emergencia (kill switch) está activado',
    'la ejecución de órdenes está en modo UNKNOWN',
  ]);
  const unreconciled = buildDashboard(parseJournal(journalOf([
    ...START,
    { type: 'ReconciliationCompleted', at: T + 62_000, payload: { resolved: false, mode: 'NORMAL', reason: 'saldo distinto' } },
  ])), context);
  assert.ok(unreconciled.attention.some((a) => a.level === 'CRITICAL' && a.message.includes('no cuadran')));
  const never = buildDashboard(parseJournal(journalOf([START[0], ...START.slice(2)].filter((x) => x !== undefined))), context);
  assert.ok(never.attention.some((a) => a.level === 'WARNING' && a.message.includes('aún no se ha comprobado')));
});

test('fail closed: sin foto inicial, con comisión en otra moneda o con un estado de orden desconocido no hay dashboard', () => {
  const fill = { tradeId: 't', clientOrderId: 'c', symbol: 'BTC/EUR', side: 'buy', quantity: '1', price: '100', fee: '0.001', feeCurrency: 'BTC', feeEstimated: false, exchangeTime: T };
  const cases: readonly [string, string][] = [
    ['sin foto inicial', journalOf(START.slice(2))],
    ['comisión en BTC', journalOf([...START, { type: 'FillRecorded', at: T + 61_000, payload: fill }])],
    ['estado desconocido', journalOf([...START, { type: 'OrderStateChanged', at: T + 61_000, payload: { clientOrderId: 'c', state: 'PERDIDA', filled: '0' } }])],
    ['venta sin posición', journalOf([...START, { type: 'FillRecorded', at: T + 61_000, payload: { ...fill, side: 'sell', feeCurrency: 'EUR' } }])],
  ];
  for (const [name, text] of cases) assert.throws(() => buildDashboard(parseJournal(text), context), DashboardError, name);
});

test('SEC-01: un tipo de evento o un activo con nombre de Object.prototype no saca alertas ni objetivos de la herencia', () => {
  const hostile = { level: 'x"><meta http-equiv="refresh" content="0">', message: '<b>falso</b>' };
  const s = buildDashboard(parseJournal(journalOf([
    ...START,
    ...['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].map((type) => ({ type, at: T + 61_000, payload: hostile })),
  ])), { ...context, planB: { target: { BTC: '0.5' }, nextRebalanceAt: null } });
  assert.deepEqual(s.alerts, [], 'solo alertan los tipos de la tabla');
  const html = renderDashboard({ snapshot: s, research: null, commit: null });
  assert.ok(!html.includes('http-equiv="refresh"') && !html.includes('<b>falso</b>'));
  const withProtoAsset = buildDashboard(parseJournal(journalOf(START)), { ...context, planB: { target: JSON.parse('{"constructor":"0.1","__proto__":"0.1"}') as Record<string, string>, nextRebalanceAt: null } });
  assert.equal(withProtoAsset.planB.allocation.find((row) => row.asset === 'EUR')?.target, '0');
});

test('SEC-02: una orden abierta sin su aprobación en el diario se muestra con «?», sin tumbar la página', () => {
  const s = buildDashboard(parseJournal(journalOf([
    ...START,
    { type: 'OrderStateChanged', at: T + 61_000, payload: { clientOrderId: 'ijp-huerfana', state: 'OPEN', filled: '0' } },
  ])), context);
  assert.equal(s.orders.open[0]?.quantity, null);
  assert.match(renderDashboard({ snapshot: s, research: null, commit: null }), /<td class="kf" data-label="Par">\?<\/td><td class="kf" data-label="Lado">\?<\/td>/);
  assert.throws(() => buildDashboard(parseJournal(journalOf([
    ...START,
    { type: 'OrderStateChanged', at: T + 61_000, payload: { clientOrderId: 'c', state: 'OPEN', filled: 'mucho' } },
  ])), context), DashboardError, 'filled tiene que ser un decimal');
});

test('el estado no lleva firmas ni nada con lo que actuar: solo datos', () => {
  const text = JSON.stringify(snapshot);
  for (const word of ['signature', 'config_hash', 'approval_id', 'apiKey', 'secret']) assert.ok(!text.includes(word), word);
  assert.ok(Object.isFrozen(snapshot));
});
