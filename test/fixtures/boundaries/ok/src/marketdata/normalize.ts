import { publish } from '../kernel/bus.ts';

export const normalize = (): string => publish();
