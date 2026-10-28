// loadConfig superpone config.json sobre los valores por defecto y, ante la duda, no arranca (fail closed).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { SECRET_NAMES, loadConfig, loadSecrets } from '../../src/config.ts';
import { redact } from '../../src/log.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DIR = mkdtempSync(join(tmpdir(), 'inversor-config-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

function load(json: unknown): ReturnType<typeof loadConfig> {
  const path = join(DIR, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(json));
  return loadConfig(path);
}

test('sin config.json se usan los valores por defecto, en papel', () => {
  const cfg = loadConfig(join(DIR, 'no-existe.json'));
  assert.equal(cfg.mode, 'paper');
});

test('el config.json versionado carga', () => {
  assert.equal(loadConfig(join(ROOT, 'config.json')).mode, 'paper');
});

test('superpone solo lo que trae config.json', () => {
  const cfg = load({ core: { timeframe: '1h' } });
  assert.equal(cfg.core.timeframe, '1h');
  assert.equal(cfg.core.strategy.emaSlow, 200);
});

test('una clave desconocida detiene el arranque', () => {
  assert.throws(() => load({ risk: { riskPerTradePtc: 5 } }), /config\.risk\.riskPerTradePtc no es una clave conocida/);
});

test('un valor de otro tipo detiene el arranque', () => {
  assert.throws(() => load({ risk: { maxDrawdownPct: '10' } }), /config\.risk\.maxDrawdownPct debe ser de tipo number/);
  assert.throws(() => load({ risk: 3 }), /config\.risk debe ser un objeto/);
  assert.throws(() => load({ core: { symbols: 'BTC/USDT' } }), /config\.core\.symbols debe ser una lista/);
  assert.throws(() => load({ scout: { exclude: [1] } }), /config\.scout\.exclude\.0 debe ser de tipo string/);
  assert.throws(() => load({ mode: 'real' }), /config\.mode debe ser uno de "paper", "shadow", "live"/);
});

test('informa de todos los errores del archivo a la vez, con el código CONFIG_INVALID', () => {
  assert.throws(
    () => load({ risk: { maxDrawdownPct: '10' }, scout: { stopPtc: 5 } }),
    (e: Error) => /^CONFIG_INVALID: /.test(e.message) && /maxDrawdownPct debe ser de tipo number/.test(e.message) && /scout\.stopPtc no es una clave conocida/.test(e.message),
  );
});

test('los topes de validate siguen aplicándose', () => {
  assert.throws(() => load({ risk: { riskPerTradePct: 5 } }), /riskPerTradePct/);
});

// Un campo nuevo de Secrets que no se registre en el logger hace fallar esta prueba.
test('tacha de los logs todos los secretos que carga', () => {
  const vars = Object.values(SECRET_NAMES);
  assert.equal(vars.length, 8);
  // Valores sin forma de secreto: solo se tachan si loadSecrets los registra.
  const env = Object.fromEntries(vars.map((k) => [k, `valor de prueba ${k.toLowerCase()}`]));
  const secrets = loadSecrets({ environment: 'development', env, envFile: join(DIR, 'no-existe.txt') });
  const values = Object.values(secrets).filter((v): v is string => typeof v === 'string');
  assert.equal(values.length, vars.length);
  for (const v of values) assert.equal(redact(`error con ${v}`), 'error con ***', `no se tacha ${v}`);
});
