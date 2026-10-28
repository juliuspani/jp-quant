// INV-01 y INV-10 (SECURITY_AND_TRADING_INVARIANTS.md): el modo real está apagado por defecto, el bot no arranca
// en real sin la confirmación de una persona y, al negarse, no escribe sus claves en la salida.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LIVE_CONFIRMATION, loadConfig, loadSecrets } from '../../src/config.ts';
import { ROOT, read, repoFiles } from './repo.ts';

const DIR = mkdtempSync(join(tmpdir(), 'inversor-inv-live-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const VAR = 'LIVE_TRADING';
const FAKE_KEY = 'clave-falsa-de-prueba-inv01c';
const FAKE_SECRET = 'secreto-falso-de-prueba-inv01c';

function confirmedWith(value: string | undefined): boolean {
  const env = value === undefined ? {} : { [VAR]: value };
  return loadSecrets({ environment: 'development', env, envFile: join(DIR, 'no-existe.txt') }).liveConfirmed;
}

/** Carpeta de credenciales del gestor de secretos (systemd) con las claves falsas, o vacía. */
function credentials(withKeys: boolean): string {
  const dir = mkdtempSync(join(DIR, 'credenciales-'));
  if (withKeys) {
    writeFileSync(join(dir, 'EXCHANGE_API_KEY'), FAKE_KEY);
    writeFileSync(join(dir, 'EXCHANGE_API_SECRET'), FAKE_SECRET);
  }
  return dir;
}

/**
 * Arranca src/main.ts en production, en una carpeta temporal, sin .env y sin las variables del bot del entorno
 * de quien ejecuta las pruebas. Los casos que se prueban se detienen antes de cualquier conexión.
 */
function startBot(env: Record<string, string>): { status: number | null; output: string; created: boolean } {
  const cwd = mkdtempSync(join(DIR, 'bot-'));
  writeFileSync(join(cwd, 'config.json'), JSON.stringify({ mode: 'live', exchange: { id: 'binance', sandbox: false } }));
  const inherited = Object.entries(process.env).filter(
    ([k]) => !/^(EXCHANGE_|LIVE_|TELEGRAM_|DASHBOARD_|ANTHROPIC_|HEALTHCHECK_|APP_ENV$|NODE_ENV$|CREDENTIALS_DIRECTORY$)/i.test(k),
  );
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'main.ts')], {
    cwd,
    env: { ...Object.fromEntries(inherited), APP_ENV: 'production', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}`, created: existsSync(join(cwd, 'data')) };
}

test('INV-01a: sin la frase exacta en LIVE_TRADING no hay confirmación', () => {
  const near = [undefined, '', 'true', 'TRUE', '1', 'yes', 'si', LIVE_CONFIRMATION.toLowerCase(), `${LIVE_CONFIRMATION}!`];
  for (const value of near) assert.equal(confirmedWith(value), false, `confirma con ${String(value)}`);
  assert.equal(confirmedWith(LIVE_CONFIRMATION), true);
});

test('INV-01b: la configuración por defecto y la versionada son de papel', () => {
  assert.equal(loadConfig(join(DIR, 'no-existe.json')).mode, 'paper');
  assert.equal(loadConfig(join(ROOT, 'config.json')).mode, 'paper');
});

test('INV-01c: el bot no arranca en real sin la confirmación, aunque tenga claves', () => {
  for (const value of [undefined, 'true']) {
    const env = { CREDENTIALS_DIRECTORY: credentials(true), ...(value === undefined ? {} : { [VAR]: value }) };
    const r = startBot(env);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /Para operar con dinero real/);
    assert.equal(r.created, false, 'se detuvo después de crear su carpeta de datos');
  }
});

test('INV-01c: el bot no arranca en real sin claves', () => {
  const r = startBot({ CREDENTIALS_DIRECTORY: credentials(false) });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Modo live sin EXCHANGE_API_KEY/);
  assert.equal(r.created, false);
});

test('INV-01d: ningún archivo de configuración o de arranque trae la confirmación', () => {
  // Solo la definen src/config/environment.ts y el hook que la bloquea. Las pruebas y la documentación pueden citarla.
  const allowed = new Set(['src/config/environment.ts', 'scripts/claude-guard.ts']);
  const offenders = repoFiles()
    .filter((f) => !allowed.has(f) && !/^(test|docs)\//.test(f) && !f.endsWith('.md'))
    .filter((f) => read(f).includes(LIVE_CONFIRMATION));
  assert.deepEqual(offenders, []);
});

test('INV-10d: al negarse a arrancar, el bot no escribe sus claves en la salida', () => {
  // Con las claves en el gestor de secretos y, mal puestas, en variables de entorno.
  const cases: Record<string, string>[] = [{ CREDENTIALS_DIRECTORY: credentials(true) }, { EXCHANGE_API_KEY: FAKE_KEY, EXCHANGE_API_SECRET: FAKE_SECRET }];
  for (const env of cases) {
    const r = startBot(env);
    assert.equal(r.status, 1, r.output);
    assert.ok(!r.output.includes(FAKE_KEY) && !r.output.includes(FAKE_SECRET), 'una clave aparece en la salida');
  }
});
