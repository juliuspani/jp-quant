// Reglas de CLAUDE.md §2 («Calidad de código» y «Seguridad operativa») convertidas en errores.
// Las infracciones del código previo al paso 4 no se desactivan aquí: viven, contadas por archivo y regla,
// en eslint-suppressions.json (ver docs/enforcement.md). El código nuevo no tiene excepciones.
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { MONEY_MODULES, NO_FLOAT_EXEMPT, noFloatPlugin } from './scripts/eslint-no-float.ts';
import { DETERMINISTIC_MODULES, WALL_CLOCK_EXEMPT, wallClockRules, wallClockSyntax } from './scripts/eslint-wall-clock.ts';

const NO_WITHDRAW =
  'CLAUDE.md §2: nunca withdrawals por API. No se escribe código que llame a endpoints de retiro.';

const NO_WITHDRAW_SYNTAX = [
  { selector: 'MemberExpression[property.name=/withdraw/i]', message: NO_WITHDRAW },
  { selector: 'MemberExpression[property.value=/withdraw/i]', message: NO_WITHDRAW },
];

const sharedRules = {
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-console': 'error',
  'no-restricted-syntax': ['error', ...NO_WITHDRAW_SYNTAX],
};

export default defineConfig(
  { ignores: ['node_modules/', 'data/'] },
  {
    // Un comentario eslint-disable no puede apagar una regla: las excepciones solo existen en la lista.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...sharedRules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // test() de node:test devuelve una promesa que gestiona el propio runner.
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe'] }],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    rules: sharedRules,
  },
  {
    files: [...MONEY_MODULES.map((m) => `src/${m}/**/*.ts`), 'capguard/**/*.ts'],
    ignores: NO_FLOAT_EXEMPT,
    plugins: { inversor: noFloatPlugin },
    rules: { 'inversor/no-float': 'error' },
  },
  {
    // Sin reloj ni azar propios en el dominio (ADR 0021). Este no-restricted-syntax sustituye al de sharedRules en
    // estos archivos, así que repite los selectores de sharedRules.
    files: DETERMINISTIC_MODULES.map((m) => `src/${m}/**/*.ts`),
    ignores: WALL_CLOCK_EXEMPT,
    rules: { ...wallClockRules, 'no-restricted-syntax': ['error', ...NO_WITHDRAW_SYNTAX, ...wallClockSyntax] },
  },
  {
    // El logger es el único sitio donde se permite console.
    files: ['src/log.ts'],
    rules: { 'no-console': 'off' },
  },
);
