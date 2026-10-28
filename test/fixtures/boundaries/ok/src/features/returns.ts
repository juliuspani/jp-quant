export const lastReturn = (prices: number[]): number => (prices.at(-1) ?? 0) - (prices.at(-2) ?? 0);
