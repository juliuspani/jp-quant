import { publish } from '../kernel/bus.ts';
import { verify } from '../risk/approval.ts';

export const placeOrder = (): string => `${publish()}:${String(verify('firma:orden'))}`;
