// Guarda del test final (CLAUDE.md §2, INV-13, ADR 0019 y ADR 0020). Es el único código, además del hook, que nombra
// config/holdout.lock y data/holdout/ (INV-13c). Fail closed: sin un candado legible no se carga nada, ni siquiera
// investigación. Los datos con received_time desde el inicio del periodo solo se escriben bajo data/holdout/ y solo
// se leen con el token HOLDOUT_UNLOCK firmado por la persona, la etapa abierta y la huella de los datos en el candado.
// Lo mismo para los ficheros brutos (paso 19B, ADR 0022): uno cuyo periodo pasa de researchDataEndUtc, aunque sea en
// parte, es del test final; leerlo o descargarlo exige ese desbloqueo, y se guarda bajo data/holdout/raw/.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { addMs, parseUtcIso, toUtcIso, type UtcMillis } from '../shared/time.ts';
import { IsoUtc, readDataset, readManifest, treeSha256, writeDataset, type DatasetManifest, type NewDataset } from './store.ts';
import type { HistoricalCandle } from './types.ts';
import { verifyUnlock, type UnlockPayload } from './unlock.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
export const DEFAULT_PATHS: GuardPaths = {
  lock: join(REPO, 'config', 'holdout.lock'),
  testFinalRoot: join(REPO, 'data', 'holdout'),
  researchRoot: join(REPO, 'data', 'historical'),
  rawRoot: join(REPO, 'data', 'raw'),
};
const TEST_FINAL_RAW = 'raw'; // subcarpeta de los brutos dentro de la carpeta del test final
// Informes de procedencia de las capturas. Las rutas de data/ solo se nombran aquí (test/enforcement/data-paths.test.ts).
export const PROVENANCE_ROOT = join(REPO, 'data', 'provenance');
export const UNLOCK_VARIABLE = 'HOLDOUT_UNLOCK';
// Fijado también aquí (ADR 0019): un candado con otro inicio no se acepta, para que no se pueda mover el periodo.
export const TEST_FINAL_START_UTC = '2026-10-01T00:00:00Z';
const MAX_TOKEN_VALIDITY_MS = 86_400_000; // 24 horas

export interface GuardPaths {
  readonly lock: string;
  readonly testFinalRoot: string;
  readonly researchRoot: string;
  readonly rawRoot: string; // ficheros brutos de investigación, tal como se descargan
}

/** Periodo que cubre un fichero bruto: primer y último segundo, en UTC e incluidos (null si no se sabe el primero). */
export interface RawPeriod {
  readonly firstUtc: string | null;
  readonly lastUtc: string;
}

export interface GuardOptions {
  readonly paths: GuardPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => UtcMillis;
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const LockSchema = z.object({
  periodUtc: z.object({ start: IsoUtc, endExclusive: IsoUtc }),
  researchDataEndUtc: IsoUtc,
  stages: z.array(
    z.object({ stage: z.number().int().positive(), opensTestData: z.boolean(), notBeforeUtc: IsoUtc.optional() }),
  ),
  dataHash: Sha256.nullable(),
  // Campo del ADR 0020: lo añade la persona al abrir una etapa. Mientras falte o sea null, nada se abre.
  unlockPublicKey: z.string().min(1).nullable().optional(),
});

interface Lock {
  readonly start: UtcMillis;
  readonly end: UtcMillis;
  readonly researchDataEnd: UtcMillis;
  readonly stages: z.infer<typeof LockSchema>['stages'];
  readonly dataHash: string | null;
  readonly unlockPublicKey: string | null;
  readonly sha256: string;
}

export class TestFinalLockedError extends Error {
  override readonly name = 'TestFinalLockedError';
}

export interface TestFinalAuthorization {
  readonly stage: number;
  readonly visibleUntil: UtcMillis; // emisión del token: no se ve nada recibido después
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class TestFinalGuard {
  readonly #options: GuardOptions;

  constructor(options: GuardOptions) {
    for (const root of [options.paths.researchRoot, options.paths.rawRoot]) {
      if (isInside(root, options.paths.testFinalRoot) || isInside(options.paths.testFinalRoot, root)) {
        throw new TestFinalLockedError('los datos de investigación y los del test final deben estar separados físicamente');
      }
    }
    this.#options = options;
  }

  #lock(): Lock {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.#options.paths.lock);
    } catch (e) {
      throw new TestFinalLockedError(`no hay candado del test final legible: no se carga nada (${e instanceof Error ? e.message : String(e)})`);
    }
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new TestFinalLockedError('el candado del test final no es JSON válido: no se carga nada');
    }
    const parsed = LockSchema.safeParse(json);
    if (!parsed.success) throw new TestFinalLockedError(`candado del test final inválido: ${parsed.error.message}`);
    const lock = parsed.data;
    const start = parseUtcIso(lock.periodUtc.start);
    if (start !== parseUtcIso(TEST_FINAL_START_UTC)) {
      throw new TestFinalLockedError(`el candado dice que el test final empieza el ${lock.periodUtc.start}; el ADR 0019 fija ${TEST_FINAL_START_UTC}`);
    }
    const researchDataEnd = parseUtcIso(lock.researchDataEndUtc);
    if (researchDataEnd >= start) throw new TestFinalLockedError('los datos de investigación no pueden llegar al test final');
    return {
      start,
      end: parseUtcIso(lock.periodUtc.endExclusive),
      researchDataEnd,
      stages: lock.stages,
      dataHash: lock.dataHash,
      unlockPublicKey: lock.unlockPublicKey ?? null,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** Separa por received_time: lo recibido desde el inicio del periodo es del test final. */
  partition(candles: readonly HistoricalCandle[]): { research: HistoricalCandle[]; testFinal: HistoricalCandle[] } {
    const { start } = this.#lock();
    return { research: candles.filter((c) => c.receivedTime < start), testFinal: candles.filter((c) => c.receivedTime >= start) };
  }

  async writeResearch(input: NewDataset): Promise<DatasetManifest> {
    const { start } = this.#lock();
    const leaked = input.candles.find((c) => c.receivedTime >= start);
    if (leaked !== undefined) {
      throw new TestFinalLockedError(`${leaked.symbol} recibido el ${toUtcIso(leaked.receivedTime)} es del test final: no va a investigación`);
    }
    return writeDataset(this.#options.paths.researchRoot, input);
  }

  async writeTestFinal(input: NewDataset): Promise<DatasetManifest> {
    const { start } = this.#lock();
    if (input.candles.some((c) => c.receivedTime < start)) throw new RangeError('hay velas anteriores al test final: van a investigación');
    return writeDataset(this.#options.paths.testFinalRoot, input);
  }

  /** Investigación: se niega antes de leer si el rango del dataset llega al test final. */
  async loadResearch(dataset: string, version: string): Promise<HistoricalCandle[]> {
    const { start } = this.#lock();
    const manifest = readManifest(this.#options.paths.researchRoot, dataset, version);
    const lastReceived = addMs(parseUtcIso(manifest.rangeUtc.endExclusive), manifest.receivedLatencyMs);
    if (lastReceived >= start) {
      throw new TestFinalLockedError(`${dataset}/${version} llega hasta ${toUtcIso(lastReceived)}: toca el test final, que empieza el ${TEST_FINAL_START_UTC}`);
    }
    const { candles } = await readDataset(this.#options.paths.researchRoot, dataset, version);
    // Segunda barrera: dato a dato, por si el manifiesto mintiera.
    if (candles.some((c) => c.receivedTime >= start)) throw new TestFinalLockedError(`${dataset}/${version} contiene datos del test final`);
    return candles;
  }

  /** Un fichero bruto es de investigación si todo su periodo acaba como tarde en researchDataEndUtc. */
  #rawIsResearch(period: RawPeriod): boolean {
    const { researchDataEnd } = this.#lock();
    const last = parseUtcIso(period.lastUtc);
    if (period.firstUtc !== null && parseUtcIso(period.firstUtc) > last) throw new RangeError(`periodo invertido: ${period.firstUtc} > ${period.lastUtc}`);
    return last <= researchDataEnd;
  }

  /**
   * Ruta de un fichero bruto que se va a leer. De investigación: solo dentro de su carpeta. Si su periodo pasa de
   * researchDataEndUtc, es del test final: sin el desbloqueo, lanza antes de leer nada.
   */
  rawFileForReading(path: string, period: RawPeriod): string {
    if (this.#rawIsResearch(period)) {
      if (!isInside(path, this.#options.paths.rawRoot)) throw new TestFinalLockedError(`${path} no está en la carpeta de brutos de investigación`);
      return path;
    }
    this.authorize();
    if (!isInside(path, join(this.#options.paths.testFinalRoot, TEST_FINAL_RAW))) {
      throw new TestFinalLockedError(`${path} tiene datos del test final y no está en su carpeta`);
    }
    return path;
  }

  /**
   * Destino de una descarga (ruta relativa dentro de los brutos). Un periodo que pasa de researchDataEndUtc se niega
   * sin el desbloqueo y, con él, va a la carpeta del test final, nunca a la de investigación.
   */
  rawDownloadPath(relativePath: string, period: RawPeriod): string {
    const research = this.#rawIsResearch(period);
    if (!research) this.authorize();
    const root = research ? this.#options.paths.rawRoot : join(this.#options.paths.testFinalRoot, TEST_FINAL_RAW);
    const path = join(root, relativePath);
    if (!isInside(path, root) || path === resolve(root)) throw new RangeError(`ruta de descarga fuera de su carpeta: ${relativePath}`);
    return path;
  }

  /** Comprueba token, etapa y huella. Sin todo eso, lanza: el test final no se abre. */
  authorize(): TestFinalAuthorization {
    const lock = this.#lock();
    const token = this.#options.env[UNLOCK_VARIABLE];
    if (token === undefined || token === '') throw new TestFinalLockedError(`falta ${UNLOCK_VARIABLE}: solo la persona abre el test final (M-13)`);
    if (lock.unlockPublicKey === null) throw new TestFinalLockedError('el candado no tiene unlockPublicKey: ninguna etapa está abierta');
    if (lock.dataHash === null) throw new TestFinalLockedError('el candado no tiene dataHash: los datos del test final no están fijados');

    let payload: UnlockPayload;
    try {
      payload = verifyUnlock(token, lock.unlockPublicKey);
    } catch (e) {
      throw new TestFinalLockedError(`${UNLOCK_VARIABLE} no es válido: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (payload.lockSha256 !== lock.sha256) throw new TestFinalLockedError(`${UNLOCK_VARIABLE} se firmó para otro candado`);
    const now = this.#options.now();
    const issued = parseUtcIso(payload.issuedAtUtc);
    const expires = parseUtcIso(payload.expiresAtUtc);
    if (expires > addMs(issued, MAX_TOKEN_VALIDITY_MS)) throw new TestFinalLockedError(`${UNLOCK_VARIABLE} dura más de 24 horas`);
    if (now < issued || now >= expires) throw new TestFinalLockedError(`${UNLOCK_VARIABLE} no está vigente ahora`);

    const stage = lock.stages.find((s) => s.stage === payload.stage);
    if (stage === undefined || !stage.opensTestData) throw new TestFinalLockedError(`la etapa ${String(payload.stage)} no abre datos del test final`);
    if (stage.notBeforeUtc === undefined) throw new TestFinalLockedError(`la etapa ${String(payload.stage)} no tiene fecha mínima en el candado`);
    if (issued < parseUtcIso(stage.notBeforeUtc)) throw new TestFinalLockedError(`la etapa ${String(payload.stage)} no se abre antes del ${stage.notBeforeUtc}`);

    let hash: string;
    try {
      hash = treeSha256(this.#options.paths.testFinalRoot);
    } catch (e) {
      throw new TestFinalLockedError(`no se pueden comprobar los datos del test final: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (hash !== lock.dataHash) throw new TestFinalLockedError('los datos del test final no coinciden con el dataHash del candado');
    return { stage: payload.stage, visibleUntil: issued };
  }

  /** Test final: solo con autorización, y solo lo recibido hasta la emisión del token. */
  async loadTestFinal(dataset: string, version: string): Promise<HistoricalCandle[]> {
    const { visibleUntil } = this.authorize();
    const { candles } = await readDataset(this.#options.paths.testFinalRoot, dataset, version);
    return candles.filter((c) => c.receivedTime <= visibleUntil);
  }
}

/** La guarda con las rutas reales, el entorno del proceso y el reloj del sistema. */
export function defaultGuard(): TestFinalGuard {
  return new TestFinalGuard({ paths: DEFAULT_PATHS, env: process.env, now: () => Date.now() });
}
