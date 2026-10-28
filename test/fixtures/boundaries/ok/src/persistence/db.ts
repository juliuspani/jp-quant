import { DatabaseSync } from 'node:sqlite';
import { publish } from '../kernel/bus.ts';

export const open = (): DatabaseSync => new DatabaseSync(':memory:');
export const journal = publish;
