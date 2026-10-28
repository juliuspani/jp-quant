// Ejemplo para test/enforcement/wall-clock.test.ts: cada línea marcada con ✗ debe dar al menos un error, y
// ninguna otra.
import { setTimeout as wait } from 'node:timers/promises'; // ✗
import { randomUUID } from 'node:crypto'; // ✗
import { performance as perf } from 'node:perf_hooks'; // ✗

export function samples(): unknown[] {
  return [
    Date.now(), // ✗
    new Date(), // ✗
    Date(), // ✗
    Math.random(), // ✗
    performance.now(), // ✗
    process.hrtime.bigint(), // ✗
    process.uptime(), // ✗
    crypto.randomUUID(), // ✗
    setTimeout(() => undefined, 1), // ✗
    setInterval(() => undefined, 1), // ✗
    setImmediate(() => undefined), // ✗
    globalThis.setTimeout(() => undefined, 1), // ✗
    wait,
    randomUUID,
    perf,
  ];
}
