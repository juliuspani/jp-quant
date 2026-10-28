// Firmante de aprobaciones (trading-risk §2.2). El par Ed25519 se genera en memoria al crear el firmante y la clave
// privada vive solo en este cierre: no se guarda, no se exporta y cambia en cada arranque, así que los tokens de
// antes de un reinicio dejan de valer. Solo lo importa src/risk/ (regla solo-risk-usa-el-firmante).
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { approvalPayload, type SignedApproval, type UnsignedApproval } from './approval.ts';

export interface ApprovalSigner {
  readonly publicKey: KeyObject; // se entrega a Execution (y al capguard) al componer
  sign(approval: UnsignedApproval): SignedApproval;
}

export function createApprovalSigner(): ApprovalSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    publicKey,
    sign(approval: UnsignedApproval): SignedApproval {
      const signature = sign(null, Buffer.from(approvalPayload(approval), 'utf8'), privateKey).toString('base64url');
      return Object.freeze({ ...approval, signature });
    },
  });
}
