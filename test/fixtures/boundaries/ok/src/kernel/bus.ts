import { now } from '../shared/time.ts';

export const publish = (): string => `evento@${now()}`;
