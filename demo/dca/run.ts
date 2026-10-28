// Replay del bot de plan B (paso 49, ADR 0048): el bot de demo/dca/bot.ts sobre los mismos precios sintéticos de la demo,
// con el venue simulado, el reloj del replay y los almacenes en memoria del backtester. Determinista: la misma semilla da
// el mismo diario. Vive en demo/, fuera de src/, como el replay de la demo (INV-14a): no es un resultado de investigación.
// El reparto objetivo es un ejemplo para la demostración, no una recomendación.
import { quoteFromCandle, DEFAULT_DEPTH_MODEL } from '../../src/backtest/book-model.ts';
import { CandleTape } from '../../src/backtest/candle-tape.ts';
import { executionCosts } from '../../src/backtest/costs.ts';
import { DEFAULT_INSTRUMENT_RULES, instrumentFor } from '../../src/backtest/instrument-model.ts';
import { ReplayEngine, type ReplayContext, type ReplayHandler, type ReplayRecord } from '../../src/backtest/replay.ts';
import { MemoryExecutionStore, MemoryRiskStore } from '../../src/backtest/research-stores.ts';
import { DEFAULT_VENUE_LATENCY, SimulatedVenue } from '../../src/backtest/simulated-venue.ts';
import type { HistoricalCandle } from '../../src/historical/types.ts';
import type { Sleeper } from '../../src/kernel/clock.ts';
import type { RawMarketData } from '../../src/kernel/market-data.ts';
import { seededIds, seededUuids } from '../../src/kernel/random.ts';
import { DEFAULT_RISK_LIMITS } from '../../src/risk/limits.ts';
import { canonicalJson } from '../../src/shared/canonical.ts';
import { Decimal } from '../../src/shared/decimal.ts';
import { timeframeMs, toUtcIso, type UtcMillis } from '../../src/shared/time.ts';
import { DEMO_COSTS, DEMO_SEED, DEMO_T0, demoCandles } from '../replay.ts';
import { PLAN_B_ID, PLAN_B_VERSION, PlanBBot, type PlanBPlan } from './bot.ts';

const DAY = timeframeMs('1d');
const START = (DEMO_T0 + 20 * DAY) as UtcMillis; // con unas velas antes, para que haya precio al empezar
const END = (DEMO_T0 + 151 * DAY) as UtcMillis;
const RUN_ID = 'demo-plan-b';
const noSleep: Sleeper = { sleep: () => Promise.resolve() };

/** El plan de la demostración: 24 % en BTC y 16 % en ETH, comprando cada semana y revisando cada cuatro. */
export const DEMO_PLAN: PlanBPlan = Object.freeze({
  target: Object.freeze({ 'BTC/EUR': '0.24', 'ETH/EUR': '0.16' }),
  contribution: '400',
  everyMs: 7 * DAY,
  rebalanceEveryMs: 28 * DAY,
  band: '0.03',
  stopFraction: '0.35',
});

export interface PlanBRun {
  readonly jsonl: string; // diario inversor-replay/1, como el de la demo
  readonly card: string; // ficha del dashboard, con el reparto objetivo
  readonly halted: string | null;
}

export function planBRun(plan: PlanBPlan = DEMO_PLAN): PlanBRun {
  const candles: HistoricalCandle[] = demoCandles();
  const costs = executionCosts(DEMO_COSTS);
  const rules = DEFAULT_INSTRUMENT_RULES;
  const listings = new Map([...new Set(candles.map((c) => c.symbol))].map((symbol) => [symbol, { listedAt: DEMO_T0, delistedAt: null }]));
  const tape = new CandleTape(candles, listings);
  const instants = new Map<UtcMillis, HistoricalCandle[]>();
  for (const candle of candles) instants.set(candle.receivedTime, [...(instants.get(candle.receivedTime) ?? []), candle]);
  const records: ReplayRecord[] = candles.map((candle, i) => ({
    type: 'RawMarketDataReceived', source: 'historical', sourceSeq: i, eventTime: candle.closeTime, receivedTime: candle.receivedTime, payload: Object.freeze({ ...candle }),
  }));
  let context: ReplayContext | null = null;
  let bot: PlanBBot | null = null;
  let venue: SimulatedVenue | null = null;
  let deliveredAt: UtcMillis | null = null;
  const handler: ReplayHandler = (event, ctx) => {
    context = ctx;
    try {
      if (event.type === 'TimerFired') {
        const payload = event.payload as { readonly timerId?: unknown } | null;
        if (venue === null || typeof payload?.timerId !== 'string' || !venue.onTimer(payload.timerId)) throw new Error('temporizador desconocido');
      } else if (event.type === 'RawMarketDataReceived') {
        if (bot === null) throw new Error('bot sin construir');
        if (deliveredAt === event.receivedTime) return undefined;
        deliveredAt = event.receivedTime;
        const raws: RawMarketData[] = [];
        for (const candle of instants.get(event.receivedTime) ?? []) {
          const instrument = instrumentFor(candle.symbol, candle.close, rules, tape.listed(candle.symbol, event.receivedTime) === true, event.receivedTime);
          const { receivedTime: _received, ...plain } = candle;
          raws.push(
            { kind: 'instruments', instruments: [instrument] },
            { kind: 'quote', quote: quoteFromCandle(candle, instrument, costs.halfSpread, DEFAULT_DEPTH_MODEL, event.receivedTime) },
            { kind: 'candle', candle: plain, closed: true },
          );
        }
        bot.onMarketBatch(raws, event.receivedTime);
      } else {
        throw new Error(`evento desconocido: ${event.type}`);
      }
    } finally {
      context = null;
    }
    return undefined;
  };
  const engine = new ReplayEngine(records, [handler], { runId: RUN_ID, seed: DEMO_SEED, segment: { from: START, to: END } }, noSleep);
  const startingCash = Decimal.parse('10000');
  venue = new SimulatedVenue({
    clock: engine.clock, ids: seededIds(DEMO_SEED, 'venue'), market: tape, rules, costs, depth: DEFAULT_DEPTH_MODEL, latency: DEFAULT_VENUE_LATENCY,
    quoteCurrency: 'EUR', startingCash,
    sinks: { update: (u) => bot?.onVenueUpdate(u), failure: (f) => bot?.onVenueFailure(f), snapshot: (s) => bot?.onAccountSnapshot(s) },
  });
  bot = new PlanBBot({
    clock: engine.clock, intentIds: seededIds(DEMO_SEED, 'intent'), approvalIds: seededUuids(DEMO_SEED, 'approval'), venue,
    riskStore: new MemoryRiskStore(), executionStore: new MemoryExecutionStore(), riskLimits: DEFAULT_RISK_LIMITS, quoteCurrency: 'EUR', startingCash,
    commit: 'demo', orderTtlMs: 300_000, startAt: START, plan,
    journal: (type, payload) => {
      if (context === null) throw new Error(`${type} fuera de un evento del replay`);
      context.output(type, payload);
    },
  });
  bot.start();
  engine.run();
  const result = engine.result();
  const header = canonicalJson({ format: 'inversor-replay/1', runId: RUN_ID, seed: DEMO_SEED, segment: { from: START, to: END }, journalSha256: result.sha256 });
  const footer = canonicalJson({ events: result.journal.length, clock: result.journal.at(-1)?.receivedTime ?? END });
  const jsonl = `${[header, ...result.journal.map((e) => canonicalJson(e)), footer].join('\n')}\n`;
  // El objetivo de la ficha, por activo, con el resto en efectivo: así la tarjeta del plan B compara también la caja.
  const objetivo: Record<string, string> = Object.fromEntries(Object.entries(plan.target).map(([symbol, weight]) => [symbol.split('/')[0] ?? symbol, weight]));
  const invested = Object.values(plan.target).reduce((sum, w) => sum.plus(Decimal.parse(w)), Decimal.parse('0'));
  objetivo['EUR'] = Decimal.parse('1').minus(invested).toString();
  const card = JSON.stringify({
    etiqueta: 'Demostración con datos sintéticos: bot de plan B, compras periódicas y rebalanceo en paper. El reparto es un ejemplo, no una recomendación',
    datos: 'sinteticos',
    estrategia: { id: PLAN_B_ID, version: PLAN_B_VERSION, parametros: { aportacion: Number(plan.contribution), diasEntreCompras: plan.everyMs / DAY, diasEntreRevisiones: plan.rebalanceEveryMs / DAY, banda: Number(plan.band), stop: Number(plan.stopFraction) } },
    temporalidad: '1d',
    costes: DEMO_COSTS,
    referencia: 'BTC/EUR',
    planB: { objetivo, proximoRebalanceo: toUtcIso(bot.nextRebalanceAt) },
  });
  return { jsonl, card, halted: bot.halted };
}
