// Evaluador de los criterios congelados del paso 27 (docs/PROMOTION_CRITERIA.md, A.3; paso 27B, ADR 0031). Recibe lo
// medido en un experimento y da, para cada criterio, PASS, FAIL o NO CONCLUYENTE con su valor medido y su umbral, y el
// veredicto de quant-research §11. Reglas generales del documento:
// - fallar un solo criterio basta para RECHAZADA;
// - un criterio que no se puede medir da NO CONCLUYENTE, nunca PASS;
// - todo, fuera de muestra y neto de costes; la métrica primaria es el Sharpe anualizado con 365 días.
// Los umbrales de este archivo son los del documento congelado, cuya huella lleva cada informe. Cambiar uno es cambiar
// los criterios: parada obligatoria (CLAUDE.md §7). A.4 (paso 31), las etapas 2 y 3 (A.5 y A.6) y el PRE-LIVE GATE no
// se evalúan aquí. Puro: sin E/S.
import { MAX_REPLICA_DEVIATION } from './random-control.ts';
import type { ConfidenceInterval } from './statistics.ts';
import { significantDigits, type PboOutcome, type WithoutBestYear } from './robustness.ts';
import type { DeflatedSharpeReport } from './report.ts';
import type { RegimeMeasures, RegimeReturns, WindowResult } from './windows.ts';

/** Huella (SHA-256 con finales LF) de los documentos que este evaluador implementa (ADR 0030, decisión 7). */
export const FROZEN_DOCUMENTS: readonly { readonly path: string; readonly sha256: string }[] = Object.freeze([
  Object.freeze({ path: 'docs/PROMOTION_CRITERIA.md', sha256: '7967cb763d0a773e6e6ccf055afeea332c15c4f6ca883ba17e3304da79db7893' }),
  Object.freeze({ path: 'docs/PRE_LIVE_GATE.md', sha256: '10d075607b3e051aabe2fe0c0012e09209ba203633623f388a78f4a71d75331c' }),
]);

/** Umbrales congelados de A.3. */
export const THRESHOLDS = Object.freeze({
  minFolds: 3, // A.3.1
  minDsr: 0.95, // A.3.2
  maxDrawdown: 0.1, // A.3.4, el breaker DRAWDOWN_HALT
  maxDrawdownUpper: 0.2, // A.3.4, límite superior del IC al 95 %
  minClosedTrades: 100, // A.3.5
  maxPbo: 0.2, // A.3.6
  minPboConfigurations: 3, // A.3.6: con menos, el PBO se informa y no decide (ADR 0041)
  crisisMaxDrawdown: 0.1, // A.3.7
  sensitivityFloor: 0.5, // A.3.8: ninguna variante por debajo de la mitad
  maxSignificantDigits: 3, // A.3.8
  minSweepStability: 2 / 3, // A.3.8
  randomControlPercentile: 0.95, // A.3.12 y A.3.15
  minRandomSimulations: 1000, // A.3.12
  maxReplicaDeviation: MAX_REPLICA_DEVIATION, // A.3.12 y A.3.15: el simulador solo decide si su réplica se aleja ≤ 10 %
});

/** Política del backtester con stop y objetivo en la misma vela (A.3.7): la de backtest/intrabar.ts. */
export const WORST_CASE_INTRABAR = 'peor-caso@1';

/** Perfil por régimen de una familia (tabla A.3.9). */
export interface RegimeProfile {
  readonly name: string;
  readonly bearShare: number; // pierde ≤ esta fracción de lo que pierde BTC en cada episodio bajista
  readonly bullCapture: number; // captura ≥ esta fracción de la subida de BTC en alcista
  readonly lateral: { readonly kind: 'maxLoss' | 'minReturn'; readonly value: number }; // anualizada con 365 días
}

const TREND: RegimeProfile = Object.freeze({ name: 'Trend following / momentum defensivo', bearShare: 0.5, bullCapture: 0.5, lateral: Object.freeze({ kind: 'maxLoss', value: 0.05 }) });
const MEAN_REVERSION: RegimeProfile = Object.freeze({ name: 'Reversión a la media', bearShare: 0.25, bullCapture: 0.25, lateral: Object.freeze({ kind: 'minReturn', value: 0 }) });
const BREAKOUT: RegimeProfile = Object.freeze({ name: 'Breakout / expansión de volatilidad', bearShare: 0.5, bullCapture: 0.5, lateral: Object.freeze({ kind: 'maxLoss', value: 0.05 }) });

export const REGIME_PROFILES = Object.freeze({
  trend: TREND,
  meanReversion: MEAN_REVERSION,
  breakout: BREAKOUT,
  crossSectional: Object.freeze({ name: 'Cross-Sectional Momentum', bearShare: 0.5, bullCapture: 1, lateral: Object.freeze({ kind: 'maxLoss', value: 0.05 }) }) as RegimeProfile,
  priceVolume: Object.freeze({ name: 'Price + Volume Momentum', bearShare: 0.5, bullCapture: 0.5, lateral: Object.freeze({ kind: 'minReturn', value: 0 }) }) as RegimeProfile,
});

/**
 * Familia del registro → perfil. Solo las familias que ya existen; Cross-Sectional y Price + Volume se asocian cuando la
 * segunda ronda abra las suyas. Una familia sin perfil no puede pasar A.3.9 (NO CONCLUYENTE).
 */
export const FAMILY_PROFILES: ReadonlyMap<string, RegimeProfile> = new Map([
  ['tendencia-donchian-atr', TREND],
  ['regimen-btc-sma200', TREND],
  ['reversion-rsi2', MEAN_REVERSION],
  ['ruptura-volatilidad-intradia', BREAKOUT],
]);

export type CriterionStatus = 'PASS' | 'FAIL' | 'NO CONCLUYENTE';
export type CriteriaVerdict = 'RECHAZADA' | 'NO CONCLUYENTE' | 'CANDIDATA A TEST FINAL';
type Value = number | string | boolean | null;

export interface CriterionResult {
  readonly id: string;
  readonly name: string;
  readonly status: CriterionStatus;
  readonly value: Readonly<Record<string, Value>>; // lo medido
  readonly threshold: string;
  readonly note: string | null; // por qué no se mide, o qué se informa sin decidir
}

/** Algo medido, o el motivo por el que no se pudo medir. */
export type Measured<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface StressRun {
  readonly sharpe: number | null; // anualizado
  readonly netPnl: number;
}

export interface SensitivityVariant {
  readonly param: string;
  readonly step: number;
  readonly sharpe: Measured<number | null>;
}

/** Con qué se evaluaron las colocaciones del control: el simulador de operaciones o el backtester real. */
export type ControlMethod = 'simulador' | 'backtester';

export interface ControlResult {
  readonly method: ControlMethod;
  readonly simulations: number;
  readonly p95: number;
  readonly median: number; // la que descuenta la ablación (ADR 0037)
  readonly percentile: number | null; // el de la estrategia en la distribución
  readonly replica: number | null; // Sharpe de las operaciones de la estrategia con el simulador
  readonly deviation: number | null; // |réplica − Sharpe del backtester| / |Sharpe del backtester|
  readonly simulatorP95: number | null; // el del simulador, informado cuando no decide
}

export interface AblationVariant {
  readonly component: string;
  readonly sharpe: Measured<number | null>; // Sharpe sin ese componente
  // Ese Sharpe menos la mediana de su control aleatorio, de sus mismas operaciones y duraciones: lo que su exposición no
  // explica (ADR 0037)
  readonly excess: Measured<number | null>;
  readonly exposure: { readonly timeInMarket: number | null; readonly meanExposure: number | null } | null; // null: sin construir
}

export interface CriteriaEvidence {
  readonly family: string;
  readonly sharpe: number | null; // métrica primaria de la serie concatenada
  readonly netPnl: number;
  readonly calmar: number | null;
  readonly foldSharpes: readonly (number | null)[];
  readonly maxDrawdown: number;
  readonly bootstrap: { readonly sharpe: ConfidenceInterval | null; readonly maxDrawdown: ConfidenceInterval | null; readonly excessSharpe: ConfidenceInterval | null };
  // IC al 95 % del Sharpe anualizado con la varianza a largo plazo de su estimación (ADR 0038)
  readonly intervalLongRun: { readonly lower: number; readonly upper: number; readonly lag: number } | null;
  readonly closedTrades: number;
  readonly dsrFamily: DeflatedSharpeReport | null;
  readonly dsrGlobal: Measured<DeflatedSharpeReport>; // con la N de todo el registro: solo en la decisión (ADR 0039)
  readonly bearEpisodes: readonly WindowResult[]; // frente a BTC con la exposición de la estrategia en toda la serie (ADR 0042)
  readonly crisisWindows: readonly WindowResult[]; // frente al buy-and-hold de BTC con todo el capital
  readonly bull: RegimeReturns; // como los episodios bajistas
  readonly lateral: RegimeReturns;
  readonly regimeExposure: number | null; // la de toda la serie; null: la estrategia nunca tiene posición
  readonly regimeOwn: RegimeMeasures['own']; // la condición por régimen de A.3.9: con la exposición de cada régimen (ADR 0042)
  readonly costs2: Measured<StressRun>;
  readonly costs3: Measured<StressRun>;
  readonly delay: Measured<StressRun>;
  readonly intrabarPolicy: string;
  readonly params: Readonly<Record<string, unknown>>; // los registrados
  readonly sensitivity: Measured<readonly SensitivityVariant[]>;
  readonly sweep: readonly { readonly param: string; readonly stability: number | null }[] | null; // null: sin barrido
  readonly benchmarks: {
    readonly btc: { readonly sharpe: number | null; readonly calmar: number | null };
    readonly universe: Measured<{ readonly sharpe: number | null; readonly calmar: number | null }>;
  };
  readonly randomControl: Measured<ControlResult>;
  readonly ablation: Measured<readonly AblationVariant[]>; // vacía: ningún componente que quitar
  readonly alternativeUniverse: Measured<{ readonly symbols: string; readonly sharpe: number | null }>;
  readonly withoutBestYear: WithoutBestYear;
  readonly withoutBestAsset: Measured<{ readonly asset: string; readonly sharpe: number | null }>;
  readonly pbo: { readonly family: PboOutcome; readonly global: PboOutcome };
  readonly smoke: {
    readonly shifted: Measured<{ readonly method: ControlMethod; readonly deviation: number | null; readonly median: number; readonly p95: number }>;
    readonly randomWalk: Measured<{ readonly method: ControlMethod; readonly deviation: number | null; readonly replica: number | null; readonly sharpe: number | null; readonly p95: number }>;
  };
}

export interface CriteriaReport {
  readonly documents: typeof FROZEN_DOCUMENTS;
  readonly criteria: readonly CriterionResult[];
  readonly verdict: CriteriaVerdict;
  readonly notEvaluated: readonly string[];
}

const NOT_EVALUATED = Object.freeze([
  'A.4 (de VALIDATED a PAPER): decisión del paso 31, con el consultor quant y la reproducción',
  'A.5 y A.6 (etapas 2 y 3, con el test final hacia delante): pasos 42 a 45',
  'PRE-LIVE GATE (docs/PRE_LIVE_GATE.md): pasos 42 a 45',
]);

function combine(statuses: readonly CriterionStatus[]): CriterionStatus {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('NO CONCLUYENTE')) return 'NO CONCLUYENTE';
  return 'PASS';
}

/** PASS si `ok`; NO CONCLUYENTE si falta el valor. */
function check(value: number | null | undefined, ok: (v: number) => boolean): CriterionStatus {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'NO CONCLUYENTE';
  return ok(value) ? 'PASS' : 'FAIL';
}

function result(id: string, name: string, statuses: readonly CriterionStatus[], value: Record<string, Value>, threshold: string, notes: readonly (string | null)[] = []): CriterionResult {
  const note = notes.filter((n): n is string => n !== null).join('; ');
  return Object.freeze({ id, name, status: combine(statuses), value: Object.freeze(value), threshold, note: note === '' ? null : note });
}

function reason<T>(m: Measured<T>): string | null {
  return m.ok ? null : m.reason;
}

function walkForward(e: CriteriaEvidence): CriterionResult {
  const positive = e.foldSharpes.filter((s) => s !== null && s > 0).length;
  const folds = e.foldSharpes.length;
  return result(
    'A.3.1', 'Fuera de muestra y walk-forward',
    [folds >= THRESHOLDS.minFolds ? 'PASS' : 'FAIL', check(e.sharpe, (s) => s > 0), 2 * positive >= folds && folds > 0 ? 'PASS' : 'FAIL'],
    { tramos: folds, sharpe_anualizado: e.sharpe, tramos_positivos: positive },
    '≥ 3 tramos de validación; Sharpe > 0 en la serie concatenada y en al menos la mitad de los tramos',
  );
}

function deflated(e: CriteriaEvidence): CriterionResult {
  const ok = (v: number): boolean => v >= THRESHOLDS.minDsr;
  return result(
    'A.3.2', 'Deflated Sharpe',
    [check(e.dsrFamily?.dsr, ok), check(e.dsrGlobal.ok ? e.dsrGlobal.value.dsr : null, ok)],
    {
      dsr_familia: e.dsrFamily?.dsr ?? null,
      n_familia: e.dsrFamily?.trials ?? null,
      dsr_global: e.dsrGlobal.ok ? e.dsrGlobal.value.dsr : null,
      n_global: e.dsrGlobal.ok ? e.dsrGlobal.value.trials : null,
    },
    'DSR ≥ 0,95 con la N de la familia y, en la decisión, con la N de todo el registro; V[SRₙ], la del Sharpe de una prueba sin habilidad (ADR 0039)',
    [e.dsrFamily === null ? 'sin DSR de la familia: menos de tres periodos o sin variación' : null, reason(e.dsrGlobal)],
  );
}

function costStatus(e: CriteriaEvidence): CriterionStatus {
  if (!e.costs2.ok) return 'NO CONCLUYENTE';
  return combine([check(e.costs2.value.sharpe, (s) => s > 0), e.costs2.value.netPnl > 0 ? 'PASS' : 'FAIL']);
}

function costs(e: CriteriaEvidence): CriterionResult {
  return result(
    'A.3.3', 'Costes realistas y con margen',
    [costStatus(e)],
    {
      sharpe_costes_x2: e.costs2.ok ? e.costs2.value.sharpe : null,
      pnl_costes_x2: e.costs2.ok ? e.costs2.value.netPnl : null,
      sharpe_costes_x3: e.costs3.ok ? e.costs3.value.sharpe : null,
      pnl_costes_x3: e.costs3.ok ? e.costs3.value.netPnl : null,
    },
    'Con costes ×2, Sharpe y P&L neto > 0; con ×3 se informa',
    [reason(e.costs2), e.costs3.ok ? null : `costes ×3 sin medir: ${e.costs3.reason}`],
  );
}

function drawdown(e: CriteriaEvidence): CriterionResult {
  return result(
    'A.3.4', 'Drawdown máximo',
    [e.maxDrawdown <= THRESHOLDS.maxDrawdown ? 'PASS' : 'FAIL', check(e.bootstrap.maxDrawdown?.upper, (u) => u <= THRESHOLDS.maxDrawdownUpper)],
    { caida_maxima: e.maxDrawdown, ic95_caida_maxima_superior: e.bootstrap.maxDrawdown?.upper ?? null },
    'Caída máxima ≤ 10 % y límite superior del IC al 95 % ≤ 20 %',
  );
}

/**
 * A.3.5. Se mide y no llega (menos de 100 operaciones, MinTRL sin cumplir): FAIL. No se puede medir (ningún bajista
 * entero fuera de muestra, como en los perfiles de A.3.9, o sin DSR): NO CONCLUYENTE. Lectura fijada por la persona.
 */
function sample(e: CriteriaEvidence): CriterionResult {
  const mintrl = e.dsrFamily === null ? 'NO CONCLUYENTE' : e.dsrFamily.meetsMinTrackRecord ? 'PASS' : 'FAIL';
  const bear = e.bearEpisodes.filter((w) => w.coverage === 'dentro').map((w) => w.id);
  return result(
    'A.3.5', 'Número mínimo de operaciones',
    [e.closedTrades >= THRESHOLDS.minClosedTrades ? 'PASS' : 'FAIL', mintrl, bear.length > 0 ? 'PASS' : 'NO CONCLUYENTE'],
    { operaciones_cerradas: e.closedTrades, mintrl: e.dsrFamily?.minTrackRecord ?? null, periodos: e.dsrFamily?.periods ?? null, bajistas_completos: bear.join(', ') },
    '≥ 100 operaciones cerradas; la historia cumple MinTRL al 95 % e incluye 2018 o 2022 entero fuera de muestra',
    [bear.length === 0 ? 'ningún bajista (2018 o 2022) entero fuera de muestra: no se puede medir' : null],
  );
}

function pboStatus(outcome: PboOutcome): CriterionStatus {
  if (!outcome.measured || outcome.result.configurations < THRESHOLDS.minPboConfigurations) return 'NO CONCLUYENTE';
  return outcome.result.pbo < THRESHOLDS.maxPbo ? 'PASS' : 'FAIL';
}

function pbo(e: CriteriaEvidence): CriterionResult {
  const { family, global } = e.pbo;
  return result(
    'A.3.6', 'PBO máximo',
    // Decide la matriz de toda la ronda, como dice el texto congelado; el PBO de la familia se informa (auditoría Q-06).
    [pboStatus(global)],
    {
      pbo_familia: family.measured ? family.result.pbo : null,
      configuraciones_familia: family.measured ? family.result.configurations : family.configurations,
      pbo_global: global.measured ? global.result.pbo : null,
      configuraciones_global: global.measured ? global.result.configurations : global.configurations,
    },
    'PBO < 0,20 por CSCV (S = 16) con todas las configuraciones de la ronda, de todas las familias; el de la familia se informa y no decide; con menos de 3 configuraciones, NO CONCLUYENTE (ADR 0041)',
    [
      family.measured ? null : `familia: ${family.reason}`,
      global.measured ? null : `entre familias: ${global.reason}`,
      global.measured && global.result.configurations < THRESHOLDS.minPboConfigurations
        ? `entre familias: ${String(global.result.configurations)} configuraciones, menos de ${String(THRESHOLDS.minPboConfigurations)}: el PBO se informa y no decide (ADR 0041)`
        : null,
    ],
  );
}

function windowStatus(w: WindowResult): CriterionStatus {
  if (w.coverage === 'parcial') return 'NO CONCLUYENTE';
  const { strategyReturn: s, benchmarkReturn: b, maxDrawdown: dd } = w;
  if (s === null || b === null || dd === null) return 'NO CONCLUYENTE';
  return dd <= THRESHOLDS.crisisMaxDrawdown && s >= b ? 'PASS' : 'FAIL';
}

function stress(e: CriteriaEvidence): CriterionResult {
  const windows = e.crisisWindows.filter((w) => w.coverage !== 'fuera');
  const windowValues: Record<string, Value> = {};
  for (const w of e.crisisWindows) {
    windowValues[`crisis_${w.id}_rentabilidad`] = w.strategyReturn;
    windowValues[`crisis_${w.id}_btc`] = w.benchmarkReturn;
    windowValues[`crisis_${w.id}_caida_maxima`] = w.maxDrawdown;
  }
  return result(
    'A.3.7', 'Stress testing',
    [
      costStatus(e),
      e.delay.ok ? check(e.delay.value.sharpe, (s) => s > 0) : 'NO CONCLUYENTE',
      windows.length === 0 ? 'NO CONCLUYENTE' : combine(windows.map(windowStatus)),
      e.intrabarPolicy === WORST_CASE_INTRABAR ? 'PASS' : 'FAIL',
    ],
    { sharpe_retraso_una_vela: e.delay.ok ? e.delay.value.sharpe : null, ...windowValues, politica_dentro_de_la_vela: e.intrabarPolicy },
    'Costes ×2 como A.3.3; con retraso de una vela, Sharpe > 0; en cada ventana de crisis en validación, caída ≤ 10 % y rentabilidad ≥ BTC; peor caso dentro de la vela',
    [
      reason(e.delay),
      windows.length === 0 ? 'ninguna ventana de crisis cae en los tramos de validación' : null,
      windows.some((w) => w.coverage === 'parcial') ? 'una ventana de crisis cae solo en parte en los tramos de validación' : null,
    ],
  );
}

function sensitivityStatus(e: CriteriaEvidence): CriterionStatus {
  if (!e.sensitivity.ok) return 'NO CONCLUYENTE';
  if (e.sharpe === null) return 'NO CONCLUYENTE';
  if (e.sharpe <= 0) return 'FAIL';
  const base = e.sharpe;
  return combine(e.sensitivity.value.map((v) => (v.sharpe.ok ? check(v.sharpe.value, (s) => s >= THRESHOLDS.sensitivityFloor * base) : 'NO CONCLUYENTE')));
}

function parameters(e: CriteriaEvidence): CriterionResult {
  const numeric = Object.entries(e.params).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  const tooPrecise = numeric.filter(([, v]) => significantDigits(v) > THRESHOLDS.maxSignificantDigits).map(([k]) => k);
  const values: Record<string, Value> = { parametros_con_mas_de_3_cifras: tooPrecise.join(', ') };
  if (e.sensitivity.ok) {
    for (const v of e.sensitivity.value) values[`sharpe_${v.param}_${v.step > 0 ? '+' : ''}${String(v.step * 100)}%`] = v.sharpe.ok ? v.sharpe.value : null;
  }
  const sweep = e.sweep === null ? [] : e.sweep.map((s) => check(s.stability, (x) => x >= THRESHOLDS.minSweepStability));
  for (const s of e.sweep ?? []) values[`estabilidad_barrido_${s.param}`] = s.stability;
  const failed = e.sensitivity.ok ? e.sensitivity.value.filter((v) => !v.sharpe.ok).map((v) => `${v.param} ${String(v.step * 100)} %: ${v.sharpe.ok ? '' : v.sharpe.reason}`) : [];
  return result(
    'A.3.8', 'Estabilidad de parámetros',
    [sensitivityStatus(e), tooPrecise.length === 0 ? 'PASS' : 'FAIL', ...sweep],
    { sharpe_base: e.sharpe, ...values },
    'Con ±25 % y ±50 % en cada parámetro, Sharpe sin cambio de signo y ≥ la mitad; ≤ 3 cifras significativas; en un barrido, el elegido se mueve ≤ 1 punto en ≥ 2/3 de los cambios de tramo',
    [reason(e.sensitivity), failed.length > 0 ? `variantes sin medir: ${failed.join(', ')}` : null, e.sweep === null ? 'sin barrido: la estabilidad del elegido en train no aplica' : null],
  );
}

/** Lo que necesita A.3.9: lo de `regimeMeasures` (windows.ts). */
export type RegimeEvidence = Pick<CriteriaEvidence, 'bearEpisodes' | 'bull' | 'lateral' | 'regimeExposure' | 'regimeOwn'>;

/** ln(1 + s) frente a `share` · ln(1 + b) si el benchmark se mueve en el sentido `sign`; si no, la estrategia no puede perder. */
function logRule(s: number, b: number, sign: 1 | -1, share: number): boolean {
  return sign * b > 0 ? Math.log1p(s) >= share * Math.log1p(b) : s >= 0;
}

/** ln(1 + s) / ln(1 + b): la parte del crecimiento logarítmico del benchmark; null si no se puede calcular. */
function logShare(s: number | null, b: number | null): number | null {
  if (s === null || b === null || b === 0) return null;
  const share = Math.log1p(s) / Math.log1p(b);
  return Number.isFinite(share) ? share : null;
}

/**
 * Estados de A.3.9 con un perfil, en orden: cada episodio bajista, el alcista y el lateral (ADR 0042). Bajista y alcista
 * comparan el crecimiento logarítmico, ln(1 + r), con el de BTC escalado por la exposición de la estrategia en toda la
 * serie y, si la tuvo, por la que tuvo en esos mismos periodos, sin polvo; vale la más exigente de las dos. Sin ninguna
 * exposición no se comparan. El lateral es un umbral absoluto.
 */
export function regimeStatuses(profile: RegimeProfile, e: RegimeEvidence): CriterionStatus[] {
  const bearStatus = (w: WindowResult): CriterionStatus => {
    const b = w.benchmarkReturn;
    return w.coverage !== 'dentro' || b === null ? 'NO CONCLUYENTE' : check(w.strategyReturn, (s) => logRule(s, b, -1, profile.bearShare));
  };
  const bullStatus = (r: RegimeReturns): CriterionStatus => {
    const b = r.benchmarkReturn;
    return b === null ? 'NO CONCLUYENTE' : check(r.strategyReturn, (s) => logRule(s, b, 1, profile.bullCapture));
  };
  const exposed = e.regimeExposure !== null;
  const statuses: CriterionStatus[] = e.bearEpisodes.map((w, k) => {
    const own = e.regimeOwn.bear[k] ?? null;
    return exposed ? combine([bearStatus(w), own === null ? 'PASS' : bearStatus(own.result)]) : 'NO CONCLUYENTE';
  });
  const ownBull = e.regimeOwn.bull;
  statuses.push(exposed ? combine([bullStatus(e.bull), ownBull === null ? 'PASS' : bullStatus(ownBull.result)]) : 'NO CONCLUYENTE');
  const floor = profile.lateral.kind === 'maxLoss' ? -profile.lateral.value : profile.lateral.value;
  statuses.push(check(e.lateral.strategyAnnualized, (s) => s >= floor));
  return statuses;
}

function regimes(e: CriteriaEvidence): CriterionResult {
  const profile = FAMILY_PROFILES.get(e.family);
  if (profile === undefined) {
    return result('A.3.9', 'Regímenes', ['NO CONCLUYENTE'], { familia: e.family }, 'Perfil por régimen de su familia (tabla A.3.9)', [`la familia ${e.family} no tiene perfil en la tabla A.3.9`]);
  }
  const values: Record<string, Value> = { perfil: profile.name, exposicion_benchmark: e.regimeExposure };
  const bearShareOf = (w: WindowResult): number | null => (w.benchmarkReturn !== null && w.benchmarkReturn < 0 ? logShare(w.strategyReturn, w.benchmarkReturn) : null);
  for (const [k, w] of e.bearEpisodes.entries()) {
    const own = e.regimeOwn.bear[k] ?? null;
    values[`bajista_${w.id}_estrategia`] = w.strategyReturn;
    values[`bajista_${w.id}_benchmark`] = w.benchmarkReturn;
    values[`bajista_${w.id}_fraccion_log`] = bearShareOf(w);
    values[`bajista_${w.id}_exposicion`] = own?.exposure ?? null;
    values[`bajista_${w.id}_fraccion_log_propia`] = own === null ? null : bearShareOf(own.result);
  }
  const bull = e.bull.benchmarkReturn;
  const ownBull = e.regimeOwn.bull;
  const bullShareOf = (r: RegimeReturns): number | null => (r.benchmarkReturn !== null && r.benchmarkReturn > 0 ? logShare(r.strategyReturn, r.benchmarkReturn) : null);
  const bear = `pierde ≤ ${String(profile.bearShare * 100)} % de lo que pierde el benchmark en cada episodio`;
  const lateral = profile.lateral.kind === 'maxLoss' ? `pérdida anualizada ≤ ${String(profile.lateral.value * 100)} %` : `rentabilidad anualizada ≥ ${String(profile.lateral.value * 100)} %`;
  return result(
    'A.3.9', 'Regímenes', regimeStatuses(profile, e),
    {
      ...values,
      alcista_estrategia: e.bull.strategyReturn, alcista_benchmark: bull, alcista_periodos: e.bull.periods,
      alcista_captura_log: bullShareOf(e.bull),
      alcista_exposicion: ownBull?.exposure ?? null,
      alcista_captura_log_propia: ownBull === null ? null : bullShareOf(ownBull.result),
      lateral_anualizada: e.lateral.strategyAnnualized, lateral_periodos: e.lateral.periods,
    },
    `${profile.name}, en crecimiento logarítmico frente a BTC escalado por la exposición de la estrategia en toda la serie y por la que tuvo en cada régimen, sin polvo, y vale la más exigente (ADR 0042): bajista, ${bear}; alcista, captura ≥ ${String(profile.bullCapture * 100)} %; lateral, ${lateral}`,
    [
      e.regimeExposure === null ? 'la estrategia nunca tiene posición: sin la exposición del benchmark no se comparan el bajista ni el alcista' : null,
      e.bearEpisodes.some((w) => w.coverage !== 'dentro') ? 'un episodio bajista no está entero fuera de muestra' : null,
      e.bull.periods === 0 ? 'sin periodos alcistas etiquetados' : null,
      e.lateral.periods === 0 ? 'sin periodos laterales etiquetados' : null,
    ],
  );
}

function versus(sharpe: number | null, calmar: number | null, other: { readonly sharpe: number | null; readonly calmar: number | null }): CriterionStatus {
  const s = other.sharpe;
  const c = other.calmar;
  if (s === null || c === null) return 'NO CONCLUYENTE';
  return combine([check(sharpe, (v) => v > s), check(calmar, (v) => v > c)]);
}

function buyAndHold(e: CriteriaEvidence): CriterionResult {
  const { btc, universe } = e.benchmarks;
  return result(
    'A.3.10', 'Buy-and-hold ajustado por riesgo',
    [versus(e.sharpe, e.calmar, btc), universe.ok ? versus(e.sharpe, e.calmar, universe.value) : 'NO CONCLUYENTE'],
    {
      sharpe: e.sharpe, calmar: e.calmar, btc_sharpe: btc.sharpe, btc_calmar: btc.calmar,
      equiponderado_sharpe: universe.ok ? universe.value.sharpe : null, equiponderado_calmar: universe.ok ? universe.value.calmar : null,
      ic95_exceso_sharpe_inferior: e.bootstrap.excessSharpe?.lower ?? null, ic95_exceso_sharpe_superior: e.bootstrap.excessSharpe?.upper ?? null,
    },
    'Sharpe y Calmar netos por encima de los del buy-and-hold de BTC y del equiponderado; el IC del exceso de Sharpe se informa',
    [reason(universe)],
  );
}

function interval(e: CriteriaEvidence): CriterionResult {
  const boot = e.bootstrap.sharpe?.lower;
  const longRun = e.intervalLongRun?.lower;
  // Decide el más bajo de los dos límites: el del bootstrap y el de la varianza a largo plazo (ADR 0038).
  const lower = boot === undefined || longRun === undefined ? null : Math.min(boot, longRun);
  return result(
    'A.3.11', 'Intervalo de confianza',
    [check(lower, (l) => l > 0)],
    {
      ic95_sharpe_inferior: e.bootstrap.sharpe?.lower ?? null,
      ic95_sharpe_superior: e.bootstrap.sharpe?.upper ?? null,
      ic95_sharpe_inferior_largo_plazo: e.intervalLongRun?.lower ?? null,
      ic95_sharpe_superior_largo_plazo: e.intervalLongRun?.upper ?? null,
      ic95_sharpe_inferior_que_decide: lower,
    },
    'Límite inferior del IC al 95 % del Sharpe > 0: el menor del bootstrap estacionario por bloques y del de la varianza a largo plazo con la autocorrelación (ADR 0038)',
  );
}

/** Si un control puede decidir: con el backtester, siempre; con el simulador, solo si su réplica se aleja ≤ 10 %. */
export function controlUsable(method: ControlMethod, deviation: number | null): boolean {
  return method === 'backtester' || (deviation !== null && deviation <= THRESHOLDS.maxReplicaDeviation);
}

function randomControl(e: CriteriaEvidence): CriterionResult {
  const c = e.randomControl;
  const usable = c.ok && controlUsable(c.value.method, c.value.deviation);
  const status = !c.ok || !usable || c.value.simulations < THRESHOLDS.minRandomSimulations ? 'NO CONCLUYENTE' : check(e.sharpe, (s) => s > c.value.p95);
  return result(
    'A.3.12', 'Control aleatorio',
    [status],
    {
      sharpe: e.sharpe, percentil_95: c.ok ? c.value.p95 : null, percentil_estrategia: c.ok ? c.value.percentile : null,
      simulaciones: c.ok ? c.value.simulations : null, metodo: c.ok ? c.value.method : null, replica: c.ok ? c.value.replica : null,
      desviacion_replica: c.ok ? c.value.deviation : null, percentil_95_simulador: c.ok ? c.value.simulatorP95 : null,
    },
    'Sharpe > percentil 95 de ≥ 1000 simulaciones con las mismas operaciones, duración, tamaño y costes; el simulador solo decide si su réplica se aleja ≤ 10 % del backtester',
    [
      reason(c),
      c.ok && c.value.simulations < THRESHOLDS.minRandomSimulations ? 'menos de 1000 simulaciones' : null,
      c.ok && !usable ? 'la réplica del simulador se aleja más de un 10 % y no se repitió con el backtester' : null,
      c.ok && c.value.method === 'backtester' ? 'repetido con el backtester real: la réplica del simulador se alejaba más de un 10 %' : null,
    ],
  );
}

function temporal(e: CriteriaEvidence): CriterionResult {
  const asset = e.withoutBestAsset;
  return result(
    'A.3.13', 'Estabilidad temporal y por activo',
    [check(e.withoutBestYear.sharpeAnnualized, (s) => s > 0), asset.ok ? check(asset.value.sharpe, (s) => s > 0) : 'NO CONCLUYENTE'],
    {
      mejor_ano: e.withoutBestYear.bestYear, sharpe_sin_mejor_ano: e.withoutBestYear.sharpeAnnualized,
      mejor_activo: asset.ok ? asset.value.asset : null, sharpe_sin_mejor_activo: asset.ok ? asset.value.sharpe : null,
    },
    'Sin el mejor año y sin el mejor activo, Sharpe > 0',
    [e.withoutBestYear.bestYear === null ? 'menos de dos años de validación' : null, reason(asset)],
  );
}

/** Sharpe de la estrategia menos la mediana de su control aleatorio; null sin Sharpe o sin control. */
function baseExcess(e: CriteriaEvidence): number | null {
  return e.sharpe === null || !e.randomControl.ok ? null : e.sharpe - e.randomControl.value.median;
}

function ablationStatus(e: CriteriaEvidence): CriterionStatus {
  const base = baseExcess(e);
  if (!e.ablation.ok || e.ablation.value.length === 0 || base === null) return 'NO CONCLUYENTE';
  // Un componente aporta si quitarlo baja el exceso sobre el control aleatorio de las mismas operaciones y duraciones:
  // así no cuenta como aportación lo que solo cambia la exposición (ADR 0037).
  return combine(e.ablation.value.map((v) => (v.excess.ok ? check(v.excess.value, (x) => x < base) : 'NO CONCLUYENTE')));
}

function ablation(e: CriteriaEvidence): CriterionResult {
  const values: Record<string, Value> = { sharpe_base: e.sharpe, exceso_base: baseExcess(e) };
  if (e.ablation.ok) {
    for (const v of e.ablation.value) {
      values[`sharpe_sin_${v.component}`] = v.sharpe.ok ? v.sharpe.value : null;
      values[`exceso_sin_${v.component}`] = v.excess.ok ? v.excess.value : null;
      values[`tiempo_en_mercado_sin_${v.component}`] = v.exposure?.timeInMarket ?? null;
      values[`exposicion_media_sin_${v.component}`] = v.exposure?.meanExposure ?? null;
    }
  }
  const alt = e.alternativeUniverse;
  const unmeasured = e.ablation.ok ? e.ablation.value.filter((v) => !v.excess.ok).map((v) => `${v.component}: ${v.excess.ok ? '' : v.excess.reason}`) : [];
  return result(
    'A.3.14', 'Ablación y universo alternativo',
    [ablationStatus(e), alt.ok ? check(alt.value.sharpe, (s) => s > 0) : 'NO CONCLUYENTE'],
    { ...values, universo_alternativo: alt.ok ? alt.value.symbols : null, sharpe_universo_alternativo: alt.ok ? alt.value.sharpe : null },
    'Quitar cada componente que queda baja el exceso de Sharpe sobre su control aleatorio, de sus mismas operaciones y duraciones (todos aportan, con la exposición controlada); con activos no usados para diseñarla, Sharpe > 0',
    [
      reason(e.ablation),
      reason(e.randomControl),
      e.ablation.ok && e.ablation.value.length === 0 ? 'la estrategia no declara ningún componente que se pueda quitar' : null,
      unmeasured.length > 0 ? `componentes sin medir: ${unmeasured.join(', ')}` : null,
      reason(alt),
    ],
  );
}

function smoke(e: CriteriaEvidence): CriterionResult {
  const { shifted, randomWalk } = e.smoke;
  return result(
    'A.3.15', 'Pruebas de humo',
    [
      !shifted.ok || !controlUsable(shifted.value.method, shifted.value.deviation) ? 'NO CONCLUYENTE' : shifted.value.median <= shifted.value.p95 ? 'PASS' : 'FAIL',
      !randomWalk.ok || !controlUsable(randomWalk.value.method, randomWalk.value.deviation) ? 'NO CONCLUYENTE' : check(randomWalk.value.sharpe, (s) => s <= randomWalk.value.p95),
    ],
    {
      senal_desplazada_mediana: shifted.ok ? shifted.value.median : null, senal_desplazada_p95: shifted.ok ? shifted.value.p95 : null,
      senal_desplazada_metodo: shifted.ok ? shifted.value.method : null,
      paseo_aleatorio_sharpe: randomWalk.ok ? randomWalk.value.sharpe : null, paseo_aleatorio_p95: randomWalk.ok ? randomWalk.value.p95 : null,
      paseo_aleatorio_metodo: randomWalk.ok ? randomWalk.value.method : null, paseo_aleatorio_desviacion_replica: randomWalk.ok ? randomWalk.value.deviation : null,
    },
    'Con la señal desplazada al azar y con un paseo aleatorio, el resultado no supera el percentil 95 del control aleatorio (con el simulador, solo si su réplica se aleja ≤ 10 %)',
    [reason(shifted), reason(randomWalk)],
  );
}

/** Evalúa A.3 entera. Fallar uno basta para RECHAZADA; sin fallos, uno sin medir da NO CONCLUYENTE. */
export function evaluateCriteria(e: CriteriaEvidence): CriteriaReport {
  const criteria = [
    walkForward(e), deflated(e), costs(e), drawdown(e), sample(e), pbo(e), stress(e), parameters(e),
    regimes(e), buyAndHold(e), interval(e), randomControl(e), temporal(e), ablation(e), smoke(e),
  ];
  const statuses = criteria.map((c) => c.status);
  const verdict: CriteriaVerdict = statuses.includes('FAIL') ? 'RECHAZADA' : statuses.includes('NO CONCLUYENTE') ? 'NO CONCLUYENTE' : 'CANDIDATA A TEST FINAL';
  return Object.freeze({ documents: FROZEN_DOCUMENTS, criteria: Object.freeze(criteria), verdict, notEvaluated: NOT_EVALUATED });
}
