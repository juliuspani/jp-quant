// Demuestra que los límites arquitectónicos de .dependency-cruiser.cjs funcionan: un import prohibido
// hace fallar estas pruebas, tanto en los árboles de ejemplo como en el src/ real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
// El mismo comando que `npm run boundaries`: analiza src/ y, si existe, capguard/.
const BOUNDARIES = join(ROOT, 'scripts', 'boundaries.ts');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'boundaries');

interface Violation {
  from: string;
  rule: { name: string };
}

function cruise(cwd: string, extraArgs: string[] = []): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [BOUNDARIES, ...extraArgs], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout };
}

function violations(cwd: string): string[] {
  const { stdout } = cruise(cwd, ['--output-type', 'json']);
  const report = JSON.parse(stdout) as { summary: { violations: Violation[] } };
  return report.summary.violations.map((v) => `${v.rule.name} <- ${v.from}`).sort();
}

// Las reglas del paso 4 y la matriz del paso 14 (ADR 0015) se solapan: un mismo import puede infringir las dos.
test('cada import prohibido del árbol de ejemplo se detecta', () => {
  assert.deepEqual(violations(join(FIXTURES, 'bad')), [
    'analytics-solo-importa-lo-permitido <- src/analytics/uses-portfolio.ts',
    'backtest-solo-importa-lo-permitido <- src/backtest/sim.ts',
    'backtest-solo-importa-lo-permitido <- src/backtest/uses-execution.ts',
    'capguard-no-importa-src <- capguard/uses-src.ts',
    'config-solo-importa-lo-permitido <- src/config/uses-app.ts',
    'dominio-sin-entrada-salida <- src/execution/uses-sqlite.ts',
    'dominio-sin-entrada-salida <- src/risk/uses-fs.ts',
    'dominio-sin-paquetes-npm <- src/features/uses-npm.ts',
    'dominio-sin-paquetes-npm <- src/strategy/uses-ccxt.ts',
    'exchange-solo-importa-lo-permitido <- src/exchange/uses-execution.ts',
    'execution-solo-importa-lo-permitido <- src/execution/uses-exchange.ts',
    'execution-solo-importa-lo-permitido <- src/execution/uses-signer.ts',
    'features-no-execution-ni-risk <- src/features/uses-execution.ts',
    'features-no-execution-ni-risk <- src/features/uses-risk.ts',
    'features-sin-contratos-de-ordenes <- src/features/uses-orders.ts',
    'features-solo-importa-lo-permitido <- src/features/uses-execution.ts',
    'features-solo-importa-lo-permitido <- src/features/uses-risk.ts',
    'historical-solo-importa-lo-permitido <- src/historical/uses-exchange.ts',
    'intel-solo-importa-lo-permitido <- src/intel/uses-strategy.ts',
    'kernel-solo-importa-lo-permitido <- src/kernel/uses-risk.ts',
    'llm-y-news-no-execution-ni-exchange <- src/llm/uses-execution.ts',
    'llm-y-news-no-execution-ni-exchange <- src/news/uses-exchange.ts',
    'marketdata-solo-importa-lo-permitido <- src/marketdata/uses-features.ts',
    'monitoring-solo-importa-lo-permitido <- src/monitoring/uses-execution.ts',
    'persistence-solo-importa-lo-permitido <- src/persistence/uses-risk.ts',
    'portfolio-solo-importa-lo-permitido <- src/portfolio/uses-risk.ts',
    'registry-solo-importa-lo-permitido <- src/registry/uses-strategy.ts',
    'research-solo-importa-lo-permitido <- src/research/uses-exchange.ts',
    'risk-solo-importa-lo-permitido <- src/risk/uses-execution.ts',
    'shared-solo-importa-lo-permitido <- src/shared/uses-kernel.ts',
    'solo-decimal-importa-big-js <- capguard/uses-big.ts',
    'solo-decimal-importa-big-js <- src/exchange/uses-big.ts',
    'solo-exchange-importa-ccxt <- src/engine/uses-ccxt.ts',
    'solo-exchange-importa-ccxt <- src/strategy/uses-ccxt.ts',
    'solo-persistence-usa-sqlite <- src/execution/uses-sqlite.ts',
    'solo-risk-usa-el-firmante <- src/execution/uses-signer.ts',
    'solo-risk-usa-el-firmante <- src/strategy/uses-signer.ts',
    'src-no-importa-capguard <- src/engine/uses-capguard.ts',
    'strategy-no-ccxt <- src/strategy/uses-ccxt.ts',
    'strategy-no-execution-ni-exchange <- src/strategy/uses-exchange.ts',
    'strategy-no-execution-ni-exchange <- src/strategy/uses-execution.ts',
    'strategy-solo-importa-lo-permitido <- src/strategy/uses-exchange.ts',
    'strategy-solo-importa-lo-permitido <- src/strategy/uses-execution.ts',
    'strategy-solo-importa-lo-permitido <- src/strategy/uses-legacy-broker.ts',
    'strategy-solo-importa-lo-permitido <- src/strategy/uses-portfolio.ts',
    'strategy-solo-importa-lo-permitido <- src/strategy/uses-signer.ts',
  ]);
});

test('un árbol con imports prohibidos hace fallar el comando', () => {
  assert.notEqual(cruise(join(FIXTURES, 'bad')).status, 0);
});

// El árbol correcto tiene un import permitido de cada módulo y de cada excepción transitoria (ADR 0015).
test('un árbol que respeta los límites pasa sin infracciones', () => {
  assert.deepEqual(violations(join(FIXTURES, 'ok')), []);
  assert.equal(cruise(join(FIXTURES, 'ok')).status, 0);
});

test('src/ no tiene imports prohibidos fuera de la lista de excepciones', () => {
  const { status, stdout } = cruise(ROOT, ['--ignore-known']);
  assert.equal(status, 0, stdout);
});
