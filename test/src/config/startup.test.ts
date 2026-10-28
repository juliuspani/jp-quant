// La guarda de arranque (src/config/startup.ts) y la resolución del entorno: cada combinación peligrosa impide
// arrancar, y una configuración segura no da ningún problema. Todo en memoria: sin red, sin .env y sin procesos.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  ENVIRONMENTS,
  MAX_CAPITAL_CAP_QUOTE,
  NO_SECRETS,
  assertSafeStartup,
  loadConfig,
  parseConfig,
  resolveEnvironment,
  startupProblems,
} from '../../../src/config.ts';
import type { Config, Environment, KeyPermissions, Secrets, StartupInput } from '../../../src/config.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const KEYS = { apiKey: 'clave-de-prueba', apiSecret: 'secreto-de-prueba' };
const CLEAN_KEY: KeyPermissions = { fundsOut: false, fundsBetweenAccounts: false, margin: false, futures: false, ipRestricted: true };
const LIVE: Secrets = { ...KEYS, liveConfirmed: true, liveRequested: true };

function config(over: Record<string, unknown> = {}): Config {
  return parseConfig({ capital: { startingQuote: 500, capQuote: 500 }, ...over });
}

/** Una entrada segura para cada entorno: la base sobre la que cada prueba cambia una sola cosa. */
function safe(environment: Environment): StartupInput {
  switch (environment) {
    case 'production':
      return { environment, config: config({ mode: 'live' }), secrets: LIVE, keyPermissions: CLEAN_KEY };
    case 'shadow':
      return { environment, config: config({ mode: 'shadow' }), secrets: { ...NO_SECRETS, ...KEYS }, keyPermissions: CLEAN_KEY };
    default:
      return { environment, config: config(), secrets: NO_SECRETS };
  }
}

function problems(input: StartupInput): string {
  return startupProblems(input).join('\n');
}

test('una configuración segura arranca en cada entorno', () => {
  for (const environment of ENVIRONMENTS) assert.deepEqual(startupProblems(safe(environment)), [], environment);
  const testnet = { ...safe('development'), config: config({ mode: 'live', exchange: { sandbox: true } }), secrets: { ...NO_SECRETS, ...KEYS } };
  assert.deepEqual(startupProblems(testnet), []);
});

test('el config.json versionado con capital cap arranca en paper', () => {
  const versioned = loadConfig(join(ROOT, 'config.json'));
  assert.deepEqual(startupProblems({ environment: 'paper', config: versioned, secrets: NO_SECRETS }), []);
});

test('LIVE=true fuera de production no arranca', () => {
  for (const environment of ENVIRONMENTS.filter((e) => e !== 'production')) {
    for (const secrets of [{ ...NO_SECRETS, liveRequested: true }, { ...NO_SECRETS, liveRequested: true, liveConfirmed: true }]) {
      const base = safe(environment);
      assert.match(problems({ ...base, secrets: { ...base.secrets, ...secrets } }), /LIVE_TRADING activado fuera de production/, environment);
    }
  }
});

test('el modo live con dinero real fuera de production no arranca', () => {
  for (const environment of ENVIRONMENTS.filter((e) => e !== 'production')) {
    const input = { ...safe(environment), config: config({ mode: 'live' }), secrets: { ...NO_SECRETS, ...KEYS } };
    assert.match(problems(input), /el modo live no está permitido en el entorno/, environment);
  }
});

test('cada entorno solo admite sus modos', () => {
  const cases: [Environment, Record<string, unknown>, string][] = [
    ['production', { mode: 'paper' }, 'paper'],
    ['production', { mode: 'shadow' }, 'shadow'],
    ['production', { mode: 'live', exchange: { sandbox: true } }, 'testnet'],
    ['test', { mode: 'live', exchange: { sandbox: true } }, 'testnet'],
    ['paper', { mode: 'shadow' }, 'shadow'],
    ['shadow', { mode: 'paper' }, 'paper'],
  ];
  for (const [environment, over, mode] of cases) {
    const input = { ...safe(environment), config: config(over), secrets: { ...LIVE, liveRequested: environment === 'production', liveConfirmed: environment === 'production' } };
    assert.match(problems(input), new RegExp(`el modo ${mode} no está permitido en el entorno ${environment}`));
  }
});

test('production sin la confirmación de una persona no arranca', () => {
  for (const secrets of [{ ...LIVE, liveConfirmed: false }, { ...LIVE, liveConfirmed: false, liveRequested: false }]) {
    assert.match(problems({ ...safe('production'), secrets }), /Para operar con dinero real/);
  }
});

test('sin claves no arrancan live, testnet ni shadow', () => {
  assert.match(problems({ ...safe('production'), secrets: { ...LIVE, apiKey: undefined } }), /Modo live sin EXCHANGE_API_KEY/);
  assert.match(problems({ ...safe('production'), secrets: { ...LIVE, apiSecret: undefined } }), /Modo live sin EXCHANGE_API_KEY/);
  assert.match(problems({ ...safe('shadow'), secrets: NO_SECRETS }), /Modo shadow sin EXCHANGE_API_KEY/);
  assert.match(problems({ ...safe('development'), config: config({ mode: 'live', exchange: { sandbox: true } }) }), /Modo testnet sin/);
});

test('el apalancamiento activado no arranca, en ningún entorno', () => {
  for (const environment of ENVIRONMENTS) {
    const base = safe(environment);
    for (const leverage of [2, 3, 10, 0.5, 0]) {
      const input = { ...base, config: config({ mode: base.config.mode, exchange: { leverage } }) };
      assert.match(problems(input), /apalancamiento activado: exchange\.leverage/, `${environment} ${leverage}`);
    }
    const margin = { ...base, config: config({ mode: base.config.mode, exchange: { margin: true } }) };
    assert.match(problems(margin), /apalancamiento activado: exchange\.margin/, environment);
    for (const marketType of ['future', 'swap', 'margin', 'option', 'SPOT']) {
      const input = { ...base, config: config({ mode: base.config.mode, exchange: { marketType } }) };
      assert.match(problems(input), /solo spot: exchange\.marketType/, `${environment} ${marketType}`);
    }
  }
});

test('el capital cap ausente no arranca, en ningún entorno', () => {
  for (const environment of ENVIRONMENTS) {
    const base = safe(environment);
    const input = { ...base, config: parseConfig({ mode: base.config.mode, capital: { startingQuote: 500 } }) };
    assert.match(problems(input), /capital cap ausente/, environment);
  }
  assert.match(problems({ ...safe('paper'), config: loadConfig(join(ROOT, 'no-existe.json')) }), /capital cap ausente/);
});

test('un capital cap superior al máximo, no positivo o menor que el capital inicial no arranca', () => {
  for (const environment of ENVIRONMENTS) {
    const mode = safe(environment).config.mode;
    for (const capQuote of [MAX_CAPITAL_CAP_QUOTE + 0.01, MAX_CAPITAL_CAP_QUOTE * 2, 1e9]) {
      const input = { ...safe(environment), config: config({ mode, capital: { startingQuote: 500, capQuote } }) };
      assert.match(problems(input), /supera el máximo permitido/, `${environment} ${capQuote}`);
    }
    for (const capQuote of [0, -100]) {
      const input = { ...safe(environment), config: config({ mode, capital: { startingQuote: 500, capQuote } }) };
      assert.match(problems(input), /capital\.capQuote debe ser positivo/, `${environment} ${capQuote}`);
    }
    const above = { ...safe(environment), config: config({ mode, capital: { startingQuote: 800, capQuote: 500 } }) };
    assert.match(problems(above), /capital\.startingQuote \(800\) supera capital\.capQuote \(500\)/, environment);
  }
  const atMax = { ...safe('production'), config: config({ mode: 'live', capital: { startingQuote: 500, capQuote: MAX_CAPITAL_CAP_QUOTE } }) };
  assert.deepEqual(startupProblems(atMax), []);
});

test('una clave con permiso de retiro detectado no arranca, en ningún entorno', () => {
  for (const environment of ENVIRONMENTS) {
    const input = { ...safe(environment), keyPermissions: { ...CLEAN_KEY, fundsOut: true } };
    assert.match(problems(input), /la clave del exchange tiene permiso de retiro/, environment);
  }
});

test('una clave con transferencias, margen, futuros o sin restricción de IP no arranca en production', () => {
  const cases: [Partial<KeyPermissions>, RegExp][] = [
    [{ fundsBetweenAccounts: true }, /permiso de transferencia/],
    [{ margin: true }, /permiso de margen/],
    [{ futures: true }, /permiso de futuros/],
    [{ ipRestricted: false }, /no tiene restricción de IP/],
  ];
  for (const [change, expected] of cases) {
    assert.match(problems({ ...safe('production'), keyPermissions: { ...CLEAN_KEY, ...change } }), expected);
  }
});

test('sin poder leer los permisos de la clave, shadow y production no arrancan', () => {
  for (const environment of ['shadow', 'production'] as const) {
    assert.match(problems({ ...safe(environment), keyPermissions: undefined }), /no se han podido comprobar los permisos/, environment);
  }
});

test('assertSafeStartup lanza CONFIG_INVALID con todos los problemas juntos', () => {
  const input = { ...safe('paper'), config: config({ mode: 'live', exchange: { leverage: 5 } }), secrets: { ...NO_SECRETS, liveRequested: true } };
  assert.throws(
    () => assertSafeStartup(input),
    (e: Error & { code?: string }) =>
      e.code === 'CONFIG_INVALID' && ['LIVE_TRADING activado', 'el modo live', 'apalancamiento activado', 'Modo live sin'].every((t) => e.message.includes(t)),
  );
  assert.doesNotThrow(() => assertSafeStartup(safe('paper')));
});

test('entorno ambiguo: sin declarar, con un valor que no es exacto o con declaraciones que se contradicen', () => {
  const ambiguous: [Record<string, string | undefined>, Environment | undefined][] = [
    [{}, undefined],
    [{ APP_ENV: '' }, undefined],
    [{ APP_ENV: 'Production' }, undefined],
    [{ APP_ENV: ' paper' }, undefined],
    [{ APP_ENV: 'prod' }, undefined],
    [{ APP_ENV: 'live' }, undefined],
    [{ APP_ENV: 'paper' }, 'production'],
    [{ APP_ENV: 'production' }, 'shadow'],
    [{ APP_ENV: 'paper', NODE_ENV: 'production' }, undefined],
    [{ APP_ENV: 'production', NODE_ENV: 'development' }, undefined],
    [{ NODE_ENV: 'test' }, 'paper'],
  ];
  for (const [env, declared] of ambiguous) {
    assert.throws(() => resolveEnvironment(env, declared), /CONFIG_INVALID: entorno ambiguo/, JSON.stringify({ env, declared }));
  }
});

test('el entorno sale de APP_ENV o de config.json, y vale si coinciden', () => {
  assert.equal(resolveEnvironment({ APP_ENV: 'shadow' }), 'shadow');
  assert.equal(resolveEnvironment({}, 'paper'), 'paper');
  assert.equal(resolveEnvironment({ APP_ENV: 'production' }, 'production'), 'production');
  assert.equal(resolveEnvironment({ APP_ENV: 'production', NODE_ENV: 'production' }), 'production');
  assert.equal(resolveEnvironment({ APP_ENV: 'test', NODE_ENV: 'test' }), 'test');
  assert.equal(resolveEnvironment({ APP_ENV: 'development', NODE_ENV: 'development' }), 'development');
  assert.throws(() => parseConfig({ environment: 'staging' }), /config\.environment debe ser uno de/);
});
