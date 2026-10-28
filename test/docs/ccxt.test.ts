// docs/CCXT.md fija qué se usa de ccxt y qué hace el sistema por su cuenta (paso 9, ADR 0007). Estas pruebas
// comprueban el texto, no el código: que no desaparezca ningún apartado pedido, que la versión documentada sea
// la instalada y que la lista de métodos permitidos no incluya ninguno prohibido.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'CCXT.md');
const ADR = join(ROOT, 'docs', 'adr', '0007-ccxt-y-exchange-adapter.md');
const LOCK = join(ROOT, 'package-lock.json');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `falta el apartado «${heading}» en docs/CCXT.md`);
  const next = text.indexOf('\n## ', start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

function lockedCcxtVersion(): string {
  const parsed: unknown = JSON.parse(read(LOCK));
  assert.ok(typeof parsed === 'object' && parsed !== null, 'package-lock.json no es un objeto');
  const packages: unknown = Reflect.get(parsed, 'packages');
  assert.ok(typeof packages === 'object' && packages !== null, 'package-lock.json sin «packages»');
  const entry: unknown = Reflect.get(packages, 'node_modules/ccxt');
  assert.ok(typeof entry === 'object' && entry !== null, 'ccxt no está en package-lock.json');
  const version: unknown = Reflect.get(entry, 'version');
  assert.ok(typeof version === 'string', 'ccxt sin versión en package-lock.json');
  return version;
}

test('docs/CCXT.md cubre la arquitectura y lo que se aprovecha de ccxt', () => {
  const text = read(DOC);
  assert.match(section(text, '1. Arquitectura'), /ExchangeAdapter \(nuestro/);
  const reuse = section(text, '2. Qué aprovechamos de CCXT');
  for (const term of ['Normalización de mercados', 'Precisión', 'Límites', 'Históricos', 'WebSocket (CCXT Pro)']) {
    assert.ok(reuse.includes(term), `§2 debe tratar «${term}»`);
  }
});

test('docs/CCXT.md cubre lo que implementamos nosotros', () => {
  const own = section(read(DOC), '3. Qué implementamos nosotros');
  for (const term of ['Idempotencia', 'Máquina de estados', 'Reconciliación', 'Rate limiting propio', 'Detección de gaps']) {
    assert.ok(own.includes(`**${term}**`), `§3 debe tener una fila «${term}»`);
  }
});

test('la versión documentada es la del lockfile y hay política de actualización', () => {
  const policy = section(read(DOC), '4. Versión y política de actualización');
  const installed = lockedCcxtVersion();
  assert.ok(policy.includes(`instala **${installed}**`), `§4 debe decir que el lockfile instala ${installed}`);
  assert.match(policy, /\*\*Versión a fijar/);
  assert.match(policy, /\*\*Política de actualización/);
});

test('docs/CCXT.md recoge los riesgos pedidos', () => {
  const risks = section(read(DOC), '5. Riesgos conocidos');
  assert.ok(risks.includes('**Cambios de API del exchange.**'));
  assert.ok(risks.includes('**Comportamiento distinto por exchange.**'));
});

test('la lista de métodos permitidos no incluye ninguno prohibido', () => {
  const text = read(DOC);
  const start = text.indexOf('| Uso | Métodos permitidos |');
  assert.ok(start >= 0, 'falta la tabla de métodos permitidos (§1.1)');
  const table = text.slice(start, text.indexOf('\n\n', start));
  const methods = [...table.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1] ?? '');
  assert.ok(methods.includes('createOrder'), 'la tabla debe listar createOrder');
  const forbidden = /withdraw|transfer|Ws$|^editOrder$|^cancelAllOrders$|^set[A-Z]|Position|borrow/i;
  for (const method of methods) {
    assert.doesNotMatch(method, forbidden, `método prohibido en la lista de permitidos: ${method}`);
  }
});

test('docs/CCXT.md y el ADR 0007 se enlazan y sus enlaces relativos existen', () => {
  const docText = read(DOC);
  const adrText = read(ADR);
  assert.ok(docText.includes('adr/0007-ccxt-y-exchange-adapter.md'), 'docs/CCXT.md debe enlazar el ADR 0007');
  assert.ok(adrText.includes('../CCXT.md'), 'el ADR 0007 debe enlazar docs/CCXT.md');
  for (const [file, text] of [[DOC, docText], [ADR, adrText]] as const) {
    for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] ?? '';
      if (/^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: enlace roto a ${target}`);
    }
  }
});
