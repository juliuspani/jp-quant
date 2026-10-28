// Strategy Library (paso 25, ADR 0028): catálogo de las estrategias de investigación, con su familia del Experiment
// Registry, su ficha y los parámetros de la literatura. Primera ronda: dos familias con hipótesis opuestas, tendencia y
// reversión a la media. Breakout, momentum transversal y precio con volumen quedan para una segunda ronda, solo si el
// paso 31 la activa.
// Todas nacen en estado RESEARCH y no tienen otro: el Strategy Registry completo, con estados y aprobaciones por modo,
// llega en el paso 34. Ninguna se describe como rentable (quant-research §1 y §11).
// Los parámetros son defaults de investigación tomados de la literatura, no ajustados a nuestros datos ni al barrido de
// docs/research/02 (ADR 0019). Se fijan en el pre-registro de cada experimento.
// Desde el paso 28 (ADR 0032), cada familia puede declarar aquí una rejilla pequeña de la literatura (como mucho
// MAX_GRID_CONFIGURATIONS), fijada antes de mirar datos: el walk-forward elige en train uno de sus puntos en cada tramo.
import type { Timeframe } from '../shared/time.ts';
import type { StrategyKit } from './baselines.ts';
import { MEAN_REVERSION_COMPONENTS, meanReversion, type MeanReversionParams } from './mean-reversion.ts';
import { TREND_COMPONENTS, trendFollowing, type TrendFollowingParams } from './trend-following.ts';

export const RESEARCH = 'RESEARCH';

export interface LibraryEntry<P> {
  readonly id: string; // el de la estrategia: nombre en el registro
  readonly version: string;
  readonly estado: typeof RESEARCH;
  readonly familia: string; // familia del Experiment Registry: la N del Deflated Sharpe
  readonly hipotesis: string;
  readonly ficha: string; // ruta desde la raíz del repositorio
  readonly fuente: string;
  readonly timeframe: Timeframe; // el de la literatura
  readonly literatura: Readonly<P>;
  // Rejilla de la literatura para el barrido del paso 28 (ADR 0032), con su fuente; sin ella, la estrategia no admite barridos.
  readonly rejilla?: { readonly valores: Readonly<Record<string, readonly number[]>>; readonly fuente: string };
  readonly enteros: readonly string[]; // parámetros enteros (periodos): sus variantes de sensibilidad se redondean (paso 27B)
  readonly componentes: readonly string[]; // los que la ablación puede quitar (A.3.14, paso 27B)
  readonly noAblables: string; // los que no se quitan, y por qué
  readonly build: (params: P, timeframe: Timeframe, ablate?: readonly string[]) => StrategyKit<P>;
}

export class LibraryParamsError extends Error {
  override readonly name = 'LibraryParamsError';
}

const TREND_FOLLOWING: LibraryEntry<TrendFollowingParams> = Object.freeze({
  id: 'tendencia-donchian',
  version: '1.0.0',
  estado: RESEARCH,
  familia: 'tendencia-donchian-atr',
  hipotesis: 'Los activos con tendencia tienden a continuarla: una ruptura del máximo de 55 días anticipa más subida',
  ficha: 'docs/research/biblioteca/tendencia-donchian.md',
  fuente: 'Faith, «Way of the Turtle» (2007), sistema 2 de los Turtle: entrada a 55 días, salida a 20, stop a 2 N con N = ATR de 20',
  timeframe: '1d',
  literatura: Object.freeze({ entryPeriod: 55, exitPeriod: 20, atrPeriod: 20, stopAtr: 2 }),
  rejilla: Object.freeze({
    valores: Object.freeze({ atrPeriod: Object.freeze([20]), entryPeriod: Object.freeze([20, 55]), exitPeriod: Object.freeze([10, 20]), stopAtr: Object.freeze([2]) }),
    fuente: 'Faith (2007): entradas y salidas de los sistemas 1 (20/10) y 2 (55/20) de los Turtle, que incluyen la regla de 4 semanas de Donchian (20/20); N = ATR de 20 y stop a 2 N, fijos',
  }),
  enteros: Object.freeze(['entryPeriod', 'exitPeriod', 'atrPeriod']),
  componentes: TREND_COMPONENTS,
  noAblables: 'la ruptura de entrada es la señal; el stop lo exige Risk para dimensionar (trading-risk)',
  build: trendFollowing,
});

const MEAN_REVERSION: LibraryEntry<MeanReversionParams> = Object.freeze({
  id: 'reversion-rsi2',
  version: '1.0.0',
  estado: RESEARCH,
  familia: 'reversion-rsi2',
  hipotesis: 'Los movimientos extremos a corto plazo tienden a revertir: tras una sobreventa de 2 días en tendencia alcista, el precio vuelve a su media',
  ficha: 'docs/research/biblioteca/reversion-rsi2.md',
  fuente: 'Connors y Alvarez, «Short Term Trading Strategies That Work» (2008): SMA 200, RSI(2) bajo 10, salida sobre la SMA 5; stop 2 N de los Turtle',
  timeframe: '1d',
  literatura: Object.freeze({ trendPeriod: 200, rsiPeriod: 2, rsiEntry: 10, exitPeriod: 5, atrPeriod: 20, stopAtr: 2 }),
  rejilla: Object.freeze({
    valores: Object.freeze({
      atrPeriod: Object.freeze([20]), exitPeriod: Object.freeze([5]), rsiEntry: Object.freeze([2, 5, 10]),
      rsiPeriod: Object.freeze([2]), stopAtr: Object.freeze([2]), trendPeriod: Object.freeze([200]),
    }),
    fuente: 'Connors y Alvarez (2008): umbrales del RSI(2) de 2, 5 y 10 sobre la SMA 200, con salida sobre la SMA 5; stop 2 N de los Turtle, fijo',
  }),
  enteros: Object.freeze(['trendPeriod', 'rsiPeriod', 'exitPeriod', 'atrPeriod']),
  componentes: MEAN_REVERSION_COMPONENTS,
  noAblables: 'el RSI en sobreventa es la señal; el stop lo exige Risk para dimensionar (trading-risk)',
  build: meanReversion,
});

export const STRATEGY_LIBRARY = Object.freeze({ trendFollowing: TREND_FOLLOWING, meanReversion: MEAN_REVERSION });

/**
 * Parámetros registrados de una estrategia de la biblioteca. En la primera ronda solo valen los de la literatura (sin
 * optimizar, ADR 0028): cualquier otro valor, una clave de más o de menos lanzan.
 */
export function literatureParams<P extends object>(entry: LibraryEntry<P>, values: Readonly<Record<string, unknown>>): P {
  const expected = entry.literatura as Readonly<Record<string, unknown>>;
  const keys = Object.keys(expected).sort();
  const given = Object.keys(values).sort();
  if (keys.join() !== given.join()) throw new LibraryParamsError(`${entry.id}: parámetros ${given.join(', ')}; se esperan ${keys.join(', ')}`);
  for (const key of keys) {
    if (values[key] !== expected[key]) {
      throw new LibraryParamsError(`${entry.id}: ${key} = ${String(values[key])}; la primera ronda usa el de la literatura (${String(expected[key])})`);
    }
  }
  return entry.literatura;
}

/** Configuraciones como mucho de una rejilla por estrategia (docs/PROMOTION_CRITERIA.md C.1 y compromiso del paso 28). */
export const MAX_GRID_CONFIGURATIONS = 20;

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Comprueba que una rejilla registrada es exactamente la de la literatura de la estrategia (paso 28, ADR 0032): mismas
 * claves y mismos valores en el mismo orden. Sin rejilla declarada, o con otra, lanza.
 */
export function literatureGrid<P extends object>(entry: LibraryEntry<P>, rejilla: Readonly<Record<string, readonly unknown[]>>): void {
  const declared = entry.rejilla?.valores;
  if (declared === undefined) throw new LibraryParamsError(`${entry.id}: no declara rejilla; solo admite los valores de la literatura`);
  const keys = Object.keys(declared).sort();
  const given = Object.keys(rejilla).sort();
  if (keys.join() !== given.join()) throw new LibraryParamsError(`${entry.id}: rejilla con ${given.join(', ')}; se esperan ${keys.join(', ')}`);
  for (const key of keys) {
    if (!sameList(rejilla[key] ?? [], declared[key] ?? [])) throw new LibraryParamsError(`${entry.id}: ${key} no es la rejilla de la literatura (${(declared[key] ?? []).join(', ')})`);
  }
  const size = Object.values(declared).reduce((n, values) => n * values.length, 1);
  if (size > MAX_GRID_CONFIGURATIONS) throw new LibraryParamsError(`${entry.id}: ${String(size)} configuraciones; como mucho ${String(MAX_GRID_CONFIGURATIONS)}`);
}

/** Parámetros registrados admitidos: los de la literatura o un punto de su rejilla declarada (paso 28). Si no, lanza. */
export function acceptedParams<P extends object>(entry: LibraryEntry<P>, values: Readonly<Record<string, unknown>>): P {
  const declared = entry.rejilla?.valores;
  if (declared === undefined) return literatureParams(entry, values);
  const keys = Object.keys(declared).sort();
  const given = Object.keys(values).sort();
  const inGrid = keys.join() === given.join() && keys.every((k) => (declared[k] ?? []).some((v) => Object.is(v, values[k])));
  return inGrid ? (Object.freeze({ ...values }) as P) : literatureParams(entry, values);
}

/**
 * Parámetros de una variante de sensibilidad (paso 27B, ADR 0031): las mismas claves que la literatura, todas numéricas y
 * finitas, con cualquier valor. Solo para las ejecuciones de robustez pre-registradas con su experimento, que cuentan en
 * N; el experimento sigue registrando los de la literatura. Si un valor no vale para la regla, lanza al construirla.
 */
export function variantParams<P extends object>(entry: LibraryEntry<P>, values: Readonly<Record<string, unknown>>): P {
  const keys = Object.keys(entry.literatura).sort();
  const given = Object.keys(values).sort();
  if (keys.join() !== given.join()) throw new LibraryParamsError(`${entry.id}: parámetros ${given.join(', ')}; se esperan ${keys.join(', ')}`);
  for (const key of keys) {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new LibraryParamsError(`${entry.id}: ${key} no es un número finito`);
  }
  return Object.freeze({ ...values }) as P;
}
