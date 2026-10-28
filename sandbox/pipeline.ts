// Motor del sandbox (paso 49): pasa una estrategia de usuario por el mismo pipeline que la investigación oficial
// (backtestRunner: walk-forward con purging y embargo, elección en train si hay rejilla, costes, Deflated Sharpe, PBO,
// control aleatorio con 1000 colocaciones y los criterios congelados) y traduce el resultado a lenguaje llano.
// - Nunca toca el Experiment Registry oficial ni su N, ni los criterios congelados: las ejecuciones van a un registro local
//   aparte (sandbox-runs/registry.jsonl, ignorado por git). Cada ejecución de la misma estrategia suma a SU N local, como
//   en la investigación: repetir hasta que salga bien se paga en el Deflated Sharpe.
// - Los datos del usuario se tratan como un solo par. El ejecutor mide régimen y buy-and-hold contra BTC/EUR, así que el par
//   se llama internamente BTC/EUR; el informe muestra el nombre que dio el usuario. Las cifras van en su moneda de cotización.
// - El veredicto llano mira solo la pregunta «¿ventaja o suerte?» (A.3.1, A.3.2, A.3.5, A.3.6, A.3.11 y A.3.12). El de todos
//   los criterios congelados va aparte: con datos propios, régimen, ablación y universo alternativo quedan sin medir.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { robustnessPlan } from '../src/app/criteria-evidence.ts';
import { backtestRunner, REGIME_SYMBOL } from '../src/app/research-runner.ts';
import type { MarketHistory } from '../src/app/datasets.ts';
import type { HistoricalCandle } from '../src/historical/types.ts';
import type { RunInput, RunOutput } from '../src/research/experiment.ts';
import { timeframeMs, toUtcIso, type Timeframe, type UtcMillis } from '../src/shared/time.ts';
import { gridOf, type Params, type SandboxStrategy } from './define.ts';

export const INTERNAL_SYMBOL = REGIME_SYMBOL;
export const SANDBOX_FAMILY_PREFIX = 'sandbox-';
export const LOCAL_REGISTRY = 'registry.jsonl';
export const FOLDS = 5;
const VALIDATION_SHARE = 0.5; // la segunda mitad de los datos, en FOLDS tramos de validación seguidos
const MIN_VALIDATION_BARS = 30;
// Costes mínimos de quant-research §5, los mismos que la investigación oficial (comisión, medio spread y slippage).
export const SANDBOX_COSTS = Object.freeze({ comision: '0.0025', spread: '0.00075', slippage: '0.0005', multiplicador: 1 });
export const SANDBOX_SEED = 49;

export type PlainVerdict = 'edge' | 'luck' | 'insufficient';

export interface CheckResult {
  readonly id: string;
  readonly name: string;
  readonly status: 'PASS' | 'FAIL' | 'NO CONCLUYENTE';
  readonly value: unknown;
}

export interface SandboxResult {
  readonly runId: string;
  readonly strategy: string;
  readonly dataLabel: string;
  readonly timeframe: Timeframe;
  readonly candles: number;
  readonly from: UtcMillis;
  readonly to: UtcMillis;
  readonly localN: number; // pruebas de esta estrategia en el registro local, contando esta
  readonly configurations: number;
  readonly verdict: PlainVerdict;
  readonly reasons: readonly string[];
  readonly fullVerdict: string | null; // el de todos los criterios congelados
  readonly criteria: readonly CheckResult[];
  readonly metrics: Readonly<Record<string, string | number | null>>;
  readonly returns: readonly number[]; // fuera de muestra, por periodo
}

export class SandboxError extends Error {
  override readonly name = 'SandboxError';
}

/** Tramos de walk-forward automáticos: la segunda mitad de los datos en FOLDS validaciones; cada train, la ventana anterior del mismo largo que la primera mitad. */
export function makePartitions(candles: readonly HistoricalCandle[], timeframe: Timeframe, warmupBars: number): RunInput['particiones'] | string {
  const step = timeframeMs(timeframe);
  const first = candles[0]?.openTime;
  const last = candles.at(-1)?.openTime;
  if (first === undefined || last === undefined) return 'no hay velas';
  const bars = Math.round((last - first) / step) + 1;
  const trainBars = Math.floor(bars * (1 - VALIDATION_SHARE));
  const validationBars = Math.floor((bars - trainBars) / FOLDS);
  const needTrain = 2 * warmupBars + MIN_VALIDATION_BARS;
  if (validationBars < MIN_VALIDATION_BARS || trainBars < needTrain) {
    return `hacen falta más velas: con un calentamiento de ${String(warmupBars)}, al menos ${String(Math.max(2 * needTrain, needTrain + FOLDS * MIN_VALIDATION_BARS))} y hay ${String(bars)}`;
  }
  const at = (bar: number): string => toUtcIso(first + bar * step);
  const tramos = Array.from({ length: FOLDS }, (_, k) => {
    const v0 = trainBars + k * validationBars;
    const v1 = k === FOLDS - 1 ? bars : v0 + validationBars;
    return { train: { desde: at(v0 - trainBars), hasta: at(v0) }, validation: { desde: at(v0), hasta: at(v1) } };
  });
  return { tramos, test: null, purging_velas: warmupBars, embargo_velas: warmupBars };
}

/** Los datos del usuario como un MarketHistory de un solo par, con el nombre interno que espera el ejecutor. */
export function historyOf(candles: readonly HistoricalCandle[], timeframe: Timeframe): MarketHistory {
  const internal = candles.map((c) => ({ ...c, symbol: INTERNAL_SYMBOL }));
  const from = internal[0]?.openTime ?? 0;
  const to = (internal.at(-1)?.closeTime ?? 0) + 1;
  return {
    kind: 'market-history',
    timeframe,
    from,
    to,
    listings: { source: 'csv', coverageStart: from, coverageEnd: to, delistingsFrom: to, listings: [{ symbol: INTERNAL_SYMBOL, listedAt: from, delistedAt: null }], includesDelisted: false },
    candles: (symbols) => Promise.resolve(symbols.includes(INTERNAL_SYMBOL) ? [...internal] : []),
  };
}

interface LocalLine {
  readonly run: string;
  readonly date: string;
  readonly strategy: string;
  readonly trials: number; // configuraciones y variantes de robustez de esta ejecución
  readonly data: string; // SHA-256 de las velas
  readonly verdict: PlainVerdict;
}

function readLocal(dir: string): LocalLine[] {
  const path = join(dir, LOCAL_REGISTRY);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LocalLine);
}

/** Pruebas previas de esta estrategia en el registro local. */
export function previousTrials(dir: string, strategy: string): number {
  return readLocal(dir).filter((l) => l.strategy === strategy).reduce((sum, l) => sum + l.trials, 0);
}

function dataHash(candles: readonly HistoricalCandle[]): string {
  const hash = createHash('sha256');
  for (const c of candles) hash.update(`${String(c.openTime)},${c.open.toString()},${c.high.toString()},${c.low.toString()},${c.close.toString()},${c.volume.toString()}\n`);
  return hash.digest('hex');
}

function criterion(output: RunOutput, id: string): CheckResult {
  const report = (output.salida as { criterios?: { criteria?: readonly { id: string; name: string; status: CheckResult['status']; value: unknown }[] } }).criterios;
  const found = report?.criteria?.find((c) => c.id === id);
  return found === undefined ? { id, name: id, status: 'NO CONCLUYENTE', value: null } : { id, name: found.name, status: found.status, value: found.value };
}

/** Todos los criterios congelados del informe, en su orden. */
function allCriteria(output: RunOutput): CheckResult[] {
  const report = (output.salida as { criterios?: { criteria?: readonly { id: string; name: string; status: CheckResult['status']; value: unknown }[] } }).criterios;
  return (report?.criteria ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, value: c.value }));
}

/** El veredicto llano y sus motivos, de los criterios que responden a «¿ventaja o suerte?». */
/** Operaciones cerradas fuera de muestra por debajo de las cuales no se juzga (el mínimo de A.3.5). */
export const MIN_TRADES = 100;

export interface PlainInput {
  readonly dsr: number | null;
  readonly configurations: number;
  readonly trades: number;
  readonly sharpe: number | null;
}

export function plainVerdict(checks: ReadonlyMap<string, CheckResult>, input: PlainInput): { readonly verdict: PlainVerdict; readonly reasons: string[] } {
  const { dsr, configurations } = input;
  const status = (id: string): CheckResult['status'] => checks.get(id)?.status ?? 'NO CONCLUYENTE';
  const missing: string[] = [];
  // Sin operaciones bastantes no se juzga. Con un Sharpe positivo, además, A.3.5 pide MinTRL y un mercado bajista completo;
  // sin Sharpe positivo no hay ventaja que confirmar y el veredicto es suerte.
  if (input.trades < MIN_TRADES) missing.push('sample');
  else if ((input.sharpe ?? 0) > 0 && status('A.3.5') !== 'PASS') missing.push('track-record');
  if (status('A.3.1') === 'NO CONCLUYENTE') missing.push('oos-missing');
  // Lo que además falla con los datos que hay: con datos insuficientes también se dice, para no esconderlo.
  const failing: string[] = [];
  if (status('A.3.1') === 'FAIL') failing.push('oos');
  if (dsr === null || dsr < 0.95) failing.push('dsr');
  if (status('A.3.11') !== 'PASS') failing.push('ci');
  if (status('A.3.12') !== 'PASS') failing.push('control');
  if (configurations >= 3 && status('A.3.6') !== 'PASS') failing.push('pbo');
  if (missing.length > 0) return { verdict: 'insufficient', reasons: [...missing, ...failing] };
  return { verdict: failing.length === 0 ? 'edge' : 'luck', reasons: failing };
}

export interface TestStrategyInput<P extends Params> {
  readonly strategy: SandboxStrategy<P>;
  readonly candles: readonly HistoricalCandle[];
  readonly timeframe: Timeframe;
  readonly dataLabel: string;
  readonly dir: string; // carpeta del registro local y de los informes
  readonly controls?: { readonly simulations: number; readonly shifts: number }; // solo para pruebas rápidas
  readonly now?: Date;
}

const SANDBOX_CHECKS = ['A.3.1', 'A.3.2', 'A.3.5', 'A.3.6', 'A.3.11', 'A.3.12'] as const;

export async function testStrategy<P extends Params>(input: TestStrategyInput<P>): Promise<SandboxResult> {
  const { strategy, candles, timeframe, dir } = input;
  const def = strategy.definition;
  if (def.timeframe !== timeframe) throw new SandboxError(`la estrategia es de velas de ${def.timeframe} y los datos son de ${timeframe}: cambia timeframe en la estrategia o usa otras velas`);
  mkdirSync(dir, { recursive: true });
  const date = (input.now ?? new Date()).toISOString();
  const runId = `run-${date.replace(/[-:.TZ]/g, '').slice(0, 14)}-${def.name}`;
  const warmup = strategy.entry.strategy.warmupBars;
  const grid = gridOf(def);
  const values = def.params;
  const plan = robustnessPlan({ values, integers: def.integers ?? [], symbols: [INTERNAL_SYMBOL], components: null, alternatives: [] });
  const trials = strategy.configurations + plan.total;
  const localN = previousTrials(dir, def.name) + trials;
  const base = {
    runId, strategy: def.name, dataLabel: input.dataLabel, timeframe, candles: candles.length, from: candles[0]?.openTime ?? 0, to: candles.at(-1)?.closeTime ?? 0,
    localN, configurations: strategy.configurations,
  };
  const partitions = makePartitions(candles, timeframe, warmup);
  let result: SandboxResult;
  if (typeof partitions === 'string') {
    result = { ...base, verdict: 'insufficient', reasons: [`short: ${partitions}`], fullVerdict: null, criteria: [], metrics: {}, returns: [] };
  } else {
    const history = historyOf(candles, timeframe);
    const runInput: RunInput = {
      familia: `${SANDBOX_FAMILY_PREFIX}${def.name}`,
      estrategia: { nombre: def.name, version: '1.0.0' },
      datos: { fuente: `csv: ${input.dataLabel}`, dataset: null, version: null, timeframe, rango: { desde: toUtcIso(history.from), hasta: toUtcIso(history.to) }, hash: dataHash(candles) },
      universo: { regla: 'un solo par, el de los datos del usuario', simbolos: [INTERNAL_SYMBOL], alternativos: [] },
      particiones: partitions,
      costes: SANDBOX_COSTS,
      parametros: grid === null ? { tipo: 'valores', valores: { ...values } } : { tipo: 'rejilla', rejilla: Object.fromEntries(Object.entries(grid).map(([k, v]) => [k, [...v]])) },
      semilla: SANDBOX_SEED,
      variantes: plan.total,
      pruebas_familia: { n: localN },
      data: history,
    };
    const output = await backtestRunner(strategy.entry, input.controls)(runInput);
    const checks = new Map(SANDBOX_CHECKS.map((id) => [id, criterion(output, id)] as const));
    const dsrValue = (checks.get('A.3.2')?.value as { dsr_familia?: number | null } | null)?.dsr_familia ?? null;
    const numeric = (key: string): number | null => (typeof output.metricas[key] === 'number' ? (output.metricas[key] as number) : null);
    const plain = plainVerdict(checks, { dsr: dsrValue, configurations: strategy.configurations, trades: numeric('operaciones_cerradas') ?? 0, sharpe: numeric('sharpe_anualizado') });
    const series = (output.salida as { serie_configuracion?: { rendimientos?: number[] } }).serie_configuracion?.rendimientos ?? [];
    result = { ...base, verdict: plain.verdict, reasons: plain.reasons, fullVerdict: output.veredicto, criteria: allCriteria(output), metrics: output.metricas, returns: series };
  }
  const line: LocalLine = { run: runId, date, strategy: def.name, trials, data: dataHash(candles), verdict: result.verdict };
  appendFileSync(join(dir, LOCAL_REGISTRY), `${JSON.stringify(line)}\n`, 'utf8');
  return result;
}
