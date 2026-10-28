// Captura del OHLCVT de Kraken (src/historical/capture.ts y kraken.ts, paso 19B, ADR 0022). En una carpeta temporal
// con un candado de prueba: ninguna prueba lee el candado real ni data/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { captureKrakenCsv, compareWithListing, KRAKEN_OHLCVT_LATENCY_MS, listedPairs, type CaptureSource } from '../../../src/historical/capture.ts';
import { TestFinalGuard } from '../../../src/historical/guard.ts';
import { candlesFromKrakenTrades, parseKrakenCsvName, type KrakenCsvFile } from '../../../src/historical/kraken.ts';
import { readDataset } from '../../../src/historical/store.ts';

const BASE = mkdtempSync(join(tmpdir(), 'inversor-capture-'));
after(() => rmSync(BASE, { recursive: true, force: true }));
const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 1); // inicio del test final en el candado de prueba

let counter = 0;
function workspace(): { guard: TestFinalGuard; researchRoot: string; testFinalRoot: string } {
  counter += 1;
  const dir = join(BASE, `w${String(counter)}`);
  mkdirSync(dir);
  const paths = { lock: join(dir, 'lock.json'), testFinalRoot: join(dir, 'final'), researchRoot: join(dir, 'research'), rawRoot: join(dir, 'raw') };
  writeFileSync(
    paths.lock,
    JSON.stringify({
      version: 1,
      periodUtc: { start: '2026-10-01T00:00:00Z', endExclusive: '2027-10-01T00:00:00Z' },
      researchDataEndUtc: '2026-09-30T23:59:59Z',
      stages: [{ stage: 1, name: 'paper-provisional', opensTestData: false }],
      dataHash: null,
    }),
  );
  return { guard: new TestFinalGuard({ paths, env: {}, now: () => START }), researchRoot: paths.researchRoot, testFinalRoot: paths.testFinalRoot };
}

const SOURCE: CaptureSource = {
  label: 'full2026q2',
  provider: 'Kraken, ZIP de OHLCVT',
  url: 'https://example.invalid/kraken.zip',
  retrievedAtUtc: '2026-10-08T00:00:00Z',
  originalSha256: 'a'.repeat(64),
  terms: null,
};
const XBTEUR_1H: KrakenCsvFile = { pair: 'XBTEUR', symbol: 'BTC/EUR', timeframe: '1h' };
const row = (ms: number, close = '100'): string => `${String(ms / 1000)},100,110,90,${close},1.5,3`;

test('nombres del ZIP: solo pares en EUR en 1h, 4h y 1d, con los alias XBT y XDG', () => {
  assert.deepEqual(parseKrakenCsvName('XBTEUR_60.csv'), XBTEUR_1H);
  assert.deepEqual(parseKrakenCsvName('XDGEUR_1440.csv'), { pair: 'XDGEUR', symbol: 'DOGE/EUR', timeframe: '1d' });
  assert.deepEqual(parseKrakenCsvName('1INCHEUR_240.csv'), { pair: '1INCHEUR', symbol: '1INCH/EUR', timeframe: '4h' });
  for (const other of ['XBTUSD_60.csv', 'EURUSD_60.csv', 'XBTEUR_720.csv', 'XBTEUR_30.csv', 'XBTEUR_1.csv', 'EUR_60.csv', 'dir/XBTEUR_60.csv', 'MANIFEST.json']) {
    assert.equal(parseKrakenCsvName(other), null, other);
  }
});

test('velas desde trades: OHLCV por intervalo, segundos con decimales y número de trades', () => {
  const t0 = Date.UTC(2026, 5, 15) / 1000;
  const trades = [
    { price: '100', volume: '0.5', time: `${String(t0)}.1256185` },
    { price: '105.5', volume: '0.25', time: `${String(t0 + 10)}.9` },
    { price: '99', volume: '1', time: `${String(t0 + 3599)}.9999999` },
    { price: '101', volume: '2', time: `${String(t0 + 3600)}` },
  ];
  const { candles, trades: counts } = candlesFromKrakenTrades(trades, { symbol: 'BTC/EUR', timeframe: '1h', receivedLatencyMs: 0 });
  assert.equal(candles.length, 2);
  const [first, second] = candles;
  assert.equal(first?.openTime, t0 * 1000);
  assert.deepEqual([first?.open, first?.high, first?.low, first?.close, first?.volume].map(String), ['100', '105.5', '99', '99', '1.75']);
  assert.equal(second?.openTime, t0 * 1000 + HOUR);
  assert.deepEqual([...counts.values()], [3, 1]);
});

test('captura: lo del test final se descarta y solo se cuenta; lo demás se limpia y se guarda con su procedencia', async () => {
  const { guard, researchRoot, testFinalRoot } = workspace();
  const lastResearchHour = START - 2 * HOUR; // cierra 1 h antes del inicio: received_time = cierre + 60 s
  const csv = [
    row(START - 10 * HOUR),
    row(START - 10 * HOUR), // duplicado idéntico
    row(lastResearchHour), // hueco de 7 velas antes
    'basura',
    row(START - HOUR), // cierra en el inicio: es del test final
    row(START + HOUR),
    '',
  ].join('\n');
  const result = await captureKrakenCsv(guard, researchRoot, csv, XBTEUR_1H, SOURCE);
  assert.equal(result.dataset, 'kraken-xbteur-1h-full2026q2');
  assert.equal(result.testFinalDropped, 2);
  assert.equal(result.parsedRows, 5);
  assert.deepEqual(result.rejectedRows.map((r) => r.row), [3]);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.validRows, 2);
  assert.equal(result.gaps, 1);
  assert.equal(result.largestGapBars, 7);
  assert.equal(result.lastCloseUtc, new Date(lastResearchHour + HOUR).toISOString());
  assert.equal(existsSync(testFinalRoot), false, 'nada se escribe en el test final');

  assert.ok(result.version !== null);
  const { manifest, candles } = await readDataset(researchRoot, result.dataset, result.version);
  assert.equal(manifest.source.originalSha256, SOURCE.originalSha256);
  assert.equal(manifest.receivedLatencyMs, KRAKEN_OHLCVT_LATENCY_MS);
  assert.ok(candles.every((c) => c.receivedTime < START));

  // Repetir con el mismo original no reescribe; con otro original, falla.
  assert.equal((await captureKrakenCsv(guard, researchRoot, csv, XBTEUR_1H, SOURCE)).reused, true);
  await assert.rejects(captureKrakenCsv(guard, researchRoot, csv, XBTEUR_1H, { ...SOURCE, originalSha256: 'b'.repeat(64) }), /otra procedencia/);
});

test('captura: el volumen con ruido de float se redondea a 18 decimales y se cuenta; los precios, nunca', async () => {
  const { guard, researchRoot } = workspace();
  const t = String((START - 5 * HOUR) / 1000);
  const result = await captureKrakenCsv(guard, researchRoot, `${t},100,110,90,105,0.0008168399999999999,2\n`, XBTEUR_1H, SOURCE);
  assert.equal(result.volumeRoundedRows, 1);
  assert.ok(result.version !== null);
  const { candles } = await readDataset(researchRoot, result.dataset, result.version);
  assert.equal(candles[0]?.volume.toString(), '0.00081684');

  const tooPrecise = `${t},100.0000000000000000001,110,90,105,1,2\n`;
  await assert.rejects(captureKrakenCsv(guard, researchRoot, tooPrecise, { ...XBTEUR_1H, pair: 'ABCEUR' }, SOURCE), /no cabe/);
});

test('captura: la vela de frontera del ZIP 2026Q3, que cierra el 2026-10-01T00:00:00Z, no entra en investigación', async () => {
  const { guard, researchRoot } = workspace();
  // La última vela del 30 de septiembre en cada marco cierra justo en el inicio del test final.
  const frontier = { '1h': START - HOUR, '4h': START - 4 * HOUR, '1d': START - 24 * HOUR } as const;
  for (const [timeframe, open] of Object.entries(frontier) as [keyof typeof frontier, number][]) {
    const before = open - (timeframe === '1d' ? 24 : timeframe === '4h' ? 4 : 1) * HOUR;
    const csv = [row(before), row(open)].join('\n');
    const result = await captureKrakenCsv(guard, researchRoot, csv, { ...XBTEUR_1H, timeframe }, SOURCE);
    assert.equal(result.testFinalDropped, 1, timeframe);
    assert.equal(result.validRows, 1, timeframe);
    assert.equal(result.lastCloseUtc, new Date(open).toISOString(), timeframe);
    assert.ok(result.version !== null);
    const { candles } = await readDataset(researchRoot, result.dataset, result.version);
    assert.deepEqual(candles.map((c) => c.openTime), [before], timeframe);
    assert.ok(candles.every((c) => c.closeTime < START && c.receivedTime < START), timeframe);
  }
});

test('captura: un CSV que solo tiene datos del test final no deja dataset', async () => {
  const { guard, researchRoot } = workspace();
  const result = await captureKrakenCsv(guard, researchRoot, row(START), XBTEUR_1H, SOURCE);
  assert.equal(result.version, null);
  assert.equal(result.testFinalDropped, 1);
  assert.equal(existsSync(researchRoot), false);
});

test('listado: pares del ZIP que hoy no están listados y pares en EUR listados que el ZIP no trae', () => {
  const assetPairs = {
    error: [],
    result: {
      XXBTZEUR: { altname: 'XBTEUR', quote: 'ZEUR' },
      NEWEUR: { altname: 'NEWEUR', quote: 'ZEUR' },
      XXBTZUSD: { altname: 'XBTUSD', quote: 'ZUSD' },
    },
  };
  const listed = listedPairs(assetPairs);
  assert.deepEqual([...listed.inEur].sort(), ['NEWEUR', 'XBTEUR']);
  assert.deepEqual(compareWithListing(['XBTEUR', 'LUNAEUR', 'ANTEUR'], listed), { notListedNow: ['ANTEUR', 'LUNAEUR'], missingFromZip: ['NEWEUR'] });
  assert.throws(() => listedPairs({ error: ['EGeneral:Too many requests'], result: {} }));
});
