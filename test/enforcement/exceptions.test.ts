// Las listas de excepciones solo pueden encoger. Cubrían el código previo al paso 4. El paso 13
// (saneamiento) vació la de lint; en la de límites quedan los imports de ccxt de módulos que se reescriben
// (broker.ts y market.ts en los pasos 32 y 36; main.ts en el paso que lo sustituya).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');

// Únicos archivos que aún pueden tener excepciones de límites. Nadie más puede tenerlas.
const LEGACY = new Set(['src/broker.ts', 'src/main.ts', 'src/market.ts']);

// Totales que quedaron al cerrar el paso 13. Solo se modifican a la baja.
const MAX_LINT_SUPPRESSIONS = 0;
const MAX_BOUNDARY_EXCEPTIONS = 3;

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
}

test('eslint-suppressions.json: vacía', () => {
  const suppressions = readJson('eslint-suppressions.json') as Record<string, Record<string, { count: number }>>;
  let total = 0;
  for (const rules of Object.values(suppressions)) {
    for (const { count } of Object.values(rules)) total += count;
  }
  assert.ok(total <= MAX_LINT_SUPPRESSIONS, `${total} excepciones de lint; el máximo registrado es ${MAX_LINT_SUPPRESSIONS}`);
});

test('.dependency-cruiser-known-violations.json: solo los imports de ccxt pendientes y sin crecer', () => {
  const known = readJson('.dependency-cruiser-known-violations.json') as { from: string }[];
  for (const { from } of known) {
    assert.ok(LEGACY.has(from), `${from} no es broker.ts, market.ts ni main.ts: no puede tener excepciones de límites`);
  }
  assert.ok(
    known.length <= MAX_BOUNDARY_EXCEPTIONS,
    `${known.length} excepciones de límites; el máximo registrado es ${MAX_BOUNDARY_EXCEPTIONS}`,
  );
});
