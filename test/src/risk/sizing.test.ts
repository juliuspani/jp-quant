// Dimensionado por riesgo con costes (trading-risk §4.1, paso 23, ADR 0026). Con patrimonio de 10.000 EUR, ask 40.000 y
// bid 39.990, el presupuesto de riesgo es 75 EUR (0,75 %). Riesgo por unidad = (entrada − stop) + entrada × (comisión +
// slippage) + stop × (comisión + slippage + medio spread), con comisión 0,25 % y slippage 0,05 % por lado.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RiskConfigError } from '../../../src/risk/engine.ts';
import { DEFAULT_RISK_LIMITS } from '../../../src/risk/limits.ts';
import { d, entry, exit, quote, riskBench, SYMBOL, T0 } from '../harness/trading.ts';

const FAR_STOP = d('38000'); // riesgo por unidad: 2000 + 120 + 118,7505… = 2238,7505…; tamaño 75 / 2238,75 → 0,0335

test('dimensionado por riesgo: la cantidad sale del presupuesto de riesgo y del riesgo por unidad con costes', () => {
  const { risk } = riskBench();
  const { decision, approval } = risk.evaluate(entry({ sizing: { mode: 'risk' }, stopPrice: FAR_STOP }));
  assert.equal(decision.decision, 'APPROVED');
  assert.deepEqual(decision.reasonCodes, []);
  assert.equal(decision.approvedQuantity?.toString(), '0.0335');
  assert.equal(decision.detail.riskBudget, '75');
  assert.equal(decision.detail.riskPerUnit, '2238.75059382422806');
  assert.deepEqual([approval?.max_quantity, approval?.max_notional], ['0.0335', '1340']);
  // Sin costes saldría 75 / 2000 = 0,0375: los costes reducen el tamaño, nunca lo agrandan.
  assert.ok(decision.approvedQuantity?.lt(d('0.0375')));
});

test('RISK_PER_TRADE: una cantidad pedida que arriesga más que el presupuesto se reduce, y nunca se agranda', () => {
  const { risk } = riskBench();
  const reduced = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.05') }, stopPrice: FAR_STOP })).decision;
  assert.deepEqual([reduced.decision, reduced.reasonCodes, reduced.approvedQuantity?.toString()], ['REDUCED', ['RISK_PER_TRADE'], '0.0335']);
  const small = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.01') }, stopPrice: FAR_STOP })).decision;
  assert.deepEqual([small.decision, small.approvedQuantity?.toString()], ['APPROVED', '0.01']);
  // Con varios topes, el orden es el de trading-risk §9.3 (tamaño antes que exposición, concentración y caja) y manda el
  // menor. Con el stop por defecto, 0,15 supera el tamaño por riesgo (0,1008) y la concentración (0,0625); 0,5 los supera todos.
  const two = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.15') } })).decision;
  assert.deepEqual([two.reasonCodes, two.approvedQuantity?.toString()], [['RISK_PER_TRADE', 'CONCENTRATION_LIMIT'], '0.0625']);
  const all = risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d('0.5') } })).decision;
  assert.deepEqual(all.reasonCodes, ['RISK_PER_TRADE', 'MAX_EXPOSURE', 'CONCENTRATION_LIMIT', 'INSUFFICIENT_CASH']);
  assert.equal(all.reasonCode, 'RISK_PER_TRADE');
});

test('INSUFFICIENT_CASH: el 99 % de la caja libre, con los costes de la compra, recorta; sin caja, rechaza', () => {
  const { risk, portfolio } = riskBench();
  portfolio.current = { ...portfolio.current, cash: d('1000') };
  const reduced = risk.evaluate(entry({ sizing: { mode: 'risk' }, stopPrice: FAR_STOP })).decision;
  // 990 / (40.000 × 1,003) = 0,02467… → 0,0246.
  assert.deepEqual([reduced.decision, reduced.reasonCodes, reduced.approvedQuantity?.toString()], ['REDUCED', ['INSUFFICIENT_CASH'], '0.0246']);
  assert.equal(reduced.detail.cashRoom, '990');
  portfolio.current = { ...portfolio.current, cash: d('0') };
  const rejected = risk.evaluate(entry({ sizing: { mode: 'risk' }, stopPrice: FAR_STOP })).decision;
  assert.deepEqual([rejected.decision, rejected.reasonCode], ['REJECTED', 'INSUFFICIENT_CASH']);
});

test('un presupuesto de riesgo que no llega a un paso de cantidad se rechaza por debajo del mínimo', () => {
  const { risk, portfolio } = riskBench();
  portfolio.current = { ...portfolio.current, equity: d('10'), cash: d('10') };
  const { decision } = risk.evaluate(entry({ sizing: { mode: 'risk' }, stopPrice: FAR_STOP }));
  assert.deepEqual([decision.decision, decision.reasonCodes], ['REJECTED', ['BELOW_MIN_NOTIONAL']]);
  assert.equal(decision.detail.riskQuantity, '0');
});

test('fail closed: una cotización cruzada o sin bid no dimensiona, y una salida no se dimensiona por riesgo', () => {
  const { risk, market } = riskBench();
  market.quotes.set(SYMBOL, quote(T0, '40000', { bid: d('40001') }));
  assert.equal(risk.evaluate(entry({ sizing: { mode: 'risk' } })).decision.reasonCode, 'INTERNAL_ERROR');
  market.quotes.set(SYMBOL, quote(T0, '40000', { bid: d('0') }));
  assert.equal(risk.evaluate(entry({ sizing: { mode: 'risk' } })).decision.reasonCode, 'INTERNAL_ERROR');
  assert.equal(risk.evaluate(exit({ sizing: { mode: 'risk' } })).decision.reasonCode, 'INTERNAL_ERROR');
});

test('configuración: riesgo por operación por encima de 0,75 % o costes estimados por debajo de los mínimos no arrancan', () => {
  const bad = [
    { ...DEFAULT_RISK_LIMITS, riskPerTradeFraction: d('0.0076') },
    { ...DEFAULT_RISK_LIMITS, riskPerTradeFraction: d('0') },
    { ...DEFAULT_RISK_LIMITS, estimatedCommission: d('0.001') },
    { ...DEFAULT_RISK_LIMITS, estimatedSlippage: d('0.0004') },
    { ...DEFAULT_RISK_LIMITS, estimatedSlippage: d('1') },
  ];
  for (const limits of bad) assert.throws(() => riskBench({ limits }), RiskConfigError, JSON.stringify(limits));
  // Costes estimados más altos son más prudentes: dan un tamaño menor y otro config_hash.
  const prudent = riskBench({ limits: { ...DEFAULT_RISK_LIMITS, estimatedCommission: d('0.005') } });
  const size = prudent.risk.evaluate(entry({ sizing: { mode: 'risk' }, stopPrice: FAR_STOP })).decision.approvedQuantity;
  assert.ok(size?.lt(d('0.0335')), size?.toString());
  assert.notEqual(prudent.risk.configHash, riskBench().risk.configHash);
});
