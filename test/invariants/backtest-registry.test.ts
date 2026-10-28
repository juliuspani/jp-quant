// INV-14 (SECURITY_AND_TRADING_INVARIANTS.md, aprobado por la persona en el paso 23): todo backtest pasa por el
// Experiment Registry y con costes. INV-14a comprueba texto, como las demás pruebas de este tipo; INV-14b y INV-14c
// ejecutan el código.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBacktest } from '../../src/app/backtest.ts';
import { CostModelError, executionCosts } from '../../src/backtest/costs.ts';
import { gridSize, REGISTRY_FILE } from '../../src/research/registry.ts';
import { spec } from '../src/app/scenario.ts';
import { matchingLines, read, ROOT, runnableCode } from './repo.ts';

const COMMAND = 'src/app/backtest-command.ts';
const files = (hits: readonly string[]): string[] => [...new Set(hits.map((hit) => hit.slice(0, hit.indexOf(':'))))];

test('INV-14a: en src/ solo el ejecutor de experimentos llama a runBacktest, y el comando de backtest solo ejecuta por runExperiment', () => {
  const src = runnableCode().filter((f) => f.startsWith('src/'));
  const callers = matchingLines(src, [/\brunBacktest\(/]).filter((hit) => !hit.includes('export function runBacktest'));
  assert.deepEqual(files(callers), ['src/app/research-runner.ts']);
  assert.deepEqual(files(matchingLines(src, [/new ReplayEngine\(/])), ['src/app/backtest.ts']);
  assert.match(read(COMMAND), /await runExperiment\(/);
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts.backtest, `node ${COMMAND}`);
});

test('INV-14b: sin costes no hay backtest: por debajo de los mínimos el modelo no se construye y el run no empieza', () => {
  for (const costs of [
    { commission: '0', halfSpread: '0.00075', minSlippage: '0.0005', multiplier: 1 },
    { commission: '0.0025', halfSpread: '0', minSlippage: '0.0005', multiplier: 1 },
    { commission: '0.0025', halfSpread: '0.00075', minSlippage: '0', multiplier: 1 },
  ]) {
    assert.throws(() => executionCosts(costs), CostModelError, JSON.stringify(costs));
  }
  assert.throws(() => runBacktest(spec({ costs: { ...spec().costs, commission: '0.001' } })), CostModelError);
});

// Sustituido en el paso 28 (ADR 0032, aprobado por la persona el 2026-10-16): antes se negaba a todo barrido.
test('INV-14c: el comando de backtest se niega a una rejilla de más de 20 puntos antes de tocar el registro, y sin argumentos solo enseña el uso', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inversor-command-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'barrido.json');
  writeFileSync(file, JSON.stringify({ parametros: { tipo: 'rejilla', rejilla: { a: [1, 2, 3, 4, 5, 6, 7], b: [1, 2, 3] } }, variantes: 0 }));
  const before = read(REGISTRY_FILE);
  const refused = spawnSync(process.execPath, [COMMAND, '--spec', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /21 puntos: como mucho 20/);
  assert.equal(read(REGISTRY_FILE), before, 'el registro no cambia');
  // Cada punto de una rejilla cuenta en N (n_pruebas = puntos + variantes): lo comprueba el registro al leer.
  assert.equal(gridSize({ tipo: 'rejilla', rejilla: { a: [1, 2], b: [1, 2, 3] } }), 6);
  assert.match(read('src/research/registry.ts'), /\(gridSize\(line\.parametros\) \?\? 0\) \+ \(line\.variantes \?\? 0\) !== line\.n_pruebas/);
  const usage = spawnSync(process.execPath, [COMMAND], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^Uso: npm run backtest -- --spec/);
});
