// Your strategy for `npm run test-strategy`. Copy this file, change the rules and the parameters, and run:
//
//   npm run test-strategy -- --strategy examples/my-strategy.ts --data examples/candles/synthetic-daily.csv
//
// How it works:
// - The tool calls `decide` once per closed candle, with the values of the features you ask for in `features`.
//   You only see the past: no future candle is ever available (no look-ahead).
// - Return { action: 'enter', stopPrice, reason } to buy, { action: 'exit', reason } to sell, or
//   { action: 'hold', reason } to do nothing. The size of each trade is decided by the risk engine, not by you.
// - Every entry needs a protective stop price below the current price.
// - Costs (fee, spread and slippage) are always charged. Spot only: no shorting and no leverage.
//
// Keep it honest: every run of the same strategy counts as another test, and the Deflated Sharpe gets stricter.
//
// Esta es la plantilla de estrategia del sandbox, comentada en inglés para quien llegue de fuera; el resto del proyecto
// está en español.
import { defineStrategy, ema, close } from '../sandbox/define.ts';

export default defineStrategy({
  // A name in lower case, with dashes. It identifies the strategy in your local registry.
  name: 'my-ema-cross',
  // Candle size of your data: '1h', '4h' or '1d'.
  timeframe: '1d',
  // Parameters with their default values. Change them here.
  params: { fast: 20, slow: 100, stopFraction: 0.1 },
  // Optional: a few values to try. Each period picks the best one on its training data only, and each combination
  // counts as one more test. At most 20 combinations. Delete this line to test only the defaults.
  // grid: { fast: [10, 20], slow: [50, 100] },
  // Parameters that are periods (whole numbers).
  integers: ['fast', 'slow'],
  // The features your rules need: available are ema, sma, rsi, atr, close, volume, momentum, realizedVolatility,
  // donchianHigh and donchianLow (from ../sandbox/define.ts).
  features: (p) => [close(), ema(p.fast), ema(p.slow)],
  // The rules: buy when the fast average crosses above the slow one, sell when it falls back below.
  decide: ({ features, position, params }) => {
    const price = features.values['close'] ?? null;
    const fast = features.values[`ema_${String(params.fast)}`] ?? null;
    const slow = features.values[`ema_${String(params.slow)}`] ?? null;
    if (price === null || fast === null || slow === null) return { action: 'hold', reason: 'not enough history yet' };
    if (position === null && fast > slow) return { action: 'enter', stopPrice: price * (1 - params.stopFraction), reason: 'fast EMA above slow EMA' };
    if (position !== null && fast < slow) return { action: 'exit', reason: 'fast EMA below slow EMA' };
    return { action: 'hold', reason: 'no change' };
  },
});
