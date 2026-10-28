import { lastReturn } from '../features/returns.ts';

export const wantsToBuy = (prices: number[]): boolean => lastReturn(prices) > 0;
