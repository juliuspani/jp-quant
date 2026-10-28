import { regime } from '../analytics/regime.ts';

export const dailySummary = (prices: number[]): string => `régimen ${regime(prices)}`;
