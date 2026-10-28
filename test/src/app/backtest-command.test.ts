// Comando de backtest desde el paso 27B (ADR 0031): sin «variantes» declaradas en la especificación no registra nada, y
// los documentos congelados del repositorio son los que implementa el evaluador (si no, el comando no arrancaría).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { FROZEN_DOCUMENTS } from '../../../src/analytics/criteria.ts';
import { REGISTRY_FILE } from '../../../src/research/registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const COMMAND = 'src/app/backtest-command.ts';

test('sin «variantes» en la especificación, el comando se niega antes de tocar el registro', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inversor-command-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'sin-variantes.json');
  writeFileSync(file, JSON.stringify({ parametros: { tipo: 'valores', valores: { k: 1 } } }));
  const registry = join(ROOT, ...REGISTRY_FILE.split('/'));
  const before = readFileSync(registry, 'utf8');
  const refused = spawnSync(process.execPath, [COMMAND, '--spec', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /debe declarar «variantes»/);
  assert.equal(readFileSync(registry, 'utf8'), before, 'el registro no cambia');
});

test('los documentos congelados en disco tienen la huella que comprueba el comando antes de ejecutar', () => {
  for (const { path, sha256 } of FROZEN_DOCUMENTS) {
    const text = readFileSync(join(ROOT, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), sha256, path);
  }
  assert.match(readFileSync(join(ROOT, COMMAND), 'utf8'), /checkFrozenDocuments\(\);\n {2}const spec = readSpec/, 'la comprobación va antes de leer la especificación');
});
