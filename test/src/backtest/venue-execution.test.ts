// El venue simulado detrás del Execution Engine real (paso 20), por el puerto ExecutionVenue y sin cambiar nada de
// Execution: el backtest solo sustituye el venue (ADR 0013 y ADR 0026). Las respuestas vuelven por temporizadores, como
// en el replay, y cada una mueve la orden por la máquina de estados.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DEPTH_MODEL } from '../../../src/backtest/book-model.ts';
import { CandleTape, type Listing } from '../../../src/backtest/candle-tape.ts';
import { executionCosts } from '../../../src/backtest/costs.ts';
import { DEFAULT_INSTRUMENT_RULES } from '../../../src/backtest/instrument-model.ts';
import { MemoryExecutionStore } from '../../../src/backtest/research-stores.ts';
import { DEFAULT_VENUE_LATENCY, SimulatedVenue } from '../../../src/backtest/simulated-venue.ts';
import { ExecutionEngine } from '../../../src/execution/engine.ts';
import type { ExecutionView, Fill } from '../../../src/kernel/execution.ts';
import { seededIds } from '../../../src/kernel/random.ts';
import type { Candle } from '../../../src/kernel/market-data.ts';
import { closeTimeOf } from '../../../src/shared/time.ts';
import { d, entry, riskBench, SYMBOL, T0 } from '../harness/trading.ts';
import { COSTS } from './venue-bench.ts';

function candle(openTime: number, volume = '100'): Candle {
  return {
    symbol: SYMBOL,
    timeframe: '1h',
    openTime,
    closeTime: closeTimeOf(openTime, '1h'),
    open: d('40000'),
    high: d('40500'),
    low: d('39500'),
    close: d('40200'),
    volume: d(volume),
  };
}

interface Options {
  readonly cash?: string;
  readonly volume?: string;
  readonly delistedAt?: number | null;
  readonly orderTtlMs?: number;
}

function wired(options: Options = {}) {
  let engine: ExecutionEngine | null = null;
  const execution = (): ExecutionEngine => {
    if (engine === null) throw new Error('Execution aún no está construido');
    return engine;
  };
  const view: ExecutionView = { status: () => execution().status() };
  const bench = riskBench({ execution: view });
  const listings = new Map<string, Listing>([[SYMBOL, { listedAt: T0 - 86_400_000, delistedAt: options.delistedAt ?? null }]]);
  const venue = new SimulatedVenue({
    clock: bench.clock,
    ids: seededIds(5, 'venue'),
    market: new CandleTape([candle(T0, options.volume)], listings),
    rules: DEFAULT_INSTRUMENT_RULES,
    costs: executionCosts(COSTS),
    depth: DEFAULT_DEPTH_MODEL,
    latency: DEFAULT_VENUE_LATENCY,
    quoteCurrency: 'EUR',
    startingCash: d(options.cash ?? '10000'),
    sinks: {
      update: (u) => {
        execution().onVenueUpdate(u);
      },
      failure: (f) => {
        execution().onVenueFailure(f);
      },
      snapshot: (s) => {
        execution().reconcile(s.orders);
      },
    },
  });
  const store = new MemoryExecutionStore();
  const recorded: Fill[] = [];
  engine = new ExecutionEngine({
    clock: bench.clock,
    venue,
    store,
    market: bench.market,
    portfolio: bench.portfolio,
    risk: bench.risk,
    approvalKey: bench.risk.approvalPublicKey,
    onRejected: (rejected) => {
      bench.risk.recordExecutionRejection(rejected);
    },
    onFill: (fill) => {
      recorded.push(fill);
    },
    orderTtlMs: options.orderTtlMs ?? 300_000,
  });
  const drain = (): void => {
    for (;;) {
      const next = bench.clock.nextTimer();
      if (next === null) return;
      bench.clock.advanceTo(next.at);
      bench.clock.takeTimer(next.timerId);
      assert.ok(venue.onTimer(next.timerId), `temporizador ajeno: ${next.timerId}`);
    }
  };
  // Arranque: Execution empieza en UNKNOWN y sale reconciliando con la foto del venue (exchange-execution §16).
  venue.requestAccountSnapshot(null);
  drain();
  const submit = (quantity = '0.01'): string => {
    const { approval } = bench.risk.evaluate(entry({ sizing: { mode: 'quantity', quantity: d(quantity) } }));
    assert.ok(approval, 'Risk debía aprobar');
    const result = execution().submit(approval);
    assert.ok(result.ok, 'Execution debía aceptar el token');
    return result.clientOrderId;
  };
  return { bench, venue, store, recorded, execution: execution(), drain, submit };
}

test('arranca en UNKNOWN y sale reconciliando con el venue; una orden aprobada llega a FILLED con sus fills', () => {
  const run = wired();
  assert.equal(run.execution.status().mode, 'NORMAL');
  const id = run.submit();
  assert.equal(run.execution.order(id)?.state, 'SENT', 'hasta que vuelve la respuesta, la orden está enviada');
  run.drain();
  assert.equal(run.execution.order(id)?.state, 'FILLED');
  assert.deepEqual(run.store.transitions().map((t) => `${t.from}>${t.to}`), ['PENDING_SEND>SENT', 'SENT>FILLED']);
  assert.deepEqual(run.store.fills().map((f) => `${f.quantity.toString()}@${f.price.toString()} fee ${f.fee.toString()}`), ['0.01@40051 fee 1.001275']);
  assert.deepEqual(run.recorded.map((f) => f.tradeId), run.store.fills().map((f) => f.tradeId), 'cada fill nuevo llega una vez a Portfolio');
});

test('sin liquidez para toda la orden: PARTIALLY_FILLED y después EXPIRED, sin dudas', () => {
  const run = wired({ volume: '0.1' }); // 0,1 × 2 % = 0,002 BTC de profundidad sintética
  const id = run.submit('0.01');
  run.drain();
  assert.equal(run.execution.order(id)?.state, 'EXPIRED');
  assert.equal(run.execution.order(id)?.filled.toString(), '0.002');
  assert.deepEqual(run.store.transitions().map((t) => `${t.from}>${t.to}`), ['PENDING_SEND>SENT', 'SENT>PARTIALLY_FILLED', 'PARTIALLY_FILLED>EXPIRED']);
  assert.equal(run.execution.status().mode, 'NORMAL');
});

test('un rechazo del exchange deja la orden en REJECTED y Risk guarda EXCHANGE_REJECTED con el código del venue', () => {
  const run = wired({ delistedAt: T0 });
  const id = run.submit();
  run.drain();
  assert.equal(run.execution.order(id)?.state, 'REJECTED');
  const rejected = run.bench.store.decisions().filter((r) => r.layer === 'exchange');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reasonCode, 'EXCHANGE_REJECTED');
  assert.match(String(rejected[0]?.detail.detail), /^SYMBOL_NOT_TRADING/);
});

test('saldo insuficiente en el venue: duda, UNKNOWN y nada más sale hasta reconciliar (fail closed)', () => {
  const run = wired({ cash: '100' });
  const id = run.submit();
  run.drain();
  assert.equal(run.execution.order(id)?.state, 'UNKNOWN');
  assert.equal(run.execution.status().mode, 'UNKNOWN');
  assert.deepEqual(run.bench.risk.tradingState().entriesBlockedBy, ['STATE_UNRECONCILED']);
  // El venue no conoce la orden: la reconciliación no la confirma y el sistema sigue en UNKNOWN (NOT_SENT, paso 36).
  run.venue.requestAccountSnapshot(null);
  run.drain();
  assert.equal(run.execution.status().mode, 'UNKNOWN');
});

test('expiresAt: una orden que llega al venue después de su TTL caduca sin ejecutarse', () => {
  const run = wired({ orderTtlMs: 500 }); // la latencia de ida es de 1 s
  const id = run.submit();
  run.drain();
  assert.equal(run.execution.order(id)?.state, 'EXPIRED');
  assert.equal(run.store.fills().length, 0);
});
