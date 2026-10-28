// Demuestra que la regla «sin reloj ni azar propios» (scripts/eslint-wall-clock.ts, ADR 0021) muerde y que
// eslint.config.js la aplica al dominio y a backtest/, con solo la excepción escrita.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import {
  DETERMINISTIC_MODULES,
  WALL_CLOCK_EXEMPT,
  wallClockRules,
  wallClockSyntax,
} from '../../scripts/eslint-wall-clock.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'wall-clock');
const RULES = ['no-restricted-properties', 'no-restricted-globals', 'no-restricted-imports', 'no-restricted-syntax'];

// Solo la regla bajo prueba, sobre los archivos de ejemplo.
function linter(): ESLint {
  return new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['test/fixtures/wall-clock/**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { ...wallClockRules, 'no-restricted-syntax': ['error', ...wallClockSyntax] },
      },
    ],
  });
}

test('la regla marca cada lectura del reloj, temporizador y azar del ejemplo, y nada más', async () => {
  const file = join(FIXTURES, 'bad.ts');
  const [result] = await linter().lintFiles([file]);
  assert.ok(result, 'ESLint no devolvió resultado');
  assert.deepEqual(result.messages.filter((m) => !RULES.includes(m.ruleId ?? '')), [], 'errores ajenos a la regla');
  const expected = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .flatMap((line, i) => (line.includes('// ✗') ? [i + 1] : []));
  assert.ok(expected.length > 10);
  // Una línea puede dar dos errores (performance.now(): la propiedad y el global).
  assert.deepEqual([...new Set(result.messages.map((m) => m.line))], expected);
});

test('el reloj inyectado, new Date con argumento, Date.parse y los hash no se marcan', async () => {
  const [result] = await linter().lintFiles([join(FIXTURES, 'ok.ts')]);
  assert.deepEqual(result?.messages, []);
});

test('eslint.config.js aplica la regla al dominio y a backtest/, y solo exceptúa el reloj de tiempo real', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const rulesFor = async (file: string): Promise<Record<string, unknown>> => {
    const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> } | undefined;
    return config?.rules ?? {};
  };
  const applies = async (file: string): Promise<boolean> => {
    const rules = await rulesFor(file);
    const syntax = JSON.stringify(rules['no-restricted-syntax'] ?? null);
    const hasSyntax = wallClockSyntax.every((s) => syntax.includes(JSON.stringify(s.selector)));
    return hasSyntax && ['no-restricted-properties', 'no-restricted-globals', 'no-restricted-imports'].every((r) => {
      const setting = rules[r];
      return Array.isArray(setting) && setting[0] === 2;
    });
  };
  assert.deepEqual(DETERMINISTIC_MODULES, [
    'shared', 'kernel', 'marketdata', 'features', 'analytics', 'strategy', 'portfolio', 'risk', 'execution', 'backtest',
  ]);
  for (const module of DETERMINISTIC_MODULES) assert.ok(await applies(`src/${module}/x.ts`), `no se aplica en src/${module}/`);
  // La lista de excepciones solo puede encoger.
  assert.deepEqual(WALL_CLOCK_EXEMPT, ['src/kernel/system-clock.ts']);
  for (const file of WALL_CLOCK_EXEMPT) assert.equal(await applies(file), false, `${file} debería estar exceptuado`);
  // Los adaptadores sí leen el reloj: el histórico fecha sus manifiestos.
  assert.equal(await applies('src/historical/x.ts'), false);
  // Este bloque sustituye el no-restricted-syntax común: no debe perder la regla de los retiros.
  assert.match(JSON.stringify((await rulesFor('src/kernel/x.ts'))['no-restricted-syntax']), /withdraw/);
});
