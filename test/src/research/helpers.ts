// Utilidades de las pruebas del registro de experimentos: registro temporal, git y datasets falsos, y un ejecutor de
// juguete determinista. Son datos sintéticos para probar el código: nunca van al registro real.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { seededRng } from '../../../src/kernel/random.ts';
import type { DatasetPort, DatasetRef, ExperimentSpec, ResearchContext, Runner } from '../../../src/research/experiment.ts';
import { runnerKey } from '../../../src/research/experiment.ts';
import type { GitPort } from '../../../src/research/git.ts';
import { REGISTRY_FILE, type NewRegistration } from '../../../src/research/registry.ts';
import { parseUtcIso } from '../../../src/shared/time.ts';

export const T0 = parseUtcIso('2026-10-13T00:00:00Z');
export const COMMIT = 'a'.repeat(40);
export const DATA_HASH = 'd'.repeat(64);

/** Carpeta temporal que se borra al terminar el archivo de pruebas. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Repositorio temporal con usuario local, para poder hacer commits sin depender de la configuración global. */
export function tempRepo(): { dir: string; git: (...args: string[]) => string; commit: (message: string) => string } {
  const dir = tempDir('ijp-git-');
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'prueba');
  git('config', 'user.email', 'prueba@example.invalid');
  git('config', 'core.autocrlf', 'false'); // el registro es byte a byte: sin conversión de finales de línea
  const commit = (message: string): string => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

export function tempRegistry(): string {
  return join(tempDir('ijp-registry-'), ...REGISTRY_FILE.split('/'));
}

export interface FakeGit extends GitPort {
  headCommit: string;
  dirty: string[];
  changed: string[];
}

export function fakeGit(): FakeGit {
  const git: FakeGit = {
    headCommit: COMMIT,
    dirty: [],
    changed: [],
    head: () => git.headCommit,
    dirtyPaths: () => git.dirty,
    changedSince: () => git.changed,
  };
  return git;
}

export const REF: DatasetRef = {
  fuente: 'sintético', dataset: 'toy-1d', version: '0123456789abcdef', timeframe: '1d',
  rango: { desde: '2020-01-01T00:00:00Z', hasta: '2024-01-01T00:00:00Z' },
};

/** Datasets en memoria. `hash` es el del manifiesto; `loadHash` permite simular un contenido que ya no cuadra. */
export class FakeDatasets implements DatasetPort {
  data: unknown = ['100', '101.5', '99.25', '103', '104.75', '102', '106.5', '108', '107.25', '110'];
  hashValue = DATA_HASH;
  loadHash: string | null = null;
  loads = 0;

  hash(): string {
    return this.hashValue;
  }

  load(): Promise<{ hash: string; data: unknown }> {
    this.loads += 1;
    return Promise.resolve({ hash: this.loadHash ?? this.hashValue, data: this.data });
  }
}

/**
 * Ejecutor de juguete: rendimientos de los cierres, un ruido con la semilla y una métrica en float. Depende de los
 * datos, de los parámetros, de los costes y de la semilla, así que cualquier cambio en ellos cambia el hash.
 */
export const toyRunner: Runner = (input) => {
  const closes = (input.data as string[]).map(Number);
  const rng = seededRng(input.semilla, 'toy');
  const k = input.parametros.tipo === 'valores' ? Number(input.parametros.valores['k']) : 1;
  const cost = Number(input.costes.comision) * input.costes.multiplicador;
  const returns = closes.slice(1).map((c, i) => k * (c / (closes[i] ?? c) - 1) - cost + (rng.next() - 0.5) / 1000);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return Promise.resolve({
    metricas: { media: mean, operaciones: returns.length, simbolo: input.universo.simbolos.join(',') },
    salida: { rendimientos: returns },
    veredicto: null,
  });
};

export const STRATEGY = { nombre: 'juguete', version: '1.0.0' };

// Un solo reloj para todas las pruebas del archivo: el registro exige fechas que no retroceden.
let tick = 0;

export function context(registryPath: string, git: GitPort, datasets: DatasetPort, runner: Runner = toyRunner): ResearchContext {
  return {
    registryPath, git, datasets,
    runners: new Map([[runnerKey(STRATEGY.nombre, STRATEGY.version), runner]]),
    now: () => T0 + 1000 * tick++,
  };
}

export function spec(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    autor: 'prueba', familia: 'juguete', familia_nueva: true, hipotesis: 'h', metrica_primaria: 'media', criterios: 'quant-research §9',
    estrategia: STRATEGY, datos: REF, universo: { regla: 'fija', simbolos: ['BTC/EUR'] },
    particiones: {
      tramos: [{ train: { desde: '2020-01-01T00:00:00Z', hasta: '2022-01-01T00:00:00Z' }, validation: { desde: '2022-01-01T00:00:00Z', hasta: '2023-01-01T00:00:00Z' } }],
      test: null, purging_velas: 5, embargo_velas: 5,
    },
    costes: { comision: '0.001', spread: '0.0002', slippage: '0.0005', multiplicador: 1 },
    parametros: { tipo: 'valores', valores: { k: 2 } },
    semilla: 42, variantes: 0, informe: null, notas: null,
    ...overrides,
  };
}

/** Línea de registro válida para escribir directamente con register(). */
export function registration(overrides: Partial<NewRegistration> = {}): NewRegistration {
  // Sin «variantes»: las líneas anteriores al paso 27B no lo llevan, y una prueba previa no puede declararlo.
  const { datos, variantes, ...rest } = spec();
  return {
    ...rest, ...(variantes === 0 ? {} : { variantes }), fecha: '2026-10-13T00:00:01.000Z', previa: false, n_pruebas: 1, commit: COMMIT, datos: { ...datos, hash: DATA_HASH },
    ...overrides,
  };
}
