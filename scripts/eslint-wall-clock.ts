// Regla «sin reloj ni azar propios» (ARCHITECTURE.md §5.3, ADR 0021): en el dominio y en backtest/, la hora, los
// temporizadores y el azar llegan del kernel (Clock, Rng, Ids). Así el replay es determinista y el mismo código
// sirve en tiempo real. Son reglas de ESLint de serie: eslint.config.js las aplica y
// test/enforcement/wall-clock.test.ts comprueba que muerden y a qué módulos llegan.
import type { Linter } from 'eslint';

// El dominio de ARCHITECTURE.md §15.1 (el mismo de la regla dominio-sin-entrada-salida) y backtest/, que es el replay.
export const DETERMINISTIC_MODULES = [
  'shared', 'kernel', 'marketdata', 'features', 'analytics', 'strategy', 'portfolio', 'risk', 'execution', 'backtest',
];
// Excepción: el reloj de tiempo real, el único que lee el reloj del sistema. Esta lista solo puede encoger.
export const WALL_CLOCK_EXEMPT = ['src/kernel/system-clock.ts'];

const MESSAGE = 'Sin reloj ni azar propios en el dominio (ADR 0021): usa Clock, Rng o Ids del kernel.';
const TIMER_MODULES = ['timers', 'node:timers', 'timers/promises', 'node:timers/promises', 'perf_hooks', 'node:perf_hooks'];
const CRYPTO_RANDOM = ['randomUUID', 'randomBytes', 'randomInt', 'randomFill', 'randomFillSync', 'getRandomValues'];

/** Selectores de no-restricted-syntax. eslint.config.js los suma a los suyos: la regla no se fusiona entre bloques. */
export const wallClockSyntax = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: `new Date() sin argumentos. ${MESSAGE}` },
  { selector: "CallExpression[callee.name='Date']", message: `Date() devuelve la hora actual. ${MESSAGE}` },
];

export const wallClockRules: Linter.RulesRecord = {
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: MESSAGE },
    { object: 'Math', property: 'random', message: MESSAGE },
    { object: 'performance', property: 'now', message: MESSAGE },
    { object: 'process', property: 'hrtime', message: MESSAGE },
    { object: 'process', property: 'uptime', message: MESSAGE },
    ...['setTimeout', 'setInterval', 'setImmediate'].map((property) => ({ object: 'globalThis', property, message: MESSAGE })),
    ...CRYPTO_RANDOM.map((property) => ({ object: 'crypto', property, message: MESSAGE })),
  ],
  'no-restricted-globals': [
    'error',
    ...['setTimeout', 'setInterval', 'setImmediate', 'performance'].map((name) => ({ name, message: MESSAGE })),
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...TIMER_MODULES.map((name) => ({ name, message: MESSAGE })),
        ...['crypto', 'node:crypto'].map((name) => ({ name, importNames: CRYPTO_RANDOM, message: MESSAGE })),
      ],
    },
  ],
};
