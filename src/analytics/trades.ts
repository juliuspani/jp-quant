// Estadísticas de operaciones (paso 26, ADR 0029): tasa de acierto, profit factor, esperanza y relación entre ganancia y
// pérdida media de las operaciones cerradas, netas de costes. Una operación es un viaje de ida y vuelta: desde que se
// abre la posición hasta que vuelve a cero. Las abiertas al final se cuentan aparte y no entran en estas cifras.
import { timeframeMs, type Timeframe, type UtcMillis } from '../shared/time.ts';
import { AnalyticsError, finite } from './performance.ts';

export interface TradeRecord {
  readonly symbol: string;
  readonly strategy: string; // nombre@versión
  readonly openedAt: UtcMillis;
  readonly closedAt: UtcMillis | null; // null: abierta al final
  readonly invested: number; // lo pagado al abrir, con comisiones
  readonly pnl: number | null; // neto de comisiones y de lo implícito; null si sigue abierta
}

export interface TradeStats {
  readonly closed: number;
  readonly open: number;
  readonly wins: number;
  readonly losses: number; // pnl < 0; las de pnl 0 no son ni una cosa ni otra
  readonly hitRate: number | null; // ganadoras / cerradas
  readonly profitFactor: number | null; // suma de ganancias / suma de pérdidas; null sin pérdidas
  readonly expectancy: number | null; // pnl medio por operación cerrada, en la moneda de cotización
  readonly expectancyReturn: number | null; // media de pnl / invertido
  readonly averageWin: number | null;
  readonly averageLoss: number | null; // negativa
  readonly winLossRatio: number | null; // ganancia media / |pérdida media|
  readonly netPnl: number; // suma de las cerradas
  readonly meanBars: number | null; // duración media de las cerradas, en velas
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function tradeStats(trades: readonly TradeRecord[], timeframe: Timeframe): TradeStats {
  const step = timeframeMs(timeframe);
  const closed: { pnl: number; invested: number; bars: number }[] = [];
  let open = 0;
  for (const t of trades) {
    if (t.closedAt === null || t.pnl === null) {
      open++;
      continue;
    }
    if (t.closedAt < t.openedAt) throw new AnalyticsError(`${t.symbol}: operación cerrada antes de abrirse`);
    const invested = finite('invertido', t.invested);
    if (!(invested > 0)) throw new AnalyticsError(`${t.symbol}: operación sin importe invertido`);
    closed.push({ pnl: finite('pnl', t.pnl), invested, bars: (t.closedAt - t.openedAt) / step });
  }
  const wins = closed.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const losses = closed.filter((t) => t.pnl < 0).map((t) => t.pnl);
  const gained = wins.reduce((a, b) => a + b, 0);
  const lost = -losses.reduce((a, b) => a + b, 0);
  const averageWin = average(wins);
  const averageLoss = average(losses);
  return Object.freeze({
    closed: closed.length,
    open,
    wins: wins.length,
    losses: losses.length,
    hitRate: closed.length === 0 ? null : wins.length / closed.length,
    profitFactor: lost > 0 ? gained / lost : null,
    expectancy: average(closed.map((t) => t.pnl)),
    expectancyReturn: average(closed.map((t) => t.pnl / t.invested)),
    averageWin,
    averageLoss,
    winLossRatio: averageWin === null || averageLoss === null ? null : averageWin / -averageLoss,
    netPnl: closed.reduce((a, t) => a + t.pnl, 0),
    meanBars: average(closed.map((t) => t.bars)),
  });
}
