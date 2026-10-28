// Captura del OHLCVT de Kraken al almacén de investigación (paso 19B, DATA.md §4 y ADR 0022). Cada CSV de un par en
// EUR es un dataset por fuente: se separa por received_time con la guarda, lo del test final se descarta sin mirarlo
// (solo se cuenta), lo demás se limpia con cleanCandles y se escribe con writeResearch junto a su procedencia.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Decimal } from '../shared/decimal.ts';
import { toUtcIso } from '../shared/time.ts';
import type { TestFinalGuard } from './guard.ts';
import { parseKrakenOhlcvt, type KrakenCsvFile, type RejectedRow } from './kraken.ts';
import { cleanCandles } from './quality.ts';
import { contentSha256, listVersions, type DatasetManifest, type DatasetSource } from './store.ts';

// Latencia mínima del OHLCVT de Kraken (ADR 0022): una vela no está disponible hasta 60 s después de su cierre.
// Es conservadora: retrasa las decisiones del replay, nunca las adelanta.
export const KRAKEN_OHLCVT_LATENCY_MS = 60_000;
// Kraken suma el volumen en float («0.0008168399999999999», ADR 0022): se redondea a la escala del almacén,
// DECIMAL(38,18), y se cuenta. Los precios no se tocan: si uno no cabe, writeDataset falla.
const VOLUME_SCALE = 18;

function roundVolume(volume: Decimal): Decimal {
  return volume.roundToScale(VOLUME_SCALE, 'HALF_EVEN');
}

export interface CaptureSource extends DatasetSource {
  readonly label: string; // fuente dentro del dataset: «full2026q2», «2026q3»
}

export interface CaptureResult {
  readonly dataset: string;
  readonly pair: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly version: string | null; // null si no quedó ninguna vela de investigación
  readonly reused: boolean; // la misma versión ya estaba guardada
  readonly parsedRows: number; // filas del CSV entendidas; las demás, en rejectedRows
  readonly rejectedRows: readonly RejectedRow[];
  readonly testFinalDropped: number;
  readonly volumeRoundedRows: number; // filas cuyo volumen tenía más de 18 decimales
  readonly validRows: number;
  readonly invalid: number;
  readonly duplicatesRemoved: number;
  readonly conflicts: number;
  readonly gaps: number;
  readonly largestGapBars: number;
  readonly firstOpenUtc: string | null;
  readonly lastCloseUtc: string | null;
}

export function datasetId(file: KrakenCsvFile, label: string): string {
  return `kraken-${file.pair.toLowerCase()}-${file.timeframe}-${label}`;
}

/** Captura un CSV. Si la misma versión ya existe con la misma procedencia, no reescribe nada. */
export async function captureKrakenCsv(
  guard: TestFinalGuard,
  researchRoot: string,
  csv: string,
  file: KrakenCsvFile,
  source: CaptureSource,
): Promise<CaptureResult> {
  const dataset = datasetId(file, source.label);
  const { candles, rejected } = parseKrakenOhlcvt(csv, { symbol: file.symbol, timeframe: file.timeframe, receivedLatencyMs: KRAKEN_OHLCVT_LATENCY_MS });
  // Lo del test final no se inspecciona: solo se cuenta y se descarta.
  const { research, testFinal } = guard.partition(candles);
  const rounded = research.filter((c) => !roundVolume(c.volume).eq(c.volume));
  const { candles: clean, report } = cleanCandles(
    research.map((c) => ({ ...c, volume: roundVolume(c.volume) })),
    file.timeframe,
  );
  const first = clean[0];
  const last = clean.at(-1);
  const base = {
    dataset,
    pair: file.pair,
    symbol: file.symbol,
    timeframe: file.timeframe,
    parsedRows: candles.length,
    rejectedRows: rejected,
    testFinalDropped: testFinal.length,
    volumeRoundedRows: rounded.length,
    validRows: report.validRows,
    invalid: report.invalid.length,
    duplicatesRemoved: report.duplicatesRemoved,
    conflicts: report.conflicts.length,
    gaps: report.gaps.length,
    largestGapBars: report.gaps.reduce((m, g) => (g.missingBars > m ? g.missingBars : m), 0),
    firstOpenUtc: first === undefined ? null : toUtcIso(first.openTime),
    lastCloseUtc: last === undefined ? null : toUtcIso(last.closeTime),
  };
  if (first === undefined) return { ...base, version: null, reused: false };

  const version = contentSha256(clean).slice(0, 16);
  if (existsSync(join(researchRoot, dataset, version))) {
    const existing = listVersions(researchRoot, dataset).find((m) => m.version === version);
    if (existing?.source.originalSha256 !== source.originalSha256) {
      throw new RangeError(`${dataset}/${version} ya existe con otra procedencia: no se reescribe`);
    }
    return { ...base, version, reused: true };
  }
  const manifest: DatasetManifest = await guard.writeResearch({
    dataset,
    source: { provider: source.provider, url: source.url, retrievedAtUtc: source.retrievedAtUtc, originalSha256: source.originalSha256, terms: source.terms },
    timeframe: file.timeframe,
    receivedLatencyMs: KRAKEN_OHLCVT_LATENCY_MS,
    candles: clean,
    quality: report,
  });
  return { ...base, version: manifest.version, reused: false };
}

const AssetPairsSchema = z.object({
  error: z.array(z.string()).length(0),
  result: z.record(z.string(), z.object({ altname: z.string().min(1), quote: z.string().min(1) })),
});
// Código de Kraken para el euro en AssetPairs.
const KRAKEN_EUR = 'ZEUR';

/** Altnames de los pares que Kraken lista hoy, de la respuesta de `GET /0/public/AssetPairs`: todos y los de EUR. */
export function listedPairs(assetPairs: unknown): { all: Set<string>; inEur: Set<string> } {
  const pairs = Object.values(AssetPairsSchema.parse(assetPairs).result);
  return { all: new Set(pairs.map((p) => p.altname)), inEur: new Set(pairs.filter((p) => p.quote === KRAKEN_EUR).map((p) => p.altname)) };
}

/**
 * Pares en EUR del ZIP que hoy no están listados (deslistados o renombrados: DATA.md §2) y pares en EUR listados
 * hoy que el ZIP no trae (listados después del cierre del ZIP, o que faltan).
 */
export function compareWithListing(zipPairs: Iterable<string>, listed: { all: ReadonlySet<string>; inEur: ReadonlySet<string> }): { notListedNow: string[]; missingFromZip: string[] } {
  const inZip = new Set(zipPairs);
  return {
    notListedNow: [...inZip].filter((p) => !listed.all.has(p)).sort(),
    missingFromZip: [...listed.inEur].filter((p) => !inZip.has(p)).sort(),
  };
}
