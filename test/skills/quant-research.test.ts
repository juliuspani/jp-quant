// El skill quant-research es el procedimiento obligatorio de research (paso 5, ADR 0002). Estas pruebas
// impiden que se rompa su carga, que desaparezca una regla o que diverjan los umbrales y los veredictos.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'quant-research');
const SKILL = join(SKILL_DIR, 'SKILL.md');
const CHECKLIST = join(SKILL_DIR, 'checklist.md');
const TEMPLATE = join(SKILL_DIR, 'plantilla-informe.md');
const ADR = join(ROOT, 'docs', 'adr', '0002-protocolo-quant-research.md');

const VERDICTS = ['RECHAZADA', 'NO CONCLUYENTE', 'CANDIDATA A TEST FINAL', 'CANDIDATA A PAPER'];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function frontmatter(text: string): Map<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const body = match?.[1];
  assert.ok(body !== undefined, 'SKILL.md debe empezar con un bloque de frontmatter entre ---');
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep > 0) fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  return fields;
}

test('SKILL.md tiene un frontmatter válido para Claude Code', () => {
  const fields = frontmatter(read(SKILL));
  assert.equal(fields.get('name'), 'quant-research');
  const description = fields.get('description') ?? '';
  assert.ok(description.length > 0, 'falta description');
  assert.ok(description.length <= 1024, `description tiene ${description.length} caracteres; máximo 1024`);
});

test('los enlaces relativos de los archivos del skill apuntan a archivos que existen', () => {
  for (const file of [SKILL, CHECKLIST, TEMPLATE]) {
    for (const [, target] of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (target === undefined || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: el enlace ${target} no existe`);
    }
  }
});

test('SKILL.md cubre todas las reglas obligatorias del procedimiento', () => {
  const text = read(SKILL).toLowerCase();
  const required = [
    'train',
    'validation',
    'purging',
    'embargo',
    'walk-forward',
    'config/holdout.lock',
    'point-in-time',
    'listings',
    'delistings',
    'look-ahead',
    'supervivencia',
    'leakage',
    'comisión',
    'spread',
    'slippage',
    'buy-and-hold',
    'aleatori',
    'experiment registry',
    'fallidas',
    'deflated sharpe ratio',
    'cscv',
    'bootstrap',
    'estabilidad',
    'sensibilidad',
    'ablación',
    'tamaño de muestra mínimo',
    'complejidad',
    'corte de conocimiento',
    'tiempo real',
    'el p&l positivo no demuestra nada',
  ];
  for (const term of required) assert.ok(text.includes(term), `SKILL.md no menciona «${term}»`);
});

test('los cuatro veredictos aparecen en el skill y en la plantilla', () => {
  for (const file of [SKILL, TEMPLATE]) {
    const text = read(file);
    for (const verdict of VERDICTS) assert.ok(text.includes(verdict), `${file} no incluye el veredicto ${verdict}`);
  }
});

test('los umbrales clave coinciden entre SKILL.md y el ADR 0002', () => {
  const skill = read(SKILL);
  const adr = read(ADR);
  for (const threshold of ['DSR ≥ 0,95', '< 0,20', '≥ 0,50', '≥ 100 operaciones', '≥ 3 tramos', '≥ 1000']) {
    assert.ok(skill.includes(threshold), `SKILL.md no recoge el umbral «${threshold}»`);
    assert.ok(adr.includes(threshold), `ADR 0002 no recoge el umbral «${threshold}»`);
  }
});
