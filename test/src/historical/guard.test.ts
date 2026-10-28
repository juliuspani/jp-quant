// Guarda del test final (src/historical/guard.ts, ADR 0020). Todo ocurre en una carpeta temporal con un candado de
// prueba y claves generadas aquí: ninguna prueba lee el candado real ni data/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { TestFinalGuard, TestFinalLockedError, UNLOCK_VARIABLE, type GuardPaths } from '../../../src/historical/guard.ts';
import { cleanCandles } from '../../../src/historical/quality.ts';
import { treeSha256, writeDataset, type NewDataset } from '../../../src/historical/store.ts';
import type { HistoricalCandle } from '../../../src/historical/types.ts';
import { publicKeyBase64, signUnlock, UNLOCK_PURPOSE } from '../../../src/historical/unlock.ts';
import { candle } from './helpers.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const BASE = mkdtempSync(join(tmpdir(), 'inversor-guard-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const day = (offset: number): number => START + offset * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

const keys = generateKeyPairSync('ed25519');
const PRIVATE = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC = publicKeyBase64(keys.publicKey);

let counter = 0;
function workspace(): GuardPaths {
  counter += 1;
  const dir = join(BASE, `w${String(counter)}`);
  mkdirSync(dir);
  return { lock: join(dir, 'lock.json'), testFinalRoot: join(dir, 'final'), researchRoot: join(dir, 'research'), rawRoot: join(dir, 'raw') };
}

// Candado con la forma del anexo A del ADR 0019 más los campos del ADR 0020.
function writeLock(paths: GuardPaths, extra: Record<string, unknown> = {}): void {
  const lock = {
    version: 1,
    periodUtc: { start: '2026-10-01T00:00:00Z', endExclusive: '2027-10-01T00:00:00Z' },
    researchDataEndUtc: '2026-09-30T23:59:59Z',
    stages: [
      { stage: 1, name: 'paper-provisional', opensTestData: false },
      { stage: 2, name: 'micro-live', notBeforeUtc: '2027-01-01T00:00:00Z', opensTestData: true },
      { stage: 3, name: 'capital', notBeforeUtc: '2027-10-01T00:00:00Z', opensTestData: true },
    ],
    dataHash: null,
    ...extra,
  };
  writeFileSync(paths.lock, JSON.stringify(lock, null, 2));
}

function guard(paths: GuardPaths, env: Record<string, string> = {}, now = day(120)): TestFinalGuard {
  return new TestFinalGuard({ paths, env, now: () => now });
}

function input(name: string, candles: HistoricalCandle[]): NewDataset {
  const { candles: clean, report } = cleanCandles(candles, '1d');
  return {
    dataset: name,
    source: { provider: 'test', url: 'https://example.invalid', retrievedAtUtc: '2027-01-02T00:00:00Z', originalSha256: 'b'.repeat(64), terms: null },
    timeframe: '1d',
    receivedLatencyMs: 1000,
    candles: clean,
    quality: report,
  };
}

const daily = (offset: number): HistoricalCandle => candle('BTC/EUR', day(offset), {}, '1d');

function token(paths: GuardPaths, overrides: Partial<{ stage: number; issued: number; expires: number; lockSha256: string; key: string }> = {}): string {
  const issued = overrides.issued ?? day(110);
  return signUnlock(
    {
      purpose: UNLOCK_PURPOSE,
      stage: overrides.stage ?? 2,
      lockSha256: overrides.lockSha256 ?? lockSha(paths),
      issuedAtUtc: iso(issued),
      expiresAtUtc: iso(overrides.expires ?? issued + 3_600_000),
    },
    overrides.key ?? PRIVATE,
  );
}

// SHA-256 de los bytes del candado, como lo calcula la guarda.
function lockSha(paths: GuardPaths): string {
  return createHash('sha256').update(readFileSync(paths.lock)).digest('hex');
}

/** Datos del test final escritos, huella y clave en el candado: lo que hace la persona al abrir una etapa. */
async function openedWorkspace(): Promise<GuardPaths> {
  const paths = workspace();
  writeLock(paths);
  await guard(paths).writeTestFinal(input('btc-1d', [daily(0), daily(1), daily(105), daily(110), daily(115)]));
  writeLock(paths, { dataHash: treeSha256(paths.testFinalRoot), unlockPublicKey: PUBLIC });
  return paths;
}

test('sin candado no se carga nada, tampoco investigación', async () => {
  const paths = workspace();
  const g = guard(paths);
  await assert.rejects(g.loadResearch('btc-1d', '0123456789abcdef'), TestFinalLockedError);
  await assert.rejects(g.writeResearch(input('btc-1d', [daily(-3)])), TestFinalLockedError);
  assert.throws(() => g.partition([daily(-3)]), TestFinalLockedError);
  assert.throws(() => g.authorize(), TestFinalLockedError);
  writeFileSync(paths.lock, '{ no es json');
  await assert.rejects(g.loadResearch('btc-1d', '0123456789abcdef'), TestFinalLockedError);
});

test('un candado que mueve el inicio del periodo se rechaza', () => {
  const paths = workspace();
  writeLock(paths, { periodUtc: { start: '2027-01-01T00:00:00Z', endExclusive: '2027-10-01T00:00:00Z' } });
  assert.throws(() => guard(paths).partition([daily(-3)]), TestFinalLockedError);
});

test('separación por received_time: la vela diaria del 30 de septiembre ya es del test final', () => {
  const paths = workspace();
  writeLock(paths);
  const { research, testFinal } = guard(paths).partition([daily(-2), daily(-1), daily(0)]);
  assert.deepEqual(research.map((c) => c.openTime), [day(-2)]);
  assert.deepEqual(testFinal.map((c) => c.openTime), [day(-1), day(0)]);
});

test('investigación y test final quedan en carpetas físicamente separadas', async () => {
  const paths = workspace();
  writeLock(paths);
  const g = guard(paths);
  await assert.rejects(g.writeResearch(input('btc-1d', [daily(-3), daily(-1)])), TestFinalLockedError);
  await assert.rejects(g.writeTestFinal(input('btc-1d', [daily(-3)])), RangeError);
  const research = await g.writeResearch(input('btc-1d', [daily(-3), daily(-2)]));
  assert.equal((await g.loadResearch('btc-1d', research.version)).length, 2);
  assert.throws(() => new TestFinalGuard({ paths: { ...paths, researchRoot: join(paths.testFinalRoot, 'x') }, env: {}, now: () => 0 }), TestFinalLockedError);
});

test('la lectura de investigación se niega a abrir un dataset cuyo rango toca el test final', async () => {
  const paths = workspace();
  writeLock(paths);
  // Escrito sin pasar por la guarda, como haría un error: la lectura lo para igual.
  const leaked = await writeDataset(paths.researchRoot, input('btc-1d', [daily(-3), daily(-1)]));
  await assert.rejects(guard(paths).loadResearch('btc-1d', leaked.version), TestFinalLockedError);
});

test('el test final no se abre sin el token firmado, sin clave pública o sin huella en el candado', async () => {
  const paths = workspace();
  writeLock(paths);
  await guard(paths).writeTestFinal(input('btc-1d', [daily(0)]));
  assert.throws(() => guard(paths).authorize(), /falta HOLDOUT_UNLOCK/);
  assert.throws(() => guard(paths, { [UNLOCK_VARIABLE]: token(paths) }).authorize(), /unlockPublicKey/);
  writeLock(paths, { unlockPublicKey: PUBLIC });
  assert.throws(() => guard(paths, { [UNLOCK_VARIABLE]: token(paths) }).authorize(), /dataHash/);
});

test('con token válido, etapa abierta y huella correcta se ven solo los datos recibidos hasta la emisión', async () => {
  const paths = await openedWorkspace();
  const g = guard(paths, { [UNLOCK_VARIABLE]: token(paths) }, day(110) + 60_000);
  assert.deepEqual(g.authorize(), { stage: 2, visibleUntil: day(110) });
  const [version] = readdirSync(join(paths.testFinalRoot, 'btc-1d'));
  const visible = await g.loadTestFinal('btc-1d', version ?? '');
  assert.deepEqual(visible.map((c) => c.openTime), [day(0), day(1), day(105)]);
});

test('el flujo de la persona con los scripts: clave, huella, candado y token abren la etapa', async () => {
  const run = (script: string, args: string[]): { status: number | null; stdout: string } => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...args], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout };
  };
  const paths = workspace();
  writeLock(paths);
  await guard(paths).writeTestFinal(input('btc-1d', [daily(0), daily(100)]));
  const keyFile = join(BASE, `key-${String(counter)}.pem`);
  // La clave privada nunca dentro del repositorio.
  assert.notEqual(run('test-final-keygen.ts', [join(REPO, 'test', 'clave.pem')]).status, 0);
  const keygen = run('test-final-keygen.ts', [keyFile]);
  assert.equal(keygen.status, 0);
  const publicKey = /unlockPublicKey: (\S+)/.exec(keygen.stdout)?.[1];
  const hash = run('hash-dataset.ts', [paths.testFinalRoot]).stdout.trim();
  assert.equal(hash, treeSha256(paths.testFinalRoot));
  // El script firma con la hora real: en este candado de prueba la etapa 2 ya está abierta.
  const stages = [{ stage: 2, opensTestData: true, notBeforeUtc: '2026-10-02T00:00:00Z' }];
  writeLock(paths, { dataHash: hash, unlockPublicKey: publicKey, stages });
  const signed = run('test-final-sign.ts', [keyFile, paths.lock, '2', '2']);
  assert.equal(signed.status, 0);
  assert.equal(guard(paths, { [UNLOCK_VARIABLE]: signed.stdout.trim() }, Date.now()).authorize().stage, 2);
  assert.notEqual(run('test-final-sign.ts', [keyFile, paths.lock, '2', '25']).status, 0);
});

test('cualquier fallo del token, de la etapa o de los datos mantiene cerrado el test final', async () => {
  const paths = await openedWorkspace();
  const now = day(110) + 60_000;
  const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const cases: [string, string, number][] = [
    ['otra clave', token(paths, { key: other }), now],
    ['caducado', token(paths), day(110) + 3_600_000],
    ['emitido en el futuro', token(paths), day(109)],
    ['más de 24 horas', token(paths, { expires: day(112) }), now],
    ['etapa que no abre datos', token(paths, { stage: 1 }), now],
    ['etapa inexistente', token(paths, { stage: 9 }), now],
    ['etapa 2 antes del 2027-01-01', token(paths, { issued: day(80) }), day(80) + 60_000],
    ['etapa 3 antes del 2027-10-01', token(paths, { stage: 3 }), now],
    ['firmado para otro candado', token(paths, { lockSha256: 'c'.repeat(64) }), now],
    ['payload alterado', token(paths).replace(/^v1\.[^.]+/, `v1.${Buffer.from('{"stage":2}').toString('base64url')}`), now],
    ['basura', 'v1.x.y', now],
  ];
  for (const [what, value, at] of cases) {
    assert.throws(() => guard(paths, { [UNLOCK_VARIABLE]: value }, at).authorize(), TestFinalLockedError, what);
  }
  // Datos cambiados después de fijar la huella.
  await guard(paths).writeTestFinal(input('eth-1d', [candle('ETH/EUR', day(2), {}, '1d')]));
  assert.throws(() => guard(paths, { [UNLOCK_VARIABLE]: token(paths) }, now).authorize(), /dataHash/);
});

// Ficheros brutos (paso 19B, ADR 0022): su periodo decide si son de investigación o del test final.
const Q3 = { firstUtc: '2026-07-01T00:00:00Z', lastUtc: '2026-09-30T23:59:59Z' };
const Q4 = { firstUtc: '2026-10-01T00:00:00Z', lastUtc: '2026-12-31T23:59:59Z' };
const PARTIAL = { firstUtc: '2026-09-30T00:00:00Z', lastUtc: '2026-10-01T00:00:00Z' };

test('brutos: se leen solo si todo su periodo acaba como tarde en researchDataEndUtc, y desde su carpeta', () => {
  const paths = workspace();
  writeLock(paths);
  const g = guard(paths);
  const inRaw = join(paths.rawRoot, 'kraken', 'Kraken_OHLCVT_2026Q3.zip');
  assert.equal(g.rawFileForReading(inRaw, Q3), inRaw);
  assert.equal(g.rawFileForReading(inRaw, { firstUtc: null, lastUtc: '2026-09-30T23:59:59Z' }), inRaw);
  // Del test final, total o parcialmente: se niega antes de leer.
  for (const period of [Q4, PARTIAL, { firstUtc: null, lastUtc: '2026-10-08T23:59:59Z' }]) {
    assert.throws(() => g.rawFileForReading(inRaw, period), TestFinalLockedError, period.lastUtc);
  }
  // De investigación, pero fuera de su carpeta: tampoco.
  assert.throws(() => g.rawFileForReading(join(paths.researchRoot, 'x.zip'), Q3), TestFinalLockedError);
  assert.throws(() => g.rawFileForReading(inRaw, { firstUtc: '2026-09-30T00:00:00Z', lastUtc: '2026-07-01T00:00:00Z' }), RangeError);
});

test('brutos: una descarga del test final se niega sin el desbloqueo; las de investigación van a su carpeta', () => {
  const paths = workspace();
  writeLock(paths);
  const g = guard(paths);
  assert.equal(g.rawDownloadPath(join('kraken', 'Kraken_OHLCVT_2026Q3.zip'), Q3), join(paths.rawRoot, 'kraken', 'Kraken_OHLCVT_2026Q3.zip'));
  assert.throws(() => g.rawDownloadPath(join('kraken', 'Kraken_OHLCVT_2026Q4.zip'), Q4), TestFinalLockedError);
  assert.throws(() => g.rawDownloadPath(join('kraken', 'x.zip'), PARTIAL), TestFinalLockedError);
  assert.throws(() => g.rawDownloadPath(join('..', 'x.zip'), Q3), RangeError);
});

test('brutos: con el desbloqueo, lo del test final se lee y se descarga solo en su carpeta', async () => {
  const paths = workspace();
  writeLock(paths);
  await guard(paths).writeTestFinal(input('btc-1d', [daily(0), daily(1)]));
  const q4 = join(paths.testFinalRoot, 'raw', 'kraken', 'Kraken_OHLCVT_2026Q4.zip');
  mkdirSync(join(paths.testFinalRoot, 'raw', 'kraken'), { recursive: true });
  writeFileSync(q4, 'zip');
  writeLock(paths, { dataHash: treeSha256(paths.testFinalRoot), unlockPublicKey: PUBLIC });
  const g = guard(paths, { [UNLOCK_VARIABLE]: token(paths) }, day(110) + 60_000);
  assert.equal(g.rawFileForReading(q4, Q4), q4);
  assert.throws(() => g.rawFileForReading(join(paths.rawRoot, 'kraken', 'Kraken_OHLCVT_2026Q4.zip'), Q4), TestFinalLockedError);
  assert.equal(g.rawDownloadPath(join('kraken', 'Kraken_OHLCVT_2027Q1.zip'), Q4), join(paths.testFinalRoot, 'raw', 'kraken', 'Kraken_OHLCVT_2027Q1.zip'));
  // Sin el token, nada.
  assert.throws(() => guard(paths).rawFileForReading(q4, Q4), TestFinalLockedError);
});
