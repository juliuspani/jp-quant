import { loadRisk } from '../config/load.ts';
import { clientName } from '../exchange/client.ts';
import { placeOrder } from '../execution/orders.ts';
import { open } from '../persistence/db.ts';

export const compose = (): string => `${loadRisk()}:${placeOrder()}:${clientName()}:${typeof open}`;
