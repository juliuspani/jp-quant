// Risk Engine mínimo (paso 20, ADR 0023): aprueba, reduce o rechaza; nunca agranda; guarda cada decisión con su
// reason_code antes de responder, y solo firma lo que quedó guardado.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryRiskStore } from '../../../src/backtest/research-stores.ts';
import type { DecisionRecord, RiskState } from '../../../src/kernel/stores.ts';
import { verifyApproval } from '../../../src/risk/approval.ts';
import { RiskConfigError } from '../../../src/risk/engine.ts';
import { DEFAULT_RISK_LIMITS } from '../../../src/risk/limits.ts';
import { d, entry, exit, position, quote, riskBench, SYMBOL, T0, TestExecutionView } from '../harness/trading.ts';

test('una entrada válida se aprueba, se guarda y sale firmada con lo aprobado', () => {
  const { risk, store } = riskBench();
  const intent = entry();
  const { decision, approval } = risk.evaluate(intent);
  assert.equal(decision.decision, 'APPROVED');
  assert.equal(decision.reasonCode, null);
  assert.equal(decision.approvedQuantity?.toString(), '0.01');
  assert.equal(decision.approvedNotional?.toString(), '400');
  assert.ok(approval);
  const check = verifyApproval(approval, risk.approvalPublicKey, T0);
  assert.equal(check.ok, true);
  assert.deepEqual(
    { symbol: approval.symbol, side: approval.side, type: approval.type, q: approval.max_quantity, n: approval.max_notional, r: approval.reduce_only },
    { symbol: SYMBOL, side: 'buy', type: 'market', q: '0.01', n: '400', r: false },
  );
  assert.equal(approval.expires_at - approval.issued_at, 10_000);
  assert.equal(approval.config_hash, risk.configHash);
  const [record] = store.decisions();
  assert.equal(store.decisions().length, 1);
  assert.deepEqual(
    { layer: record?.layer, intent: record?.intentId, approval: record?.approvalId, decision: record?.decision, origin: record?.origin },
    { layer: 'risk', intent: intent.intentId, approval: approval.approval_id, decision: 'APPROVED', origin: 'strategy' },
  );
});

test('posición máxima: reduce hasta el 25 % del patrimonio, contando la posición existente, y rechaza sin margen', () => {
  const { risk, portfolio } = riskBench();
  let outcome = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.1') } }));
  assert.equal(outcome.decision.decision, 'REDUCED');
  assert.deepEqual(outcome.decision.reasonCodes, ['CONCENTRATION_LIMIT']);
  assert.equal(outcome.decision.approvedQuantity?.toString(), '0.0625');
  assert.equal(outcome.approval?.max_quantity, '0.0625');

  portfolio.current = { ...portfolio.current, exposure: d('2000'), positions: [position({ quantity: d('0.05') })] };
  outcome = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.1') } }));
  assert.equal(outcome.decision.approvedQuantity?.toString(), '0.0125');

  portfolio.current = { ...portfolio.current, exposure: d('2500'), positions: [position({ quantity: d('0.0625') })] };
  outcome = risk.evaluate(entry());
  assert.equal(outcome.decision.decision, 'REJECTED');
  assert.equal(outcome.decision.reasonCode, 'CONCENTRATION_LIMIT');
  assert.equal(outcome.approval, null);
});

test('exposición máxima: reduce hasta el 75 % del patrimonio y rechaza sin margen o por debajo del mínimo', () => {
  const { risk, portfolio } = riskBench();
  portfolio.current = { ...portfolio.current, exposure: d('7400') };
  let outcome = risk.evaluate(entry());
  assert.equal(outcome.decision.decision, 'REDUCED');
  assert.deepEqual(outcome.decision.reasonCodes, ['MAX_EXPOSURE']);
  assert.equal(outcome.decision.approvedQuantity?.toString(), '0.0025');

  portfolio.current = { ...portfolio.current, exposure: d('7500') };
  outcome = risk.evaluate(entry());
  assert.deepEqual([outcome.decision.decision, outcome.decision.reasonCode], ['REJECTED', 'MAX_EXPOSURE']);

  portfolio.current = { ...portfolio.current, exposure: d('7496') };
  outcome = risk.evaluate(entry());
  assert.deepEqual(outcome.decision.reasonCodes, ['MAX_EXPOSURE', 'BELOW_MIN_NOTIONAL']);
  assert.equal(outcome.approval, null);
});

test('con los dos topes a la vez, el principal es la exposición (orden de trading-risk §9.3) y manda el menor', () => {
  const { risk, portfolio } = riskBench();
  portfolio.current = { ...portfolio.current, exposure: d('7000'), positions: [position({ quantity: d('0.06') })] };
  const { decision } = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.1') } }));
  assert.deepEqual(decision.reasonCodes, ['MAX_EXPOSURE', 'CONCENTRATION_LIMIT']);
  assert.equal(decision.reasonCode, 'MAX_EXPOSURE');
  assert.equal(decision.approvedQuantity?.toString(), '0.0025');
});

test('nunca agranda: la cantidad aprobada no supera la pedida', () => {
  const { risk } = riskBench();
  for (const q of ['0.0001', '0.00015', '0.01', '0.0625', '0.5', '3']) {
    const { decision } = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d(q) } }));
    if (decision.approvedQuantity !== null) assert.ok(decision.approvedQuantity.lte(d(q)), q);
  }
});

test('datos obsoletos: precio de más de 60 s, sin precio, valoración vieja o señal de más de 20 min', () => {
  const { risk, market, portfolio, clock } = riskBench();
  clock.advanceTo(T0 + 60_000);
  assert.equal(risk.evaluate(entry()).decision.decision, 'APPROVED', 'justo 60 s aún vale');
  clock.advanceTo(T0 + 60_001);
  assert.equal(risk.evaluate(entry({ signalTime: T0 + 60_001 })).decision.reasonCode, 'STALE_DATA');

  market.quotes.set(SYMBOL, quote(T0 + 60_001, '40000', { eventTime: T0 }));
  assert.equal(risk.evaluate(entry()).decision.reasonCode, 'STALE_DATA', 'cuenta la marca más antigua');
  market.quotes.delete(SYMBOL);
  assert.equal(risk.evaluate(entry()).decision.reasonCode, 'STALE_DATA', 'sin precio');

  market.quotes.set(SYMBOL, quote(T0 + 60_001));
  portfolio.current = { ...portfolio.current, positions: [position()], exposure: d('400'), marksAsOf: T0 };
  assert.equal(risk.evaluate(entry()).decision.reasonCode, 'STALE_DATA', 'cartera valorada con precios viejos');
  portfolio.current = { ...portfolio.current, marksAsOf: null };
  assert.equal(risk.evaluate(entry()).decision.reasonCode, 'STALE_DATA', 'cartera sin valorar');

  portfolio.current = { ...portfolio.current, marksAsOf: T0 + 60_001 };
  const old = risk.evaluate(entry({ signalTime: T0 + 60_001 - 1_200_001 }));
  assert.deepEqual(old.decision.reasonCodes, ['SIGNAL_TOO_OLD']);
});

test('mercado no permitido y stop que no está por debajo de la entrada se rechazan', () => {
  const { risk, market } = riskBench();
  assert.equal(risk.evaluate(entry({ stopPrice: d('40000') })).decision.reasonCode, 'STOP_INVALID');
  assert.equal(risk.evaluate(entry({ stopPrice: null })).decision.reasonCode, 'STOP_INVALID');
  market.instruments.set(SYMBOL, { ...market.instruments.get(SYMBOL)!, tradable: false });
  assert.equal(risk.evaluate(entry()).decision.reasonCode, 'MARKET_NOT_ALLOWED');
  assert.equal(risk.evaluate(entry({ symbol: 'XYZ/EUR' })).decision.reasonCodes[0], 'STALE_DATA');
});

test('salidas reduce_only: «todo» vende lo disponible; más de lo que hay, REDUCE_ONLY_VIOLATION', () => {
  const { risk, portfolio, market } = riskBench();
  assert.equal(risk.evaluate(exit()).decision.reasonCode, 'REDUCE_ONLY_VIOLATION', 'sin posición');
  portfolio.current = { ...portfolio.current, exposure: d('400'), positions: [position()] };
  market.quotes.delete(SYMBOL); // una salida no se frena por datos de mercado
  const all = risk.evaluate(exit());
  assert.equal(all.decision.decision, 'APPROVED');
  assert.deepEqual({ q: all.approval?.max_quantity, n: all.approval?.max_notional, r: all.approval?.reduce_only, s: all.approval?.side }, { q: '0.01', n: null, r: true, s: 'sell' });
  assert.equal(risk.evaluate(exit({ sizing: { mode: 'quantity', quantity: d('0.02') } })).decision.reasonCode, 'REDUCE_ONLY_VIOLATION');
});

test('estado sin reconciliar: en modo UNKNOWN se rechazan entradas y salidas', () => {
  const execution = new TestExecutionView();
  const { risk, portfolio } = riskBench({ execution });
  portfolio.current = { ...portfolio.current, positions: [position()] };
  execution.mode = 'UNKNOWN';
  assert.equal(risk.evaluate(entry()).decision.reasonCode, 'STATE_UNRECONCILED');
  assert.equal(risk.evaluate(exit()).decision.reasonCode, 'STATE_UNRECONCILED');
  assert.deepEqual(risk.tradingState().entriesBlockedBy, ['STATE_UNRECONCILED']);
});

test('fail closed: intención mal formada, dimensionado no disponible o control que lanza dan INTERNAL_ERROR', () => {
  const { risk, market } = riskBench();
  const malformed = [
    entry({ side: 'sell' }),
    entry({ reduceOnly: true }),
    entry({ kind: 'protective_stop' }),
    entry({ side: 'sell', kind: 'exit', reduceOnly: true, sizing: { mode: 'risk' }, stopPrice: null }),
    entry({ sizing: { mode: 'all' } }),
    entry({ sizing: { mode: 'quantity', quantity: d('0') } }),
    entry({ signalTime: Number.NaN }),
    entry({ signalTime: T0 + 1 }),
    entry({ intentId: '' }),
  ];
  for (const intent of malformed) {
    const outcome = risk.evaluate(intent);
    assert.deepEqual([outcome.decision.decision, outcome.decision.reasonCode, outcome.approval], ['REJECTED', 'INTERNAL_ERROR', null], JSON.stringify(intent.sizing) + intent.kind);
  }
  market.quote = () => {
    throw new Error('vista rota');
  };
  const broken = risk.evaluate(entry());
  assert.equal(broken.decision.reasonCode, 'INTERNAL_ERROR');
  assert.match(String(broken.decision.detail.error), /vista rota/);
});

test('kill switch: rechaza todo, también salidas y basura; se guarda y sigue activo al reconstruir el motor', () => {
  const store = new MemoryRiskStore();
  const { risk, portfolio } = riskBench({ store });
  portfolio.current = { ...portfolio.current, positions: [position()] };
  risk.activateKillSwitch('prueba manual');
  for (const intent of [entry(), exit(), entry({ kind: 'protective_stop' }), entry({ signalTime: Number.NaN })]) {
    const outcome = risk.evaluate(intent);
    assert.deepEqual([outcome.decision.reasonCode, outcome.approval], ['KILL_SWITCH_ACTIVE', null]);
  }
  assert.equal(risk.tradingState().killSwitch, true);
  assert.equal(store.loadState()?.killSwitch.active, true);
  const again = riskBench({ store });
  assert.equal(again.risk.evaluate(entry()).decision.reasonCode, 'KILL_SWITCH_ACTIVE');
  assert.throws(() => risk.activateKillSwitch(' '), RangeError);
});

class FailingStore extends MemoryRiskStore {
  failAppend = true;
  failSave = false;
  override appendDecision(record: DecisionRecord): void {
    if (this.failAppend) throw new Error('disco lleno');
    super.appendDecision(record);
  }
  override saveState(state: RiskState): void {
    if (this.failSave) throw new Error('disco lleno');
    super.saveState(state);
  }
}

test('sin poder guardar la decisión: DECISION_LOG_UNAVAILABLE, sin token y con el kill switch activo', () => {
  const store = new FailingStore();
  const { risk } = riskBench({ store });
  const outcome = risk.evaluate(entry());
  assert.deepEqual([outcome.decision.reasonCode, outcome.approval], ['DECISION_LOG_UNAVAILABLE', null]);
  assert.equal(outcome.decision.detail.killSwitchPersisted, true);
  assert.equal(store.loadState()?.killSwitch.active, true);
  assert.equal(risk.tradingState().killSwitch, true);

  const worse = new FailingStore();
  worse.failSave = true;
  const bench = riskBench({ store: worse });
  const failed = bench.risk.evaluate(entry());
  assert.equal(failed.decision.reasonCode, 'DECISION_LOG_UNAVAILABLE');
  assert.equal(failed.decision.detail.killSwitchPersisted, false);
  assert.equal(bench.risk.tradingState().killSwitch, true, 'sin poder guardarlo, sigue activo en memoria');
  worse.failAppend = false;
  assert.equal(bench.risk.evaluate(entry()).decision.reasonCode, 'KILL_SWITCH_ACTIVE');
});

test('cada rechazo queda guardado con su reason_code, y los códigos son del catálogo', () => {
  const { risk, store, portfolio } = riskBench();
  risk.evaluate(entry({ stopPrice: null }));
  portfolio.current = { ...portfolio.current, exposure: d('7500') };
  risk.evaluate(entry());
  risk.evaluate(exit());
  const rejected = store.decisions().filter((r) => r.decision === 'REJECTED');
  assert.deepEqual(rejected.map((r) => r.reasonCode), ['STOP_INVALID', 'MAX_EXPOSURE', 'REDUCE_ONLY_VIOLATION']);
  for (const r of rejected) {
    assert.equal(r.reasonCodes[0], r.reasonCode);
    assert.equal(r.configHash, risk.configHash);
    assert.equal(r.approvalId, null);
    assert.ok(Object.isFrozen(r));
  }
});

test('rechazos de Execution: se guardan con su capa; firma inválida o token reutilizado activan el kill switch', () => {
  const { risk, store } = riskBench();
  const base = { approvalId: null, intentId: 'i', layer: 'execution', symbol: SYMBOL, side: 'buy', quantity: d('1'), notional: null, detail: {} } as const;
  risk.recordExecutionRejection({ ...base, reasonCode: 'APPROVAL_MISSING' });
  assert.equal(risk.tradingState().killSwitch, false);
  risk.recordExecutionRejection({ ...base, reasonCode: 'APPROVAL_BAD_SIGNATURE' });
  assert.equal(risk.tradingState().killSwitch, true);
  assert.deepEqual(store.decisions().map((r) => [r.layer, r.reasonCode]), [['execution', 'APPROVAL_MISSING'], ['execution', 'APPROVAL_BAD_SIGNATURE']]);

  const replay = riskBench();
  replay.risk.recordExecutionRejection({ ...base, reasonCode: 'APPROVAL_REPLAYED' });
  assert.equal(replay.risk.tradingState().killSwitch, true);

  const capguard = riskBench();
  capguard.risk.recordExecutionRejection({ ...base, layer: 'capguard', reasonCode: 'CAP_EXPOSURE' });
  assert.equal(capguard.risk.tradingState().killSwitch, true, 'un rechazo del capguard es un incidente');
});

test('configuración más arriesgada que la del skill, o sin commit: no arranca (CONFIG_INVALID)', () => {
  const bad = [
    { ...DEFAULT_RISK_LIMITS, maxExposureFraction: d('0.8') },
    { ...DEFAULT_RISK_LIMITS, maxPositionFraction: d('0.3') },
    { ...DEFAULT_RISK_LIMITS, maxPositionFraction: d('0') },
    { ...DEFAULT_RISK_LIMITS, maxPriceAgeMs: 60_001 },
    { ...DEFAULT_RISK_LIMITS, maxSignalAgeMs: 0 },
    { ...DEFAULT_RISK_LIMITS, approvalTtlMs: 10_001 },
    { ...DEFAULT_RISK_LIMITS, approvalTtlMs: 1.5 },
  ];
  for (const limits of bad) assert.throws(() => riskBench({ limits }), RiskConfigError, JSON.stringify(limits));
  const tighter = riskBench({ limits: { ...DEFAULT_RISK_LIMITS, maxPositionFraction: d('0.1') } });
  assert.equal(tighter.risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.1') } })).decision.approvedQuantity?.toString(), '0.025');
  assert.notEqual(tighter.risk.configHash, riskBench().risk.configHash);
});
