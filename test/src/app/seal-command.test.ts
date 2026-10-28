// Comando del sello (paso 41C): escribe el SVG autocontenido y no sobrescribe un archivo que ya existe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { sealFile } from '../../../src/app/seal-command.ts';
import { sealSvg } from '../../../src/monitoring/seal.ts';

const COMMAND = join(resolve(import.meta.dirname, '..', '..', '..'), 'src', 'app', 'seal-command.ts');
const dir = mkdtempSync(join(tmpdir(), 'sello-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [COMMAND, ...args], { encoding: 'utf8' });

test('exporta el sello a un .svg, en tamaño normal o pequeño', () => {
  const out = join(dir, 'sello.svg');
  assert.equal(run('--salida', out).status, 0);
  assert.equal(readFileSync(out, 'utf8'), `${sealSvg({ standalone: true })}\n`);
  const small = join(dir, 'pequeno.svg');
  assert.equal(run('--salida', small, '--pequeno').status, 0);
  assert.equal(readFileSync(small, 'utf8'), sealFile(true));
  assert.equal(run('--salida', join(dir, 'otro.svg'), '--anillo', 'puntos').status, 1, 'ya no hay variantes de anillo');
});

test('no sobrescribe, exige .svg y sin salida enseña el uso', () => {
  const existing = join(dir, 'ya-existe.svg');
  writeFileSync(existing, 'mío');
  const result = run('--salida', existing);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(existing, 'utf8'), 'mío');
  assert.equal(run('--salida', join(dir, 'sello.png')).status, 1);
  assert.equal(run().status, 2);
});
