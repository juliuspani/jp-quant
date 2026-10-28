import { existsSync } from 'node:fs';
import { publish } from '../kernel/bus.ts';

export const hasData = (path: string): boolean => existsSync(path) && publish() !== '';
