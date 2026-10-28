// INV-13 (SECURITY_AND_TRADING_INVARIANTS.md): el test final es intocable. Ningún código lo nombra salvo el hook
// que lo protege, Claude tiene negado su contenido, sus datos no se versionan y su candado sí.
// Ninguna prueba lee el contenido del candado ni de los datos: solo se comprueba que existen o que se ignoran.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TestFinalGuard, TestFinalLockedError } from '../../src/historical/guard.ts';
import { krakenDownloadPath, krakenRawForReading } from '../../src/historical/kraken-raw.ts';
import { cleanCandles } from '../../src/historical/quality.ts';
import { writeDataset } from '../../src/historical/store.ts';
import { Decimal } from '../../src/shared/decimal.ts';
import { git, matchingLines, read, ROOT, runnableCode } from './repo.ts';

const LOCK = 'config/holdout.lock';
const DATA = 'data/holdout/btc.csv';

// Código que puede nombrar el test final: el hook y la guarda de historical/ (ADR 0016 y ADR 0020).
const MAY_NAME_IT = new Set(['scripts/claude-guard.ts', 'src/historical/guard.ts']);

test('INV-13b: Claude tiene negado el contenido del test final y el hook vigila sus herramientas', () => {
  const settings = JSON.parse(read('.claude/settings.json')) as {
    permissions: { deny: string[] };
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  for (const rule of [`Read(./${LOCK})`, 'Read(./data/holdout/**)', `Edit(./${LOCK})`, 'Edit(./data/holdout/**)']) {
    assert.ok(settings.permissions.deny.includes(rule), `falta en permissions.deny: ${rule}`);
  }
  const guard = settings.hooks.PreToolUse.find((h) => h.hooks.some((c) => c.command.includes('scripts/claude-guard.ts')));
  assert.ok(guard, 'el hook scripts/claude-guard.ts no está registrado');
  for (const tool of ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Grep']) {
    assert.ok(guard.matcher.split('|').includes(tool), `el hook no vigila ${tool}`);
  }
});

test('INV-13c: ningún código nombra el test final, salvo el que lo protege', () => {
  const files = runnableCode().filter((f) => !MAY_NAME_IT.has(f));
  assert.deepEqual(matchingLines(files, [/holdout/i]), []);
});

test('INV-13e: el candado del test final existe (solo se comprueba que existe, no se lee)', () => {
  // Lo crea una persona (M-13) con el anexo A del ADR 0019.
  assert.ok(existsSync(join(ROOT, LOCK)), `${LOCK} no existe: lo crea una persona (M-13)`);
});

test('INV-13f: la guarda de historical/ rechaza el test final sin el flag firmado, y todo si falta el candado', async () => {
  // En una carpeta temporal, con un candado de prueba: nunca se lee el real (detalle en test/src/historical/guard.test.ts).
  const dir = mkdtempSync(join(tmpdir(), 'inversor-inv13f-'));
  try {
    const paths = { lock: join(dir, 'lock.json'), testFinalRoot: join(dir, 'final'), researchRoot: join(dir, 'research'), rawRoot: join(dir, 'raw') };
    const guard = new TestFinalGuard({ paths, env: {}, now: () => Date.UTC(2027, 6, 1) });
    // Sin candado: ni investigación.
    await assert.rejects(guard.loadResearch('btc-1d', '0123456789abcdef'), TestFinalLockedError);
    assert.throws(() => guard.authorize(), TestFinalLockedError);

    writeFileSync(paths.lock, JSON.stringify({
      periodUtc: { start: '2026-10-01T00:00:00Z', endExclusive: '2027-10-01T00:00:00Z' },
      researchDataEndUtc: '2026-09-30T23:59:59Z',
      stages: [{ stage: 2, opensTestData: true, notBeforeUtc: '2027-01-01T00:00:00Z' }],
      dataHash: null,
    }));
    // Un rango de investigación que toca el periodo se rechaza antes de leerlo.
    const open = Date.UTC(2026, 8, 30);
    const day = { o: Decimal.parse('1'), h: Decimal.parse('1'), l: Decimal.parse('1'), c: Decimal.parse('1') };
    const leaked = { symbol: 'BTC/EUR', timeframe: '1d' as const, openTime: open, closeTime: Date.UTC(2026, 9, 1), receivedTime: Date.UTC(2026, 9, 1, 0, 0, 1), open: day.o, high: day.h, low: day.l, close: day.c, volume: day.o };
    const { candles, report } = cleanCandles([leaked], '1d');
    const input = { dataset: 'btc-1d', source: { provider: 't', url: 'u', retrievedAtUtc: '2027-01-02T00:00:00Z', originalSha256: 'b'.repeat(64), terms: null }, timeframe: '1d' as const, receivedLatencyMs: 1000, candles, quality: report };
    await assert.rejects(guard.writeResearch(input), TestFinalLockedError);
    const written = await writeDataset(paths.researchRoot, input);
    await assert.rejects(guard.loadResearch('btc-1d', written.version), TestFinalLockedError);
    // Sin el flag firmado, el test final no se abre aunque sus datos existan.
    await guard.writeTestFinal(input);
    await assert.rejects(guard.loadTestFinal('btc-1d', written.version), TestFinalLockedError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INV-13h: la guarda no deja leer ni descargar un bruto cuyo periodo pasa del fin de los datos de investigación', () => {
  // En una carpeta temporal, con un candado de prueba (detalle en test/src/historical/guard.test.ts y kraken-raw.test.ts).
  const dir = mkdtempSync(join(tmpdir(), 'inversor-inv13h-'));
  try {
    const paths = { lock: join(dir, 'lock.json'), testFinalRoot: join(dir, 'final'), researchRoot: join(dir, 'research'), rawRoot: join(dir, 'raw') };
    writeFileSync(paths.lock, JSON.stringify({
      periodUtc: { start: '2026-10-01T00:00:00Z', endExclusive: '2027-10-01T00:00:00Z' },
      researchDataEndUtc: '2026-09-30T23:59:59Z',
      stages: [{ stage: 1, opensTestData: false }],
      dataHash: null,
    }));
    const guard = new TestFinalGuard({ paths, env: {}, now: () => Date.UTC(2026, 9, 8) });
    const raw = (name: string): string => join(paths.rawRoot, 'kraken', name);
    // Del test final, total o parcialmente: ni se lee ni se descarga sin el flag firmado.
    assert.throws(() => krakenRawForReading(guard, raw('Kraken_OHLCVT_2026Q4.zip')), TestFinalLockedError);
    assert.throws(() => krakenDownloadPath(guard, 'Kraken_OHLCVT_2026Q4.zip'), TestFinalLockedError);
    assert.throws(() => krakenDownloadPath(guard, 'Kraken_OHLCVT_2027Q1.zip'), TestFinalLockedError);
    assert.throws(() => guard.rawFileForReading(raw('x.zip'), { firstUtc: '2026-09-30T00:00:00Z', lastUtc: '2026-10-01T00:00:00Z' }), TestFinalLockedError);
    // Lo de investigación, sí, y solo desde su carpeta.
    assert.equal(krakenRawForReading(guard, raw('Kraken_OHLCVT_2026Q3.zip')), raw('Kraken_OHLCVT_2026Q3.zip'));
    assert.throws(() => guard.rawFileForReading(join(dir, 'x.zip'), { firstUtc: null, lastUtc: '2026-06-30T23:59:59Z' }), TestFinalLockedError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INV-13d: los datos del test final no se versionan y su candado sí', () => {
  // check-ignore devuelve 0 si la ruta se ignora y 1 si no.
  assert.equal(git(['check-ignore', '-q', '--no-index', DATA]).status, 0, `${DATA} debería ignorarse`);
  assert.equal(git(['check-ignore', '-q', '--no-index', LOCK]).status, 1, `${LOCK} debe poder versionarse`);
});
