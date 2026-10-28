// Máquina de estados (exchange-execution §4.2) y client order ID (§5.1). Se recorre la matriz completa: lo que no está
// permitido falla.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seededUuids } from '../../../src/kernel/random.ts';
import type { OrderState, TransitionOrigin } from '../../../src/kernel/execution.ts';
import { clientOrderIdFor } from '../../../src/execution/client-order-id.ts';
import { assertTransition, canTransition, InvalidTransitionError, isTerminal } from '../../../src/execution/state-machine.ts';

const STATES: OrderState[] = [
  'PENDING_SEND', 'SENT', 'OPEN', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT', 'UNKNOWN',
];
const ORIGINS: TransitionOrigin[] = ['rest', 'ws', 'reconciliation', 'internal'];

// Lo que permite exchange-execution §4.2, más la entrada en UNKNOWN de cualquier estado vivo (un evento imposible lleva
// a UNKNOWN) y la salida de UNKNOWN solo desde la reconciliación hacia un estado que el exchange puede confirmar.
const ALLOWED = new Set([
  'PENDING_SEND>SENT', 'PENDING_SEND>UNKNOWN',
  'SENT>OPEN', 'SENT>PARTIALLY_FILLED', 'SENT>FILLED', 'SENT>EXPIRED', 'SENT>REJECTED', 'SENT>UNKNOWN',
  'OPEN>PARTIALLY_FILLED', 'OPEN>FILLED', 'OPEN>CANCEL_PENDING', 'OPEN>CANCELED', 'OPEN>EXPIRED', 'OPEN>UNKNOWN',
  'PARTIALLY_FILLED>PARTIALLY_FILLED', 'PARTIALLY_FILLED>FILLED', 'PARTIALLY_FILLED>CANCEL_PENDING', 'PARTIALLY_FILLED>CANCELED',
  'PARTIALLY_FILLED>EXPIRED', 'PARTIALLY_FILLED>UNKNOWN',
  'CANCEL_PENDING>CANCELED', 'CANCEL_PENDING>FILLED', 'CANCEL_PENDING>EXPIRED', 'CANCEL_PENDING>UNKNOWN',
]);
const FROM_UNKNOWN = new Set(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT']);

test('las transiciones inválidas fallan: la matriz completa de estados y orígenes', () => {
  let allowed = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      for (const origin of ORIGINS) {
        const expected = from === 'UNKNOWN' ? origin === 'reconciliation' && FROM_UNKNOWN.has(to) : ALLOWED.has(`${from}>${to}`);
        assert.equal(canTransition(from, to, origin), expected, `${from} → ${to} (${origin})`);
        if (expected) {
          allowed += 1;
          assert.doesNotThrow(() => assertTransition(from, to, origin));
        } else {
          assert.throws(() => assertTransition(from, to, origin), InvalidTransitionError, `${from} → ${to} (${origin})`);
        }
      }
    }
  }
  assert.ok(allowed > 0);
});

test('una orden terminal no cambia nunca y de UNKNOWN solo se sale reconciliando', () => {
  for (const terminal of ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT'] as const) {
    assert.ok(isTerminal(terminal));
    for (const to of STATES) assert.equal(canTransition(terminal, to, 'reconciliation'), false, `${terminal} → ${to}`);
  }
  for (const live of ['PENDING_SEND', 'SENT', 'OPEN', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'UNKNOWN'] as const) assert.equal(isTerminal(live), false);
  assert.throws(() => assertTransition('UNKNOWN', 'FILLED', 'ws'), InvalidTransitionError);
  assert.throws(() => assertTransition('UNKNOWN', 'SENT', 'reconciliation'), InvalidTransitionError, 'SENT no lo confirma el exchange');
  assert.throws(() => assertTransition('FILLED', 'OPEN', 'rest'), /FILLED → OPEN/);
});

test('client order ID: ijp- y el approval_id en base64url, único, estable y dentro del formato del exchange', () => {
  assert.equal(clientOrderIdFor('0f8fad5b-d9cb-469f-a165-70867728950e'), 'ijp-D4-tW9nLRp-hZXCGdyiVDg');
  const ids = seededUuids(1, 'coid');
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const id = clientOrderIdFor(ids.next());
    assert.match(id, /^ijp-[A-Za-z0-9_-]{22}$/);
    assert.ok(id.length <= 36);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
  for (const bad of ['', 'no-uuid', '0F8FAD5B-D9CB-469F-A165-70867728950E', '0f8fad5bd9cb469fa16570867728950e']) {
    assert.throws(() => clientOrderIdFor(bad), RangeError, bad);
  }
});
