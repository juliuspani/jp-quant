// Lo ejecuta la persona, nunca Claude (ADR 0020, decisión 8): crea el par Ed25519 que firma la apertura del test
// final. La clave privada se escribe fuera del repositorio, con permisos de solo dueño y sin sobrescribir nada; la
// pública se muestra para copiarla en el campo unlockPublicKey del candado.
//   node scripts/test-final-keygen.ts <ruta de la clave privada, fuera del repositorio>
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { publicKeyBase64 } from '../src/historical/unlock.ts';

const REPO = resolve(import.meta.dirname, '..');
const [out] = process.argv.slice(2);
if (out === undefined) {
  process.stderr.write('uso: node scripts/test-final-keygen.ts <ruta de la clave privada, fuera del repositorio>\n');
  process.exit(1);
}
const rel = relative(REPO, resolve(out));
if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
  process.stderr.write('la clave privada no puede quedar dentro del repositorio\n');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(resolve(out), privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
process.stdout.write(`clave privada escrita en ${resolve(out)}\nunlockPublicKey: ${publicKeyBase64(publicKey)}\n`);
