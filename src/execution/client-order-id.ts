// Client order ID (exchange-execution §5.1): prefijo `ijp-` y el approval_id en base64url (22 caracteres). Una
// aprobación es de un solo uso, así que da como mucho una orden, y el ID nunca se reutiliza.
import { UUID } from '../risk/approval.ts';

export const CLIENT_ORDER_PREFIX = 'ijp-';

export function clientOrderIdFor(approvalId: string): string {
  if (!UUID.test(approvalId)) throw new RangeError(`el approval_id no es un UUID: ${approvalId}`);
  return `${CLIENT_ORDER_PREFIX}${Buffer.from(approvalId.replaceAll('-', ''), 'hex').toString('base64url')}`;
}
