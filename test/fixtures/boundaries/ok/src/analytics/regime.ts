import { lastReturn } from '../features/returns.ts';

export const regime = (prices: number[]): string => (lastReturn(prices) >= 0 ? 'NORMAL' : 'ALTA');
