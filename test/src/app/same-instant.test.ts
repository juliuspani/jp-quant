// Varios pares con velas recibidas en el mismo instante (auditoría quant Q-01, 2026-10-20). Risk valora la cartera con
// lo ya recibido en ese instante (quant-research §3). Antes, con ETH/EUR abierta, toda entrada de BTC/EUR salía
// STALE_DATA: la vela de BTC se evaluaba antes de ingerir la cotización de ETH del mismo instante, que aún era la de la
// vela anterior. El orden contrario funcionaba, porque BTC va antes que ETH al ordenar por símbolo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type BacktestSpec } from '../../../src/app/backtest.ts';
import type { ReplayEvent } from '../../../src/backtest/replay.ts';
import type { RiskDecision } from '../../../src/kernel/orders.ts';
import { scheduled, type ScheduledTrade, type ScheduledParams } from '../../../src/strategy/scheduled.ts';
import { candles, HOUR, spec, T0 } from './scenario.ts';

const BTC = 'BTC/EUR';
const ETH = 'ETH/EUR';

/** BTC/EUR y ETH/EUR con velas horarias que suben despacio (el stop no salta) y llegan en el mismo instante. */
function twoPairs(trades: readonly ScheduledTrade[]): BacktestSpec<ScheduledParams> {
  const kit = scheduled({ trades, stopFraction: 0.05 }, '1h');
  const btc = candles(Array.from({ length: 14 }, (_, i) => 100 + i));
  const eth = candles(Array.from({ length: 14 }, (_, i) => 50 + i / 2)).map((c) => ({ ...c, symbol: ETH }));
  return {
    ...spec(),
    candles: [...btc, ...eth],
    listings: new Map([[BTC, { listedAt: T0, delistedAt: null }], [ETH, { listedAt: T0, delistedAt: null }]]),
    from: T0 + HOUR,
    to: T0 + 14 * HOUR,
    featureSet: kit.featureSet,
    strategy: kit.strategy,
    params: kit.params,
  };
}

const stale = (journal: readonly ReplayEvent[]): RiskDecision[] =>
  journal.filter((e) => e.type === 'RiskDecisionMade').map((e) => e.payload as RiskDecision).filter((d) => d.reasonCodes.includes('STALE_DATA'));

const symbols = (result: ReturnType<typeof runBacktest>): string[] => result.roundTrips.map((t) => t.symbol).sort();

test('con ETH/EUR abierta, BTC/EUR entra: la cartera se valora con las velas recibidas en el mismo instante', () => {
  const result = runBacktest(twoPairs([
    { symbol: ETH, enterAt: T0 + 3 * HOUR, exitAt: T0 + 11 * HOUR },
    { symbol: BTC, enterAt: T0 + 5 * HOUR, exitAt: T0 + 8 * HOUR },
  ]));
  assert.deepEqual(stale(result.journal), [], 'ningún rechazo por datos obsoletos');
  assert.deepEqual(symbols(result), [BTC, ETH]);
});

test('y al revés: con BTC/EUR abierta, ETH/EUR entra', () => {
  const result = runBacktest(twoPairs([
    { symbol: BTC, enterAt: T0 + 3 * HOUR, exitAt: T0 + 11 * HOUR },
    { symbol: ETH, enterAt: T0 + 5 * HOUR, exitAt: T0 + 8 * HOUR },
  ]));
  assert.deepEqual(stale(result.journal), []);
  assert.deepEqual(symbols(result), [BTC, ETH]);
});
