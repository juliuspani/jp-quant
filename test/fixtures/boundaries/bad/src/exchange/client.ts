import type { Exchange } from 'ccxt';

export type Client = Exchange;
export const clientName = (): string => 'cliente';
