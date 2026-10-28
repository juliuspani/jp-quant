// Lo ejecuta la persona, nunca Claude (ADR 0020, decisión 8): firma un token de apertura de una etapa del test final
// para el candado tal como está ahora. Si el candado cambia, el token deja de valer. Validez por defecto, 1 hora;
// máximo, 24. El token se muestra para exportarlo en la variable de apertura solo durante esa ejecución.
//   node scripts/test-final-sign.ts <clave privada> <ruta del candado> <etapa> [horas]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { signUnlock, UNLOCK_PURPOSE } from '../src/historical/unlock.ts';

const [keyPath, lockPath, stageText, hoursText = '1'] = process.argv.slice(2);
if (keyPath === undefined || lockPath === undefined || stageText === undefined) {
  process.stderr.write('uso: node scripts/test-final-sign.ts <clave privada> <ruta del candado> <etapa> [horas]\n');
  process.exit(1);
}
const stage = Number(stageText);
const hours = Number(hoursText);
if (!Number.isInteger(stage) || stage < 1 || !Number.isInteger(hours) || hours < 1 || hours > 24) {
  process.stderr.write('la etapa es un entero positivo y las horas, un entero de 1 a 24\n');
  process.exit(1);
}

const issued = new Date();
const token = signUnlock(
  {
    purpose: UNLOCK_PURPOSE,
    stage,
    lockSha256: createHash('sha256').update(readFileSync(lockPath)).digest('hex'),
    issuedAtUtc: issued.toISOString(),
    expiresAtUtc: new Date(issued.getTime() + hours * 3_600_000).toISOString(),
  },
  readFileSync(keyPath, 'utf8'),
);
process.stdout.write(`${token}\n`);
