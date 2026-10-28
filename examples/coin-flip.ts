// A strategy with no edge at all, on purpose: it buys and sells at random (a fixed, repeatable "coin flip" per candle).
// Run it to see what the tool says about pure luck:
//
//   npm run test-strategy -- --strategy examples/coin-flip.ts --data examples/candles/synthetic-daily.csv
//
// It trades often, so there is enough data to judge. A sound test should say it is indistinguishable from luck. If a
// coin flip ever "passed", the test itself would be broken.
//
// Estrategia sin ninguna ventaja, a propósito: el control negativo del sandbox. Si la herramienta la aprobara, la prueba
// estaría rota.
import { close, defineStrategy } from '../sandbox/define.ts';

/** A repeatable number in [0, 1) from the candle time: the same candle always gets the same "coin". */
function coin(asOf: number, salt: number): number {
  const x = Math.sin((asOf / 86_400_000) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export default defineStrategy({
  name: 'coin-flip',
  timeframe: '1d',
  params: { enterChance: 0.3, exitChance: 0.3, stopFraction: 0.15 },
  features: () => [close()],
  decide: ({ asOf, features, position, params }) => {
    const price = features.values['close'] ?? null;
    if (price === null) return { action: 'hold', reason: 'no price yet' };
    if (position === null) {
      return coin(asOf, 1) < params.enterChance ? { action: 'enter', stopPrice: price * (1 - params.stopFraction), reason: 'coin says buy' } : { action: 'hold', reason: 'coin says wait' };
    }
    return coin(asOf, 2) < params.exitChance ? { action: 'exit', reason: 'coin says sell' } : { action: 'hold', reason: 'coin says keep' };
  },
});
