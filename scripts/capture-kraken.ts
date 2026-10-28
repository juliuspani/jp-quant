// Captura del OHLCVT de Kraken (paso 19B, ADR 0022). Lee del ZIP, sin extraerlo a disco, los CSV de los pares en EUR
// en 1h, 4h y 1d, y los guarda en el almacén de investigación a través de la guarda del test final. Deja un informe
// de procedencia, calidad y listado en data/provenance/. Necesita `unzip` (Info-ZIP, que lee ZIP64). Los brutos se
// abren solo si la guarda los da por investigación (su periodo acaba como tarde en researchDataEndUtc).
//   node scripts/capture-kraken.ts --zip <ruta> --label <full2026q2|2026q3> --url <url> --retrieved <ISO UTC>
//     [--asset-pairs <AssetPairs_AAAA-MM-DD.json>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { captureKrakenCsv, compareWithListing, KRAKEN_OHLCVT_LATENCY_MS, listedPairs, type CaptureResult, type CaptureSource } from '../src/historical/capture.ts';
import { DEFAULT_PATHS, defaultGuard, PROVENANCE_ROOT } from '../src/historical/guard.ts';
import { krakenRawForReading } from '../src/historical/kraken-raw.ts';
import { parseKrakenCsvName, type KrakenCsvFile } from '../src/historical/kraken.ts';
import { parseUtcIso } from '../src/shared/time.ts';

const TERMS = 'Kraken EEA Terms §11.1 y §11.5 (en vigor desde 2026-10-07): uso para beneficio propio; sin redistribuir ni explotar comercialmente';
const MAX_CSV_BYTES = 2 ** 31;

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`falta --${name}`);
  return value;
}

const { values } = parseArgs({
  options: {
    zip: { type: 'string' },
    label: { type: 'string' },
    url: { type: 'string' },
    retrieved: { type: 'string' },
    'asset-pairs': { type: 'string' },
  },
});
const guard = defaultGuard();
const zip = krakenRawForReading(guard, resolve(required(values.zip, 'zip')));
const label = required(values.label, 'label');
if (!/^[a-z0-9]{1,16}$/.test(label)) throw new Error('--label: solo minúsculas y dígitos');
const retrievedAtUtc = required(values.retrieved, 'retrieved');
parseUtcIso(retrievedAtUtc);
// Opcional: una foto de AssetPairs posterior a researchDataEndUtc es del test final y la guarda la rechaza.
const assetPairsPath = values['asset-pairs'] === undefined ? null : krakenRawForReading(guard, resolve(values['asset-pairs']));

process.stderr.write(`SHA-256 de ${basename(zip)}…\n`);
const source: CaptureSource = {
  label,
  provider: 'Kraken, ZIP de OHLCVT',
  url: required(values.url, 'url'),
  retrievedAtUtc,
  originalSha256: await sha256File(zip),
  terms: TERMS,
};

const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split(/\r?\n/).filter((e) => e !== '');
const files = entries.flatMap((name) => {
  const file = parseKrakenCsvName(name);
  return file === null ? [] : [{ name, file }];
});
process.stderr.write(`${String(entries.length)} entradas; ${String(files.length)} CSV de pares en EUR en 1h, 4h y 1d\n`);

const results: CaptureResult[] = [];
for (const [i, { name, file }] of files.entries()) {
  const csv = execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8', maxBuffer: MAX_CSV_BYTES });
  results.push(await captureKrakenCsv(guard, DEFAULT_PATHS.researchRoot, csv, file, source));
  if ((i + 1) % 100 === 0) process.stderr.write(`  ${String(i + 1)}/${String(files.length)}\n`);
}

const pairs = new Map<string, KrakenCsvFile>(files.map(({ file }) => [file.pair, file]));
const listing = assetPairsPath === null ? null : compareWithListing(pairs.keys(), listedPairs(JSON.parse(readFileSync(assetPairsPath, 'utf8'))));
const lastClose = (pair: string): string | null =>
  results.filter((r) => r.pair === pair && r.lastCloseUtc !== null).map((r) => r.lastCloseUtc ?? '').sort().at(-1) ?? null;
const sum = (pick: (r: CaptureResult) => number): number => results.reduce((s, r) => s + pick(r), 0);

const report = {
  formatVersion: 1,
  createdAtUtc: new Date().toISOString(),
  source: { ...source, file: basename(zip), bytes: statSync(zip).size, entriesInZip: entries.length },
  assetPairs: assetPairsPath === null ? null : { file: basename(assetPairsPath), sha256: await sha256File(assetPairsPath) },
  receivedLatencyMs: KRAKEN_OHLCVT_LATENCY_MS,
  totals: {
    csvCaptured: results.length,
    pairs: pairs.size,
    datasetsWritten: results.filter((r) => r.version !== null && !r.reused).length,
    datasetsReused: results.filter((r) => r.reused).length,
    parsedRows: sum((r) => r.parsedRows),
    rejectedRows: sum((r) => r.rejectedRows.length),
    testFinalDropped: sum((r) => r.testFinalDropped),
    volumeRoundedRows: sum((r) => r.volumeRoundedRows),
    validRows: sum((r) => r.validRows),
    invalid: sum((r) => r.invalid),
    duplicatesRemoved: sum((r) => r.duplicatesRemoved),
    conflicts: sum((r) => r.conflicts),
    gaps: sum((r) => r.gaps),
    largestGapBars: results.reduce((m, r) => Math.max(m, r.largestGapBars), 0),
  },
  listing: listing === null ? null : {
    pairsInZip: pairs.size,
    notListedNow: listing.notListedNow.map((pair) => ({ pair, symbol: pairs.get(pair)?.symbol ?? null, lastCloseUtc: lastClose(pair) })),
    missingFromZip: listing.missingFromZip,
  },
  datasets: results,
};
mkdirSync(PROVENANCE_ROOT, { recursive: true });
const out = join(PROVENANCE_ROOT, `kraken-ohlcvt-${label}.json`);
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ out, originalSha256: source.originalSha256, totals: report.totals, notListedNow: listing?.notListedNow.length ?? null, missingFromZip: listing?.missingFromZip.length ?? null }, null, 2)}\n`);
