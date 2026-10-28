// Ficheros brutos de Kraken y la guarda (src/historical/kraken-raw.ts y krakenRawPeriod, paso 19B, ADR 0022): el
// descargador se niega a bajar nada posterior a researchDataEndUtc. En una carpeta temporal con un candado de prueba.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { TestFinalGuard, TestFinalLockedError, type GuardPaths } from '../../../src/historical/guard.ts';
import { krakenDownloadPath, krakenRawForReading } from '../../../src/historical/kraken-raw.ts';
import { krakenRawPeriod } from '../../../src/historical/kraken.ts';

const BASE = mkdtempSync(join(tmpdir(), 'inversor-kraken-raw-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

function setup(): { guard: TestFinalGuard; paths: GuardPaths } {
  const paths = { lock: join(BASE, 'lock.json'), testFinalRoot: join(BASE, 'final'), researchRoot: join(BASE, 'research'), rawRoot: join(BASE, 'raw') };
  mkdirSync(BASE, { recursive: true });
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
  return { guard: new TestFinalGuard({ paths, env: {}, now: () => Date.UTC(2026, 9, 8) }), paths };
}

test('periodo por nombre: ZIP completo, trimestral, foto de AssetPairs y trades de un día', () => {
  assert.deepEqual(krakenRawPeriod('Kraken_OHLCVT_Full_2026Q2.zip'), { firstUtc: null, lastUtc: '2026-06-30T23:59:59Z' });
  assert.deepEqual(krakenRawPeriod('Kraken_OHLCVT_Full_2026Q2.zip.part03'), { firstUtc: null, lastUtc: '2026-06-30T23:59:59Z' });
  assert.deepEqual(krakenRawPeriod('Kraken_OHLCVT_2026Q3.zip'), { firstUtc: '2026-07-01T00:00:00Z', lastUtc: '2026-09-30T23:59:59Z' });
  assert.deepEqual(krakenRawPeriod('Kraken_OHLCVT_2026Q4.zip'), { firstUtc: '2026-10-01T00:00:00Z', lastUtc: '2026-12-31T23:59:59Z' });
  assert.deepEqual(krakenRawPeriod('AssetPairs_2026-10-08.json'), { firstUtc: '2026-10-08T00:00:00Z', lastUtc: '2026-10-08T23:59:59Z' });
  // La última página de trades puede pasarse del día: el periodo llega al final del siguiente.
  assert.deepEqual(krakenRawPeriod('Trades_XBTEUR_2026-06-15.jsonl'), { firstUtc: '2026-06-15T00:00:00Z', lastUtc: '2026-06-16T23:59:59.000Z' });
  for (const unknown of ['Kraken_OHLCVT_Full.zip.part00', 'Kraken_OHLCVT_2026Q5.zip', 'OHLCVT_Full_PARTS_SHA256SUMS.txt', 'x.zip']) {
    assert.equal(krakenRawPeriod(unknown), null, unknown);
  }
});

test('descargador: se niega al ZIP trimestral 2026Q4 y posteriores, y a todo lo posterior a researchDataEndUtc', () => {
  const { guard, paths } = setup();
  for (const name of [
    'Kraken_OHLCVT_2026Q4.zip',
    'Kraken_OHLCVT_2027Q1.zip',
    'Kraken_OHLCVT_Full_2026Q4.zip.part00',
    'AssetPairs_2026-10-08.json',
    'Trades_XBTEUR_2026-09-30.jsonl', // su última página podría llegar al 1 de octubre
  ]) {
    assert.throws(() => krakenDownloadPath(guard, name), TestFinalLockedError, name);
  }
  assert.equal(krakenDownloadPath(guard, 'Kraken_OHLCVT_2026Q3.zip'), join(paths.rawRoot, 'kraken', 'Kraken_OHLCVT_2026Q3.zip'));
  assert.equal(krakenDownloadPath(guard, 'Trades_XBTEUR_2026-09-29.jsonl'), join(paths.rawRoot, 'kraken', 'Trades_XBTEUR_2026-09-29.jsonl'));
  // Sin periodo conocido o con carpetas en el nombre: tampoco.
  assert.throws(() => krakenDownloadPath(guard, 'Kraken_OHLCVT_Full.zip.part00'), RangeError);
  assert.throws(() => krakenDownloadPath(guard, join('..', 'Kraken_OHLCVT_2026Q3.zip')), RangeError);
});

test('lectura de brutos: la foto de AssetPairs del 2026-10-08 y el ZIP 2026Q4 no se abren; el 2026Q3, sí', () => {
  const { guard, paths } = setup();
  const raw = (name: string): string => join(paths.rawRoot, 'kraken', name);
  assert.equal(krakenRawForReading(guard, raw('Kraken_OHLCVT_2026Q3.zip')), raw('Kraken_OHLCVT_2026Q3.zip'));
  assert.throws(() => krakenRawForReading(guard, raw('AssetPairs_2026-10-08.json')), TestFinalLockedError);
  assert.throws(() => krakenRawForReading(guard, raw('Kraken_OHLCVT_2026Q4.zip')), TestFinalLockedError);
  assert.throws(() => krakenRawForReading(guard, raw('renombrado.zip')), RangeError);
});
