// Vista de investigación del dashboard (paso 41C): una proyección de solo lectura del Experiment Registry y de las salidas
// guardadas de los experimentos. monitoring/ no importa research/ (ARCHITECTURE.md §4.2): app/ lee y comprueba el registro
// y entrega aquí datos planos. Nada de esto lanza un backtest (INV-14a): solo cuenta lo que ya está guardado.
// - Cada experimento es un punto de la esfera, con el color de su desenlace.
// - La N global es la suma de pruebas de todas las familias, también las fallidas, abortadas o invalidadas (quant-research §8).
// - El embudo cuenta, en el orden de A.3, cuántos experimentos superan todos los criterios hasta cada uno.
// - Las curvas del control aleatorio solo existen si el experimento las guardó; si no, la página lo dice.
import { expectedMaxSharpe } from '../analytics/statistics.ts';
import type { UtcMillis } from '../shared/time.ts';
import { t } from './i18n.ts';
import { DashboardError } from './journal.ts';

export const OUTCOMES = ['aceptado', 'rechazado', 'no concluyente', 'abortado', 'en curso'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const CRITERION_STATUSES = ['PASS', 'FAIL', 'NO CONCLUYENTE'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/** Criterios congelados de A.3 (docs/PROMOTION_CRITERIA.md), en su orden, con los nombres de analytics/criteria.ts. */
export const CRITERIA: readonly { readonly id: string; readonly label: string; readonly labelEn: string }[] = [
  { id: 'A.3.1', label: 'Fuera de muestra y walk-forward', labelEn: 'Out of sample and walk-forward' },
  { id: 'A.3.2', label: 'Deflated Sharpe', labelEn: 'Deflated Sharpe' },
  { id: 'A.3.3', label: 'Costes realistas y con margen', labelEn: 'Realistic costs, with margin' },
  { id: 'A.3.4', label: 'Drawdown máximo', labelEn: 'Maximum drawdown' },
  { id: 'A.3.5', label: 'Número mínimo de operaciones', labelEn: 'Minimum number of trades' },
  { id: 'A.3.6', label: 'PBO máximo', labelEn: 'Maximum PBO' },
  { id: 'A.3.7', label: 'Stress testing', labelEn: 'Stress testing' },
  { id: 'A.3.8', label: 'Estabilidad de parámetros', labelEn: 'Parameter stability' },
  { id: 'A.3.9', label: 'Regímenes', labelEn: 'Regimes' },
  { id: 'A.3.10', label: 'Buy-and-hold ajustado por riesgo', labelEn: 'Risk-adjusted buy-and-hold' },
  { id: 'A.3.11', label: 'Intervalo de confianza', labelEn: 'Confidence interval' },
  { id: 'A.3.12', label: 'Control aleatorio', labelEn: 'Random control' },
  { id: 'A.3.13', label: 'Estabilidad temporal y por activo', labelEn: 'Stability over time and assets' },
  { id: 'A.3.14', label: 'Ablación y universo alternativo', labelEn: 'Ablation and alternative universe' },
  { id: 'A.3.15', label: 'Pruebas de humo', labelEn: 'Smoke tests' },
];

/** Un experimento tal como lo deja el registro: su alta y su último cierre. */
export interface ResearchExperiment {
  readonly id: string;
  readonly family: string;
  readonly registeredAt: UtcMillis;
  readonly trials: number; // n_pruebas
  readonly state: 'registrado' | 'completado' | 'fallido' | 'abortado' | 'invalidado';
  readonly closedAt: UtcMillis | null;
  readonly verdict: string | null; // RECHAZADA, NO CONCLUYENTE, CANDIDATA A TEST FINAL, CANDIDATA A PAPER o null
  readonly criteria: Readonly<Record<string, CriterionStatus>>; // vacío si no se evaluó con A.3
}

/** Curvas guardadas del control aleatorio de un experimento (A.3.12), en base 100. */
export interface LuckCurves {
  readonly experimentId: string;
  readonly simulations: number; // colocaciones del control
  readonly percentile: number; // percentil de la estrategia en el control, de 0 a 100
  readonly strategy: readonly number[];
  readonly low: readonly number[]; // percentil 5 del control en cada instante
  readonly high: readonly number[]; // percentil 95
  readonly samples: readonly (readonly number[])[]; // algunas curvas del control, para el abanico
}

export interface ResearchInput {
  readonly experiments: readonly ResearchExperiment[];
  readonly luck: readonly LuckCurves[];
}

export interface ResearchPoint {
  readonly id: string;
  readonly family: string;
  readonly date: UtcMillis; // del cierre, o del alta si sigue abierto
  readonly trials: number;
  readonly outcome: Outcome;
}

export interface FunnelStep {
  readonly label: string;
  readonly criterion: string | null;
  readonly count: number;
}

export interface FailureRow {
  readonly criterion: string;
  readonly label: string;
  readonly fail: number;
  readonly inconclusive: number;
}

export interface ResearchSnapshot {
  readonly globalN: number;
  readonly points: readonly ResearchPoint[];
  readonly families: readonly { readonly family: string; readonly experiments: number; readonly trials: number }[];
  readonly outcomes: readonly { readonly outcome: Outcome; readonly count: number }[];
  readonly evaluated: number; // experimentos con todos los criterios de A.3 evaluados
  readonly funnel: readonly FunnelStep[];
  readonly failures: readonly FailureRow[]; // de más a menos veces que tumbó una estrategia
  readonly expectedMaxSharpe: number; // máximo esperado de N Sharpe sin habilidad, en desviaciones típicas
  readonly luck: readonly LuckCurves[];
  readonly events: readonly { readonly at: UtcMillis; readonly text: string }[]; // altas y cierres, lo más reciente primero
}

/** El desenlace de un experimento a partir de su estado y su veredicto. */
export function outcomeOf(e: Pick<ResearchExperiment, 'state' | 'verdict'>): Outcome {
  switch (e.state) {
    case 'registrado':
      return 'en curso';
    case 'fallido':
    case 'abortado':
    case 'invalidado':
      return 'abortado';
    case 'completado':
      if (e.verdict === 'RECHAZADA') return 'rechazado';
      if (e.verdict === 'CANDIDATA A TEST FINAL' || e.verdict === 'CANDIDATA A PAPER') return 'aceptado';
      return 'no concluyente';
  }
}

function checkLuck(luck: LuckCurves, ids: ReadonlySet<string>): void {
  const where = `control aleatorio de ${luck.experimentId}`;
  if (!ids.has(luck.experimentId)) throw new DashboardError(`${where}: el experimento no está en el registro`);
  const n = luck.strategy.length;
  if (n < 2) throw new DashboardError(`${where}: curva demasiado corta`);
  for (const [name, series] of [['low', luck.low], ['high', luck.high], ...luck.samples.map((s, i) => [`muestra ${String(i)}`, s] as const)] as const) {
    if (series.length !== n) throw new DashboardError(`${where}: ${name} no tiene la misma longitud que la estrategia`);
  }
  const all = [luck.strategy, luck.low, luck.high, ...luck.samples];
  if (!all.every((series) => series.every((v) => Number.isFinite(v)))) throw new DashboardError(`${where}: valores no finitos`);
  if (!luck.low.every((v, i) => v <= (luck.high[i] ?? -Infinity))) throw new DashboardError(`${where}: el percentil 5 supera al 95`);
  if (!(luck.percentile >= 0 && luck.percentile <= 100)) throw new DashboardError(`${where}: percentil fuera de [0, 100]`);
  if (!Number.isSafeInteger(luck.simulations) || luck.simulations < 1) throw new DashboardError(`${where}: número de simulaciones inválido`);
}

/** Construye la vista. Fail closed: datos incoherentes no se pintan. */
export function buildResearch(input: ResearchInput): ResearchSnapshot {
  const ids = new Set<string>();
  for (const e of input.experiments) {
    if (ids.has(e.id)) throw new DashboardError(`experimento repetido: ${e.id}`);
    ids.add(e.id);
    if (!Number.isSafeInteger(e.trials) || e.trials < 1) throw new DashboardError(`${e.id}: n_pruebas inválido`);
    for (const [criterion, status] of Object.entries(e.criteria)) {
      if (!CRITERIA.some((c) => c.id === criterion)) throw new DashboardError(`${e.id}: criterio desconocido ${criterion}`);
      if (!(CRITERION_STATUSES as readonly string[]).includes(status)) throw new DashboardError(`${e.id}: estado de criterio desconocido`);
    }
  }
  for (const luck of input.luck) checkLuck(luck, ids);

  const sorted = [...input.experiments].sort((a, b) => (a.id < b.id ? -1 : 1));
  const points = sorted.map((e) => ({ id: e.id, family: e.family, date: e.closedAt ?? e.registeredAt, trials: e.trials, outcome: outcomeOf(e) }));
  const globalN = sorted.reduce((total, e) => total + e.trials, 0);

  const families = new Map<string, { experiments: number; trials: number }>();
  for (const e of sorted) {
    const row = families.get(e.family) ?? { experiments: 0, trials: 0 };
    row.experiments += 1;
    row.trials += e.trials;
    families.set(e.family, row);
  }

  // Embudo: solo los evaluados con todos los criterios; en cada paso, los que superan ese criterio y todos los anteriores.
  const evaluated = sorted.filter((e) => CRITERIA.every((c) => Object.hasOwn(e.criteria, c.id)));
  const funnel: FunnelStep[] = [
    { label: t('En el registro', 'In the registry'), criterion: null, count: sorted.length },
    { label: t('Evaluados con los criterios congelados', 'Evaluated against the frozen criteria'), criterion: null, count: evaluated.length },
  ];
  let alive = evaluated;
  for (const c of CRITERIA) {
    alive = alive.filter((e) => e.criteria[c.id] === 'PASS');
    funnel.push({ label: t(c.label, c.labelEn), criterion: c.id, count: alive.length });
  }
  const failures = CRITERIA.map((c) => ({
    criterion: c.id, label: t(c.label, c.labelEn),
    fail: evaluated.filter((e) => e.criteria[c.id] === 'FAIL').length,
    inconclusive: evaluated.filter((e) => e.criteria[c.id] === 'NO CONCLUYENTE').length,
  })).filter((row) => row.fail + row.inconclusive > 0).sort((a, b) => b.fail - a.fail || b.inconclusive - a.inconclusive);

  const events = sorted.flatMap((e) => [
    { at: e.registeredAt, text: `${e.id} · ${t('registrado', 'registered')} · ${e.family}` },
    ...(e.closedAt === null ? [] : [{ at: e.closedAt, text: `${e.id} · ${e.state}${e.verdict === null ? '' : ` · ${e.verdict}`} · ${e.family}` }]),
  ]).sort((a, b) => b.at - a.at);

  return Object.freeze({
    globalN,
    points,
    families: [...families.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([family, row]) => ({ family, ...row })),
    outcomes: OUTCOMES.map((outcome) => ({ outcome, count: points.filter((p) => p.outcome === outcome).length })),
    evaluated: evaluated.length,
    funnel,
    failures,
    expectedMaxSharpe: globalN === 0 ? 0 : expectedMaxSharpe(globalN, 1),
    luck: input.luck,
    events,
  });
}
