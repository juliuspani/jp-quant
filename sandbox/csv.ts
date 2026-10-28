// Velas propias en CSV OHLCV para el sandbox (paso 49). Formato:
//   time,open,high,low,close,volume
//   2024-01-01,42000.5,42900,41800,42650.1,123.45
// - time: apertura de la vela, en UTC: fecha (2024-01-01), fecha y hora ISO 8601 con Z (2024-01-01T04:00:00Z) o un
//   instante Unix en segundos o milisegundos. Las cabeceras pueden llamarse también timestamp o date.
// - Precios y volumen en decimal con punto, sin separador de miles.
// Cada error dice la línea y qué hacer. Se rechaza lo que no se puede leer con seguridad: precios no positivos, máximos y
// mínimos incoherentes, instantes repetidos o desordenados y velas que no empiezan en su marca de tiempo. Los huecos se
// admiten y se cuentan: el Feature Engine los trata sin inventar datos.
// La vela se da por recibida un minuto después de su cierre, la latencia supuesta (sin look-ahead).
import type { HistoricalCandle } from '../src/historical/types.ts';
import { Decimal } from '../src/shared/decimal.ts';
import { closeTimeOf, isTimeframe, timeframeMs, type Timeframe, type UtcMillis } from '../src/shared/time.ts';

export const RECEIVE_LATENCY_MS = 60_000;
const MAX_ROWS = 500_000;
const DECIMAL = /^\d+(\.\d+)?$/;
const HEADERS: Readonly<Record<string, readonly string[]>> = {
  time: ['time', 'timestamp', 'date', 'datetime', 'open_time'],
  open: ['open'], high: ['high'], low: ['low'], close: ['close'], volume: ['volume', 'vol'],
};

export class CsvError extends Error {
  override readonly name = 'CsvError';
}

export interface CsvCandles {
  readonly candles: HistoricalCandle[];
  readonly timeframe: Timeframe;
  readonly gaps: number; // velas que faltan entre la primera y la última
}

function parseTime(text: string, line: number): UtcMillis {
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]00:?00)$/.test(text)) return Date.parse(text.replace(' ', 'T'));
  throw new CsvError(`línea ${String(line)}: «${text}» no es una fecha en UTC. Usa 2024-01-01, 2024-01-01T04:00:00Z o un instante Unix`);
}

function parseNumber(text: string, column: string, line: number): Decimal {
  if (!DECIMAL.test(text)) throw new CsvError(`línea ${String(line)}: ${column} «${text}» no es un número decimal con punto (por ejemplo 42000.5)`);
  return Decimal.parse(text);
}

function inferTimeframe(times: readonly UtcMillis[]): Timeframe {
  const counts = new Map<number, number>();
  for (let i = 1; i < times.length; i++) {
    const step = (times[i] ?? 0) - (times[i - 1] ?? 0);
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  const [step] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0];
  for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) if (timeframeMs(tf) === step) return tf;
  throw new CsvError(`no se reconoce el intervalo entre velas (${String(step / 60_000)} min): usa velas de 1m, 5m, 15m, 1h, 4h o 1d, o indica --timeframe`);
}

/** Las velas del CSV, validadas, con el símbolo que se les da. */
export function parseCandlesCsv(text: string, symbol: string, timeframe?: string): CsvCandles {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  const headerAt = lines.findIndex((l) => l !== '');
  if (headerAt < 0) throw new CsvError('el archivo está vacío');
  const header = (lines[headerAt] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const column = (name: string): number => {
    const i = header.findIndex((h) => (HEADERS[name] ?? []).includes(h));
    if (i < 0) throw new CsvError(`falta la columna «${name}» en la cabecera. La primera línea debe ser: time,open,high,low,close,volume`);
    return i;
  };
  const at = { time: column('time'), open: column('open'), high: column('high'), low: column('low'), close: column('close'), volume: column('volume') };
  const rows: { line: number; cells: string[] }[] = [];
  for (let i = headerAt + 1; i < lines.length; i++) if ((lines[i] ?? '') !== '') rows.push({ line: i + 1, cells: (lines[i] ?? '').split(',').map((c) => c.trim()) });
  if (rows.length < 2) throw new CsvError('hacen falta al menos dos velas');
  if (rows.length > MAX_ROWS) throw new CsvError(`más de ${String(MAX_ROWS)} velas: usa un intervalo mayor`);
  const times = rows.map((r) => parseTime(r.cells[at.time] ?? '', r.line));
  for (let i = 1; i < times.length; i++) {
    if ((times[i] ?? 0) <= (times[i - 1] ?? 0)) throw new CsvError(`línea ${String(rows[i]?.line ?? 0)}: el instante no es posterior al de la vela anterior (velas repetidas o desordenadas)`);
  }
  if (timeframe !== undefined && !isTimeframe(timeframe)) throw new CsvError(`--timeframe «${timeframe}»: usa 1m, 5m, 15m, 1h, 4h o 1d`);
  const tf: Timeframe = timeframe ?? inferTimeframe(times);
  const step = timeframeMs(tf);
  let gaps = 0;
  const candles = rows.map((row, i): HistoricalCandle => {
    const where = `línea ${String(row.line)}`;
    if (row.cells.length !== header.length) throw new CsvError(`${where}: ${String(row.cells.length)} columnas y la cabecera tiene ${String(header.length)}`);
    const openTime = times[i] ?? 0;
    if (openTime % step !== 0) throw new CsvError(`${where}: la vela no empieza en una marca de ${tf} (por ejemplo, una vela diaria empieza a las 00:00 UTC)`);
    const open = parseNumber(row.cells[at.open] ?? '', 'open', row.line);
    const high = parseNumber(row.cells[at.high] ?? '', 'high', row.line);
    const low = parseNumber(row.cells[at.low] ?? '', 'low', row.line);
    const closePrice = parseNumber(row.cells[at.close] ?? '', 'close', row.line);
    const vol = parseNumber(row.cells[at.volume] ?? '', 'volume', row.line);
    if (!open.isPositive() || !high.isPositive() || !low.isPositive() || !closePrice.isPositive()) throw new CsvError(`${where}: los precios tienen que ser mayores que cero`);
    if (high.lt(Decimal.max(open, closePrice)) || low.gt(Decimal.min(open, closePrice))) throw new CsvError(`${where}: high tiene que ser el máximo y low el mínimo de la vela`);
    if (i > 0) gaps += Math.max(0, Math.round((openTime - (times[i - 1] ?? 0)) / step) - 1);
    const closeTime = closeTimeOf(openTime, tf);
    return { symbol, timeframe: tf, openTime, closeTime, receivedTime: closeTime + RECEIVE_LATENCY_MS, open, high, low, close: closePrice, volume: vol };
  });
  return { candles, timeframe: tf, gaps };
}
