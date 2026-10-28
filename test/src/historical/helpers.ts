// Velas de prueba para test/src/historical/.
import { Decimal } from '../../../src/shared/decimal.ts';
import { closeTimeOf, type Timeframe } from '../../../src/shared/time.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';

export const LATENCY_MS = 1000;

export function candle(
  symbol: string,
  openTime: number,
  prices: { o?: string; h?: string; l?: string; c?: string; v?: string } = {},
  timeframe: Timeframe = '1h',
): HistoricalCandle {
  const closeTime = closeTimeOf(openTime, timeframe);
  return {
    symbol,
    timeframe,
    openTime,
    closeTime,
    receivedTime: closeTime + LATENCY_MS,
    open: Decimal.parse(prices.o ?? '100'),
    high: Decimal.parse(prices.h ?? '110'),
    low: Decimal.parse(prices.l ?? '90'),
    close: Decimal.parse(prices.c ?? '105'),
    volume: Decimal.parse(prices.v ?? '1.5'),
  };
}

export const HOUR = 3_600_000;
export const T0 = Date.UTC(2020, 0, 1);
export const at = (hours: number): number => T0 + hours * HOUR;
