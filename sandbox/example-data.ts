// Velas de ejemplo del sandbox (paso 49): un paseo aleatorio diario con semilla, de 2018 a 2024, con tramos de subida,
// bajada y lateral. Son inventadas: ningún dato de mercado real. Sirven para probar `npm run test-strategy` sin descargar
// nada. Una prueba comprueba que examples/candles/synthetic-daily.csv es exactamente lo que sale de aquí.
// Regenerar: node sandbox/example-data.ts
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seededRng } from '../src/kernel/random.ts';

export const EXAMPLE_CSV = resolve(import.meta.dirname, '..', 'examples', 'candles', 'synthetic-daily.csv');
const SEED = 20260049;
const START = Date.UTC(2018, 0, 1);
const DAYS = 2557; // del 2018-01-01 al 2024-12-31
const DAY = 86_400_000;

/** El CSV de ejemplo, como texto. */
export function exampleCsv(): string {
  const rng = seededRng(SEED, 'sandbox-ejemplo');
  const lines = ['time,open,high,low,close,volume'];
  let previous = 10_000;
  for (let i = 0; i < DAYS; i++) {
    const drift = [0.0015, -0.002, 0.0002, 0.0012, -0.0015, 0.0008][Math.floor(i / 120) % 6] ?? 0;
    const shock = (rng.next() + rng.next() + rng.next() - 1.5) * 0.06;
    const open = previous;
    const closePrice = Math.max(1, open * (1 + drift + shock));
    const high = Math.max(open, closePrice) * (1 + rng.next() * 0.015);
    const low = Math.min(open, closePrice) * (1 - rng.next() * 0.015);
    const volume = 500 + rng.next() * 1500;
    previous = closePrice;
    const day = new Date(START + i * DAY).toISOString().slice(0, 10);
    lines.push([day, open.toFixed(2), high.toFixed(2), low.toFixed(2), closePrice.toFixed(2), volume.toFixed(4)].join(','));
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) writeFileSync(EXAMPLE_CSV, exampleCsv(), 'utf8');
