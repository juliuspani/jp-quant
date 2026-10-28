// Ejecuta el escenario de replay en un proceso aparte e imprime el SHA-256 del diario (test/src/backtest/replay.test.ts).
import { runScenario } from '../../src/backtest/scenario.ts';

process.stdout.write(`${runScenario().result().sha256}\n`);
