// Lectura del diario de un replay (formato inversor-replay/1, backtest/replay.ts) para el dashboard (paso 41B, ADR 0045).
// El dashboard solo recibe texto: no tiene ningún objeto del sistema con el que enviar una orden o cambiar algo. En la
// versión local es su «base de datos»; en paper, shadow y live lo será SQLite con un usuario de solo lectura (paso 33).
// Fail closed: una línea que no se entiende hace fallar la lectura entera, porque un estado incompleto parecería sano.
import type { UtcMillis } from '../shared/time.ts';

export const REPLAY_FORMAT = 'inversor-replay/1';

export class DashboardError extends Error {
  override readonly name = 'DashboardError';
}

export type JsonObject = Readonly<Record<string, unknown>>;

export interface JournalEvent {
  readonly seq: number;
  readonly type: string;
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
  readonly payload: JsonObject;
}

export interface ReplayJournal {
  readonly runId: string;
  readonly seed: number;
  readonly events: readonly JournalEvent[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Campos de un objeto del diario, con su tipo comprobado. `where` dice qué se leía, para el mensaje de error. */
export function field(object: JsonObject, key: string, where: string): unknown {
  if (!Object.hasOwn(object, key)) throw new DashboardError(`${where}: falta «${key}»`);
  return object[key];
}

export function text(object: JsonObject, key: string, where: string): string {
  const value = field(object, key, where);
  if (typeof value !== 'string') throw new DashboardError(`${where}: «${key}» no es texto`);
  return value;
}

export function textOrNull(object: JsonObject, key: string, where: string): string | null {
  const value = field(object, key, where);
  if (value !== null && typeof value !== 'string') throw new DashboardError(`${where}: «${key}» no es texto ni null`);
  return value;
}

export function integer(object: JsonObject, key: string, where: string): number {
  const value = field(object, key, where);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new DashboardError(`${where}: «${key}» no es un entero`);
  return value;
}

export function flag(object: JsonObject, key: string, where: string): boolean {
  const value = field(object, key, where);
  if (typeof value !== 'boolean') throw new DashboardError(`${where}: «${key}» no es booleano`);
  return value;
}

export function object(value: unknown, where: string): JsonObject {
  if (!isObject(value)) throw new DashboardError(`${where}: no es un objeto`);
  return value;
}

function parseLine(line: string, number: number): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new DashboardError(`línea ${String(number)} del diario: no es JSON`, { cause: error });
  }
  return object(value, `línea ${String(number)} del diario`);
}

/** Lee el diario completo: cabecera, un evento por línea en orden y cierre con el número de eventos. */
export function parseJournal(jsonl: string): ReplayJournal {
  const lines = jsonl.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) throw new DashboardError('el diario no tiene cabecera y cierre');
  const header = parseLine(lines[0] ?? '', 1);
  if (header['format'] !== REPLAY_FORMAT) throw new DashboardError(`el diario no es ${REPLAY_FORMAT}`);
  const runId = text(header, 'runId', 'cabecera');
  const seed = integer(header, 'seed', 'cabecera');
  const footer = parseLine(lines.at(-1) ?? '', lines.length);
  const events = lines.slice(1, -1).map((line, i): JournalEvent => {
    const where = `evento ${String(i)}`;
    const event = parseLine(line, i + 2);
    if (integer(event, 'seq', where) !== i) throw new DashboardError(`${where}: seq fuera de orden`);
    if (text(event, 'runId', where) !== runId) throw new DashboardError(`${where}: de otro run`);
    return Object.freeze({
      seq: i,
      type: text(event, 'type', where),
      eventTime: integer(event, 'eventTime', where),
      receivedTime: integer(event, 'receivedTime', where),
      payload: object(field(event, 'payload', where), `${where}: payload`),
    });
  });
  if (integer(footer, 'events', 'cierre') !== events.length) throw new DashboardError('el cierre no cuenta los eventos del diario: está incompleto');
  return Object.freeze({ runId, seed, events: Object.freeze(events) });
}
