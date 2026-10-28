// Almacén histórico de prueba para app/: una carpeta temporal con un candado de prueba (nunca el real) y datasets
// sintéticos escritos con la convención de la captura, `<prefijo>-<par>-<marco>-<etiqueta>`. Lo usan datasets.test.ts
// y research-runner.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { HistoricalDatasets, type UniverseCoverage } from '../../../src/app/datasets.ts';
import { TestFinalGuard, type GuardPaths } from '../../../src/historical/guard.ts';
import { cleanCandles } from '../../../src/historical/quality.ts';
import { writeDataset, type NewDataset } from '../../../src/historical/store.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { candles, HOUR, LATENCY, T0 } from './scenario.ts';

export const CLOSES = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 6));
export const COVERAGE: UniverseCoverage = { delistingsFrom: T0 + 60 * HOUR, activeSince: T0 + 119 * HOUR, end: T0 + 121 * HOUR };

const BASE = mkdtempSync(join(tmpdir(), 'inversor-app-store-'));
after(() => {
  rmSync(BASE, { recursive: true, force: true });
});
let counter = 0;

export interface StoreFixture {
  readonly paths: GuardPaths;
  readonly guard: TestFinalGuard;
  readonly datasets: HistoricalDatasets;
  write(name: string, candles: readonly HistoricalCandle[]): Promise<void>; // a investigación, sin pasar por la guarda
  writeTestFinal(name: string, candles: readonly HistoricalCandle[]): Promise<void>; // a la carpeta protegida, por la guarda
}

/**
 * Carpeta nueva con candado de prueba y, si se pide, los datasets del escenario: BTC/EUR en dos partes y OLD/EUR; con
 * `withSecondPair`, también ETH/EUR entero (el universo alternativo del paso 27B).
 */
export async function storeFixture(options: { readonly withScenario?: boolean; readonly withSecondPair?: boolean } = {}): Promise<StoreFixture> {
  counter += 1;
  const dir = join(BASE, `s${String(counter)}`);
  mkdirSync(dir);
  const paths: GuardPaths = { lock: join(dir, 'lock.json'), testFinalRoot: join(dir, 'final'), researchRoot: join(dir, 'research'), rawRoot: join(dir, 'raw') };
  writeFileSync(paths.lock, JSON.stringify({
    version: 1,
    periodUtc: { start: '2026-10-01T00:00:00Z', endExclusive: '2027-10-01T00:00:00Z' },
    researchDataEndUtc: '2026-09-30T23:59:59Z',
    stages: [{ stage: 1, name: 'paper-provisional', opensTestData: false }],
    dataHash: null,
  }));
  const guard = new TestFinalGuard({ paths, env: {}, now: () => Date.UTC(2026, 9, 13) });
  const datasets = new HistoricalDatasets({ guard, researchRoot: paths.researchRoot, coverage: COVERAGE });
  const dataset = (name: string, data: readonly HistoricalCandle[]): NewDataset => {
    const { candles: clean, report } = cleanCandles(data, '1h');
    return {
      dataset: name,
      source: { provider: 'prueba', url: 'https://example.invalid', retrievedAtUtc: '2026-10-08T00:00:00Z', originalSha256: 'b'.repeat(64), terms: null },
      timeframe: '1h',
      receivedLatencyMs: LATENCY,
      candles: clean,
      quality: report,
    };
  };
  const write = async (name: string, data: readonly HistoricalCandle[]): Promise<void> => {
    await writeDataset(paths.researchRoot, dataset(name, data));
  };
  const writeTestFinal = async (name: string, data: readonly HistoricalCandle[]): Promise<void> => {
    await guard.writeTestFinal(dataset(name, data));
  };
  if (options.withScenario === true) {
    const btc = candles(CLOSES);
    await write('prueba-xbteur-1h-full', btc.filter((c) => c.openTime < T0 + 80 * HOUR));
    await write('prueba-xbteur-1h-q3', btc.filter((c) => c.openTime >= T0 + 80 * HOUR));
    await write('prueba-oldeur-1h-full', candles(CLOSES.slice(0, 30)).map((c) => ({ ...c, symbol: 'OLD/EUR' })));
  }
  if (options.withSecondPair === true) {
    await write('prueba-etheur-1h-full', candles(CLOSES.map((_, i) => 50 + 4 * Math.cos(i / 5))).map((c) => ({ ...c, symbol: 'ETH/EUR' })));
  }
  return { paths, guard, datasets, write, writeTestFinal };
}
