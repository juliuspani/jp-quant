// Serialización canónica del replay (ADR 0021) y del registro de experimentos (ADR 0024): el mismo valor da siempre
// el mismo texto, y por tanto el mismo hash. Claves ordenadas, Decimal como texto canónico y números finitos con el formato de ECMAScript, que está
// especificado. Lo que JSON perdería o cambiaría en silencio (undefined, NaN, Infinity, bigint, funciones, fechas,
// Map, Set u otras clases) se rechaza: un dato que no se puede comparar byte a byte no entra en el diario.
import { createHash } from 'node:crypto';
import { Decimal } from './decimal.ts';

export class NotCanonicalError extends Error {
  override readonly name = 'NotCanonicalError';
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotCanonicalError(`${path}: número no finito (${String(value)})`);
    return JSON.stringify(value);
  }
  if (value instanceof Decimal) return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item: unknown, i) => encode(item, `${path}[${String(i)}]`)).join(',')}]`;
  if (typeof value === 'object' && isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => {
      const item: unknown = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new NotCanonicalError(`${path}.${key}: undefined (omite la clave o usa null)`);
      return `${JSON.stringify(key)}:${encode(item, `${path}.${key}`)}`;
    });
    return `{${parts.join(',')}}`;
  }
  const kind = typeof value === 'object' ? Object.prototype.toString.call(value) : typeof value;
  throw new NotCanonicalError(`${path}: tipo no serializable de forma canónica (${kind})`);
}

/** Texto canónico de `value`, o NotCanonicalError. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Congela un valor canónico entero: así ningún handler cambia un evento que verán los siguientes. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
