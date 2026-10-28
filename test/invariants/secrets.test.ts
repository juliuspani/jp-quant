// INV-10 (SECURITY_AND_TRADING_INVARIANTS.md): los secretos no entran en Git. Los archivos que los guardan se
// ignoran, ninguno está versionado y el pre-commit escanea lo que se va a confirmar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { git, read, repoFiles } from './repo.ts';

const SECRET_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  'sub/.env',
  'clave.pem',
  'clave.key',
  'cert.p12',
  'id_ed25519',
  'id_rsa.pub',
  'secrets/exchange.json',
  'credentials/x.json',
  '.ssh/config',
  'data/live.db',
  'bot.sqlite',
  'logs/bot.log',
];

// Claves y certificados, y también los datos y registros del bot: pueden llevar saldos, órdenes o un secreto
// que se escapó a un mensaje.
const SECRET_NAME =
  /(^|\/)\.env(?!\.example$)(\.[^/]*)?$|\.(pem|key|p12|pfx|jks|keystore|db|sqlite3?|log)$|(^|\/)id_(rsa|ed25519)|(^|\/)\.?(secrets|credentials|ssh|aws|data|logs)\//;

test('INV-10a: .gitignore ignora los archivos de secretos y deja versionar .env.example', () => {
  for (const f of SECRET_FILES) {
    assert.equal(git(['check-ignore', '-q', '--no-index', f]).status, 0, `${f} no se ignora`);
  }
  assert.equal(git(['check-ignore', '-q', '--no-index', '.env.example']).status, 1, '.env.example debe poder versionarse');
});

test('INV-10b: no hay archivos de secretos en el repositorio', () => {
  for (const f of SECRET_FILES) assert.match(f, SECRET_NAME, `el patrón no reconoce ${f}`);
  const files = repoFiles();
  assert.ok(files.includes('package.json'), 'la lista de archivos está vacía: la prueba no comprobaría nada');
  assert.deepEqual(files.filter((f) => SECRET_NAME.test(f)), []);
});

test('INV-10g: el pre-commit escanea los secretos antes de nada, también en ramas wip/*', () => {
  const hook = read('.githooks/pre-commit');
  const scan = hook.indexOf('node scripts/scan-secrets.ts --staged');
  assert.ok(scan >= 0, 'el pre-commit no escanea secretos');
  assert.ok(hook.includes('set -e'), 'sin set -e un hallazgo no pararía el commit');
  assert.ok(scan < hook.indexOf('case "$branch"'), 'el escaneo debe ir antes de la excepción de ramas wip/*');
  const prepare = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['prepare'] ?? '';
  assert.match(prepare, /core\.hooksPath \.githooks/);
});
