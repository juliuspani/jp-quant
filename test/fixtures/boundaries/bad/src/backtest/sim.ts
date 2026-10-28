// Sin la excepción transitoria del paso 23: backtest/ ya no puede importar strategy/ (la compone app/).
import { wantsToBuy } from '../strategy/signal.ts';

export const legacyBacktest = (): boolean => wantsToBuy();
