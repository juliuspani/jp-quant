// `npm run fetch-candles` (paso 49, opcional): descarga velas públicas de Kraken, sin clave de API, a un CSV que entiende
// `npm run test-strategy`. Solo hace una petición GET al endpoint público de OHLC: no hay cuenta, ni claves, ni órdenes.
// Kraken da como mucho las 720 velas más recientes de cada intervalo. Los datos son para tu uso: sus términos no permiten
// redistribuirlos, así que no los publiques ni los subas a este repositorio.
//
// Uso: npm run fetch-candles -- --pair XBTEUR --interval 1d --out my-candles.csv
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const INTERVALS: Readonly<Record<string, number>> = { '1h': 60, '4h': 240, '1d': 1440 };
const PAIR = /^[A-Z0-9]{5,12}$/;
const ENDPOINT = 'https://api.kraken.com/0/public/OHLC';

export class FetchError extends Error {
  override readonly name = 'FetchError';
}

/** Las filas del JSON de Kraken como CSV, comprobando cada una. */
export function krakenToCsv(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw new FetchError('respuesta vacía de Kraken');
  const { error, result } = body as { error?: unknown; result?: Record<string, unknown> };
  if (Array.isArray(error) && error.length > 0) throw new FetchError(`Kraken: ${error.map(String).join(', ')}`);
  const rows = Object.entries(result ?? {}).find(([key]) => key !== 'last')?.[1];
  if (!Array.isArray(rows) || rows.length === 0) throw new FetchError('Kraken no devolvió velas para ese par');
  const lines = ['time,open,high,low,close,volume'];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7 || typeof row[0] !== 'number') throw new FetchError('una vela de Kraken no tiene el formato esperado');
    const [time, open, high, low, close, , volume] = row as [number, string, string, string, string, string, string];
    for (const v of [open, high, low, close, volume]) if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) throw new FetchError(`valor no numérico en la vela ${String(time)}`);
    lines.push([String(time), open, high, low, close, volume].join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { pair: { type: 'string' }, interval: { type: 'string' }, out: { type: 'string' } } });
  const pair = values.pair ?? 'XBTEUR';
  const interval = INTERVALS[values.interval ?? '1d'];
  if (!PAIR.test(pair)) throw new FetchError('--pair: un par de Kraken como XBTEUR o ETHEUR');
  if (interval === undefined) throw new FetchError('--interval: 1h, 4h o 1d');
  if (values.out === undefined) throw new FetchError('--out <archivo.csv>');
  const response = await fetch(`${ENDPOINT}?pair=${pair}&interval=${String(interval)}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new FetchError(`Kraken respondió ${String(response.status)}`);
  const csv = krakenToCsv(await response.json());
  // La última vela de Kraken aún no ha cerrado: se quita, para no usar una vela incompleta.
  const complete = `${csv.trimEnd().split('\n').slice(0, -1).join('\n')}\n`;
  writeFileSync(values.out, complete, 'utf8');
  process.stdout.write(`fetch-candles: ${String(complete.split('\n').length - 2)} closed candles of ${pair} in ${values.out}. For your own use: do not publish or redistribute them.\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`fetch-candles: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
