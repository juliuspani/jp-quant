// Ejecuta el escenario de backtest en un proceso aparte e imprime el SHA-256 del diario (test/src/app/backtest.test.ts).
// Cada proceso genera su propio par de claves Ed25519: el diario no lleva firmas, así que el hash no cambia.
import { runBacktest } from '../../../src/app/backtest.ts';
import { spec } from '../../src/app/scenario.ts';

process.stdout.write(`${runBacktest(spec()).journalSha256}\n`);
