// Desgloses de rendimiento (quant-research §7; paso 26, ADR 0029): por activo, por tiempo (año UTC), por estrategia y por
// régimen de mercado. Se agrupan los periodos de la curva (cada uno con la etiqueta que se conocía al empezar) y las
// operaciones (con la etiqueta que se conocía al abrirlas). Todo es neto de costes, en la moneda de cotización.
import { toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';
import { sharpeOf } from './performance.ts';
import { tradeStats, type TradeRecord } from './trades.ts';

/** Un periodo de la curva: de `start` a `end`, con la rentabilidad neta de la estrategia y la del benchmark. */
export interface PeriodRecord {
  readonly start: UtcMillis;
  readonly end: UtcMillis;
  readonly ret: number;
  readonly benchmark: number; // la del buy-and-hold de BTC en el mismo periodo
  readonly inMarket: boolean; // con una posición que no es polvo en la marca que cierra el periodo: exposure > 0
  // Posiciones que no son polvo entre patrimonio en la marca que cierra el periodo: la posición que dio su rentabilidad,
  // porque lo que se decide en la marca anterior se ejecuta dentro del periodo (ADR 0026). La usa A.3.9 (ADR 0042).
  readonly exposure: number;
}

export interface PeriodGroup {
  readonly periods: number;
  readonly share: number; // fracción de todos los periodos
  readonly compoundedReturn: number;
  readonly meanReturn: number;
  readonly sharpeAnnualized: number | null;
  readonly timeInMarket: number;
  readonly benchmarkReturn: number; // buy-and-hold de BTC en esos mismos periodos, compuesto
}

export interface TradeGroup {
  readonly closed: number;
  readonly open: number;
  readonly netPnl: number;
  readonly hitRate: number | null;
  readonly profitFactor: number | null;
  readonly expectancy: number | null;
}

export interface FillRecord {
  readonly symbol: string;
  readonly notional: number;
  readonly fee: number;
  readonly implicit: number;
}

export interface AssetGroup extends TradeGroup {
  readonly turnover: number; // importe negociado / capital inicial total
  readonly feesPaid: number;
  readonly implicitCosts: number;
}

function compound(returns: readonly number[]): number {
  return returns.reduce((total, r) => total * (1 + r), 1) - 1;
}

function sorted<V>(groups: Map<string, V>): Readonly<Record<string, V>> {
  return Object.freeze(Object.fromEntries([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Agrupa periodos por la clave que dé `key`. */
export function groupPeriods(records: readonly PeriodRecord[], key: (r: PeriodRecord) => string, perYear: number): Readonly<Record<string, PeriodGroup>> {
  const buckets = new Map<string, PeriodRecord[]>();
  for (const r of records) {
    const k = key(r);
    const bucket = buckets.get(k) ?? [];
    bucket.push(r);
    buckets.set(k, bucket);
  }
  const groups = new Map<string, PeriodGroup>();
  for (const [k, bucket] of buckets) {
    const returns = bucket.map((r) => r.ret);
    const { sharpe } = sharpeOf(returns);
    groups.set(k, Object.freeze({
      periods: bucket.length,
      share: bucket.length / records.length,
      compoundedReturn: compound(returns),
      meanReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
      sharpeAnnualized: sharpe === null ? null : sharpe * Math.sqrt(perYear),
      timeInMarket: bucket.filter((r) => r.inMarket).length / bucket.length,
      benchmarkReturn: compound(bucket.map((r) => r.benchmark)),
    }));
  }
  return sorted(groups);
}

function tradeGroup(trades: readonly TradeRecord[], timeframe: Timeframe): TradeGroup {
  const s = tradeStats(trades, timeframe);
  return { closed: s.closed, open: s.open, netPnl: s.netPnl, hitRate: s.hitRate, profitFactor: s.profitFactor, expectancy: s.expectancy };
}

/** Agrupa operaciones por la clave que dé `key`. */
export function groupTrades(trades: readonly TradeRecord[], key: (t: TradeRecord) => string, timeframe: Timeframe): Readonly<Record<string, TradeGroup>> {
  const buckets = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const k = key(t);
    buckets.set(k, [...(buckets.get(k) ?? []), t]);
  }
  return sorted(new Map([...buckets.entries()].map(([k, bucket]) => [k, Object.freeze(tradeGroup(bucket, timeframe))])));
}

/** Por activo: sus operaciones y lo que negoció y pagó en costes. */
export function groupAssets(trades: readonly TradeRecord[], fills: readonly FillRecord[], capital: number, timeframe: Timeframe): Readonly<Record<string, AssetGroup>> {
  const symbols = new Set([...trades.map((t) => t.symbol), ...fills.map((f) => f.symbol)]);
  const groups = new Map<string, AssetGroup>();
  for (const symbol of symbols) {
    const own = fills.filter((f) => f.symbol === symbol);
    groups.set(symbol, Object.freeze({
      ...tradeGroup(trades.filter((t) => t.symbol === symbol), timeframe),
      turnover: own.reduce((a, f) => a + f.notional, 0) / capital,
      feesPaid: own.reduce((a, f) => a + f.fee, 0),
      implicitCosts: own.reduce((a, f) => a + f.implicit, 0),
    }));
  }
  return sorted(groups);
}

/**
 * Instante al que se asigna un periodo: su punto medio. Las marcas de la curva llevan el instante en que el sistema recibe
 * la vela (su cierre más la latencia de la fuente), así que el final de un periodo puede caer ya en el día siguiente; el
 * punto medio cae dentro de la vela que lo mueve mientras la latencia sea menor que media vela (paso 27B, ADR 0031).
 */
export function periodInstant(record: Pick<PeriodRecord, 'start' | 'end'>): UtcMillis {
  return record.start + Math.floor((record.end - record.start) / 2);
}

/** Año UTC de un instante. */
export function utcYear(at: UtcMillis): string {
  return toUtcIso(at).slice(0, 4);
}
