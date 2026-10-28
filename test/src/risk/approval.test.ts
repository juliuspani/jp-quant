// Token de aprobación (trading-risk §2.2 y §2.3): firma Ed25519 sobre JSON canónico, verificación en su orden y forma
// exacta. Un token alterado, de otra clave o con otra forma no pasa.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalPayload, parseApproval, verifyApproval, type UnsignedApproval } from '../../../src/risk/approval.ts';
import { createApprovalSigner } from '../../../src/risk/signer.ts';

const T0 = Date.parse('2026-01-05T12:00:00Z');

function unsigned(overrides: Partial<UnsignedApproval> = {}): UnsignedApproval {
  return {
    approval_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    intent_id: 'intent-1',
    symbol: 'BTC/EUR',
    side: 'buy',
    type: 'market',
    max_quantity: '0.0125',
    max_notional: '500',
    trigger_price: null,
    reduce_only: false,
    issued_at: T0,
    expires_at: T0 + 10_000,
    config_hash: 'a'.repeat(64),
    ...overrides,
  };
}

test('un token firmado se verifica y sale congelado, igual a lo firmado', () => {
  const signer = createApprovalSigner();
  const token = signer.sign(unsigned());
  const check = verifyApproval(token, signer.publicKey, T0 + 1);
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.deepEqual({ ...check.order }, { ...token });
  assert.ok(Object.isFrozen(check.order));
  assert.notEqual(check.order, token, 'la copia verificada no es el objeto recibido');
});

test('sin token: APPROVAL_MISSING', () => {
  const signer = createApprovalSigner();
  for (const missing of [null, undefined]) {
    assert.deepEqual(verifyApproval(missing, signer.publicKey, T0), { ok: false, reasonCode: 'APPROVAL_MISSING' });
  }
});

test('un campo alterado o una firma de otra clave: APPROVAL_BAD_SIGNATURE', () => {
  const signer = createApprovalSigner();
  const token = signer.sign(unsigned());
  const bad = { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' };
  for (const change of [{ max_quantity: '1' }, { symbol: 'ETH/EUR' }, { max_notional: '5000' }, { expires_at: T0 + 9_000 }]) {
    assert.deepEqual(verifyApproval({ ...token, ...change }, signer.publicKey, T0), bad, JSON.stringify(change));
  }
  const other = createApprovalSigner();
  assert.deepEqual(verifyApproval(other.sign(unsigned()), signer.publicKey, T0), bad, 'clave de otro firmante');
  assert.deepEqual(verifyApproval(token, other.publicKey, T0), bad, 'verificado con otra clave pública');
});

test('cada arranque genera otro par: un token anterior a un reinicio no vale', () => {
  const before = createApprovalSigner().sign(unsigned());
  const after = createApprovalSigner();
  assert.deepEqual(verifyApproval(before, after.publicKey, T0), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' });
});

test('un token con otra forma cuenta como firma inválida aunque esté firmado', () => {
  const signer = createApprovalSigner();
  const shapes: Partial<UnsignedApproval>[] = [
    { approval_id: 'no-es-un-uuid' },
    { max_quantity: '1.0' }, // no canónico
    { max_quantity: '0' },
    { max_notional: null }, // compra sin tope de importe
    { side: 'sell' }, // venta sin reduce_only y con importe
    { side: 'sell', max_notional: null, reduce_only: false },
    { expires_at: T0 + 10_001 }, // más de 10 s de validez
    { expires_at: T0 },
    { config_hash: 'xyz' },
    { type: 'limit' }, // tipo que Risk aún no aprueba
    { trigger_price: '38000' }, // una orden a mercado no lleva precio de disparo
    { type: 'stop_market' }, // stop sin precio de disparo, y de compra
    { type: 'stop_market', side: 'sell', max_notional: null, reduce_only: true, trigger_price: '38000.0' }, // no canónico
  ];
  for (const shape of shapes) {
    const token = signer.sign(unsigned(shape));
    assert.deepEqual(verifyApproval(token, signer.publicKey, T0), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' }, JSON.stringify(shape));
  }
  const token = signer.sign(unsigned());
  assert.equal(parseApproval({ ...token, extra: 1 }), null, 'campo de más');
  const { config_hash: _dropped, ...withoutHash } = token;
  assert.equal(parseApproval(withoutHash), null, 'campo de menos');
  assert.equal(parseApproval('{}'), null);
});

test('una venta reduce_only se firma sin tope de importe y se verifica, también un stop con su precio de disparo', () => {
  const signer = createApprovalSigner();
  const token = signer.sign(unsigned({ side: 'sell', max_notional: null, reduce_only: true }));
  assert.equal(verifyApproval(token, signer.publicKey, T0).ok, true);
  const stop = signer.sign(unsigned({ side: 'sell', max_notional: null, reduce_only: true, type: 'stop_market', trigger_price: '38000' }));
  assert.equal(verifyApproval(stop, signer.publicKey, T0).ok, true);
  assert.deepEqual(verifyApproval({ ...stop, trigger_price: '30000' }, signer.publicKey, T0), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' }, 'el disparo va firmado');
});

test('caducidad: vale hasta expires_at inclusive; antes de emitirse o después, APPROVAL_EXPIRED', () => {
  const signer = createApprovalSigner();
  const token = signer.sign(unsigned());
  assert.equal(verifyApproval(token, signer.publicKey, T0).ok, true);
  assert.equal(verifyApproval(token, signer.publicKey, T0 + 10_000).ok, true);
  for (const now of [T0 - 1, T0 + 10_001]) {
    assert.deepEqual(verifyApproval(token, signer.publicKey, now), { ok: false, reasonCode: 'APPROVAL_EXPIRED' });
  }
  // La firma se comprueba antes que la caducidad.
  assert.deepEqual(verifyApproval({ ...token, max_quantity: '9' }, signer.publicKey, T0 + 20_000), { ok: false, reasonCode: 'APPROVAL_BAD_SIGNATURE' });
});

test('el JSON canónico no depende del orden en que se construyó el token', () => {
  const a = unsigned();
  const reversed = Object.fromEntries(Object.entries(a).reverse()) as unknown as UnsignedApproval;
  assert.equal(approvalPayload(a), approvalPayload(reversed));
  assert.match(approvalPayload(a), /^\{"approval_id":.*"type":"market"\}$/);
  assert.ok(!approvalPayload(a).includes(' '));
});
