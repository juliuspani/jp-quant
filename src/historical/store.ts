// Almacén de investigación en Parquet, escrito y leído con DuckDB (paso 18, ADR 0020). Cada conjunto de datos es
// inmutable y versionado: `<raíz>/<dataset>/<versión>/candles.parquet` y `manifest.json`, donde la versión es el
// hash del contenido. Nunca se reescribe: una versión que ya existe no se toca. Precios y volumen van en
// DECIMAL(38,18), nunca en float; el tiempo, en BIGINT de milisegundos UTC. El manifiesto guarda la procedencia,
// el rango, la calidad y los SHA-256 del original, del contenido y del archivo, y la lectura los comprueba.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { z } from 'zod';
import { Decimal } from '../shared/decimal.ts';
import { isTimeframe, parseEpochMillis, parseUtcIso, toUtcIso, type Timeframe } from '../shared/time.ts';
import type { QualityReport } from './quality.ts';
import type { HistoricalCandle } from './types.ts';

const PRICE = 'DECIMAL(38,18)';
// Esquema del Parquet. test/src/historical/store.test.ts comprueba en el archivo escrito que ninguna columna es float.
export const CANDLE_SCHEMA = [
  ['symbol', 'VARCHAR'],
  ['timeframe', 'VARCHAR'],
  ['open_time', 'BIGINT'],
  ['close_time', 'BIGINT'],
  ['received_time', 'BIGINT'],
  ['open', PRICE],
  ['high', PRICE],
  ['low', PRICE],
  ['close', PRICE],
  ['volume', PRICE],
] as const;
const MAX_INTEGER_DIGITS = 20; // 38 - 18
const MAX_SCALE = 18;
const DATASET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9a-f]{16}$/; // los 16 primeros caracteres del SHA-256 del contenido
const DATA_FILE = 'candles.parquet';
const MANIFEST_FILE = 'manifest.json';

export const IsoUtc = z.string().refine((s) => {
  try {
    parseUtcIso(s);
    return true;
  } catch {
    return false;
  }
}, 'fecha ISO 8601 en UTC con «Z»');

const ManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    dataset: z.string().regex(DATASET_ID),
    version: z.string().regex(VERSION),
    createdAtUtc: IsoUtc,
    source: z.object({
      provider: z.string().min(1),
      url: z.string().min(1),
      retrievedAtUtc: IsoUtc,
      originalSha256: z.string().regex(SHA256),
      terms: z.string().nullable(),
    }),
    timeframe: z.string().refine(isTimeframe),
    receivedLatencyMs: z.number().int().nonnegative(),
    symbols: z.array(z.string().min(1)).min(1),
    rangeUtc: z.object({ start: IsoUtc, endExclusive: IsoUtc }),
    rows: z.number().int().positive(),
    contentSha256: z.string().regex(SHA256),
    fileSha256: z.string().regex(SHA256),
    quality: z.unknown(),
  })
  .strict();

export type DatasetManifest = Omit<z.infer<typeof ManifestSchema>, 'timeframe' | 'quality'> & {
  timeframe: Timeframe;
  quality: QualityReport;
};

export interface DatasetSource {
  readonly provider: string;
  readonly url: string;
  readonly retrievedAtUtc: string;
  readonly originalSha256: string; // SHA-256 del archivo descargado, antes de transformarlo
  readonly terms: string | null;
}

export interface NewDataset {
  readonly dataset: string;
  readonly source: DatasetSource;
  readonly timeframe: Timeframe;
  readonly receivedLatencyMs: number;
  readonly candles: readonly HistoricalCandle[]; // ya limpias (cleanCandles)
  readonly quality: QualityReport;
}

export class DatasetIntegrityError extends Error {
  override readonly name = 'DatasetIntegrityError';
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Cabe en DECIMAL(38,18) sin redondear: si no, se rechaza en lugar de perder precisión en silencio. */
function checkFits(value: Decimal, what: string): string {
  const text = value.toString();
  const [integer = '', fraction = ''] = text.replace('-', '').split('.');
  if (integer.length > MAX_INTEGER_DIGITS || fraction.length > MAX_SCALE) {
    throw new RangeError(`${what} = ${text} no cabe en ${PRICE} sin redondear`);
  }
  return text;
}

/** Serialización canónica del contenido: su SHA-256 no depende de cómo codifique Parquet. */
function canonicalLine(c: HistoricalCandle): string {
  return [c.symbol, c.timeframe, c.openTime, c.closeTime, c.receivedTime, c.open, c.high, c.low, c.close, c.volume]
    .map(String)
    .join(',');
}

export function contentSha256(candles: readonly HistoricalCandle[]): string {
  const hash = createHash('sha256');
  for (const c of candles) hash.update(`${canonicalLine(c)}\n`);
  return hash.digest('hex');
}

/** Ruta para el SQL de DuckDB: barras normales y comillas simples escapadas. */
function sqlPath(path: string): string {
  return `'${path.split(sep).join('/').replaceAll("'", "''")}'`;
}

async function withDuckDb<T>(work: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  // Sin descargar ni cargar extensiones por la red: Parquet viene incluido en el binario.
  const instance = await DuckDBInstance.create(':memory:', {
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    allow_community_extensions: 'false',
  });
  const connection = await instance.connect();
  try {
    return await work(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function readSchema(connection: DuckDBConnection, file: string): Promise<string[][]> {
  const reader = await connection.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlPath(file)})`);
  return reader.getRows().map((row) => [String(row[0]), String(row[1])]);
}

/** Tipos de columna del Parquet escrito, tal como los ve DuckDB. */
export async function parquetSchema(file: string): Promise<string[][]> {
  return withDuckDb((connection) => readSchema(connection, file));
}

export async function writeDataset(root: string, input: NewDataset): Promise<DatasetManifest> {
  if (!DATASET_ID.test(input.dataset)) throw new RangeError(`identificador de dataset inválido: ${input.dataset}`);
  const [first] = input.candles;
  if (first === undefined) throw new RangeError('un dataset sin velas no se guarda');
  const rows = input.candles.map((c) => {
    if (c.timeframe !== input.timeframe) throw new RangeError(`${c.symbol}: timeframe ${c.timeframe} en un dataset de ${input.timeframe}`);
    return [c.open, c.high, c.low, c.close, c.volume].map((v, i) => checkFits(v, `${c.symbol}@${toUtcIso(c.openTime)}[${String(i)}]`));
  });

  const content = contentSha256(input.candles);
  const version = content.slice(0, 16);
  const datasetDir = join(root, input.dataset);
  const dir = join(datasetDir, version);
  // Nunca se reescribe: si la versión ya existe, falla. Se construye aparte y se mueve entera al final, para que
  // un fallo a medias no deje una versión incompleta (queda en `.tmp-…`, que listVersions ignora).
  if (existsSync(dir)) throw new DatasetIntegrityError(`${input.dataset}/${version} ya existe: los datasets no se reescriben`);
  const building = join(datasetDir, `.tmp-${version}`);
  mkdirSync(building, { recursive: true });

  const tmp = join(building, DATA_FILE);
  await withDuckDb(async (connection) => {
    await connection.run(
      'CREATE TEMP TABLE staging (symbol VARCHAR, timeframe VARCHAR, open_time BIGINT, close_time BIGINT, ' +
        'received_time BIGINT, open VARCHAR, high VARCHAR, low VARCHAR, close VARCHAR, volume VARCHAR)',
    );
    const appender = await connection.createAppender('staging');
    for (const [c, values] of input.candles.map((c, i) => [c, rows[i] ?? []] as const)) {
      appender.appendVarchar(c.symbol);
      appender.appendVarchar(c.timeframe);
      appender.appendBigInt(BigInt(c.openTime));
      appender.appendBigInt(BigInt(c.closeTime));
      appender.appendBigInt(BigInt(c.receivedTime));
      for (const value of values) appender.appendVarchar(value);
      appender.endRow();
    }
    appender.closeSync();
    const columns = CANDLE_SCHEMA.map(([name, type]) => (type === PRICE ? `CAST(${name} AS ${PRICE}) AS ${name}` : name));
    await connection.run(
      `COPY (SELECT ${columns.join(', ')} FROM staging ORDER BY symbol, open_time) ` +
        `TO ${sqlPath(tmp)} (FORMAT parquet, COMPRESSION zstd)`,
    );
  });
  const symbols = [...new Set(input.candles.map((c) => c.symbol))].sort();
  const start = input.candles.reduce((m, c) => (c.openTime < m ? c.openTime : m), first.openTime);
  const end = input.candles.reduce((m, c) => (c.closeTime > m ? c.closeTime : m), first.closeTime);
  const manifest: DatasetManifest = {
    formatVersion: 1,
    dataset: input.dataset,
    version,
    createdAtUtc: new Date().toISOString(),
    source: { ...input.source },
    timeframe: input.timeframe,
    receivedLatencyMs: input.receivedLatencyMs,
    symbols,
    rangeUtc: { start: toUtcIso(start), endExclusive: toUtcIso(end) },
    rows: input.candles.length,
    contentSha256: content,
    fileSha256: sha256(readFileSync(tmp)),
    quality: input.quality,
  };
  ManifestSchema.parse(manifest);
  writeFileSync(join(building, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  renameSync(building, dir);
  return manifest;
}

export function readManifest(root: string, dataset: string, version: string): DatasetManifest {
  if (!DATASET_ID.test(dataset) || !VERSION.test(version)) throw new RangeError(`dataset o versión inválidos: ${dataset}/${version}`);
  const text = readFileSync(join(root, dataset, version, MANIFEST_FILE), 'utf8');
  const parsed = ManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new DatasetIntegrityError(`manifiesto inválido en ${dataset}/${version}: ${parsed.error.message}`);
  if (parsed.data.dataset !== dataset || parsed.data.version !== version) {
    throw new DatasetIntegrityError(`el manifiesto de ${dataset}/${version} dice ser otro conjunto`);
  }
  return parsed.data as DatasetManifest;
}

/** Versiones guardadas de un dataset, de la más antigua a la más reciente. */
export function listVersions(root: string, dataset: string): DatasetManifest[] {
  if (!DATASET_ID.test(dataset)) throw new RangeError(`identificador de dataset inválido: ${dataset}`);
  return readdirSync(join(root, dataset), { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION.test(e.name))
    .map((e) => readManifest(root, dataset, e.name))
    .sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? -1 : 1));
}

/** Lee una versión comprobando el SHA-256 del archivo, el esquema sin float y el SHA-256 del contenido. */
export async function readDataset(root: string, dataset: string, version: string): Promise<{ manifest: DatasetManifest; candles: HistoricalCandle[] }> {
  const manifest = readManifest(root, dataset, version);
  const file = join(root, dataset, version, DATA_FILE);
  if (sha256(readFileSync(file)) !== manifest.fileSha256) throw new DatasetIntegrityError(`${dataset}/${version}: el archivo no coincide con su SHA-256`);

  const rows = await withDuckDb(async (connection) => {
    const schema = await readSchema(connection, file);
    if (JSON.stringify(schema) !== JSON.stringify(CANDLE_SCHEMA)) {
      throw new DatasetIntegrityError(`${dataset}/${version}: esquema inesperado ${JSON.stringify(schema)}`);
    }
    const columns = CANDLE_SCHEMA.map(([name]) => `CAST(${name} AS VARCHAR)`);
    const reader = await connection.runAndReadAll(`SELECT ${columns.join(', ')} FROM read_parquet(${sqlPath(file)}) ORDER BY symbol, open_time`);
    return reader.getRows().map((row) => row.map(String));
  });

  const candles = rows.map(([symbol = '', timeframe = '', openTime = '', closeTime = '', receivedTime = '', ...prices]) => {
    if (!isTimeframe(timeframe)) throw new DatasetIntegrityError(`${dataset}/${version}: timeframe ${timeframe}`);
    const [open, high, low, close, volume] = prices.map((p) => Decimal.parse(p));
    if (open === undefined || high === undefined || low === undefined || close === undefined || volume === undefined) {
      throw new DatasetIntegrityError(`${dataset}/${version}: fila incompleta`);
    }
    return {
      symbol,
      timeframe,
      openTime: parseEpochMillis(openTime),
      closeTime: parseEpochMillis(closeTime),
      receivedTime: parseEpochMillis(receivedTime),
      open,
      high,
      low,
      close,
      volume,
    };
  });
  if (contentSha256(candles) !== manifest.contentSha256) throw new DatasetIntegrityError(`${dataset}/${version}: el contenido no coincide con su SHA-256`);
  return { manifest, candles };
}

/**
 * Huella de un árbol de datos: SHA-256 de la lista ordenada «ruta relativa, SHA-256 del archivo». Es la que se
 * anota en el candado del test final (ADR 0020).
 */
export function treeSha256(dir: string): string {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .map((path) => `${relative(dir, path).split(sep).join('/')}\u0000${sha256(readFileSync(path))}`)
    .sort();
  if (files.length === 0) throw new DatasetIntegrityError(`${dir} no tiene archivos`);
  return sha256(files.join('\n'));
}
