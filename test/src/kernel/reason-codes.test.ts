// El catálogo de reason_code del código es el de trading-risk §9.2: mismos códigos, mismo orden y misma capa. Es una
// prueba de texto sobre el skill: comprueba lo que está escrito, no lo que hace el bot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catalogLayer, isReasonCode, REASON_CODES } from '../../../src/kernel/reason-codes.ts';

const SKILL = join(resolve(import.meta.dirname, '..', '..', '..'), '.claude', 'skills', 'trading-risk', 'SKILL.md');

function skillCatalog(): [string, string][] {
  const text = readFileSync(SKILL, 'utf8');
  const start = text.indexOf('### 9.2');
  const end = text.indexOf('### 9.3');
  assert.ok(start >= 0 && end > start, 'no se encuentra trading-risk §9.2');
  return [...text.slice(start, end).matchAll(/^\| `([A-Z_]+)` \| ([a-z]+) \|/gm)].map((m) => [m[1] ?? '', m[2] ?? '']);
}

test('el catálogo del código es el de trading-risk §9.2, en el mismo orden y con la misma capa', () => {
  const catalog = skillCatalog();
  assert.ok(catalog.length > 40, 'el catálogo del skill parece incompleto');
  assert.deepEqual([...REASON_CODES], catalog.map(([code]) => code));
  for (const [code, layer] of catalog) {
    assert.ok(isReasonCode(code));
    assert.equal(catalogLayer(code), layer, `${code}: otra capa`);
  }
});

test('un código fuera del catálogo no lo es', () => {
  for (const bad of ['', 'kill_switch_active', 'APPROVED', 'toString', '__proto__']) assert.equal(isReasonCode(bad), false, bad);
  assert.ok(Object.isFrozen(REASON_CODES));
});
