// Registro de experimentos (quant-research §10, ADR 0024): JSONL solo de inserción y versionado en git. Cada línea es
// un evento en JSON canónico y lleva el SHA-256 de la anterior, así que editar o borrar una línea rompe la cadena y
// la lectura lo rechaza. Cada experimento tiene una línea de pre-registro («registrado») y al menos una de cierre
// («completado», «fallido», «abortado» o «invalidado»). Las reglas se comprueban al leer, no solo al escribir: un
// archivo editado a mano no pasa. El número de pruebas de cada familia, que es la N del Deflated Sharpe, se deriva de
// este archivo y de nada más.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { checkSeed } from '../kernel/random.ts';
import { canonicalJson, sha256Hex } from '../shared/canonical.ts';
import { Decimal } from '../shared/decimal.ts';
import { isTimeframe, parseUtcIso, timeframeMs } from '../shared/time.ts';

export const REGISTRY_FILE = 'docs/research/experiments/registry.jsonl'; // relativo a la raíz del repositorio
export const EXPERIMENTS_DIR = 'docs/research/experiments/';
export const GENESIS = '0'.repeat(64); // «anterior» de la primera línea
const FORMAT = 1;

// Costes mínimos por lado de quant-research §5, en fracción: un experimento nuevo por debajo no se registra.
export const MIN_COMMISSION = '0.001';
export const MIN_SLIPPAGE = '0.0005';

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^EXP-(\d{4,})$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const FRACTION = /^\d+(\.\d+)?$/; // decimal en notación normal, no negativo

const IsoUtc = z.string().refine((s) => {
  try {
    parseUtcIso(s);
    return true;
  } catch {
    return false;
  }
}, 'fecha ISO 8601 en UTC con «Z»');
const Text = z.string().min(1);
const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.string(), z.number().refine(Number.isFinite), z.array(Json), z.record(z.string(), Json)]),
);
const Range = z.object({ desde: IsoUtc, hasta: IsoUtc }).strict(); // [desde, hasta)

const Strategy = z.object({ nombre: z.string().regex(SLUG), version: z.string().regex(VERSION) }).strict();
const Data = z
  .object({
    fuente: Text,
    dataset: Text.nullable(), // identificador y versión del almacén histórico; null solo en pruebas previas
    version: Text.nullable(),
    timeframe: z.string().refine(isTimeframe, 'timeframe desconocido'),
    rango: Range,
    hash: z.string().regex(SHA256).nullable(),
  })
  .strict();
const Universe = z
  .object({
    regla: Text,
    simbolos: z.array(Text), // vacío solo en una prueba previa que no los detalla
    // Universo alternativo (A.3.14; paso 27B, ADR 0031): activos que no se usaron para diseñar la estrategia, fijados antes
    // de mirar datos. Falta en las líneas anteriores al paso 27B.
    alternativos: z.array(Text).optional(),
  })
  .strict();
const Costs = z
  .object({
    comision: z.string().regex(FRACTION), // por lado, en fracción: 0.001 es el 0,10 %
    spread: z.string().regex(FRACTION), // medio spread por lado
    slippage: z.string().regex(FRACTION),
    multiplicador: z.number().int().min(1), // estrés de costes: 1, 2 o 3
  })
  .strict();
const Fold = z.object({ train: Range, validation: Range }).strict();
const Partitions = z
  .object({
    tramos: z.array(Fold).min(1), // walk-forward en orden
    test: z.null(), // el test final no se abre desde aquí (ADR 0019): solo las etapas 2 y 3, con autorización humana
    purging_velas: z.number().int().nonnegative(),
    embargo_velas: z.number().int().nonnegative(),
  })
  .strict();
const Parameters = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('valores'), valores: z.record(z.string(), Json) }).strict(),
  z.object({ tipo: z.literal('rejilla'), rejilla: z.record(z.string(), z.array(Json).min(1)) }).strict(),
  z.object({ tipo: z.literal('descripcion'), texto: Text }).strict(), // solo pruebas previas
]);
export const VERDICTS = ['RECHAZADA', 'NO CONCLUYENTE', 'CANDIDATA A TEST FINAL', 'CANDIDATA A PAPER'] as const;
const Metrics = z.record(z.string(), z.union([z.null(), z.string(), z.number().refine(Number.isFinite)]));
const Result = z
  .object({
    metricas: Metrics,
    hash_salida: z.string().regex(SHA256), // SHA-256 del JSON canónico de { metricas, salida }
    veredicto: z.enum(VERDICTS).nullable(), // null: el protocolo de §9 aún no lo calcula
  })
  .strict();

const Common = {
  formato: z.literal(FORMAT),
  anterior: z.string().regex(SHA256),
  id: z.string().regex(ID),
  fecha: IsoUtc,
  autor: Text,
  familia: z.string().regex(SLUG),
  notas: Text.nullable(),
};

const Registered = z
  .object({
    ...Common,
    estado: z.literal('registrado'),
    previa: z.boolean(), // prueba anterior al registro, dada de alta solo para que cuente en N
    familia_nueva: z.boolean(),
    n_pruebas: z.number().int().positive(),
    // Ejecuciones de robustez sobre datos reales (paso 27B, ADR 0031): estrés, sensibilidad y estabilidad. Cuentan en N
    // como cualquier prueba (docs/PROMOTION_CRITERIA.md, regla 4). Falta en las líneas anteriores al paso 27B.
    variantes: z.number().int().nonnegative().optional(),
    // Experimento que solo elige en train (paso 31, ADR 0044): un barrido sin validaciones medidas, sin variantes y sin
    // veredicto. Falta en todos los demás.
    solo_eleccion: z.literal(true).optional(),
    n_familia: z.number().int().positive(),
    hipotesis: Text,
    metrica_primaria: Text,
    criterios: Text,
    estrategia: Strategy,
    commit: z.string().regex(COMMIT).nullable(),
    datos: Data,
    universo: Universe,
    particiones: Partitions.nullable(),
    costes: Costs.nullable(),
    parametros: Parameters,
    semilla: z.number().int().nullable(),
    informe: Text.nullable(),
  })
  .strict();

export const CLOSING_STATES = ['completado', 'fallido', 'abortado', 'invalidado'] as const;
const Closed = z
  .object({
    ...Common,
    estado: z.enum(CLOSING_STATES),
    referencia: z.string().regex(SHA256), // SHA-256 de la última línea de este experimento, la que cierra o corrige
    resultado: Result.nullable(),
  })
  .strict();

const Line = z.discriminatedUnion('estado', [Registered, Closed]);

export type RegisteredLine = z.infer<typeof Registered>;
export type ClosedLine = z.infer<typeof Closed>;
export type RegistryLine = z.infer<typeof Line>;
export type ClosingState = (typeof CLOSING_STATES)[number];
export type Metricas = z.infer<typeof Metrics>;
export type Resultado = z.infer<typeof Result>;

/** Lo que el autor de una línea aporta; el registro pone formato, anterior y, al registrar, el id y las cuentas. */
export type NewRegistration = Omit<RegisteredLine, 'formato' | 'anterior' | 'id' | 'estado' | 'n_familia'>;
export type NewClosing = Omit<ClosedLine, 'formato' | 'anterior' | 'referencia' | 'familia'>;

// Cuerpo de una línea sin lo que pone append: Omit repartido sobre la unión, para no perder los campos de cada tipo.
type LineBody = RegistryLine extends infer L ? (L extends RegistryLine ? Omit<L, 'formato' | 'anterior'> : never) : never;

export interface Experiment {
  readonly registered: RegisteredLine;
  readonly closings: readonly ClosedLine[];
  readonly lastHash: string; // SHA-256 de su última línea
}

export interface Registry {
  readonly lines: readonly RegistryLine[];
  readonly experiments: ReadonlyMap<string, Experiment>;
  readonly lastHash: string; // GENESIS si está vacío
}

function fail(lineNo: number, message: string): never {
  throw new RegistryError(`registro, línea ${String(lineNo)}: ${message}`);
}

function ms(text: string): number {
  return parseUtcIso(text);
}

/** Número de configuraciones que evalúa el experimento: 1 con valores, el producto de la rejilla con un barrido. */
export function gridSize(parametros: RegisteredLine['parametros']): number | null {
  if (parametros.tipo === 'valores') return 1;
  if (parametros.tipo === 'rejilla') return Object.values(parametros.rejilla).reduce((n, values) => n * values.length, 1);
  return null;
}

/**
 * Configuraciones que evalúa el experimento, en un orden fijo: con valores, la única; con una rejilla, su producto
 * cartesiano, con las claves ordenadas y los valores en el orden registrado (la última clave varía más deprisa).
 */
export function gridPoints(parametros: RegisteredLine['parametros']): Readonly<Record<string, unknown>>[] {
  if (parametros.tipo === 'valores') return [Object.freeze({ ...parametros.valores })];
  if (parametros.tipo !== 'rejilla') throw new RegistryError('parámetros sin valores ni rejilla');
  let points: Record<string, unknown>[] = [{}];
  for (const key of Object.keys(parametros.rejilla).sort()) {
    const values = parametros.rejilla[key] ?? [];
    points = points.flatMap((p) => values.map((v) => ({ ...p, [key]: v })));
  }
  return points.map((p) => Object.freeze(p));
}

function checkRegistration(line: RegisteredLine, lineNo: number): void {
  const { datos, particiones, costes } = line;
  if (ms(datos.rango.desde) >= ms(datos.rango.hasta)) fail(lineNo, 'datos.rango vacío o invertido');
  if (line.previa) {
    if (line.variantes !== undefined) fail(lineNo, 'una prueba previa no declara variantes');
    if (line.solo_eleccion !== undefined) fail(lineNo, 'una prueba previa no es un experimento que solo elige');
    if (line.parametros.tipo !== 'descripcion' && gridSize(line.parametros) !== line.n_pruebas) {
      fail(lineNo, 'n_pruebas no coincide con los parámetros');
    }
    return;
  }
  // Un experimento nuevo lleva todo lo que hace falta para reproducirlo exactamente.
  if (line.commit === null) fail(lineNo, 'sin commit');
  if (datos.dataset === null || datos.version === null || datos.hash === null) fail(lineNo, 'sin dataset, versión o hash de los datos');
  if (line.semilla === null) fail(lineNo, 'sin semilla');
  try {
    checkSeed(line.semilla);
  } catch (e) {
    fail(lineNo, (e as Error).message);
  }
  if (particiones === null) fail(lineNo, 'sin particiones');
  if (costes === null) fail(lineNo, 'sin costes: un backtest sin costes no es válido');
  if (Decimal.parse(costes.comision).lt(Decimal.parse(MIN_COMMISSION))) fail(lineNo, `comisión por debajo del mínimo (${MIN_COMMISSION})`);
  if (Decimal.parse(costes.slippage).lt(Decimal.parse(MIN_SLIPPAGE))) fail(lineNo, `slippage por debajo del mínimo (${MIN_SLIPPAGE})`);
  if (line.parametros.tipo === 'descripcion') fail(lineNo, 'parámetros sin valores ni rejilla');
  if ((gridSize(line.parametros) ?? 0) + (line.variantes ?? 0) !== line.n_pruebas) {
    fail(lineNo, 'n_pruebas no coincide con los parámetros y las variantes');
  }
  // Solo elegir en train (ADR 0044) exige un barrido y no mide nada más: ni variantes ni validaciones.
  if (line.solo_eleccion === true && ((gridSize(line.parametros) ?? 0) < 2 || line.variantes !== 0)) {
    fail(lineNo, 'solo se elige en train con una rejilla de al menos 2 puntos y sin variantes');
  }
  if (line.universo.simbolos.length === 0) fail(lineNo, 'universo sin símbolos');
  if (new Set(line.universo.simbolos).size !== line.universo.simbolos.length) fail(lineNo, 'símbolos repetidos en el universo');
  const alternatives = line.universo.alternativos ?? [];
  if (new Set(alternatives).size !== alternatives.length) fail(lineNo, 'símbolos repetidos en el universo alternativo');
  if (alternatives.some((s) => line.universo.simbolos.includes(s))) fail(lineNo, 'el universo alternativo repite símbolos del universo de diseño');
  if (particiones.embargo_velas < particiones.purging_velas) fail(lineNo, 'embargo menor que el purging (quant-research §4)');
  if (!isTimeframe(datos.timeframe)) fail(lineNo, 'timeframe desconocido');
  const bar = timeframeMs(datos.timeframe);
  const last = particiones.tramos.length - 1;
  let previous = ms(datos.rango.desde);
  for (const [i, { train, validation }] of particiones.tramos.entries()) {
    const points = [ms(train.desde), ms(train.hasta), ms(validation.desde), ms(validation.hasta)] as const;
    if (!(points[0] < points[1] && points[1] <= points[2] && points[2] < points[3])) fail(lineNo, `tramo ${String(i)}: train y validation no van en orden`);
    // El último tramo de un experimento que solo elige (ADR 0044) puede validar fuera de los datos, porque no los lee: lo
    // que puntúa de su train, hasta h velas antes de su final, sí tiene que estar dentro.
    const end = line.solo_eleccion === true && i === last ? points[1] - particiones.purging_velas * bar : points[3];
    if (points[0] < ms(datos.rango.desde) || end > ms(datos.rango.hasta)) fail(lineNo, `tramo ${String(i)}: fuera de datos.rango`);
    if (points[2] < previous) fail(lineNo, `tramo ${String(i)}: validation solapa con la del tramo anterior`);
    previous = points[3];
  }
}

const ALLOWED_AFTER: Record<RegistryLine['estado'], readonly ClosingState[]> = {
  registrado: CLOSING_STATES,
  completado: ['invalidado'],
  fallido: ['invalidado'],
  abortado: ['invalidado'],
  invalidado: [],
};

function checkClosing(line: ClosedLine, experiment: Experiment, lineNo: number): void {
  const last = experiment.closings.at(-1) ?? experiment.registered;
  if (line.referencia !== experiment.lastHash) fail(lineNo, `${line.id}: «referencia» no es su última línea`);
  if (line.familia !== experiment.registered.familia) fail(lineNo, `${line.id}: familia distinta de la del registro`);
  if (!ALLOWED_AFTER[last.estado].includes(line.estado)) fail(lineNo, `${line.id}: no se pasa de «${last.estado}» a «${line.estado}»`);
  if (experiment.registered.previa && line.estado !== 'invalidado') fail(lineNo, `${line.id}: una prueba previa solo se cierra como invalidada`);
  if ((line.estado === 'completado') !== (line.resultado !== null)) fail(lineNo, `${line.id}: solo «completado» lleva resultado, y siempre`);
  if (line.estado !== 'completado' && line.notas === null) fail(lineNo, `${line.id}: «${line.estado}» necesita el motivo en notas`);
  if (experiment.registered.solo_eleccion === true && line.resultado !== null && line.resultado.veredicto !== null) {
    fail(lineNo, `${line.id}: un experimento que solo elige en train no da veredicto`);
  }
}

/** Pruebas por familia: la N del Deflated Sharpe (quant-research §8). Cuenta todo, también lo fallido, abortado o invalidado. */
export function trialsByFamily(registry: Registry): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { registered } of registry.experiments.values()) {
    counts.set(registered.familia, (counts.get(registered.familia) ?? 0) + registered.n_pruebas);
  }
  return counts;
}

export function trialsInFamily(registry: Registry, familia: string): number {
  return trialsByFamily(registry).get(familia) ?? 0;
}

export function experimentId(n: number): string {
  return `EXP-${String(n).padStart(4, '0')}`;
}

/** Lee y comprueba el registro entero. Cualquier línea que no cumpla las reglas lo invalida todo (fail closed). */
export function parseRegistry(text: string): Registry {
  const experiments = new Map<string, Experiment>();
  const lines: RegistryLine[] = [];
  const families = new Map<string, number>();
  let lastHash = GENESIS;
  if (text.length > 0 && !text.endsWith('\n')) fail(text.split('\n').length, 'el archivo no termina en salto de línea (¿escritura cortada?)');
  const raw = text.length === 0 ? [] : text.slice(0, -1).split('\n');
  for (const [i, rawLine] of raw.entries()) {
    const lineNo = i + 1;
    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      fail(lineNo, 'no es JSON');
    }
    const parsed = Line.safeParse(value);
    if (!parsed.success) fail(lineNo, z.prettifyError(parsed.error));
    const line = parsed.data;
    if (canonicalJson(value) !== rawLine) fail(lineNo, 'no está en JSON canónico');
    if (line.anterior !== lastHash) fail(lineNo, 'la cadena de hashes no cuadra: se editó, borró o reordenó una línea');
    const hash = sha256Hex(rawLine);
    if (line.estado === 'registrado') {
      if (line.id !== experimentId(experiments.size + 1)) fail(lineNo, `id ${line.id} fuera de orden (toca ${experimentId(experiments.size + 1)})`);
      const before = families.get(line.familia) ?? 0;
      if (line.familia_nueva !== (before === 0)) fail(lineNo, line.familia_nueva ? `la familia ${line.familia} ya existe` : `la familia ${line.familia} no existe`);
      if (line.n_familia !== before + line.n_pruebas) fail(lineNo, `n_familia debería ser ${String(before + line.n_pruebas)}`);
      checkRegistration(line, lineNo);
      families.set(line.familia, line.n_familia);
      experiments.set(line.id, { registered: line, closings: [], lastHash: hash });
    } else {
      const experiment = experiments.get(line.id) ?? fail(lineNo, `${line.id} cierra un experimento que no está registrado`);
      checkClosing(line, experiment, lineNo);
      experiments.set(line.id, { ...experiment, closings: [...experiment.closings, line], lastHash: hash });
    }
    if (ms(line.fecha) < ms(lines.at(-1)?.fecha ?? line.fecha)) fail(lineNo, 'fecha anterior a la de la línea previa');
    lines.push(line);
    lastHash = hash;
  }
  return { lines, experiments, lastHash };
}

export function readRegistry(path: string): Registry {
  return parseRegistry(existsSync(path) ? readFileSync(path, 'utf8') : '');
}

/**
 * Añade una línea al final, con un candado de archivo para que dos procesos no intercalen escrituras. Relee y
 * comprueba todo antes de escribir, y comprueba también el resultado: si la línea nueva no pasa, no se escribe.
 */
function append(path: string, build: (registry: Registry) => LineBody): RegistryLine {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let lockFd: number;
  try {
    lockFd = openSync(lock, 'wx');
  } catch (e) {
    throw new RegistryError(`registro bloqueado (${lock}): otro proceso escribe, o una ejecución anterior murió; si no hay otro, borra el candado a mano (${(e as Error).message})`);
  }
  try {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const registry = parseRegistry(current);
    const line = { formato: FORMAT, anterior: registry.lastHash, ...build(registry) };
    const text = `${canonicalJson(line)}\n`;
    const parsed = parseRegistry(current + text); // misma comprobación que al leer
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const added = parsed.lines.at(-1);
    if (added === undefined) throw new RegistryError('registro vacío tras escribir');
    return added;
  } finally {
    closeSync(lockFd);
    rmSync(lock);
  }
}

/** Pre-registro (quant-research §2): asigna el id correlativo y la cuenta de la familia. */
export function register(path: string, entry: NewRegistration): RegisteredLine {
  const line = append(path, (registry) => ({
    ...entry,
    id: experimentId(registry.experiments.size + 1),
    estado: 'registrado',
    n_familia: trialsInFamily(registry, entry.familia) + entry.n_pruebas,
  }));
  if (line.estado !== 'registrado') throw new RegistryError('se esperaba una línea de registro');
  return line;
}

/** Cierre o corrección de un experimento: siempre una línea nueva que referencia la última de ese experimento. */
export function close(path: string, entry: NewClosing): ClosedLine {
  const line = append(path, (registry) => {
    const experiment = registry.experiments.get(entry.id);
    if (experiment === undefined) throw new RegistryError(`${entry.id} no está registrado`);
    return { ...entry, familia: experiment.registered.familia, referencia: experiment.lastHash };
  });
  if (line.estado === 'registrado') throw new RegistryError('se esperaba una línea de cierre');
  return line;
}
