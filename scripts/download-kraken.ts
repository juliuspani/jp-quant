// Descargador de Kraken (paso 19B, ADR 0022). La guarda decide el destino antes de cualquier petición: lo que pasa de
// researchDataEndUtc (el ZIP trimestral 2026Q4 en adelante, una foto de AssetPairs de hoy, trades recientes) se niega
// sin el desbloqueo del ADR 0020. No sobrescribe nada. Descargar es una acción con permiso (DATA.md §4).
//   node scripts/download-kraken.ts Kraken_OHLCVT_2026Q3.zip
//   node scripts/download-kraken.ts Kraken_OHLCVT_Full_2026Q2.zip.part00
//   node scripts/download-kraken.ts Trades_XBTEUR_2026-06-15.jsonl
//   node scripts/download-kraken.ts AssetPairs_<hoy UTC>.json
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { defaultGuard } from '../src/historical/guard.ts';
import { KRAKEN_API_URL, KRAKEN_ASSETS_URL, krakenDownloadPath } from '../src/historical/kraken-raw.ts';
import { krakenRawPeriod } from '../src/historical/kraken.ts';
import { parseUnixSecondsFraction, parseUtcIso, toUtcIso } from '../src/shared/time.ts';

const [fileName] = process.argv.slice(2);
if (fileName === undefined) throw new Error('uso: node scripts/download-kraken.ts <fichero>');
// Primero la guarda: si el periodo es del test final y no hay desbloqueo, lanza aquí, sin red.
const destination = krakenDownloadPath(defaultGuard(), fileName);
mkdirSync(dirname(destination), { recursive: true });

async function get(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`${url}: HTTP ${String(res.status)}`);
  return res;
}

const trades = /^Trades_([A-Z0-9]+)_(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(fileName);
if (fileName.startsWith('Kraken_OHLCVT_')) {
  const res = await get(`${KRAKEN_ASSETS_URL}${fileName}`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(destination, { flags: 'wx' }));
  process.stdout.write(`${hash.digest('hex')}  ${destination}\n`);
} else if (fileName.startsWith('AssetPairs_')) {
  // Una foto del listado solo puede ser de hoy: la API no da listados pasados.
  if (fileName !== `AssetPairs_${new Date().toISOString().slice(0, 10)}.json`) throw new Error('AssetPairs solo se descarga con la fecha UTC de hoy');
  writeFileSync(destination, await (await get(`${KRAKEN_API_URL}AssetPairs`)).text(), { flag: 'wx' });
  process.stdout.write(`${destination}\n`);
} else if (trades !== null) {
  const [, pair = '', day = ''] = trades;
  const from = parseUtcIso(`${day}T00:00:00Z`);
  const until = parseUtcIso(`${day}T23:59:59Z`);
  const bound = parseUtcIso(krakenRawPeriod(fileName)?.lastUtc ?? '');
  writeFileSync(destination, '', { flag: 'wx' });
  // Una respuesta por línea, tal cual; los números se miran como texto para no pasar por float.
  let since = `${String(from / 1000)}000000000`;
  for (;;) {
    const text = await (await get(`${KRAKEN_API_URL}Trades?pair=${pair}&since=${since}&count=1000`)).text();
    const parsed = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && context?.source !== undefined ? context.source : value) as { error: string[]; result: Record<string, unknown> };
    if (parsed.error.length > 0) throw new Error(parsed.error.join(', '));
    const rows = Object.entries(parsed.result).find(([key]) => key !== 'last')?.[1] as string[][] | undefined;
    const last = rows?.at(-1)?.[2];
    if (last !== undefined && parseUnixSecondsFraction(last) > bound) throw new Error(`la página llega a ${toUtcIso(parseUnixSecondsFraction(last))}, después del periodo del fichero`);
    appendFileSync(destination, `${text.trim()}\n`);
    if (last === undefined || parseUnixSecondsFraction(last) > until) break;
    since = String(parsed.result.last);
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.stdout.write(`${destination}\n`);
} else {
  throw new Error(`${fileName}: tipo de fichero sin descargador`);
}
