// Sandbox (paso 49): cómo define un usuario su estrategia para `npm run test-strategy`. Es el mismo contrato que las
// estrategias de investigación (src/strategy/types.ts): una función pura que, con las features de una vela cerrada y la
// posición, decide esperar, entrar o salir. No envía órdenes: el tamaño lo decide Risk, como en todo el sistema.
// - Los parámetros son números con un valor por defecto. Una rejilla pequeña (como mucho MAX_GRID_CONFIGURATIONS puntos)
//   hace que cada tramo del walk-forward elija en su train, y cada punto cuenta como una prueba más para el Deflated Sharpe.
// - Las features salen del catálogo del Feature Engine, sin look-ahead.
// Vive fuera de src/ (INV-14a): el sandbox no es investigación oficial y nunca escribe en el Experiment Registry.
import { atr, close, donchianHigh, donchianLow, ema, momentum, realizedVolatility, rsi, sma, volume } from '../src/features/definitions.ts';
import type { FeatureDefinition, FeatureSet } from '../src/features/types.ts';
import type { KitVariant } from '../src/app/criteria-evidence.ts';
import type { StrategyEntry } from '../src/app/research-runner.ts';
import { MAX_GRID_CONFIGURATIONS } from '../src/strategy/library.ts';
import type { Timeframe } from '../src/shared/time.ts';
import type { Strategy, StrategyDecision, StrategyInput } from '../src/strategy/types.ts';

export { atr, close, donchianHigh, donchianLow, ema, momentum, realizedVolatility, rsi, sma, volume };
export type { StrategyDecision, StrategyInput };

export type Params = Readonly<Record<string, number>>;

export interface StrategyDefinition<P extends Params> {
  readonly name: string; // minúsculas, números y guiones: identifica la estrategia en el registro local
  readonly timeframe: Timeframe; // el de las velas: '1h', '4h' o '1d'
  readonly params: P; // valores por defecto
  readonly grid?: Partial<Readonly<Record<keyof P & string, readonly number[]>>>; // opcional: valores a probar
  readonly integers?: readonly (keyof P & string)[]; // periodos: sus variantes de sensibilidad se redondean
  readonly features: (params: P) => readonly FeatureDefinition[];
  readonly decide: (input: StrategyInput<P>) => StrategyDecision;
}

export interface SandboxStrategy<P extends Params> {
  readonly definition: StrategyDefinition<P>;
  readonly entry: StrategyEntry<P>;
  readonly configurations: number; // puntos de la rejilla (1 sin rejilla)
}

export class StrategyDefinitionError extends Error {
  override readonly name = 'StrategyDefinitionError';
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function valuesOf<P extends Params>(def: StrategyDefinition<P>, values: Readonly<Record<string, unknown>>): P {
  const out: Record<string, number> = {};
  for (const key of Object.keys(def.params)) {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new StrategyDefinitionError(`${def.name}: el parámetro «${key}» debe ser un número`);
    out[key] = value;
  }
  const extra = Object.keys(values).filter((k) => !Object.hasOwn(def.params, k));
  if (extra.length > 0) throw new StrategyDefinitionError(`${def.name}: parámetros desconocidos: ${extra.join(', ')}`);
  return out as P;
}

function kitOf<P extends Params>(def: StrategyDefinition<P>, params: P): KitVariant<P> {
  const features = def.features(params);
  if (features.length === 0) throw new StrategyDefinitionError(`${def.name}: features() no devuelve ninguna feature`);
  const ids = features.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new StrategyDefinitionError(`${def.name}: features repetidas: ${ids.join(', ')}`);
  const featureSet: FeatureSet = Object.freeze({ id: `${def.name}-${ids.join('-')}`, version: 1, timeframe: def.timeframe, features: Object.freeze([...features]) });
  const strategy: Strategy<P> = Object.freeze({
    id: def.name,
    version: '1.0.0',
    featureSet: { id: featureSet.id, version: featureSet.version },
    warmupBars: Math.max(...features.map((f) => f.warmupBars)),
    evaluate: def.decide,
  });
  return { strategy, params, featureSet };
}

/** La rejilla completa que se registra: cada parámetro con sus valores, los que no están en la rejilla con el suyo. */
export function gridOf<P extends Params>(def: StrategyDefinition<P>): Readonly<Record<string, readonly number[]>> | null {
  if (def.grid === undefined) return null;
  const grid: Record<string, readonly number[]> = {};
  for (const [key, value] of Object.entries(def.params)) grid[key] = def.grid[key] ?? [value];
  return grid;
}

export function defineStrategy<P extends Params>(def: StrategyDefinition<P>): SandboxStrategy<P> {
  if (!SLUG.test(def.name)) throw new StrategyDefinitionError(`name «${def.name}»: usa minúsculas, números y guiones (por ejemplo «my-ema-cross»)`);
  for (const key of Object.keys(def.grid ?? {})) if (!Object.hasOwn(def.params, key)) throw new StrategyDefinitionError(`grid: «${key}» no está en params`);
  const grid = gridOf(def);
  let configurations = 1;
  if (grid !== null) {
    for (const [key, values] of Object.entries(grid)) {
      if (!Object.hasOwn(def.params, key)) throw new StrategyDefinitionError(`grid: «${key}» no está en params`);
      if (values.length === 0 || values.some((v) => !Number.isFinite(v))) throw new StrategyDefinitionError(`grid.${key}: una lista de números`);
      configurations *= values.length;
    }
    if (configurations > MAX_GRID_CONFIGURATIONS) throw new StrategyDefinitionError(`grid: ${String(configurations)} combinaciones; como mucho ${String(MAX_GRID_CONFIGURATIONS)} (cada una cuenta como una prueba más)`);
  }
  for (const key of def.integers ?? []) if (!Object.hasOwn(def.params, key)) throw new StrategyDefinitionError(`integers: «${key}» no está en params`);
  const base = kitOf(def, def.params); // falla ya si las features no se pueden construir
  const entry: StrategyEntry<P> = {
    strategy: base.strategy,
    configure: (values) => kitOf(def, valuesOf(def, values)),
    grid: (rejilla) => {
      for (const key of Object.keys(rejilla)) if (!Object.hasOwn(def.params, key)) throw new StrategyDefinitionError(`rejilla: «${key}» no está en params`);
    },
    sensitivity: { integers: def.integers ?? [], build: (values) => kitOf(def, valuesOf(def, values)) },
  };
  return Object.freeze({ definition: def, entry, configurations });
}
