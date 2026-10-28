// Estudio sintético del número mínimo de configuraciones del PBO (auditoría quant Q-06; parte 6 del plan de la
// auditoría). Solo datos sintéticos con semilla: no lee datos reales ni el registro.
//
// Con configuraciones sin diferencias reales, la elección en muestra es ruido por definición, y el PBO (CSCV, S = 16) no
// debería quedar por debajo del umbral de A.3.6 (0,20). Para cada número de configuraciones N y cada correlación entre
// ellas, el estudio mide con qué frecuencia el PBO queda por debajo del umbral sin ninguna ventaja (aceptación falsa) y
// con una configuración que sí la tiene (potencia).
//
// Uso: node scripts/pbo-minimo.ts [matrices por celda] [N …]. Sin argumentos, el estudio del ADR 0041: 200 matrices y
// N de 2 a 16. La tabla que pidió la persona (2026-10-21): node scripts/pbo-minimo.ts 1000 3 5 8 12 20.
import { probabilityOfBacktestOverfitting } from '../src/analytics/statistics.ts';
import { seededRng, type Rng } from '../src/kernel/random.ts';

const PERIODS = 3650; // diez años de velas diarias: los diez tramos de validación de un año del walk-forward
const REPLICATES = Number(process.argv[2] ?? 200);
const THRESHOLD = 0.2; // A.3.6
const BLOCKS = 16; // A.3.6
const SIZES = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [2, 3, 4, 5, 6, 7, 8, 10, 12, 16];
for (const n of [REPLICATES, ...SIZES]) if (!Number.isSafeInteger(n) || n < 2) throw new RangeError(`argumento inválido: ${String(n)}`);
const CORRELATIONS = [0, 0.5, 0.9]; // equicorrelación: los puntos de una rejilla se parecen
const EDGE_SHARPE = 1; // Sharpe anual de la configuración con ventaja; las demás, 0
const VOL = 0.02; // diaria; el Sharpe no depende de la escala
const SEED = 2026_10_21;

function gaussian(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
}

/** n series de rentabilidades normales con correlación rho entre ellas; la primera, con un Sharpe anual `edge`. */
function configurations(rng: Rng, n: number, rho: number, edge: number): number[][] {
  const series = Array.from({ length: n }, (): number[] => []);
  const mean = (edge / Math.sqrt(365)) * VOL;
  for (let t = 0; t < PERIODS; t++) {
    const common = gaussian(rng);
    series.forEach((s, c) => s.push((c === 0 ? mean : 0) + VOL * (Math.sqrt(rho) * common + Math.sqrt(1 - rho) * gaussian(rng))));
  }
  return series;
}

/** Frecuencia de PBO < 0,20 y PBO medio en REPLICATES matrices. */
function rate(n: number, rho: number, edge: number): { readonly accepted: number; readonly mean: number } {
  const rng = seededRng(SEED, `pbo-${String(n)}-${String(rho)}-${String(edge)}`);
  let accepted = 0;
  let total = 0;
  for (let r = 0; r < REPLICATES; r++) {
    const { pbo } = probabilityOfBacktestOverfitting(configurations(rng, n, rho, edge), BLOCKS);
    if (pbo < THRESHOLD) accepted++;
    total += pbo;
  }
  return { accepted: accepted / REPLICATES, mean: total / REPLICATES };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)} %`;
process.stdout.write(`PBO por CSCV (S = ${String(BLOCKS)}), T = ${String(PERIODS)}, ${String(REPLICATES)} matrices por celda, semilla ${String(SEED)}\n`);
process.stdout.write('N | correlación | PBO < 0,20 sin ventaja (aceptación falsa) | PBO medio sin ventaja | PBO < 0,20 con ventaja (potencia)\n');
for (const n of SIZES) {
  for (const rho of CORRELATIONS) {
    const none = rate(n, rho, 0);
    const edge = rate(n, rho, EDGE_SHARPE);
    process.stdout.write(`${String(n)} | ${String(rho)} | ${pct(none.accepted)} | ${none.mean.toFixed(3)} | ${pct(edge.accepted)}\n`);
  }
}
