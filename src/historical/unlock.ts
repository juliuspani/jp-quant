// Token de apertura del test final firmado por la persona (ADR 0020, decisión 7): `v1.<payload>.<firma>` en
// base64url, con Ed25519. El repositorio solo guarda la clave pública; la privada no sale de la máquina de la persona.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { IsoUtc } from './store.ts';

export const UNLOCK_PURPOSE = 'inversor-jp-test-final-unlock';

const PayloadSchema = z
  .object({
    purpose: z.literal(UNLOCK_PURPOSE),
    stage: z.number().int().positive(),
    lockSha256: z.string().regex(/^[0-9a-f]{64}$/),
    issuedAtUtc: IsoUtc,
    expiresAtUtc: IsoUtc,
  })
  .strict();

export type UnlockPayload = z.infer<typeof PayloadSchema>;

export class InvalidUnlockError extends Error {
  override readonly name = 'InvalidUnlockError';
}

/** Clave pública en el formato del candado: SPKI DER en base64. */
export function publicKeyBase64(key: KeyObject): string {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  return pub.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function signUnlock(payload: UnlockPayload, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new InvalidUnlockError('la clave privada no es Ed25519');
  const body = Buffer.from(JSON.stringify(PayloadSchema.parse(payload)), 'utf8');
  return `v1.${body.toString('base64url')}.${sign(null, body, key).toString('base64url')}`;
}

/** Comprueba la firma con la clave pública del candado y devuelve el payload. Cualquier fallo lanza. */
export function verifyUnlock(token: string, publicKey: string): UnlockPayload {
  const [version, body, signature, ...rest] = token.split('.');
  if (version !== 'v1' || body === undefined || signature === undefined || rest.length > 0) {
    throw new InvalidUnlockError('el token no tiene la forma v1.<payload>.<firma>');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  } catch (e) {
    throw new InvalidUnlockError(`clave pública del candado ilegible: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new InvalidUnlockError('la clave pública del candado no es Ed25519');
  const bytes = Buffer.from(body, 'base64url');
  if (!verify(null, bytes, key, Buffer.from(signature, 'base64url'))) throw new InvalidUnlockError('firma inválida');
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InvalidUnlockError('payload firmado ilegible');
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) throw new InvalidUnlockError(`payload inválido: ${parsed.error.message}`);
  return parsed.data;
}
