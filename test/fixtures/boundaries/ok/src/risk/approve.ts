import { maxExposure } from './limits.ts';
import { sign } from './signer.ts';

export const approve = (notional: number): string | null => (notional <= maxExposure ? sign(String(notional)) : null);
