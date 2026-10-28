// Ejemplo para test/enforcement/wall-clock.test.ts: nada de esto lee el reloj ni el azar del sistema.
import { createHash } from 'node:crypto';

interface Clock {
  now(): number;
}

export function samples(clock: Clock): unknown[] {
  return [
    clock.now(),
    new Date(0).toISOString(),
    Date.parse('2026-10-01T00:00:00Z'),
    Date.UTC(2026, 9, 1),
    Math.floor(1.5),
    createHash('sha256').update('x').digest('hex'),
  ];
}
