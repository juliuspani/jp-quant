// El registro real (docs/research/experiments/registry.jsonl, ADR 0024): pasa todas las reglas, no cambia lo ya
// confirmado y tiene dadas de alta las pruebas previas del inventario del ADR 0019.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseRegistry, REGISTRY_FILE } from '../../../src/research/registry.ts';
import { ROOT } from '../../invariants/repo.ts';

const text = readFileSync(join(ROOT, ...REGISTRY_FILE.split('/')), 'utf8');

test('el registro real cumple todas las reglas: esquema, cadena, ids, ciclo de vida y cuentas', () => {
  assert.doesNotThrow(() => parseRegistry(text));
});

test('solo inserción frente a git: el registro del último commit es un prefijo exacto del actual', () => {
  const git = (args: string[]): string => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  // Antes del primer commit (el de la copia pública, paso 49) no hay HEAD con el que comparar.
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: ROOT }).status !== 0) return;
  if (git(['ls-tree', 'HEAD', '--', REGISTRY_FILE]) === '') return; // solo en el commit que lo crea: HEAD aún no lo tiene
  const r = { stdout: git(['show', `HEAD:${REGISTRY_FILE}`]) };
  assert.ok(text.startsWith(r.stdout), 'se cambió o borró una línea ya confirmada: las correcciones son líneas nuevas');
});

test('las pruebas previas de docs/research/02 cuentan en N con el inventario del ADR 0019, invalidadas', () => {
  const registry = parseRegistry(text);
  const prior = [...registry.experiments.values()].filter((e) => e.registered.previa);
  const counts: Record<string, number> = {};
  for (const { registered } of prior) counts[registered.familia] = (counts[registered.familia] ?? 0) + registered.n_pruebas;
  assert.deepEqual(counts, {
    'tendencia-donchian-atr': 48,
    'regimen-btc-sma200': 3,
    'reversion-rsi2': 7,
    'ruptura-volatilidad-intradia': 1,
    'dca-btc': 2,
    'vistazos-descriptivos': 2,
  });
  for (const { registered, closings } of prior) {
    assert.deepEqual(closings.map((c) => c.estado), ['invalidado'], registered.id);
    assert.equal(registered.informe, 'docs/research/02-estrategias-y-frecuencia.md', registered.id);
  }
});
