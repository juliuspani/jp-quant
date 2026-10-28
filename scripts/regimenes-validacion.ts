// Validación de la condición por régimen de A.3.9 (ADR 0042), aprobada por la persona el 2026-10-21: caminos sintéticos
// nuevos, con una semilla distinta de la del diseño, medidos con el evaluador tal como queda (regimeMeasures y
// regimeStatuses, con la exposición sin polvo de cada periodo). El diseño y sus criterios están fijados en el ADR 0042
// antes de ejecutarla, y el mercado y las estrategias, en regimenes-sinteticos.ts. Solo datos sintéticos con semilla: no
// lee datos reales ni el registro.
//
// Uso: node scripts/regimenes-validacion.ts [caminos]
import { REGIME_PROFILES, regimeStatuses, type RegimeEvidence, type RegimeProfile } from '../src/analytics/criteria.ts';
import { drawdownOf } from '../src/analytics/performance.ts';
import { BEAR_EPISODES, regimeMeasures } from '../src/analytics/windows.ts';
import { seededRng } from '../src/kernel/random.ts';
import {
  COST, DOF, DRIFT, market, median, num, out, participation, pct, rate, regimeShares, run, VOL, type Latent, type Market, type Participation, type Run,
  type Size,
} from './regimenes-sinteticos.ts';

const PATHS = Number(process.argv[2] ?? 400);
const SEED = 2026_10_22; // la del diseño fue 2026_10_21
const MAX_DRAWDOWN = 0.1; // A.3.4
const NO_OWN: RegimeEvidence['regimeOwn'] = { bull: null, bear: BEAR_EPISODES.map(() => null) }; // B2 sin la condición

interface Evaluated {
  readonly b2: boolean[]; // cada parte de A.3.9 con B2 solo
  readonly condition: boolean[]; // con B2 y la condición por régimen
  readonly exposure: number | null;
}

/** Cada parte de A.3.9 (cada bajista, el alcista y el lateral), como mide el evaluador. */
function evaluate(profile: RegimeProfile, m: Market, r: Run): Evaluated {
  const e = regimeMeasures({ records: r.records, regimes: m.regimes, folds: m.folds, perYear: 365 });
  const evidence = { bearEpisodes: e.bearEpisodes, bull: e.bull, lateral: e.lateral, regimeExposure: e.regimeExposure };
  const flags = (own: RegimeEvidence['regimeOwn']): boolean[] => regimeStatuses(profile, { ...evidence, regimeOwn: own }).map((s) => s === 'PASS');
  return { b2: flags(NO_OWN), condition: flags(e.own), exposure: e.regimeExposure };
}

function drawdownOk(r: Run): boolean {
  const path = [1];
  for (const ret of r.returns) path.push((path.at(-1) ?? 1) * (1 + ret));
  return drawdownOf(path).maxDrawdown <= MAX_DRAWDOWN;
}

const markets = Array.from({ length: PATHS }, (_, i) => market(seededRng(SEED, `validacion-mercado-${String(i)}`)));
const shares = markets[0] === undefined ? { alcista: 0, lateral: 0, bajista: 0 } : regimeShares(markets[0]);
/** El tiempo en mercado de una participación, para la estrategia sin ventaja que la iguala. */
const timeIn = (p: Participation): number => shares.alcista * p.alcista + shares.lateral * p.lateral + shares.bajista * p.bajista;
const flat = (q: number): Participation => ({ alcista: q, lateral: q, bajista: q });
const all = (results: readonly Evaluated[], key: 'b2' | 'condition'): string => rate(results.map((x) => x[key].every(Boolean)));
const part = (results: readonly Evaluated[], key: 'b2' | 'condition', k: number): string => rate(results.map((x) => x[key][k] ?? false));

out(`Validación de la condición por régimen de A.3.9 (ADR 0042): ${String(PATHS)} caminos de 2016 a 2025, semilla ${String(SEED)}`);
out(`BTC sintético: t de Student (${String(DOF)} g. l.), ${pct(VOL)} diario; deriva log por año ${String(DRIFT.alcista)} / ${String(DRIFT.bajista)} / ${String(DRIFT.lateral)}`);

// 1. Las trampas de la comprobación de participación: las mismas rachas en cada camino para todos los tamaños.
const sizes: readonly { readonly label: string; readonly size: Size; readonly dust: (latent: Latent) => boolean }[] = [
  { label: '0,10 en todo (referencia)', size: () => 0.1, dust: () => false },
  { label: '0,001 en todo (benchmark casi nulo)', size: () => 0.001, dust: () => false },
  { label: '0,10 en alcista y polvo marcado fuera', size: (l) => (l === 'alcista' ? 0.1 : 0.001), dust: (l) => l !== 'alcista' },
  { label: '0,10 en alcista y 0,03 fuera', size: (l) => (l === 'alcista' ? 0.1 : 0.03), dust: () => false },
  { label: '0,10 en alcista y 0,05 fuera', size: (l) => (l === 'alcista' ? 0.1 : 0.05), dust: () => false },
];
const cases: readonly [RegimeProfile, readonly number[]][] = [[REGIME_PROFILES.trend, [0.2, 0.4]], [REGIME_PROFILES.meanReversion, [0.1, 0.2]]];
out('\nTrampas: perfil | participación en alcista | tamaño | exposición mediana | alcista: B2 · con la condición | A.3.9: B2 · con la condición');
for (const [profile, levels] of cases) {
  for (const p of levels) {
    for (const s of sizes) {
      const results = markets.map((m, i) => {
        const inside = participation(m, { alcista: p, lateral: 0.9, bajista: 0.9 }, 30, seededRng(SEED, `validacion-participacion-${String(p)}-${String(i)}`));
        return evaluate(profile, m, run(m, inside, s.size, 0, s.dust));
      });
      const bull = BEAR_EPISODES.length;
      out(`${profile.name} | ${String(p)} | ${s.label} | ${num(median(results.map((x) => x.exposure)))} | ${part(results, 'b2', bull)} · ${part(results, 'condition', bull)} | ${all(results, 'b2')} · ${all(results, 'condition')}`);
    }
  }
}

// 2. Las estrategias con ventaja y sin ella del estudio de diseño, con sus mismos parámetros.
interface Strategy {
  readonly name: string;
  readonly p: Participation;
  readonly mean: number;
  readonly x: number;
  readonly edge: number; // lo que la posición gana sobre BTC cada día que está dentro
  readonly profiles: readonly RegimeProfile[];
}
const trend: Participation = { alcista: 0.8, lateral: 0.5, bajista: 0.2 };
const reversion: Participation = { alcista: 0.35, lateral: 0.3, bajista: 0.05 };
const REBOUND = (2 * 2 * COST) / 5; // los rebotes de la reversión: dos veces sus costes de ida y vuelta en una racha de 5 días
const strategies: readonly Strategy[] = [
  { name: 'Tendencia con ventaja, x = 0,10', p: trend, mean: 30, x: 0.1, edge: 0, profiles: [REGIME_PROFILES.trend, REGIME_PROFILES.priceVolume, REGIME_PROFILES.crossSectional] },
  { name: 'Tendencia con ventaja, x = 0,25', p: trend, mean: 30, x: 0.25, edge: 0, profiles: [REGIME_PROFILES.trend] },
  { name: `Sin ventaja, ${pct(timeIn(trend))} dentro y rachas de 30 días`, p: flat(timeIn(trend)), mean: 30, x: 0.1, edge: 0, profiles: [REGIME_PROFILES.trend] },
  { name: 'Reversión con ventaja, x = 0,10', p: reversion, mean: 5, x: 0.1, edge: REBOUND, profiles: [REGIME_PROFILES.meanReversion] },
  { name: `Sin ventaja, ${pct(timeIn(reversion))} dentro y rachas de 5 días`, p: flat(timeIn(reversion)), mean: 5, x: 0.1, edge: 0, profiles: [REGIME_PROFILES.meanReversion] },
];
out('\nEstrategias: estrategia | perfil | medida | bajista 2018 · 2022 | alcista | lateral | A.3.9 | A.3.9 y caída ≤ 10 %');
for (const [row, s] of strategies.entries()) {
  const runs = markets.map((m, i) => ({ m, r: run(m, participation(m, s.p, s.mean, seededRng(SEED, `validacion-familia-${String(row)}-${String(i)}`)), s.x, s.edge) }));
  const drawdowns = runs.map(({ r }) => drawdownOk(r));
  out(`${s.name}: caída ≤ 10 % en ${rate(drawdowns)}`);
  for (const profile of s.profiles) {
    const results = runs.map(({ m, r }) => evaluate(profile, m, r));
    for (const [kind, key] of [['B2', 'b2'], ['con la condición', 'condition']] as const) {
      const joint = rate(results.map((x, i) => x[key].every(Boolean) && (drawdowns[i] ?? false)));
      out(`  ${profile.name} | ${kind} | ${part(results, key, 0)} · ${part(results, key, 1)} | ${part(results, key, 2)} | ${part(results, key, 3)} | ${all(results, key)} | ${joint}`);
    }
  }
}
