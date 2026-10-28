// Copia pública (paso 49, ADR 0048; SEC-01, SEC-05 y SEC-07 de la revisión del CONSULTOR SECURITY): ningún archivo que se
// publica lleva datos del ordenador ni correos personales, las salidas publicadas van reducidas y la demo no puede llegar a
// un exchange real. En el repositorio privado miran lo que exporta scripts/export-public.ts (sin el registro de trabajo, y
// las salidas tal como quedarán al reducirlas); en la copia pública, todo. Comprueban texto, no comportamiento: un dato
// personal escrito de otra forma no lo ven.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isExported, reduceOutput } from '../../scripts/export-public.ts';
import { repoFiles, ROOT } from '../invariants/repo.ts';

const BINARY = /\.(png|gif|jpe?g|ico|zip|parquet)$/i;
const SELF = 'test/docs/public-copy.test.ts';
// Solo el repositorio privado tiene export/: allí las salidas se publican reducidas por la exportación.
const PRIVATE = existsSync(join(ROOT, 'export', 'overlay.json'));

function textFiles(): string[] {
  return repoFiles().filter((f) => !BINARY.test(f) && f !== SELF && isExported(f));
}

// Los patrones se montan por partes para que este archivo no se detecte a sí mismo si se quita de la exclusión.
const MACHINE = [
  new RegExp(['[A-Za-z]:', 'Users', ''].join('\\\\')), // C:\Users\
  new RegExp(['', 'c', 'Users', ''].join('/')), // /c/Users/
  new RegExp(`\\b(${['LAPTOP', 'DESKTOP'].join('|')})-[A-Z0-9]`),
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// noreply de GitHub, localhost y los dominios reservados para ejemplos y pruebas (RFC 2606).
const ALLOWED_EMAIL = /(@users\.noreply\.github\.com|@example\.(com|org|net)|@localhost|\.(example|invalid|test|localhost))$/;

test('ningún archivo versionado lleva rutas del ordenador ni nombres de equipo', () => {
  const hits: string[] = [];
  for (const file of textFiles()) {
    readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
      if (MACHINE.some((p) => p.test(line))) hits.push(`${file}:${String(i + 1)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('los únicos correos son de ejemplo, locales o noreply de GitHub', () => {
  const hits: string[] = [];
  for (const file of textFiles()) {
    for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(EMAIL)) {
      if (!ALLOWED_EMAIL.test(match[0])) hits.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('las salidas publicadas no llevan curvas, operaciones ni series de la rejilla (SEC-02)', () => {
  const outputs = repoFiles().filter((f) => /^docs\/research\/experiments\/salidas\/EXP-\d{4}\.json$/.test(f));
  assert.ok(outputs.length > 0);
  for (const file of outputs) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const published = PRIVATE ? reduceOutput(text) : text;
    if (!PRIVATE) assert.equal(reduceOutput(text), text, `${file} no está reducida`);
    const salida = (JSON.parse(published) as { salida?: Record<string, unknown> }).salida ?? {};
    assert.ok(!('series_rejilla' in salida), file);
    const tramos = Array.isArray(salida['tramos']) ? (salida['tramos'] as Record<string, unknown>[]) : [];
    assert.ok(tramos.every((t) => !('curva' in t) && !('operaciones' in t)), file);
  }
});

test('la demo no importa ccxt ni el código previo que habla con el exchange', () => {
  const forbidden = /from '[^']*(ccxt|src\/(broker|market|main|telegram|intel)\.ts)'/;
  const hits = repoFiles().filter((f) => f.startsWith('demo/') && f.endsWith('.ts')).filter((f) => forbidden.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, []);
  assert.ok(repoFiles().includes('demo/autopilot/bot.ts'), 'la lista de archivos de la demo está vacía: la prueba no comprobaría nada');
});
