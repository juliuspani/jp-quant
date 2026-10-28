// Excepción transitoria: src/store.ts puede importar node:sqlite hasta el paso 33.
import { DatabaseSync } from 'node:sqlite';

export const legacyDb = (): DatabaseSync => new DatabaseSync(':memory:');
