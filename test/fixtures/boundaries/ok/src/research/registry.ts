import { regime } from '../analytics/regime.ts';
import { approvedAt } from '../registry/strategies.ts';

export const experimentLine = (prices: number[]): string => `${regime(prices)}@${approvedAt()}`;
