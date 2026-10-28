// Comprobación de DATA.md §4 (paso 19B): las velas rehechas desde los trades de la API pública coinciden con las del
// ZIP de OHLCVT. Lee los trades guardados en JSONL (una respuesta de `GET /0/public/Trades` por línea) y el CSV de 1h
// del par dentro del ZIP. Sale con código 1 si alguna hora no coincide.
//   node scripts/verify-kraken-trades.ts --zip <ruta> --trades <jsonl> --pair XBTEUR --day 2026-06-15
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { defaultGuard, PROVENANCE_ROOT } from '../src/historical/guard.ts';
import { krakenRawForReading } from '../src/historical/kraken-raw.ts';
import { candlesFromKrakenTrades, parseKrakenCsvName, parseKrakenOhlcvt, type KrakenTrade } from '../src/historical/kraken.ts';
import { Decimal } from '../src/shared/decimal.ts';
import { closeTimeOf, parseUnixSeconds, parseUtcIso, toUtcIso } from '../src/shared/time.ts';

const LATENCY_MS = 0; // no interviene en la comparación

const { values } = parseArgs({ options: { zip: { type: 'string' }, trades: { type: 'string' }, pair: { type: 'string' }, day: { type: 'string' } } });
if (values.zip === undefined || values.trades === undefined || values.pair === undefined || values.day === undefined) {
  throw new Error('uso: --zip <ruta> --trades <jsonl> --pair <altname> --day <AAAA-MM-DD>');
}
const { pair, day } = values;
// Los brutos solo se abren si la guarda los da por investigación.
const guard = defaultGuard();
const zip = krakenRawForReading(guard, resolve(values.zip));
const tradesPath = krakenRawForReading(guard, resolve(values.trades));
const file = parseKrakenCsvName(`${pair}_60.csv`);
if (file === null) throw new Error(`${pair} no es un par en EUR`);
const from = parseUtcIso(`${day}T00:00:00Z`);
const to = closeTimeOf(from, '1d');

// Los números de la respuesta se conservan como texto (JSON.parse con el texto original): nunca pasan por float.
const asText = (_key: string, value: unknown, context?: { source?: string }): unknown =>
  typeof value === 'number' && context?.source !== undefined ? context.source : value;
const Response = z.object({ error: z.array(z.string()).length(0), result: z.record(z.string(), z.unknown()) });
const TradeRow = z.tuple([z.string(), z.string(), z.string()]).rest(z.unknown());
const byId = new Map<string, KrakenTrade>();
for (const line of readFileSync(tradesPath, 'utf8').split(/\r?\n/).filter((l) => l !== '')) {
  const { result } = Response.parse(JSON.parse(line, asText));
  for (const [key, rows] of Object.entries(result)) {
    if (key === 'last') continue;
    for (const row of z.array(TradeRow).parse(rows)) {
      const [price, volume, time] = row;
      const id = String(row.at(-1));
      byId.set(id, { price, volume, time });
    }
  }
}
const trades = [...byId.entries()].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(([, t]) => t);
const rebuilt = candlesFromKrakenTrades(trades, { symbol: file.symbol, timeframe: '1h', receivedLatencyMs: LATENCY_MS });
const fromTrades = new Map(rebuilt.candles.filter((c) => c.openTime >= from && c.openTime < to).map((c) => [c.openTime, c]));

const csv = execFileSync('unzip', ['-p', zip, `${pair}_60.csv`], { encoding: 'utf8', maxBuffer: 2 ** 31 });
const { candles } = parseKrakenOhlcvt(csv, { symbol: file.symbol, timeframe: '1h', receivedLatencyMs: LATENCY_MS });
const fromZip = new Map(candles.filter((c) => c.openTime >= from && c.openTime < to).map((c) => [c.openTime, c]));
// Séptimo campo del CSV: número de trades de la vela.
const zipTradeCounts = new Map(
  csv.split(/\r?\n/).filter((l) => l !== '').map((l) => l.split(',')).map((f) => [parseUnixSeconds(f[0] ?? ''), f[6] ?? ''] as const),
);

// El volumen del OHLCVT es una suma hecha en float por Kraken («8.969955389999999» frente a 8.96995539 exacto): se
// acepta una diferencia relativa de hasta 1e-12 y se anota la mayor. Precios y número de trades, exactos.
const VOLUME_TOLERANCE = Decimal.parse('0.000000000001');
const volumeDiffs: { hourUtc: string; fromTrades: string; fromZip: string }[] = [];
const hours = [...new Set([...fromTrades.keys(), ...fromZip.keys()])].sort((a, b) => a - b);
const mismatches = hours.flatMap((h) => {
  const a = fromTrades.get(h);
  const b = fromZip.get(h);
  const fields = a === undefined || b === undefined
    ? ['vela ausente en una de las dos fuentes']
    : (['open', 'high', 'low', 'close'] as const).filter((k) => !a[k].eq(b[k]));
  if (a !== undefined && b !== undefined && !a.volume.eq(b.volume)) {
    volumeDiffs.push({ hourUtc: toUtcIso(h), fromTrades: a.volume.toString(), fromZip: b.volume.toString() });
    if (a.volume.minus(b.volume).abs().gt(a.volume.times(VOLUME_TOLERANCE))) fields.push('volume');
  }
  if (String(rebuilt.trades.get(h) ?? 0) !== (zipTradeCounts.get(h) ?? '')) fields.push('trades');
  return fields.length === 0 ? [] : [{ hourUtc: toUtcIso(h), fields }];
});

const report = {
  createdAtUtc: new Date().toISOString(),
  pair,
  dayUtc: day,
  tradesFile: tradesPath,
  tradesInDay: [...fromTrades.keys()].reduce((n, h) => n + (rebuilt.trades.get(h) ?? 0), 0),
  hoursCompared: hours.length,
  volumeTolerance: VOLUME_TOLERANCE.toString(),
  hoursWithFloatVolume: volumeDiffs.length,
  volumeDiffs,
  mismatches,
};
mkdirSync(PROVENANCE_ROOT, { recursive: true });
writeFileSync(join(PROVENANCE_ROOT, `kraken-trades-check-${pair.toLowerCase()}-${day}.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (mismatches.length > 0) process.exitCode = 1;
