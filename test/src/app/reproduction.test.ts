// Reproducción de un experimento (A.4.3; ADR 0034): aquí si desde su commit solo cambió documentación; en un worktree de
// ese commit si cambió código. El comando no escribe en el registro. La reproducción en sí (mismas métricas, mismo hash
// y mismo veredicto) la prueban las pruebas de reproduceExperiment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { worktreeFor } from '../../../src/app/reproduction.ts';
import { ReproductionError } from '../../../src/research/experiment.ts';
import { REGISTRY_FILE } from '../../../src/research/registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const COMMIT = 'a'.repeat(40);

test('con solo cambios de documentación se reproduce aquí; con cambios de código, en el worktree de su commit', () => {
  assert.equal(worktreeFor(COMMIT, [], 'base'), null);
  assert.equal(worktreeFor(COMMIT, ['PROGRESS.md', 'docs/research/experiments/registry.jsonl', 'docs/adr/0001-x.md'], 'base'), null);
  assert.equal(worktreeFor(COMMIT, ['PROGRESS.md', 'src/strategy/library.ts'], 'base'), join('base', COMMIT));
  for (const code of ['package.json', 'scripts/build.ts', 'test/src/app/library.test.ts', 'docs.ts']) {
    assert.equal(worktreeFor(COMMIT, [code], 'base'), join('base', COMMIT), code);
  }
});

// Comprueba texto: con la guarda de este repositorio, las velas llevaban otra clase Decimal que la del commit y su
// canonicalJson lanzaba NotCanonicalError (primer intento de reproducir EXP-0025 y EXP-0026, sin ejecutar nada).
test('en el worktree, todos los módulos que tocan los datos son los del commit, también la clase de la guarda', () => {
  const source = readFileSync(join(ROOT, 'src', 'app', 'reproduction.ts'), 'utf8');
  assert.match(source, /guard: new guard\.TestFinalGuard\(\{ paths: DEFAULT_PATHS,/);
  assert.doesNotMatch(source, /defaultGuard\(/);
});

test('fail closed: sin commit registrado no se reproduce', () => {
  assert.throws(() => worktreeFor(null, [], 'base'), ReproductionError);
});

test('el comando se niega sin id y con un id que no está en el registro, sin tocar el registro', () => {
  const registry = join(ROOT, ...REGISTRY_FILE.split('/'));
  const before = readFileSync(registry, 'utf8');
  const empty = spawnSync(process.execPath, ['src/app/reproduce-command.ts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(empty.status, 2, empty.stderr);
  const unknown = spawnSync(process.execPath, ['src/app/reproduce-command.ts', '--id', 'EXP-9999'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stderr, /EXP-9999 no está en el registro/);
  assert.equal(readFileSync(registry, 'utf8'), before, 'el registro no cambia');
});
