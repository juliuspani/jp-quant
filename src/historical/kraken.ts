// Lector del ZIP de OHLCVT de Kraken (DATA.md §3): un CSV por par y marco, sin cabecera, con
// `timestamp,open,high,low,close,volume,trades` y el timestamp de apertura en segundos Unix UTC. Los valores se
// leen como texto decimal, también en notación científica (DATA.md §4); una fila que no se entiende se rechaza con
// su motivo, nunca se adivina.
import { Decimal } from '../shared/decimal.ts';
import { addMs, closeTimeOf, floorToTimeframe, parseUnixSeconds, parseUnixSecondsFraction, parseUtcIso, toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';
import type { RawPeriod } from './guard.ts';
import type { HistoricalCandle, SymbolId } from './types.ts';

// Kraken escribe en notación científica los valores pequeños («2.333e-07»): se leen de forma exacta (ADR 0014 §5).
function krakenDecimal(text: string): Decimal {
  return /[eE]/.test(text) ? Decimal.parseScientific(text) : Decimal.parse(text);
}

/**
 * Desde esta fecha los ZIP de OHLCVT de Kraken traen los pares dados de baja (DATA.md §5): el primero dejó de negociarse
 * el 2023-01-01. Antes faltan los deslistados antiguos, y el universo tendría sesgo de supervivencia.
 */
export const KRAKEN_DELISTINGS_FROM_UTC = '2023-01-01T00:00:00Z';

export interface KrakenOptions {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  /** Latencia mínima de la fuente en ms: received_time = cierre + latencia (ARCHITECTURE.md §5.1). */
  readonly receivedLatencyMs: number;
}

export interface RejectedRow {
  readonly row: number; // índice de la fila en el archivo, desde 0
  readonly reason: string;
}

export function parseKrakenOhlcvt(csv: string, options: KrakenOptions): { candles: HistoricalCandle[]; rejected: RejectedRow[] } {
  const candles: HistoricalCandle[] = [];
  const rejected: RejectedRow[] = [];
  const rows = csv.split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  for (const [row, line] of rows.entries()) {
    try {
      const fields = line.split(',');
      if (fields.length !== 7) throw new SyntaxError(`se esperaban 7 campos y hay ${String(fields.length)}`);
      const [time = '', open = '', high = '', low = '', close = '', volume = ''] = fields;
      const openTime = parseUnixSeconds(time);
      const closeTime = closeTimeOf(openTime, options.timeframe);
      candles.push({
        symbol: options.symbol,
        timeframe: options.timeframe,
        openTime,
        closeTime,
        receivedTime: addMs(closeTime, options.receivedLatencyMs),
        open: krakenDecimal(open),
        high: krakenDecimal(high),
        low: krakenDecimal(low),
        close: krakenDecimal(close),
        volume: krakenDecimal(volume),
      });
    } catch (e) {
      rejected.push({ row, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { candles, rejected };
}

// Nombre de cada CSV en el ZIP: `<altname>_<minutos>.csv`, con el altname de AssetPairs («XBTEUR_60.csv»). Solo se
// capturan los pares en EUR y los marcos que usa el research (DATA.md §1); 1, 5, 15, 30 y 720 minutos se ignoran.
const CSV_NAME = /^([A-Z0-9]+)(EUR)_(\d+)\.csv$/;
const CAPTURED_INTERVALS: Readonly<Record<string, Timeframe>> = { '60': '1h', '240': '4h', '1440': '1d' };
// Los dos alias propios de Kraken más conocidos; el resto de bases se queda con el nombre de Kraken (ADR 0022).
const BASE_ALIASES: Readonly<Record<string, string>> = { XBT: 'BTC', XDG: 'DOGE' };

export interface KrakenCsvFile {
  readonly pair: string; // altname de Kraken: «XBTEUR»
  readonly symbol: SymbolId; // unificado: «BTC/EUR»
  readonly timeframe: Timeframe;
}

/** Par y marco de un CSV del ZIP, o null si no es un par en EUR en un marco capturado. */
export function parseKrakenCsvName(name: string): KrakenCsvFile | null {
  const [, base, quote, interval] = CSV_NAME.exec(name) ?? [];
  const timeframe = CAPTURED_INTERVALS[interval ?? ''];
  if (base === undefined || quote === undefined || timeframe === undefined) return null;
  return { pair: `${base}${quote}`, symbol: `${BASE_ALIASES[base] ?? base}/${quote}`, timeframe };
}

/** Un trade de la API pública `Trades` con sus valores como texto: precio, volumen y segundos Unix con decimales. */
export interface KrakenTrade {
  readonly price: string;
  readonly volume: string;
  readonly time: string;
}

/**
 * Velas rehechas desde los trades, con las reglas del OHLCVT: solo intervalos con trades, apertura y cierre por
 * orden de llegada. Sirve para comprobar el ZIP (DATA.md §4), no como fuente de investigación.
 */
export function candlesFromKrakenTrades(trades: readonly KrakenTrade[], options: KrakenOptions): { candles: HistoricalCandle[]; trades: Map<UtcMillis, number> } {
  const groups = new Map<UtcMillis, KrakenTrade[]>();
  for (const t of trades) {
    const openTime = floorToTimeframe(parseUnixSecondsFraction(t.time), options.timeframe);
    const group = groups.get(openTime);
    if (group === undefined) groups.set(openTime, [t]);
    else group.push(t);
  }
  const candles: HistoricalCandle[] = [];
  for (const [openTime, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const prices = group.map((t) => krakenDecimal(t.price));
    const [open, close] = [prices[0], prices.at(-1)];
    if (open === undefined || close === undefined) continue;
    const closeTime = closeTimeOf(openTime, options.timeframe);
    candles.push({
      symbol: options.symbol,
      timeframe: options.timeframe,
      openTime,
      closeTime,
      receivedTime: addMs(closeTime, options.receivedLatencyMs),
      open,
      high: Decimal.max(...prices),
      low: Decimal.min(...prices),
      close,
      volume: group.map((t) => krakenDecimal(t.volume)).reduce((sum, v) => sum.plus(v)),
    });
  }
  return { candles, trades: new Map([...groups].map(([openTime, group]) => [openTime, group.length])) };
}

// Periodo de cada fichero bruto de Kraken según su nombre (paso 19B, ADR 0022). La guarda lo usa para decidir si es
// de investigación o del test final; un nombre que no se reconoce no tiene periodo y no se lee ni se descarga.
const QUARTERS: Readonly<Record<string, { readonly first: string; readonly last: string }>> = {
  '1': { first: '01-01', last: '03-31' },
  '2': { first: '04-01', last: '06-30' },
  '3': { first: '07-01', last: '09-30' },
  '4': { first: '10-01', last: '12-31' },
};
const FULL_ZIP = /^Kraken_OHLCVT_Full_(\d{4})Q([1-4])\.zip(?:\.part\d{2})?$/;
const QUARTER_ZIP = /^Kraken_OHLCVT_(\d{4})Q([1-4])\.zip$/;
const ASSET_PAIRS = /^AssetPairs_(\d{4}-\d{2}-\d{2})\.json$/;
const TRADES = /^Trades_[A-Z0-9]+_(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export function krakenRawPeriod(fileName: string): RawPeriod | null {
  const full = FULL_ZIP.exec(fileName);
  const quarter = full ?? QUARTER_ZIP.exec(fileName);
  const q = QUARTERS[quarter?.[2] ?? ''];
  if (quarter !== null && q !== undefined) {
    // El completo va desde el primer trade de cada par: su primer instante no se conoce por el nombre.
    return { firstUtc: full === null ? `${quarter[1] ?? ''}-${q.first}T00:00:00Z` : null, lastUtc: `${quarter[1] ?? ''}-${q.last}T23:59:59Z` };
  }
  // Foto del listado: cubre el día en que se tomó.
  const pairs = ASSET_PAIRS.exec(fileName)?.[1];
  if (pairs !== undefined) return { firstUtc: `${pairs}T00:00:00Z`, lastUtc: `${pairs}T23:59:59Z` };
  // Trades de un día: la última página puede pasarse del día, como mucho hasta el final del siguiente.
  const trades = TRADES.exec(fileName)?.[1];
  if (trades !== undefined) return { firstUtc: `${trades}T00:00:00Z`, lastUtc: toUtcIso(addMs(parseUtcIso(`${trades}T23:59:59Z`), DAY_MS)) };
  return null;
}
