// Token de aprobación de trading-risk §2.2: forma, serialización canónica y verificación. Es lo único de risk/ que
// importa Execution (ARCHITECTURE.md §15.1). El tipo marcado ApprovedOrder solo sale de verifyApproval, tras
// comprobar la firma: fuera de aquí no se puede construir uno (trading-risk §2.3). La reutilización y la coincidencia
// con la orden las comprueba Execution.
import { verify as verifySignature, type KeyObject } from 'node:crypto';
import type { OrderType, SignedApproval } from '../kernel/orders.ts';
import { Decimal } from '../shared/decimal.ts';
import { addMs, toUtcIso, type UtcMillis } from '../shared/time.ts';

export type { SignedApproval };
export type UnsignedApproval = Omit<SignedApproval, 'signature'>;

/** Validez máxima de un token (trading-risk §2.2). */
export const MAX_APPROVAL_TTL_MS = 10_000;

declare const verified: unique symbol; // no se exporta
export type ApprovedOrder = SignedApproval & { readonly [verified]: true };
export type ApprovalCheck =
  | { readonly ok: true; readonly order: ApprovedOrder }
  | { readonly ok: false; readonly reasonCode: 'APPROVAL_MISSING' | 'APPROVAL_BAD_SIGNATURE' | 'APPROVAL_EXPIRED' };

const FIELDS: readonly (keyof SignedApproval)[] = [
  'approval_id', 'config_hash', 'expires_at', 'intent_id', 'issued_at', 'max_notional', 'max_quantity', 'reduce_only',
  'side', 'signature', 'symbol', 'trigger_price', 'type',
];
// Lo que Risk aprueba hoy: órdenes a mercado y stops de protección a mercado (paso 23). Límite y stop-limit, paso 36.
const ORDER_TYPES: readonly OrderType[] = ['market', 'stop_market'];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ED25519_BASE64URL = /^[A-Za-z0-9_-]{86}$/; // 64 bytes sin relleno

/** JSON canónico de los campos firmados: claves ordenadas, sin espacios. El token solo lleva valores planos. */
export function approvalPayload(approval: UnsignedApproval): string {
  const fields = FIELDS.filter((key) => key !== 'signature');
  return `{${fields.map((key) => `${JSON.stringify(key)}:${JSON.stringify(approval[key as keyof UnsignedApproval])}`).join(',')}}`;
}

function isInstant(value: unknown): value is UtcMillis {
  if (typeof value !== 'number') return false;
  try {
    toUtcIso(value);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function isPositiveCanonical(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = Decimal.parse(value);
    return parsed.isPositive() && parsed.toString() === value;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** La forma exacta que firma el Risk Engine, o null. Un token con otra forma no se pudo firmar aquí. */
export function parseApproval(value: unknown): SignedApproval | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== FIELDS.length || keys.some((key, i) => key !== FIELDS[i])) return null;
  const a = value as Record<string, unknown>;
  const ok =
    typeof a.approval_id === 'string' && UUID.test(a.approval_id) &&
    typeof a.intent_id === 'string' && a.intent_id !== '' &&
    typeof a.symbol === 'string' && a.symbol !== '' &&
    (a.side === 'buy' || a.side === 'sell') &&
    typeof a.type === 'string' && (ORDER_TYPES as readonly string[]).includes(a.type) &&
    isPositiveCanonical(a.max_quantity) &&
    // En spot una compra abre y lleva tope de importe; una venta solo reduce.
    (a.side === 'buy' ? isPositiveCanonical(a.max_notional) && a.reduce_only === false : a.max_notional === null && a.reduce_only === true) &&
    // Un stop de protección es una venta con precio de disparo; una orden a mercado no lleva ninguno.
    (a.type === 'stop_market' ? a.side === 'sell' && isPositiveCanonical(a.trigger_price) : a.trigger_price === null) &&
    isInstant(a.issued_at) && isInstant(a.expires_at) &&
    a.expires_at > a.issued_at && a.expires_at <= addMs(a.issued_at, MAX_APPROVAL_TTL_MS) &&
    typeof a.config_hash === 'string' && SHA256_HEX.test(a.config_hash) &&
    typeof a.signature === 'string' && ED25519_BASE64URL.test(a.signature);
  if (!ok) return null;
  return Object.freeze(Object.fromEntries(FIELDS.map((key) => [key, a[key]]))) as unknown as SignedApproval;
}

/**
 * Comprobaciones 1 a 3 de trading-risk §2.2, en su orden: hay token, la firma es válida y no ha caducado. Un token
 * con forma distinta de la firmada cuenta como firma inválida. Devuelve una copia congelada: lo que se verificó es lo
 * que se envía.
 */
export function verifyApproval(approval: unknown, publicKey: KeyObject, now: UtcMillis): ApprovalCheck {
  if (approval === null || approval === undefined) return { ok: false, reasonCode: 'APPROVAL_MISSING' };
  const parsed = parseApproval(approval);
  if (parsed === null) return { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' };
  const payload = Buffer.from(approvalPayload(parsed), 'utf8');
  if (!verifySignature(null, payload, publicKey, Buffer.from(parsed.signature, 'base64url'))) {
    return { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' };
  }
  if (now < parsed.issued_at || now > parsed.expires_at) return { ok: false, reasonCode: 'APPROVAL_EXPIRED' };
  return { ok: true, order: parsed as ApprovedOrder };
}
