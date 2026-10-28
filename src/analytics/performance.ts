// Métricas de rendimiento (ARCHITECTURE.md §4.2: Analytics; paso 24, ADR 0027; ampliadas en el paso 26, ADR 0029). Es el
// último eslabón del camino Data → Features → Strategy → Risk → Execution → Fill → Portfolio → Analytics: resume la curva
// de patrimonio y los fills. Son análisis, en float: el dinero se lleva en Decimal en portfolio/ y aquí solo se describe.
// Sin E/S y sin decidir nada.
//
// Rentabilidades por periodo de la curva marcada a mercado; Sharpe y Sortino por periodo sin tipo libre de riesgo y
// anualizados con 365 días (quant-research §3). Todo es neto de costes: la curva ya los descuenta. Los costes se separan
// en comisiones y en lo implícito (medio spread, slippage e impacto), ambos realizados en cada fill, más la venta supuesta
// al final. La rentabilidad bruta es la neta más esos costes; en el control aleatorio sobre precios sin estructura debe
// quedar cerca de cero.
import { timeframeMs, type Timeframe, type UtcMillis } from '../shared/time.ts';
import { moments, sortedQuantile } from './statistics.ts';

const YEAR_MS = 365 * 86_400_000;
const TAIL = 0.05;

export interface EquitySample {
  readonly at: UtcMillis;
  readonly equity: number;
  readonly exposure: number; // valor de las posiciones, en la moneda de cotización
  readonly exposureWithoutDust: number; // el de las que no son polvo (ADR 0033): el de A.3.9 (ADR 0042)
}

export interface FillCost {
  readonly notional: number; // cantidad por precio
  readonly fee: number;
  readonly implicit: number; // medio spread, slippage e impacto frente al precio de referencia, realizados
}

export interface PerformanceInput {
  readonly timeframe: Timeframe;
  readonly startEquity: number;
  readonly endEquity: number; // valor de liquidación al final, neto de los costes de vender lo abierto
  readonly curve: readonly EquitySample[]; // una muestra por vela evaluada, en orden
  readonly fills: readonly FillCost[];
  readonly liquidationCost: number; // comisión, medio spread y slippage de vender al final lo que queda abierto
}

export interface Drawdown {
  readonly maxDrawdown: number; // en fracción del máximo previo
  readonly maxDuration: number; // periodos desde un máximo hasta recuperarlo (o hasta el final): la racha más larga
}

export interface TailLosses {
  readonly valueAtRisk95: number; // pérdida del cuantil 5 % de las rentabilidades por periodo (positiva si es pérdida)
  readonly expectedShortfall95: number; // pérdida media en ese 5 % peor
  readonly worstPeriod: number; // la peor rentabilidad por periodo
}

export interface PerformanceSummary {
  readonly periods: number; // rentabilidades por periodo
  readonly netPnl: number; // en la moneda de cotización
  readonly netReturn: number;
  readonly cagr: number | null;
  readonly meanReturn: number | null; // por periodo
  readonly volatility: number | null; // desviación típica muestral por periodo
  readonly volatilityAnnualized: number | null;
  readonly sharpe: number | null; // por periodo, sin anualizar
  readonly sharpeAnnualized: number | null; // × √(periodos en 365 días)
  readonly sortinoAnnualized: number | null;
  readonly maxDrawdown: number;
  readonly maxDrawdownDuration: number; // en periodos
  readonly calmar: number | null; // CAGR / caída máxima
  readonly tail: TailLosses | null;
  readonly timeInMarket: number | null; // fracción de muestras con posición que no es polvo
  readonly meanExposure: number | null; // media de posiciones sin polvo / patrimonio
  readonly turnover: number; // importe negociado / patrimonio inicial
  readonly feesPaid: number;
  readonly implicitCosts: number; // medio spread, slippage e impacto realizados
  readonly totalCosts: number; // comisiones + implícitos + liquidación
  readonly costReturn: number; // costes totales / patrimonio inicial
  readonly grossReturn: number; // neta + costes, en fracción del patrimonio inicial
}

export class AnalyticsError extends Error {
  override readonly name = 'AnalyticsError';
}

export function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new AnalyticsError(`${name} no es un número finito: ${String(value)}`);
  return value;
}

/** Rentabilidades simples entre puntos consecutivos de la serie. */
export function periodReturns(equity: readonly number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const previous = equity[i - 1] ?? Number.NaN;
    const current = equity[i] ?? Number.NaN;
    if (!(previous > 0)) throw new AnalyticsError(`patrimonio no positivo en la posición ${String(i - 1)}`);
    returns.push(finite('rentabilidad', current / previous - 1));
  }
  return returns;
}

/** Media, desviación típica muestral y Sharpe por periodo; null si hay menos de dos valores o ninguna variación. */
export function sharpeOf(returns: readonly number[]): { mean: number | null; volatility: number | null; sharpe: number | null } {
  if (returns.length < 2) return { mean: returns[0] ?? null, volatility: null, sharpe: null };
  const { mean, std } = moments(returns);
  return { mean, volatility: std, sharpe: std > 0 ? mean / std : null };
}

/** Sortino por periodo: media entre la desviación a la baja (raíz de la media de min(r, 0)²); null sin pérdidas. */
export function sortinoOf(returns: readonly number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = Math.sqrt(returns.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / returns.length);
  return downside > 0 ? mean / downside : null;
}

/** Caída máxima desde un máximo previo y la duración más larga de una caída, del máximo a su recuperación, en periodos. */
export function drawdownOf(equity: readonly number[]): Drawdown {
  let peak = Number.NEGATIVE_INFINITY;
  let peakIndex = 0;
  let maxDrawdown = 0;
  let maxDuration = 0;
  for (const [i, value] of equity.entries()) {
    finite('patrimonio', value);
    if (value >= peak) {
      if (i - peakIndex > 1) maxDuration = Math.max(maxDuration, i - peakIndex); // recupera el máximo tras una caída
      peak = value;
      peakIndex = i;
    } else {
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
      maxDuration = Math.max(maxDuration, i - peakIndex);
    }
  }
  return Object.freeze({ maxDrawdown, maxDuration });
}

/** Periodos de `timeframe` en un año de 365 días. */
export function periodsPerYear(timeframe: Timeframe): number {
  return YEAR_MS / timeframeMs(timeframe);
}

/** Rentabilidad anual compuesta de `periods` periodos; −1 si el patrimonio final no es positivo. */
export function cagrOf(start: number, end: number, periods: number, perYear: number): number | null {
  if (periods < 1 || !(start > 0)) return null;
  if (!(end > 0)) return -1;
  return (end / start) ** (perYear / periods) - 1;
}

/** Pérdidas de cola históricas al 95 %: VaR, expected shortfall y peor periodo. null sin rentabilidades. */
export function tailLossesOf(returns: readonly number[]): TailLosses | null {
  if (returns.length === 0) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const cut = sortedQuantile(sorted, TAIL);
  const tail = sorted.filter((r) => r <= cut);
  return Object.freeze({
    valueAtRisk95: -cut,
    expectedShortfall95: -(tail.reduce((a, b) => a + b, 0) / tail.length),
    worstPeriod: sorted[0] ?? 0,
  });
}

export interface AlphaBeta {
  readonly beta: number;
  readonly alpha: number; // por periodo
  readonly alphaAnnualized: number; // × periodos en 365 días
  readonly correlation: number | null;
}

/** Regresión por mínimos cuadrados de la estrategia sobre el benchmark, periodo a periodo; null si no se puede estimar. */
export function alphaBetaOf(strategy: readonly number[], benchmark: readonly number[], perYear: number): AlphaBeta | null {
  if (strategy.length !== benchmark.length) throw new AnalyticsError(`${String(strategy.length)} rentabilidades frente a ${String(benchmark.length)} del benchmark`);
  const n = strategy.length;
  if (n < 3) return null;
  const ms = strategy.reduce((a, b) => a + b, 0) / n;
  const mb = benchmark.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vb = 0;
  let vs = 0;
  for (let i = 0; i < n; i++) {
    const ds = (strategy[i] ?? 0) - ms;
    const db = (benchmark[i] ?? 0) - mb;
    cov += ds * db;
    vb += db * db;
    vs += ds * ds;
  }
  if (!(vb > 0)) return null;
  const beta = cov / vb;
  const alpha = ms - beta * mb;
  return Object.freeze({ beta, alpha, alphaAnnualized: alpha * perYear, correlation: vs > 0 ? cov / Math.sqrt(vb * vs) : null });
}

export function summarize(input: PerformanceInput): PerformanceSummary {
  const start = finite('patrimonio inicial', input.startEquity);
  if (!(start > 0)) throw new AnalyticsError('patrimonio inicial no positivo');
  const end = finite('patrimonio final', input.endEquity);
  const liquidation = finite('coste de liquidación', input.liquidationCost);
  for (let i = 1; i < input.curve.length; i++) {
    if ((input.curve[i]?.at ?? 0) <= (input.curve[i - 1]?.at ?? 0)) throw new AnalyticsError('curva de patrimonio fuera de orden');
  }
  const equity = [start, ...input.curve.map((p) => finite('patrimonio', p.equity))];
  const returns = periodReturns(equity);
  const { mean, volatility, sharpe } = sharpeOf(returns);
  const sortino = sortinoOf(returns);
  const perYear = periodsPerYear(input.timeframe);
  const annual = Math.sqrt(perYear);
  let traded = 0;
  let fees = 0;
  let implicit = 0;
  for (const fill of input.fills) {
    traded += finite('importe', fill.notional);
    fees += finite('comisión', fill.fee);
    implicit += finite('coste implícito', fill.implicit);
  }
  const totalCosts = fees + implicit + liquidation;
  const netReturn = end / start - 1;
  // La caída cuenta también la liquidación final: es lo que se cobraría al cerrar.
  const { maxDrawdown, maxDuration } = drawdownOf([...equity, end]);
  const cagr = cagrOf(start, end, returns.length, perYear);
  // Sin polvo (ADR 0033): un resto que no se puede vender no es estar en mercado.
  const exposures = input.curve.filter((p) => p.equity > 0).map((p) => finite('exposición sin polvo', p.exposureWithoutDust) / p.equity);
  return Object.freeze({
    periods: returns.length,
    netPnl: end - start,
    netReturn,
    cagr,
    meanReturn: mean,
    volatility,
    volatilityAnnualized: volatility === null ? null : volatility * annual,
    sharpe,
    sharpeAnnualized: sharpe === null ? null : sharpe * annual,
    sortinoAnnualized: sortino === null ? null : sortino * annual,
    maxDrawdown,
    maxDrawdownDuration: maxDuration,
    calmar: cagr === null || maxDrawdown === 0 ? null : cagr / maxDrawdown,
    tail: tailLossesOf(returns),
    timeInMarket: input.curve.length === 0 ? null : input.curve.filter((p) => p.exposureWithoutDust > 0).length / input.curve.length,
    meanExposure: exposures.length === 0 ? null : exposures.reduce((a, b) => a + b, 0) / exposures.length,
    turnover: traded / start,
    feesPaid: fees,
    implicitCosts: implicit,
    totalCosts,
    costReturn: totalCosts / start,
    grossReturn: netReturn + totalCosts / start,
  });
}
