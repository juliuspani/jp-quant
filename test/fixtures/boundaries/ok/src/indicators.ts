export const sma = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
