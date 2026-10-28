// Excepción transitoria: strategy/ puede importar src/indicators.ts, src/types.ts y src/config.ts.
import { sma } from '../indicators.ts';

export const legacySignal = (prices: number[]): boolean => sma(prices) > 0;
