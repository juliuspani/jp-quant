// La estructura de src/ sigue ARCHITECTURE.md (ADR 0015): cada carpeta de primer nivel es un módulo de la
// arquitectura con su regla de límites, y en la raíz de src/ no aparecen archivos nuevos. Una carpeta que no
// fuera un módulo quedaría fuera de la matriz de dependencias de .dependency-cruiser.cjs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');

// Módulos de ARCHITECTURE.md §4. Añadir uno exige su regla en la matriz y un ADR.
const MODULES = [
  'shared', 'kernel', 'marketdata', 'features', 'analytics', 'strategy', 'portfolio', 'risk', 'execution',
  'exchange', 'historical', 'backtest', 'persistence', 'monitoring', 'registry', 'research', 'intel', 'config',
  'app',
];
// app/ es la composición: puede importarlo todo y no tiene regla.
const WITHOUT_RULE = new Set(['app']);

// Archivos del código previo que siguen en la raíz de src/ (clasificación del paso 13). Esta lista solo encoge:
// cada archivo sale al moverse a su módulo, reescribirse o archivarse (ARCHITECTURE.md §18).
const LEGACY_ROOT_FILES = new Set([
  'broker.ts', 'config.ts', 'dashboard.ts', 'engine.ts', 'indicators.ts', 'intel.ts', 'log.ts',
  'main.ts', 'market.ts', 'portfolio.ts', 'report.ts', 'risk.ts', 'scout.ts', 'store.ts', 'telegram.ts',
  'types.ts', 'util.ts',
]);

function ruleNames(): Set<string> {
  const config: unknown = createRequire(import.meta.url)(join(ROOT, '.dependency-cruiser.cjs'));
  assert.ok(typeof config === 'object' && config !== null && 'forbidden' in config, '.dependency-cruiser.cjs sin forbidden');
  const forbidden: unknown = config.forbidden;
  assert.ok(Array.isArray(forbidden), 'forbidden no es una lista');
  const names = new Set<string>();
  for (const rule of forbidden as unknown[]) {
    if (typeof rule === 'object' && rule !== null && 'name' in rule && typeof rule.name === 'string') names.add(rule.name);
  }
  return names;
}

test('cada carpeta de primer nivel de src/ es un módulo de la arquitectura', () => {
  for (const entry of readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.ok(MODULES.includes(entry.name), `src/${entry.name}/ no es un módulo de ARCHITECTURE.md §4`);
  }
});

test('la raíz de src/ solo tiene archivos del código previo', () => {
  for (const entry of readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    assert.ok(LEGACY_ROOT_FILES.has(entry.name), `src/${entry.name} es nuevo: el código nuevo va en la carpeta de su módulo`);
  }
});

test('cada módulo tiene su regla en la matriz de .dependency-cruiser.cjs', () => {
  const names = ruleNames();
  for (const module of MODULES) {
    if (WITHOUT_RULE.has(module)) continue;
    assert.ok(names.has(`${module}-solo-importa-lo-permitido`), `falta la regla de límites de src/${module}/`);
  }
});

test('ARCHITECTURE.md nombra cada módulo y sus enlaces relativos existen', () => {
  const text = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  for (const module of MODULES) {
    assert.ok(text.includes(`\`src/${module}/\``), `ARCHITECTURE.md no nombra src/${module}/`);
  }
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1] ?? '';
    if (/^[a-z]+:/i.test(target)) continue;
    assert.ok(existsSync(join(ROOT, target)), `ARCHITECTURE.md: enlace roto a ${target}`);
  }
});
