// Demuestra que la regla «nunca float» (scripts/eslint-no-float.ts, ADR 0014) funciona y que eslint.config.js la
// aplica a cada módulo de dinero y precios, con solo las excepciones escritas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { MONEY_MODULES, NO_FLOAT_EXEMPT, noFloatPlugin } from '../../scripts/eslint-no-float.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'no-float');

// Solo la regla bajo prueba, con información de tipos, sobre los archivos de ejemplo.
function linter(): ESLint {
  return new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['test/fixtures/no-float/**/*.ts'],
        languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: ROOT } },
        plugins: { inversor: noFloatPlugin },
        rules: { 'inversor/no-float': 'error' },
      },
    ],
  });
}

test('la regla marca cada conversión y cada operación con number del ejemplo, y nada más', async () => {
  const file = join(FIXTURES, 'bad.ts');
  const [result] = await linter().lintFiles([file]);
  assert.ok(result, 'ESLint no devolvió resultado');
  assert.deepEqual(result.messages.filter((m) => m.ruleId !== 'inversor/no-float'), [], 'errores ajenos a la regla');
  const expected = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .flatMap((line, i) => (line.includes('// ✗') ? [i + 1] : []));
  assert.ok(expected.length > 10);
  assert.deepEqual(result.messages.map((m) => m.line), expected);
});

test('Decimal, comparaciones, bigint, literales negativos y texto no se marcan', async () => {
  const [result] = await linter().lintFiles([join(FIXTURES, 'ok.ts')]);
  assert.deepEqual(result?.messages, []);
});

test('eslint.config.js aplica la regla a cada módulo de dinero y solo exceptúa los archivos escritos', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const applies = async (file: string): Promise<boolean> => {
    const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> } | undefined;
    const setting = config?.rules?.['inversor/no-float'];
    return Array.isArray(setting) && setting[0] === 2;
  };
  for (const module of MONEY_MODULES) assert.ok(await applies(`src/${module}/x.ts`), `no se aplica en src/${module}/`);
  assert.ok(await applies('capguard/x.ts'), 'no se aplica en capguard/');
  assert.deepEqual(MONEY_MODULES, ['exchange', 'execution', 'risk', 'portfolio', 'historical', 'backtest']);
  // La lista de excepciones solo puede encoger.
  assert.deepEqual(NO_FLOAT_EXEMPT, ['capguard/decimal.ts']);
  for (const file of NO_FLOAT_EXEMPT) assert.equal(await applies(file), false, `${file} debería estar exceptuado`);
  // El análisis sí usa float (exchange-execution §17).
  assert.equal(await applies('src/features/x.ts'), false);
});
