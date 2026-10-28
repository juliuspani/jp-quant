// loadSecrets (src/config/secrets.ts): en production solo lee del gestor de secretos y no arranca con un archivo
// de secretos en disco ni con claves en variables de entorno. Fuera de production lee el archivo sin tocar
// process.env. Todos los archivos son temporales y los valores, inventados.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SECRET_NAMES, loadSecrets } from '../../../src/config.ts';
import { redact } from '../../../src/log.ts';

const DIR = mkdtempSync(join(tmpdir(), 'inversor-secrets-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** Carpeta de trabajo vacía y su ruta de archivo de secretos, que no existe salvo que la prueba lo cree. */
function workdir(): { cwd: string; envFile: string } {
  const cwd = mkdtempSync(join(DIR, 'cwd-'));
  return { cwd, envFile: join(cwd, '.env') };
}

function credentials(files: Record<string, string>): string {
  const dir = mkdtempSync(join(DIR, 'credenciales-'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value);
  return dir;
}

test('en production lee las claves del gestor de secretos y las tacha de los logs', () => {
  const { envFile } = workdir();
  const dir = credentials({ EXCHANGE_API_KEY: 'clave del gestor 1\n', EXCHANGE_API_SECRET: 'secreto del gestor 1' });
  const s = loadSecrets({ environment: 'production', env: { CREDENTIALS_DIRECTORY: dir, LIVE_TRADING: 'SI_ENTIENDO_EL_RIESGO' }, envFile });
  assert.equal(s.apiKey, 'clave del gestor 1');
  assert.equal(s.apiSecret, 'secreto del gestor 1');
  assert.equal(s.telegramToken, undefined);
  assert.equal(s.liveConfirmed, true);
  assert.equal(redact('fallo con clave del gestor 1'), 'fallo con ***');
});

test('en production un archivo de secretos en disco impide arrancar', () => {
  for (const name of ['.env', '.env.local', '.env.production']) {
    const { cwd, envFile } = workdir();
    writeFileSync(join(cwd, name), 'EXCHANGE_API_KEY=valor-falso\n');
    const dir = credentials({ EXCHANGE_API_KEY: 'clave del gestor 2', EXCHANGE_API_SECRET: 'secreto del gestor 2' });
    assert.throws(
      () => loadSecrets({ environment: 'production', env: { CREDENTIALS_DIRECTORY: dir }, envFile }),
      /CONFIG_INVALID: en production los secretos no se leen de un \.env en disco/,
      name,
    );
  }
});

test('en production .env.example, que solo lleva nombres, no impide arrancar', () => {
  const { cwd, envFile } = workdir();
  writeFileSync(join(cwd, '.env.example'), 'EXCHANGE_API_KEY=\n');
  const dir = credentials({ EXCHANGE_API_KEY: 'clave del gestor 3', EXCHANGE_API_SECRET: 'secreto del gestor 3' });
  assert.equal(loadSecrets({ environment: 'production', env: { CREDENTIALS_DIRECTORY: dir }, envFile }).apiKey, 'clave del gestor 3');
});

test('en production una clave en una variable de entorno impide arrancar', () => {
  for (const name of Object.values(SECRET_NAMES)) {
    const { envFile } = workdir();
    const env = { CREDENTIALS_DIRECTORY: credentials({}), [name]: 'valor-falso' };
    assert.throws(() => loadSecrets({ environment: 'production', env, envFile }), new RegExp(`${name} no puede venir de una variable de entorno`));
  }
});

test('en production sin gestor de secretos no se arranca', () => {
  const { envFile } = workdir();
  for (const dir of [undefined, '', 'credenciales', join(DIR, 'no-existe'), envFile]) {
    const env = dir === undefined ? {} : { CREDENTIALS_DIRECTORY: dir };
    assert.throws(() => loadSecrets({ environment: 'production', env, envFile }), /falta el gestor de secretos/, String(dir));
  }
});

test('fuera de production lee el archivo sin tocar process.env, y el entorno manda sobre él', () => {
  const { cwd, envFile } = workdir();
  writeFileSync(join(cwd, '.env'), 'EXCHANGE_API_KEY=clave del archivo\nTELEGRAM_CHAT_ID=chat del archivo\n');
  const s = loadSecrets({ environment: 'shadow', env: { TELEGRAM_CHAT_ID: 'chat del entorno' }, envFile });
  assert.equal(s.apiKey, 'clave del archivo');
  assert.equal(s.telegramChatId, 'chat del entorno');
  assert.equal(process.env['EXCHANGE_API_KEY'] === 'clave del archivo', false, 'el archivo se volcó en process.env');
});

test('el archivo de secretos no puede declarar el entorno', () => {
  const { cwd, envFile } = workdir();
  writeFileSync(join(cwd, '.env'), 'APP_ENV=production\n');
  assert.throws(() => loadSecrets({ environment: 'development', env: {}, envFile }), /entorno ambiguo: .* no puede declarar APP_ENV/);
});

test('LIVE_TRADING pide operar en real con cualquier valor salvo vacío o false', () => {
  const { envFile } = workdir();
  const requested = (value: string | undefined) =>
    loadSecrets({ environment: 'paper', env: value === undefined ? {} : { LIVE_TRADING: value }, envFile }).liveRequested;
  for (const value of [undefined, '', '  ', 'false']) assert.equal(requested(value), false, String(value));
  for (const value of ['true', '1', 'TRUE', 'False', 'yes', 'SI_ENTIENDO_EL_RIESGO']) assert.equal(requested(value), true, value);
});
