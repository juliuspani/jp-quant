// Autopilot, antes «Autopilot» (paso 49, ADR 0048): determinista, toda orden pasa por Risk, Risk lo frena con sus límites, el stop de
// protección cubre siempre la posición y solo se cancela con el sustituto aprobado, y el dashboard lo lee como cualquier
// diario.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_PLAN, autopilotRun } from '../../demo/autopilot/run.ts';
import { autopilotPage } from '../../demo/demo.ts';
import { contextFromCard } from '../../src/app/dashboard-command.ts';
import { buildDashboard } from '../../src/monitoring/dashboard.ts';
import { parseJournal } from '../../src/monitoring/journal.ts';

interface Event {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const run = autopilotRun();
const events: Event[] = run.jsonl.trim().split('\n').slice(1, -1).map((line) => JSON.parse(line) as Event);
const of = (type: string): Record<string, unknown>[] => events.filter((e) => e.type === type).map((e) => e.payload);

test('el mismo plan da exactamente el mismo diario y el bot no se detiene', () => {
  assert.equal(autopilotRun().jsonl, run.jsonl);
  assert.equal(run.halted, null);
});

test('toda orden pasa por Risk: cada intención tiene su decisión y cada orden enviada, su aprobación', () => {
  const intents = of('OrderIntentCreated');
  const decisions = of('RiskDecisionMade');
  assert.equal(decisions.length, intents.length);
  assert.deepEqual(decisions.map((d) => d['intentId']), intents.map((i) => i['intentId']));
  const approved = new Set(of('OrderApproved').map((a) => a['intent_id']));
  for (const d of decisions) assert.equal(approved.has(d['intentId']), d['decision'] !== 'REJECTED', String(d['intentId']));
  for (const i of intents) assert.equal(i['origin'], 'system');
});

test('las compras piden una cantidad con un stop declarado, y Risk las reduce cuando pasan de su riesgo por operación', () => {
  const entries = of('OrderIntentCreated').filter((i) => i['kind'] === 'entry');
  assert.ok(entries.length > 10, 'compras periódicas');
  for (const e of entries) {
    assert.equal((e['sizing'] as { mode: string }).mode, 'quantity');
    assert.notEqual(e['stopPrice'], null);
  }
  assert.ok(of('RiskDecisionMade').some((d) => d['decision'] === 'REDUCED' && d['reasonCode'] === 'RISK_PER_TRADE'), 'se ve actuar a Risk');
  assert.ok(of('OrderIntentCreated').some((i) => i['kind'] === 'exit' && String(i['reason']).startsWith('rebalanceo')), 'hay un rebalanceo con venta');
});

test('un stop de protección solo se cancela con su sustituto ya aprobado (stop_update o venta)', () => {
  const approvals = new Map(of('OrderApproved').map((a) => [String(a['approval_id']), a]));
  const intents = new Map(of('OrderIntentCreated').map((i) => [String(i['intentId']), i]));
  const cancels = events.filter((e) => e.type === 'OrderStateChanged' && e.payload['state'] === 'CANCEL_PENDING');
  assert.ok(cancels.length > 0);
  // Cada cancelación de un stop sigue a la aprobación de una intención que lo sustituye.
  let lastApproval: Record<string, unknown> | undefined;
  for (const e of events) {
    if (e.type === 'OrderApproved') lastApproval = approvals.get(String(e.payload['approval_id']));
    if (e.type === 'OrderStateChanged' && e.payload['state'] === 'CANCEL_PENDING') {
      const kind = intents.get(String(lastApproval?.['intent_id']))?.['kind'];
      assert.ok(kind === 'stop_update' || kind === 'exit', `cancelación sin sustituto aprobado: ${String(kind)}`);
    }
  }
});

test('al final, cada posición tiene su stop y el reparto queda cerca del objetivo; el dashboard lo lee', () => {
  const snapshot = buildDashboard(parseJournal(run.jsonl), contextFromCard(run.card));
  assert.ok(snapshot.positions.length > 0);
  for (const p of snapshot.positions) assert.notEqual(p.protectiveStop, null, `${p.symbol} sin stop`);
  assert.ok(snapshot.planB.hasTarget);
  for (const row of snapshot.planB.allocation) {
    if (row.target === null || row.deviation === null) continue;
    assert.ok(Math.abs(Number(row.deviation)) <= Number(DEMO_PLAN.band) + 0.01, `${row.asset} lejos del objetivo: ${row.deviation}`);
  }
  assert.ok(snapshot.attention.every((a) => !a.message.includes('sin stop')));
});

test('la página del Autopilot es la del dashboard, con su ficha y la reproducción', () => {
  const html = autopilotPage('es');
  assert.equal(autopilotPage('es'), html);
  assert.ok(html.includes('Autopilot') && html.includes('Replay en marcha'));
  assert.ok(autopilotPage('en').includes('Autopilot') && autopilotPage('en').includes('Replay in motion'));
});

test('un plan inválido no construye el bot', () => {
  assert.throws(() => autopilotRun({ ...DEMO_PLAN, target: { 'BTC/EUR': '0.7', 'ETH/EUR': '0.4' } }), RangeError);
  assert.throws(() => autopilotRun({ ...DEMO_PLAN, stopFraction: '1' }), RangeError);
  assert.throws(() => autopilotRun({ ...DEMO_PLAN, everyMs: 0 }), RangeError);
});
