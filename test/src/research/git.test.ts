// Lectura del estado del código con git real, en un repositorio temporal (sin red).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitRepo, GitError } from '../../../src/research/git.ts';
import { tempDir, tempRepo } from './helpers.ts';

test('head, cambios sin confirmar (también archivos nuevos y movidos) y archivos cambiados desde un commit', () => {
  const repo = tempRepo();
  const port = gitRepo(repo.dir);
  mkdirSync(join(repo.dir, 'src'));
  writeFileSync(join(repo.dir, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(repo.dir, 'README.md'), 'r\n');
  const first = repo.commit('uno');
  assert.equal(port.head(), first);
  assert.deepEqual(port.dirtyPaths(), []);
  writeFileSync(join(repo.dir, 'src', 'a.ts'), 'a2\n');
  writeFileSync(join(repo.dir, 'src', 'nuevo.ts'), 'n\n');
  assert.deepEqual([...port.dirtyPaths()].sort(), ['src/a.ts', 'src/nuevo.ts']);
  repo.commit('dos');
  repo.git('mv', 'src/nuevo.ts', 'src/movido.ts');
  assert.deepEqual([...port.dirtyPaths()].sort(), ['src/movido.ts', 'src/nuevo.ts'], 'un movimiento muestra las dos rutas');
  repo.commit('tres');
  assert.deepEqual([...port.changedSince(first)].sort(), ['src/a.ts', 'src/movido.ts']);
  assert.deepEqual(port.changedSince(port.head()), []);
});

test('un commit desconocido o una carpeta sin repositorio son errores, no «nada cambió»', () => {
  const repo = tempRepo();
  writeFileSync(join(repo.dir, 'a.txt'), 'a\n');
  repo.commit('uno');
  assert.throws(() => gitRepo(repo.dir).changedSince('f'.repeat(40)), GitError);
  assert.throws(() => gitRepo(tempDir('ijp-nogit-')).head(), GitError);
});
