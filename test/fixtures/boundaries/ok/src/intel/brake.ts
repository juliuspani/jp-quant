import { publish } from '../kernel/bus.ts';

export const brake = (): string => publish();
