// Escenario de replay para las pruebas de determinismo (ADR 0021): velas sintéticas de tres pares de dos fuentes con
// received_time que empatan, y un handler que usa Decimal, el reloj, temporizadores, azar e ids con semilla. Lo
// importan replay.test.ts y test/fixtures/replay/run.ts (la ejecución en otro proceso).
import { ReplayEngine, type ReplayConfig, type ReplayHandler, type ReplayRecord } from '../../../src/backtest/replay.ts';
import type { Sleeper } from '../../../src/kernel/clock.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { candle, HOUR, T0 } from '../historical/helpers.ts';

export const SYMBOLS = ['BTC/EUR', 'ETH/EUR', 'SOL/EUR'];
export const HOURS = 48;
export const CONFIG: ReplayConfig = { runId: 'determinismo', seed: 20261008 };
export const noSleep: Sleeper = { sleep: () => Promise.resolve() };

export function scenarioCandles(): HistoricalCandle[] {
  return SYMBOLS.flatMap((symbol, s) =>
    Array.from({ length: HOURS }, (_, i) => {
      const close = `${String(100 + ((i * 7 + s * 3) % 11))}.${String((i * 13 + s) % 100).padStart(2, '0')}`;
      return candle(symbol, T0 + i * HOUR, { h: '120', c: close, v: `0.${String(1 + ((i + s) % 9))}` });
    }),
  );
}

/** Registros de una fuente: sourceSeq es el orden en que la fuente los dio. */
export function toRecords(candles: readonly HistoricalCandle[], source: string): ReplayRecord[] {
  return candles.map((c, i) => ({
    type: 'CandleClosed',
    source,
    sourceSeq: i,
    eventTime: c.closeTime,
    receivedTime: c.receivedTime,
    payload: {
      candle: { symbol: c.symbol, timeframe: c.timeframe, openTime: c.openTime, closeTime: c.closeTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
    },
  }));
}

/** Dos fuentes: las velas de BTC llegan por otra, con los mismos received_time, para ejercitar el desempate. */
export function scenarioRecords(): ReplayRecord[] {
  const candles = scenarioCandles();
  return [
    ...toRecords(candles.filter((c) => c.symbol !== 'BTC/EUR'), 'kraken-zip'),
    ...toRecords(candles.filter((c) => c.symbol === 'BTC/EUR'), 'bitvavo-api'),
  ];
}

interface CandlePayload {
  readonly candle: { readonly symbol: string; readonly openTime: number; readonly close: Decimal };
}

/** Handler nuevo en cada run: media de tres cierres por par, señal si el cierre la supera y temporizador a 30 min. */
export function strategyHandler(): ReplayHandler {
  const closes = new Map<string, Decimal[]>();
  return (event, ctx) => {
    if (event.type === 'TimerFired') {
      ctx.output('TimerSeen', { now: ctx.clock.now(), timer: event.payload });
      return undefined;
    }
    const { symbol, openTime, close } = (event.payload as CandlePayload).candle;
    const last = [...(closes.get(symbol) ?? []), close].slice(-3);
    closes.set(symbol, last);
    if (last.length < 3) return undefined;
    const sma = last.reduce((a, b) => a.plus(b), Decimal.parse('0')).div(Decimal.parse('3'), 8, 'HALF_EVEN');
    if (close.gt(sma)) {
      ctx.output('Signal', { symbol, close, sma, noise: ctx.rng.next(), ref: ctx.ids.next() });
      ctx.clock.schedule(ctx.clock.now() + HOUR / 2, `revisar:${symbol}:${String(openTime)}`);
    }
    return undefined;
  };
}

export function runScenario(records: readonly ReplayRecord[] = scenarioRecords(), config: ReplayConfig = CONFIG): ReplayEngine {
  const engine = new ReplayEngine(records, [strategyHandler()], config, noSleep);
  engine.run();
  return engine;
}
