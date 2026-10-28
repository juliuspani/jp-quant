// SECURITY_AND_TRADING_INVARIANTS.md y las pruebas no se separan: cada control del documento apunta a algo que
// existe, cada prueba INV- figura en el documento y ningún control pendiente sobrevive a su paso (ADR 0016).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, read, repoFiles } from './repo.ts';

const DOC = 'SECURITY_AND_TRADING_INVARIANTS.md';

// Quitar un invariante es una parada obligatoria (CLAUDE.md §7): exige cambiar esta lista con un ADR.
const INVARIANTS = ['INV-00', 'INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05', 'INV-06', 'INV-07', 'INV-08', 'INV-09', 'INV-10', 'INV-11', 'INV-12', 'INV-13', 'INV-14'];

interface Control {
  id: string;
  kind: 'auto' | 'manual' | 'pendiente';
  where: string;
}

const text = read(DOC);

const controls: Control[] = [...text.matchAll(/^\| (INV-\d\d[a-z]) \| (auto|manual|pendiente) \| (.+?) \| .+? \|$/gm)].map((m) => ({
  id: m[1] ?? '',
  kind: m[2] as Control['kind'],
  where: m[3] ?? '',
}));

/**
 * Último paso cerrado del plan según CHANGELOG.md: la copia pública no lleva PROGRESS.md, que es un registro de trabajo
 * privado. Si no se encuentra, la prueba falla: sin él no se puede vigilar nada.
 */
function lastClosedStep(): number {
  const m = /\*\*Last closed step:\*\*\s*(\d+)/.exec(read('CHANGELOG.md'));
  assert.ok(m?.[1], 'CHANGELOG.md no dice el último paso cerrado («**Last closed step:** N»)');
  return Number(m[1]);
}

test('el documento tiene los quince invariantes, en orden', () => {
  const headings = [...text.matchAll(/^### (INV-\d\d) /gm)].map((m) => m[1]);
  assert.deepEqual(headings, INVARIANTS);
});

test('cada control es único, tiene su invariante y cada invariante tiene controles', () => {
  assert.ok(controls.length > 0, 'no se encuentra la matriz de controles');
  const ids = controls.map((c) => c.id);
  assert.deepEqual(ids, [...new Set(ids)], 'hay controles repetidos');
  for (const c of controls) assert.ok(INVARIANTS.includes(c.id.slice(0, 6)), `${c.id} no pertenece a ningún invariante`);
  for (const inv of INVARIANTS) assert.ok(ids.some((id) => id.startsWith(inv)), `${inv} no tiene controles`);
});

test('cada control automático apunta a una prueba que existe y contiene el texto citado', () => {
  for (const c of controls.filter((x) => x.kind === 'auto')) {
    const m = /^`(test\/[^`]+\.test\.ts)` «(.+)»$/.exec(c.where);
    assert.ok(m?.[1] && m[2], `${c.id}: «Dónde» debe ser \`test/….test.ts\` «texto»`);
    assert.ok(existsSync(join(ROOT, m[1])), `${c.id}: no existe ${m[1]}`);
    assert.ok(read(m[1]).includes(m[2]), `${c.id}: ${m[1]} no contiene «${m[2]}»`);
  }
});

test('cada control manual tiene su procedimiento', () => {
  for (const c of controls.filter((x) => x.kind === 'manual')) {
    assert.match(c.where, /^M-\d\d$/, `${c.id}: «Dónde» debe ser un procedimiento M-NN`);
    assert.ok(new RegExp(`^### ${c.where} `, 'm').test(text), `${c.id}: falta el procedimiento ${c.where}`);
  }
});

test('ningún control pendiente ha pasado su paso', () => {
  const closed = lastClosedStep();
  for (const c of controls.filter((x) => x.kind === 'pendiente')) {
    const m = /^paso (\d+)$/.exec(c.where);
    assert.ok(m?.[1], `${c.id}: «Dónde» debe ser «paso N»`);
    assert.ok(Number(m[1]) > closed, `${c.id} debía ser una prueba en el paso ${m[1]}, y el último cerrado es el ${closed}`);
  }
});

test('cada prueba con nombre INV- figura en la matriz como automática y en su archivo', () => {
  const auto = new Map(controls.filter((c) => c.kind === 'auto').map((c) => [c.id, c.where]));
  for (const file of repoFiles().filter((f) => /^test\/.*\.test\.ts$/.test(f))) {
    for (const m of read(file).matchAll(/test\(\s*['"`](INV-\d\d[a-z]):/g)) {
      const id = m[1] ?? '';
      assert.ok(auto.has(id), `${file}: ${id} no está en la matriz como control automático`);
      assert.ok(auto.get(id)?.startsWith(`\`${file}\``), `${file}: la matriz sitúa ${id} en otro archivo`);
    }
  }
});
