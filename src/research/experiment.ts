// Ejecución de experimentos sobre el registro (quant-research §2, §10 y §13; ADR 0024). Orden fijo:
//   1. el árbol de trabajo está limpio y se anota el commit (si no, se aborta sin escribir nada: nada se ha mirado);
//   2. pre-registro con todo lo necesario para repetirlo, antes de cargar los datos;
//   3. carga, comprobación del hash de los datos y ejecución;
//   4. cierre «completado» con las métricas y el hash de la salida, o «fallido» con el motivo si algo lanza.
// La entrada del ejecutor se construye desde la línea registrada, no desde la petición, y desde lo que el registro tenía
// antes de ella (el N de la familia y el global, y los Sharpe de las pruebas anteriores, para el DSR): la ejecución y su
// reproducción reciben exactamente lo mismo. Un experimento se reproduce por su id con reproduceExperiment.
// Desde el paso 27B (ADR 0031), el ejecutor da también el veredicto de quant-research §11, calculado con los criterios
// congelados del paso 27, y las ejecuciones de robustez se declaran en «variantes» y cuentan en N.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256Hex } from '../shared/canonical.ts';
import { toUtcIso, type UtcMillis } from '../shared/time.ts';
import type { GitPort } from './git.ts';
import {
  close, EXPERIMENTS_DIR, gridSize, readRegistry, register,
  type ClosedLine, type Metricas, type RegisteredLine, type Registry, type Resultado,
} from './registry.ts';

type Particiones = NonNullable<RegisteredLine['particiones']>;
type Costes = NonNullable<RegisteredLine['costes']>;
type Parametros = Exclude<RegisteredLine['parametros'], { tipo: 'descripcion' }>;

/** Referencia a un dataset del almacén histórico; el hash lo da el puerto, no quien pide el experimento. */
export type DatasetRef = Omit<RegisteredLine['datos'], 'hash'> & { readonly dataset: string; readonly version: string };

export interface DatasetPort {
  hash(ref: DatasetRef): string; // SHA-256 del contenido según su manifiesto, sin cargar los datos
  load(ref: DatasetRef): Promise<{ readonly hash: string; readonly data: unknown }>; // carga y recalcula el hash
}

/** Lo que recibe un ejecutor: los campos del registro y los datos. Nada más, para que el resultado dependa solo de eso. */
export interface RunInput {
  readonly familia: string; // la del registro: elige el perfil por régimen (A.3.9)
  readonly estrategia: RegisteredLine['estrategia'];
  readonly datos: RegisteredLine['datos'];
  readonly universo: RegisteredLine['universo'];
  readonly particiones: Particiones;
  readonly costes: Costes;
  readonly parametros: Parametros;
  readonly semilla: number;
  readonly variantes: number; // ejecuciones de robustez registradas (0 en las líneas anteriores al paso 27B)
  readonly solo_eleccion?: boolean; // solo elige en train, sin medir validaciones (ADR 0044)
  readonly pruebas_familia: FamilyEvidence;
  readonly data: unknown;
}

/**
 * Lo que el DSR de la familia necesita del registro (quant-research §8), tal como estaba al pre-registrar. Su V[SRₙ] no
 * depende de otras pruebas (ADR 0039); el DSR global se calcula al decidir, con registryTrials.
 */
export interface FamilyEvidence {
  readonly n: number; // pruebas contando la línea registrada: también las fallidas, abortadas, invalidadas y previas
}

/** Métrica de cierre con el Sharpe por periodo, sin anualizar, de la serie fuera de muestra. */
export const FAMILY_SHARPE = 'sharpe_periodo';

export interface RunOutput {
  readonly metricas: Metricas;
  readonly salida: unknown; // valor canónico (src/shared/canonical.ts): operaciones, curva de patrimonio…
  readonly veredicto: Resultado['veredicto']; // quant-research §11 con los criterios congelados; null si el ejecutor no los evalúa
  // Archivos que se guardan aparte (paso 41C): las curvas del control aleatorio y los diarios de cada tramo. No entran en
  // el hash_salida por tamaño, pero el ejecutor pone su SHA-256 en la salida, así que el hash los cubre igual.
  readonly artefactos?: Artefacts;
}

export interface Artefacts {
  readonly controles: unknown; // una entrada de inversor-controles/1 sin id, o null si no representaría A.3.12
  // El diario inversor-replay/1 de cada tramo, en orden, con los parámetros con que se ejecutó (su ficha del dashboard).
  readonly diarios: readonly { readonly texto: string; readonly parametros: Readonly<Record<string, unknown>> }[];
}

export type Runner = (input: RunInput) => Promise<RunOutput>;

export interface ResearchContext {
  readonly registryPath: string;
  readonly git: GitPort;
  readonly datasets: DatasetPort;
  readonly runners: ReadonlyMap<string, Runner>; // por runnerKey(nombre, versión)
  readonly now: () => UtcMillis;
}

export interface ExperimentSpec {
  readonly autor: string;
  readonly familia: string;
  readonly familia_nueva: boolean; // una familia nueva se declara: una errata no puede abrir una familia con N = 1
  readonly hipotesis: string;
  readonly metrica_primaria: string;
  readonly criterios: string;
  readonly estrategia: RegisteredLine['estrategia'];
  readonly datos: DatasetRef;
  readonly universo: RegisteredLine['universo'];
  readonly particiones: Particiones;
  readonly costes: Costes;
  readonly parametros: Parametros;
  readonly semilla: number;
  readonly variantes: number; // ejecuciones de robustez que hará el ejecutor; las comprueba él mismo
  readonly solo_eleccion?: true; // solo elige en train, sin validaciones medidas, variantes ni veredicto (ADR 0044)
  readonly informe: string | null;
  readonly notas: string | null;
}

export class DirtyWorkingTreeError extends Error {
  override readonly name = 'DirtyWorkingTreeError';
}

export class ExperimentError extends Error {
  override readonly name = 'ExperimentError';
}

export class ReproductionError extends Error {
  override readonly name = 'ReproductionError';
}

export function runnerKey(nombre: string, version: string): string {
  return `${nombre}@${version}`;
}

/** Documentación: no cambia lo que ejecuta un experimento. Todo lo demás (src, scripts, config, lockfile…) sí. */
export function isDocumentation(path: string): boolean {
  return path.startsWith('docs/') || /^[^/]+\.md$/.test(path);
}

/** Commit de HEAD si no hay cambios sin confirmar. Solo se admiten los del propio registro y sus informes. */
export function cleanCommit(git: GitPort): string {
  const dirty = git.dirtyPaths().filter((path) => !path.startsWith(EXPERIMENTS_DIR));
  if (dirty.length > 0) {
    throw new DirtyWorkingTreeError(`cambios sin confirmar: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? '…' : ''}`);
  }
  return git.head();
}

function runnerFor(ctx: ResearchContext, estrategia: RegisteredLine['estrategia']): Runner {
  const runner = ctx.runners.get(runnerKey(estrategia.nombre, estrategia.version));
  if (runner === undefined) throw new ExperimentError(`sin ejecutor para ${runnerKey(estrategia.nombre, estrategia.version)}`);
  return runner;
}

function refOf(datos: RegisteredLine['datos']): DatasetRef {
  const { fuente, dataset, version, timeframe, rango } = datos;
  if (dataset === null || version === null) throw new ExperimentError('el registro no tiene dataset ni versión');
  return { fuente, dataset, version, timeframe, rango };
}

/** Carga, comprueba el hash de los datos registrado y ejecuta. Devuelve el resultado del cierre y la salida entera. */
async function execute(ctx: ResearchContext, line: RegisteredLine, runner: Runner): Promise<{ resultado: Resultado; salida: unknown; artefactos: Artefacts | null }> {
  const { particiones, costes, semilla, parametros } = line;
  if (line.previa || particiones === null || costes === null || semilla === null || parametros.tipo === 'descripcion') {
    throw new ExperimentError(`${line.id}: es una prueba previa o le faltan campos para ejecutarlo`);
  }
  const loaded = await ctx.datasets.load(refOf(line.datos));
  if (loaded.hash !== line.datos.hash) {
    throw new ExperimentError(`${line.id}: los datos no coinciden con el hash registrado (${String(line.datos.hash)} ≠ ${loaded.hash})`);
  }
  const registry = readRegistry(ctx.registryPath);
  const output = await runner({
    familia: line.familia,
    estrategia: line.estrategia,
    datos: line.datos,
    universo: line.universo,
    particiones,
    costes,
    parametros,
    semilla,
    variantes: line.variantes ?? 0,
    solo_eleccion: line.solo_eleccion === true,
    pruebas_familia: familyEvidence(line),
    data: loaded.data,
  });
  return { resultado: { metricas: output.metricas, hash_salida: outputHash(output), veredicto: output.veredicto }, salida: output.salida, artefactos: output.artefactos ?? null };
}

/** SHA-256 del JSON canónico de { metricas, salida }: el hash_salida del cierre. */
export function outputHash(output: Pick<RunOutput, 'metricas' | 'salida'>): string {
  return sha256Hex(canonicalJson({ metricas: output.metricas, salida: output.salida }));
}

/** Salidas completas de los experimentos, junto al registro (paso 27B): la decisión del paso 31 junta de ahí la matriz del PBO. */
export const OUTPUTS_DIR = `${EXPERIMENTS_DIR}salidas/`;

/** Guarda { metricas, salida } en JSON canónico, solo si coincide con el hash_salida del cierre y el archivo no existe. */
export function writeOutput(path: string, resultado: Resultado, salida: unknown): void {
  const text = canonicalJson({ metricas: resultado.metricas, salida });
  if (sha256Hex(text) !== resultado.hash_salida) throw new ExperimentError('la salida no coincide con el hash_salida del cierre');
  if (existsSync(path)) throw new ExperimentError(`${path} ya existe: una salida no se reescribe`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}\n`, { flag: 'wx' });
}

/** Lee una salida guardada y comprueba que es la del cierre: lanza si el archivo se editó. */
export function readOutput(path: string, resultado: Resultado): unknown {
  const text = readFileSync(path, 'utf8').replace(/\n$/, '');
  if (sha256Hex(text) !== resultado.hash_salida) throw new ExperimentError(`${path} no coincide con el hash_salida del cierre`);
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null && 'salida' in value ? value.salida : null;
}

/** N de la familia contando la línea registrada (el que guarda la línea, n_familia). */
export function familyEvidence(line: RegisteredLine): FamilyEvidence {
  return Object.freeze({ n: line.n_familia });
}

/**
 * N de todo el registro en el momento de decidir (A.3.2, ADR 0039): todas las pruebas de todas las familias, también las
 * previas, fallidas, abortadas e invalidadas, con sus variantes. Sin orden: cuenta todas las líneas de pre-registro.
 */
export function registryTrials(registry: Registry): number {
  return registry.lines.reduce((n, l) => (l.estado === 'registrado' ? n + l.n_pruebas : n), 0);
}

function failure(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Registra y ejecuta un experimento. Toda ejecución queda en el registro: si algo falla después del pre-registro, se
 * cierra como «fallido» y el error se relanza. Antes del pre-registro (árbol sucio, sin ejecutor, datos inexistentes o
 * campos inválidos) no se ha mirado nada, y se aborta sin escribir.
 */
export async function runExperiment(
  ctx: ResearchContext,
  spec: ExperimentSpec,
): Promise<{ registered: RegisteredLine; closed: ClosedLine; salida: unknown; artefactos: Artefacts | null }> {
  const commit = cleanCommit(ctx.git);
  const runner = runnerFor(ctx, spec.estrategia);
  const n = gridSize(spec.parametros);
  if (n === null) throw new ExperimentError('parámetros sin valores ni rejilla');
  const registered = register(ctx.registryPath, {
    ...spec,
    fecha: toUtcIso(ctx.now()),
    previa: false,
    n_pruebas: n + spec.variantes,
    commit,
    datos: { ...spec.datos, hash: ctx.datasets.hash(spec.datos) },
  });
  let done: { resultado: Resultado; salida: unknown; artefactos: Artefacts | null };
  try {
    done = await execute(ctx, registered, runner);
  } catch (e) {
    close(ctx.registryPath, { id: registered.id, fecha: toUtcIso(ctx.now()), autor: spec.autor, estado: 'fallido', resultado: null, notas: failure(e) });
    throw e;
  }
  const closed = close(ctx.registryPath, {
    id: registered.id, fecha: toUtcIso(ctx.now()), autor: spec.autor, estado: 'completado', resultado: done.resultado, notas: null,
  });
  return { registered, closed, salida: done.salida, artefactos: done.artefactos };
}

/** Descarta un experimento abierto (quedó «registrado», por ejemplo porque el proceso murió): sigue contando en N. */
export function discardExperiment(ctx: ResearchContext, id: string, autor: string, motivo: string): ClosedLine {
  return close(ctx.registryPath, { id, fecha: toUtcIso(ctx.now()), autor, estado: 'abortado', resultado: null, notas: motivo });
}

/** Invalida un experimento (por ejemplo, por un error en el código que lo ejecutó): sigue contando en N. */
export function invalidateExperiment(ctx: ResearchContext, id: string, autor: string, motivo: string): ClosedLine {
  return close(ctx.registryPath, { id, fecha: toUtcIso(ctx.now()), autor, estado: 'invalidado', resultado: null, notas: motivo });
}

/**
 * Vuelve a ejecutar un experimento completado a partir de su id y comprueba que da exactamente las mismas métricas y
 * el mismo hash de salida. Exige el mismo código: árbol limpio y, entre el commit registrado y HEAD, solo cambios de
 * documentación. Si el código cambió, se reproduce en un worktree de ese commit pasando la ruta de este registro.
 * No escribe en el registro: no es una prueba nueva, sino la comprobación de una que ya cuenta.
 */
export async function reproduceExperiment(ctx: ResearchContext, id: string): Promise<Resultado> {
  const experiment = readRegistry(ctx.registryPath).experiments.get(id);
  if (experiment === undefined) throw new ReproductionError(`${id} no está en el registro`);
  const { registered } = experiment;
  const done = experiment.closings.find((c) => c.estado === 'completado')?.resultado;
  if (registered.previa || registered.commit === null || done === undefined || done === null) {
    throw new ReproductionError(`${id}: solo se reproduce un experimento completado con este protocolo`);
  }
  cleanCommit(ctx.git);
  const changed = ctx.git.changedSince(registered.commit).filter((path) => !isDocumentation(path));
  if (changed.length > 0) {
    throw new ReproductionError(
      `${id}: el código cambió desde ${registered.commit} (${changed.slice(0, 10).join(', ')}); reprodúcelo en un worktree de ese commit`,
    );
  }
  const runner = runnerFor(ctx, registered.estrategia);
  const hash = ctx.datasets.hash(refOf(registered.datos));
  if (hash !== registered.datos.hash) throw new ReproductionError(`${id}: el dataset cambió (${String(registered.datos.hash)} ≠ ${hash})`);
  const { resultado: again } = await execute(ctx, registered, runner);
  if (again.hash_salida !== done.hash_salida || canonicalJson(again.metricas) !== canonicalJson(done.metricas) || again.veredicto !== done.veredicto) {
    throw new ReproductionError(`${id}: la salida no coincide (${done.hash_salida} ≠ ${again.hash_salida})`);
  }
  return again;
}
