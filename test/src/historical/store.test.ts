// Almacén Parquet/DuckDB (src/historical/store.ts): sin float en el esquema, versiones inmutables, procedencia y
// checksums que se comprueban al leer. Escribe en una carpeta temporal, nunca en data/.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanCandles } from '../../../src/historical/quality.ts';
import {
  CANDLE_SCHEMA,
  DatasetIntegrityError,
  listVersions,
  parquetSchema,
  readDataset,
  treeSha256,
  writeDataset,
  type NewDataset,
} from '../../../src/historical/store.ts';
import { at, candle, LATENCY_MS } from './helpers.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'inversor-store-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const SOURCE = {
  provider: 'kraken',
  url: 'https://example.invalid/ohlcvt.zip',
  retrievedAtUtc: '2026-10-08T10:00:00Z',
  originalSha256: 'a'.repeat(64),
  terms: null,
};

function dataset(name: string, candles = [candle('BTC/EUR', at(0), { o: '7000.123456789012345678', l: '0.000000000000000001', h: '99999999999999999999.5' }), candle('BTC/EUR', at(1)), candle('ETH/EUR', at(0))]): NewDataset {
  const { candles: clean, report } = cleanCandles(candles, '1h');
  return { dataset: name, source: SOURCE, timeframe: '1h', receivedLatencyMs: LATENCY_MS, candles: clean, quality: report };
}

const FLOAT_TYPES = /^(FLOAT|DOUBLE|REAL|FLOAT4|FLOAT8)$/i;

test('el Parquet escrito no tiene ninguna columna float: precios y volumen en DECIMAL(38,18)', async () => {
  const manifest = await writeDataset(ROOT, dataset('schema'));
  const schema = await parquetSchema(join(ROOT, 'schema', manifest.version, 'candles.parquet'));
  assert.deepEqual(schema.filter(([, type]) => FLOAT_TYPES.test(type ?? '')), []);
  assert.deepEqual(schema, CANDLE_SCHEMA.map(([n, t]) => [n, t]));
  for (const column of ['open', 'high', 'low', 'close', 'volume']) {
    assert.deepEqual(schema.find(([n]) => n === column), [column, 'DECIMAL(38,18)']);
  }
  // El esquema declarado tampoco admite float.
  assert.ok(CANDLE_SCHEMA.every(([, type]) => !/FLOAT|DOUBLE|REAL/i.test(type)));
});

test('lo que se escribe se lee exacto, con procedencia, rango, calidad y checksums en el manifiesto', async () => {
  const input = dataset('roundtrip');
  const manifest = await writeDataset(ROOT, input);
  const { manifest: read, candles } = await readDataset(ROOT, 'roundtrip', manifest.version);
  assert.deepEqual(read, manifest);
  assert.deepEqual(candles.map(String), input.candles.map(String));
  assert.deepEqual(
    candles.map((c) => [c.symbol, c.openTime, c.receivedTime, c.open.toString(), c.high.toString(), c.low.toString()]),
    input.candles.map((c) => [c.symbol, c.openTime, c.receivedTime, c.open.toString(), c.high.toString(), c.low.toString()]),
  );
  assert.equal(candles[0]?.open.toString(), '7000.123456789012345678');
  assert.equal(candles[0]?.low.toString(), '0.000000000000000001');
  assert.equal(manifest.source.provider, 'kraken');
  assert.equal(manifest.source.originalSha256, 'a'.repeat(64));
  assert.deepEqual(manifest.rangeUtc, { start: '2020-01-01T00:00:00.000Z', endExclusive: '2020-01-01T02:00:00.000Z' });
  assert.deepEqual(manifest.symbols, ['BTC/EUR', 'ETH/EUR']);
  assert.equal(manifest.rows, 3);
  assert.match(manifest.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.version, manifest.contentSha256.slice(0, 16));
  assert.equal(manifest.quality.validRows, 3);
});

test('versionado: una versión no se reescribe y otro contenido es otra versión', async () => {
  const first = await writeDataset(ROOT, dataset('versions'));
  await assert.rejects(writeDataset(ROOT, dataset('versions')), DatasetIntegrityError);
  const second = await writeDataset(ROOT, dataset('versions', [candle('BTC/EUR', at(5))]));
  assert.notEqual(first.version, second.version);
  assert.deepEqual(listVersions(ROOT, 'versions').map((m) => m.version).sort(), [first.version, second.version].sort());
});

test('un valor que no cabe en DECIMAL(38,18) se rechaza, nunca se redondea en silencio', async () => {
  const tooPrecise = dataset('precision', [candle('X/EUR', at(0), { l: '0.0000000000000000001', o: '1', c: '1' })]);
  await assert.rejects(writeDataset(ROOT, tooPrecise), RangeError);
  const tooLarge = dataset('large', [candle('X/EUR', at(0), { h: '100000000000000000000' })]);
  await assert.rejects(writeDataset(ROOT, tooLarge), RangeError);
  assert.deepEqual(readdirSync(ROOT).filter((d) => d === 'precision' || d === 'large'), []);
});

test('un archivo o un manifiesto alterados se detectan al leer', async () => {
  const manifest = await writeDataset(ROOT, dataset('tamper'));
  const dir = join(ROOT, 'tamper', manifest.version);
  appendFileSync(join(dir, 'candles.parquet'), 'x');
  await assert.rejects(readDataset(ROOT, 'tamper', manifest.version), DatasetIntegrityError);

  const other = await writeDataset(ROOT, dataset('tamper2'));
  writeFileSync(join(ROOT, 'tamper2', other.version, 'manifest.json'), JSON.stringify({ ...other, rows: 'tres' }));
  await assert.rejects(readDataset(ROOT, 'tamper2', other.version), DatasetIntegrityError);
  assert.throws(() => listVersions(ROOT, '../tamper'), RangeError);
});

test('la huella del árbol es estable y cambia si cambia cualquier archivo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inversor-tree-'));
  try {
    await writeDataset(root, dataset('tree'));
    const before = treeSha256(root);
    assert.equal(treeSha256(root), before);
    await writeDataset(root, dataset('tree2', [candle('BTC/EUR', at(3))]));
    assert.notEqual(treeSha256(root), before);
    assert.match(before, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
