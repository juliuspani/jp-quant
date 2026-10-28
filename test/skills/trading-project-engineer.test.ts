// El skill trading-project-engineer es el estándar de ingeniería del repositorio (paso 8, ADR 0006). Estas
// pruebas impiden que se rompa su carga, que desaparezca una regla, que cite un script que no existe o que
// entre una dependencia sin registrar en docs/DEPENDENCIES.md.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'trading-project-engineer');
const SKILL = join(SKILL_DIR, 'SKILL.md');
const CHECKLIST = join(SKILL_DIR, 'checklist.md');
const ADR = join(ROOT, 'docs', 'adr', '0006-estandar-de-ingenieria.md');
const DEPENDENCIES = join(ROOT, 'docs', 'DEPENDENCIES.md');
const PACKAGE = join(ROOT, 'package.json');

const REGISTRY_ROW = /^\| `([^`]+)` \|/gm;

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

function packageJson(): { scripts: Record<string, string>; deps: string[] } {
  const parsed: unknown = JSON.parse(read(PACKAGE));
  assert.ok(typeof parsed === 'object' && parsed !== null, 'package.json no es un objeto');
  const record = (key: string): Record<string, string> => {
    const value: unknown = Reflect.get(parsed, key);
    if (value === undefined) return {};
    assert.ok(typeof value === 'object' && value !== null, `package.json: ${key} no es un objeto`);
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(value)) out[name] = String(v);
    return out;
  };
  return {
    scripts: record('scripts'),
    deps: [...Object.keys(record('dependencies')), ...Object.keys(record('devDependencies'))],
  };
}

test('SKILL.md tiene un frontmatter válido para Claude Code', () => {
  const fields = frontmatter(read(SKILL));
  assert.equal(fields.get('name'), 'trading-project-engineer');
  const description = fields.get('description') ?? '';
  assert.ok(description.length > 0, 'falta description');
  assert.ok(description.length <= 1024, `description tiene ${description.length} caracteres; máximo 1024`);
});

test('los enlaces relativos de los archivos del skill apuntan a archivos que existen', () => {
  for (const file of [SKILL, CHECKLIST]) {
    for (const [, target] of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (target === undefined || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: el enlace ${target} no existe`);
    }
  }
});

test('SKILL.md cubre todas las exigencias del estándar', () => {
  const text = read(SKILL).toLowerCase();
  const required = [
    'scope mínimo',
    'cambios pequeños',
    'tests',
    'build',
    'typecheck',
    'lint',
    'commits atómicos',
    'documentación',
    'ausencia de secretos',
    'explicación de cambios',
    'no refactorizar módulos no relacionados',
    'no añadir dependencias sin justificar',
    'licencia',
    'mantenimiento',
    'tamaño',
    'alternativa nativa',
    'scripts de instalación',
    'aprobación expresa de la persona',
    'infraestructura innecesaria',
    'no generar subagentes recursivamente',
    'autorización explícita',
    'leer solo los archivos necesarios',
    'no volcar archivos enteros',
    'preferir búsquedas dirigidas',
    'si una tarea no cabe en una sesión, se parte y se deja anotado en `progress.md`',
    'manda `claude.md`',
  ];
  for (const term of required) assert.ok(text.includes(term), `SKILL.md no menciona «${term}»`);
});

test('§6 sigue la estructura de PROGRESS.md: 200 líneas, historial y decisiones aparte', () => {
  const text = read(SKILL);
  const start = text.indexOf('\n## 6. Documentación');
  assert.ok(start >= 0, 'SKILL.md no tiene el apartado «6. Documentación»');
  const docs = text.slice(start, text.indexOf('\n## ', start + 1));
  for (const term of ['200 líneas', 'decisiones pendientes', 'compromisos para pasos futuros',
    'los 3 últimos relevos resumidos', 'riesgos vigentes', '`docs/progress/HISTORY.md`', '`docs/progress/DECISIONS.md`']) {
    assert.ok(docs.includes(term), `§6 no menciona «${term}»`);
  }
});

test('los scripts npm que citan el skill y el checklist existen en package.json', () => {
  const { scripts } = packageJson();
  for (const file of [SKILL, CHECKLIST]) {
    for (const [, name] of read(file).matchAll(/npm run ([\w:-]+)/g)) {
      if (name === undefined) continue;
      assert.ok(name in scripts, `${file} cita «npm run ${name}», que no está en package.json`);
    }
  }
});

test('toda dependencia de package.json está en docs/DEPENDENCIES.md, y al revés', () => {
  const registered = new Set([...read(DEPENDENCIES).matchAll(REGISTRY_ROW)].map(([, name]) => name));
  const { deps } = packageJson();
  assert.ok(deps.length > 0, 'package.json no declara dependencias; revisar el test');
  for (const dep of deps) {
    assert.ok(registered.has(dep), `la dependencia ${dep} no está en docs/DEPENDENCIES.md`);
  }
  for (const name of registered) {
    assert.ok(deps.includes(name ?? ''), `docs/DEPENDENCIES.md registra ${name ?? '?'}, que ya no está en package.json`);
  }
});

test('el checklist tiene todos los bloques y remite al registro de dependencias', () => {
  const text = read(CHECKLIST);
  for (const block of ['Antes de empezar', 'Durante el cambio', 'Tests', 'Dependencias', 'Subagentes', 'Antes del commit', 'Cierre']) {
    assert.ok(text.includes(`## ${block}`), `checklist.md no tiene el bloque «${block}»`);
  }
  assert.ok(text.includes('docs/DEPENDENCIES.md'), 'checklist.md no remite a docs/DEPENDENCIES.md');
  const boxes = text.match(/^- \[ \] /gm) ?? [];
  assert.ok(boxes.length >= 30, `checklist.md tiene ${boxes.length} casillas; se esperaban al menos 30`);
});

test('el ADR 0006 remite al registro y no contiene la lista de dependencias', () => {
  const adr = read(ADR);
  assert.ok(adr.includes('](../DEPENDENCIES.md)'), 'ADR 0006 no enlaza docs/DEPENDENCIES.md');
  assert.equal([...adr.matchAll(REGISTRY_ROW)].length, 0, 'ADR 0006 no debe listar dependencias');
});
