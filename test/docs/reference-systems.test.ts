// docs/REFERENCE_SYSTEMS.md fija cómo se consultan los sistemas de referencia (paso 10, ADR 0008). Estas
// pruebas comprueban el texto y el árbol del repositorio: que cada ficha tenga sus seis apartados, que ninguna
// permita copiar código y que ningún sistema de referencia esté dentro del repositorio. No pueden comprobar
// que no se haya copiado código: eso depende de la revisión.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'REFERENCE_SYSTEMS.md');
const ADR = join(ROOT, 'docs', 'adr', '0008-sistemas-de-referencia.md');

const SYSTEMS = ['CCXT', 'Hummingbot', 'Hummingbot Quants Lab', 'Freqtrade', 'NautilusTrader'] as const;
const FICHA = [
  'Qué resuelve bien',
  'Patrón arquitectónico interesante',
  'Qué adoptar conceptualmente',
  'Qué NO copiar',
  'Licencia y dependencias',
  'Diferencias con nuestra arquitectura',
] as const;
// Nombres que no pueden aparecer como carpeta ni como dependencia (CCXT es dependencia por el ADR 0007).
const NOT_IN_REPO = /freqtrade|hummingbot|quants-lab|nautilus/i;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function section(text: string, heading: RegExp): string {
  const match = heading.exec(text);
  assert.ok(match, `falta el apartado ${heading.source} en docs/REFERENCE_SYSTEMS.md`);
  const start = match.index;
  const next = text.indexOf('\n## ', start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

function summaryRows(text: string): string[][] {
  const table = section(text, /\n## 2\. Resumen/);
  return table
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Sistema') && !line.startsWith('|---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

test('la metodología tiene sus reglas y la ficha fija', () => {
  const method = section(read(DOC), /\n## 1\. Metodología/);
  for (const rule of ['Nunca dentro del repositorio', 'No se copia código', 'Copyleft (GPL, AGPL, LGPL)', 'Lista cerrada']) {
    assert.ok(method.includes(`**${rule}`), `§1 debe tener la regla «${rule}»`);
  }
  for (const item of FICHA) {
    assert.ok(method.includes(`**${item}**`), `§1.2 debe listar el apartado «${item}»`);
  }
});

test('cada sistema tiene su ficha con los seis apartados en orden y la versión consultada', () => {
  const text = read(DOC);
  for (const system of SYSTEMS) {
    const body = section(text, new RegExp(`\\n## \\d+\\. ${system}\\n`));
    assert.match(body, /Versión consultada:/, `${system}: falta la versión consultada`);
    let last = -1;
    for (const item of FICHA) {
      const at = body.indexOf(`**${item}**`);
      assert.ok(at > last, `${system}: falta «${item}» o está fuera de orden`);
      last = at;
    }
  }
});

test('el resumen cubre los cinco sistemas, con licencia, y ninguno permite copiar código', () => {
  const rows = summaryRows(read(DOC));
  assert.deepEqual(rows.map((row) => row[0]), [...SYSTEMS]);
  const licences = new Map(rows.map((row) => [row[0], row[1]]));
  assert.equal(licences.get('Freqtrade'), 'GPL-3.0');
  assert.equal(licences.get('CCXT'), 'MIT');
  assert.equal(licences.get('NautilusTrader'), 'LGPL-3.0');
  for (const row of rows) {
    assert.equal(row.at(-1), 'No', `${row[0]}: la columna «¿Se copia código?» debe decir No`);
  }
});

test('NautilusTrader se usa solo como consulta, con su licencia verificada, y no queda como propuesto', () => {
  const text = read(DOC);
  const nautilus = section(text, /\n## \d+\. NautilusTrader\n/);
  assert.match(nautilus, /\*\*Se usa\s+solo como consulta, sin copiar código\*\*/);
  assert.match(nautilus, /\*\*LGPL-3\.0\*\*, verificada/);
  const proposed = section(text, /\n## \d+\. Propuestos, no incorporados/);
  assert.match(proposed, /Ninguno pendiente/);
  assert.doesNotMatch(proposed, /### NautilusTrader/);
});

test('ningún sistema de referencia está dentro del repositorio', () => {
  assert.ok(!existsSync(join(ROOT, '.gitmodules')), 'no debe haber submódulos de git');
  for (const entry of readdirSync(ROOT)) {
    assert.doesNotMatch(entry, NOT_IN_REPO, `carpeta o archivo de un sistema de referencia: ${entry}`);
  }
  const pkg: unknown = JSON.parse(read(join(ROOT, 'package.json')));
  assert.ok(typeof pkg === 'object' && pkg !== null, 'package.json no es un objeto');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps: unknown = Reflect.get(pkg, field);
    if (typeof deps !== 'object' || deps === null) continue;
    for (const name of Object.keys(deps)) {
      assert.doesNotMatch(name, NOT_IN_REPO, `dependencia de un sistema de referencia: ${name}`);
    }
  }
});

test('docs/REFERENCE_SYSTEMS.md y el ADR 0008 se enlazan y sus enlaces relativos existen', () => {
  const docText = read(DOC);
  const adrText = read(ADR);
  assert.ok(docText.includes('adr/0008-sistemas-de-referencia.md'), 'el documento debe enlazar el ADR 0008');
  assert.ok(adrText.includes('../REFERENCE_SYSTEMS.md'), 'el ADR 0008 debe enlazar el documento');
  for (const [file, text] of [[DOC, docText], [ADR, adrText]] as const) {
    for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] ?? '';
      if (/^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: enlace roto a ${target}`);
    }
  }
});
