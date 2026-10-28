// Estudio sintético de los umbrales de A.3.9 con el benchmark del ADR 0042 (auditoría quant Q-02; parte 7 del plan de la
// auditoría). Solo datos sintéticos con semilla: no lee datos reales ni el registro. El diseño está fijado en el ADR 0042,
// y el mercado y las estrategias sintéticas, en regimenes-sinteticos.ts.
//
// Para cada estrategia se mide con qué frecuencia pasa cada parte de A.3.9 con tres medidas:
// - la congelada: rentabilidades compuestas frente a BTC con todo el capital;
// - B1: en logaritmos, frente a BTC escalado al tope por par de A.4.5;
// - B2: en logaritmos, frente a BTC con la exposición de la estrategia, sin la condición por régimen.
// También A.3.9 junto con la caída máxima de A.3.4. Los bloques 4 y 5 son la comprobación de participación que pidió la
// persona al aprobar B2 (2026-10-21), con la condición candidata fijada en el ADR 0042 antes de ejecutarlos y calculada
// aquí a mano, como en el diseño. La condición aprobada, tal como la mide el evaluador, la valida regimenes-validacion.ts.
//
// Uso: node scripts/regimenes-alcanzables.ts [caminos]
import { periodInstant, type PeriodRecord } from '../src/analytics/breakdown.ts';
import { REGIME_PROFILES, regimeStatuses, type RegimeEvidence, type RegimeProfile } from '../src/analytics/criteria.ts';
import { drawdownOf } from '../src/analytics/performance.ts';
import { regimeAt } from '../src/analytics/regime.ts';
import { BEAR_EPISODES, benchmarkExposure, regimeReturns, scaledBenchmark, windowResult } from '../src/analytics/windows.ts';
import { seededRng, type Rng } from '../src/kernel/random.ts';
import {
  COST, DOF, DRIFT, market, median, num, out, participation, pct, rate, regimeShares, run, VOL, type Market, type Participation, type Run, type Size,
} from './regimenes-sinteticos.ts';

const PATHS = Number(process.argv[2] ?? 400);
const SEED = 2026_10_21;
const CAP = 0.25; // B1: el tope por par de A.4.5, con un solo par
const MAX_DRAWDOWN = 0.1; // A.3.4
const NO_OWN: RegimeEvidence['regimeOwn'] = { bull: null, bear: BEAR_EPISODES.map(() => null) }; // B2 sin la condición

/** La exposición de cada marca entre el patrimonio, como la medía este estudio: con el polvo, al cerrar el periodo. */
function fractions(samples: Run['samples']): number[] {
  return samples.map((s) => (s.equity > 0 ? s.exposure / s.equity : 0));
}

/** Las partes de A.3.9 frente a BTC escalado por `exposure` (null: con todo el capital, sin comparar). */
function measured(m: Market, r: Run, exposure: number | null): RegimeEvidence {
  const records = exposure === null ? r.records : scaledBenchmark(r.records, exposure);
  return {
    regimeExposure: exposure,
    bearEpisodes: BEAR_EPISODES.map((w) => windowResult(w, records, m.folds)),
    bull: regimeReturns(records, m.regimes, 'ALCISTA', 365),
    lateral: regimeReturns(records, m.regimes, 'LATERAL', 365),
    regimeOwn: NO_OWN,
  };
}

/** La regla congelada de hoy: rentabilidades compuestas frente a BTC con todo el capital. Un valor por parte de A.3.9. */
function frozenPasses(profile: RegimeProfile, e: RegimeEvidence): boolean[] {
  const rule = (s: number | null, b: number | null, sign: 1 | -1, share: number): boolean =>
    s !== null && b !== null && s >= (sign * b > 0 ? share * b : 0);
  const floor = profile.lateral.kind === 'maxLoss' ? -profile.lateral.value : profile.lateral.value;
  return [
    ...e.bearEpisodes.map((w) => rule(w.strategyReturn, w.benchmarkReturn, -1, profile.bearShare)),
    rule(e.bull.strategyReturn, e.bull.benchmarkReturn, 1, profile.bullCapture),
    e.lateral.strategyAnnualized !== null && e.lateral.strategyAnnualized >= floor,
  ];
}

function passes(profile: RegimeProfile, e: RegimeEvidence): boolean[] {
  return regimeStatuses(profile, e).map((s) => s === 'PASS');
}

/** ln(1 + s) / ln(1 + b), o s / b con la regla congelada; null si el benchmark no se mueve en el sentido `sign`. */
function share(s: number | null, b: number | null, sign: 1 | -1, log: boolean): number | null {
  if (s === null || b === null || !(sign * b > 0)) return null;
  return log ? Math.log1p(s) / Math.log1p(b) : s / b;
}

const markets = Array.from({ length: PATHS }, (_, i) => market(seededRng(SEED, `mercado-${String(i)}`)));
const shares = markets[0] === undefined ? { alcista: 0, lateral: 0, bajista: 0 } : regimeShares(markets[0]);
/** El tiempo en mercado de una participación, para la estrategia sin ventaja que la iguala. */
const timeIn = (p: Participation): number => shares.alcista * p.alcista + shares.lateral * p.lateral + shares.bajista * p.bajista;
const flat = (q: number): Participation => ({ alcista: q, lateral: q, bajista: q });
const profileWith = (capture: number, bear: number): RegimeProfile => ({ ...REGIME_PROFILES.trend, name: 'umbral', bullCapture: capture, bearShare: bear });

out(`A.3.9 con datos sintéticos (ADR 0042): ${String(PATHS)} caminos de 2016 a 2025, semilla ${String(SEED)}`);
out(`BTC sintético: t de Student (${String(DOF)} g. l.), ${pct(VOL)} diario; deriva log por año ${String(DRIFT.alcista)} / ${String(DRIFT.bajista)} / ${String(DRIFT.lateral)}`);

// 1. Captura del alcista según la participación en alcista (x = 0,10; rachas de 30 días; el resto al 50 %).
out('\nAlcista: participación en alcista | captura mediana (congelada · B1 · B2) | B2: P(captura ≥ 25 %) · P(≥ 50 %) · P(≥ 100 %)');
const bullRows: { readonly label: string; readonly inside: (m: Market, rng: Rng) => boolean[] }[] = [
  ...[0.2, 0.4, 0.6, 0.8, 1].map((p) => ({ label: String(p), inside: (m: Market, rng: Rng) => participation(m, { alcista: p, lateral: 0.5, bajista: 0.5 }, 30, rng) })),
  { label: 'solo con la etiqueta ALCISTA', inside: (m: Market) => m.days.map((d) => d.trend === 'ALCISTA') },
];
for (const [row, spec] of bullRows.entries()) {
  const frozen: (number | null)[] = [];
  const b1: (number | null)[] = [];
  const b2: (number | null)[] = [];
  const at: Record<number, boolean[]> = { 0.25: [], 0.5: [], 1: [] };
  for (const [i, m] of markets.entries()) {
    const r = run(m, spec.inside(m, seededRng(SEED, `alcista-${String(row)}-${String(i)}`)), 0.1);
    const full = measured(m, r, 1);
    const capped = measured(m, r, CAP);
    const own = measured(m, r, benchmarkExposure(fractions(r.samples)));
    frozen.push(share(full.bull.strategyReturn, full.bull.benchmarkReturn, 1, false));
    b1.push(share(capped.bull.strategyReturn, capped.bull.benchmarkReturn, 1, true));
    b2.push(share(own.bull.strategyReturn, own.bull.benchmarkReturn, 1, true));
    for (const capture of [0.25, 0.5, 1]) at[capture]?.push(passes(profileWith(capture, 0.5), own)[2] ?? false);
  }
  out(`${spec.label} | ${num(median(frozen))} · ${num(median(b1))} · ${num(median(b2))} | ${rate(at[0.25] ?? [])} · ${rate(at[0.5] ?? [])} · ${rate(at[1] ?? [])}`);
}

// 2. Pérdida en cada bajista según la participación en bajista (x = 0,10; rachas de 30 días; el resto al 50 %).
out('\nBajista (2018 y 2022 juntos): participación en bajista | fracción de la pérdida mediana (congelada · B1 · B2) | B2: P(pierde ≤ 25 %) · P(≤ 50 %)');
for (const [row, p] of [0, 0.1, 0.2, 0.4, 0.6].entries()) {
  const frozen: (number | null)[] = [];
  const b1: (number | null)[] = [];
  const b2: (number | null)[] = [];
  const at: Record<number, boolean[]> = { 0.25: [], 0.5: [] };
  for (const [i, m] of markets.entries()) {
    const r = run(m, participation(m, { alcista: 0.5, lateral: 0.5, bajista: p }, 30, seededRng(SEED, `bajista-${String(row)}-${String(i)}`)), 0.1);
    const full = measured(m, r, 1);
    const capped = measured(m, r, CAP);
    const own = measured(m, r, benchmarkExposure(fractions(r.samples)));
    for (const [k, w] of own.bearEpisodes.entries()) {
      frozen.push(share(full.bearEpisodes[k]?.strategyReturn ?? null, full.bearEpisodes[k]?.benchmarkReturn ?? null, -1, false));
      b1.push(share(capped.bearEpisodes[k]?.strategyReturn ?? null, capped.bearEpisodes[k]?.benchmarkReturn ?? null, -1, true));
      b2.push(share(w.strategyReturn, w.benchmarkReturn, -1, true));
    }
    for (const bear of [0.25, 0.5]) at[bear]?.push(...passes(profileWith(0.5, bear), own).slice(0, own.bearEpisodes.length));
  }
  out(`${String(p)} | ${num(median(frozen))} · ${num(median(b1))} · ${num(median(b2))} | ${rate(at[0.25] ?? [])} · ${rate(at[0.5] ?? [])}`);
}

// 3. A.3.9 completo, por familia, y con la caída máxima de A.3.4.
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
out('\nA.3.9 por familia: estrategia | perfil | medida | bajista 2018 · 2022 | alcista | lateral | A.3.9 | A.3.9 y caída ≤ 10 %');
for (const [row, s] of strategies.entries()) {
  const runs = markets.map((m, i) => ({ m, r: run(m, participation(m, s.p, s.mean, seededRng(SEED, `familia-${String(row)}-${String(i)}`)), s.x, s.edge) }));
  const drawdownOk = runs.map(({ r }) => {
    const path = [1];
    for (const ret of r.returns) path.push((path.at(-1) ?? 1) * (1 + ret));
    return drawdownOf(path).maxDrawdown <= MAX_DRAWDOWN;
  });
  const exposures = runs.map(({ r }) => benchmarkExposure(fractions(r.samples)));
  out(`${s.name}: exposición del benchmark B2 mediana ${num(median(exposures))}; caída ≤ 10 % en ${rate(drawdownOk)}`);
  for (const profile of s.profiles) {
    const kinds: readonly [string, (m: Market, r: Run) => boolean[]][] = [
      ['congelada', (m, r) => frozenPasses(profile, measured(m, r, 1))],
      ['B1', (m, r) => passes(profile, measured(m, r, CAP))],
      ['B2', (m, r) => passes(profile, measured(m, r, benchmarkExposure(fractions(r.samples))))],
    ];
    for (const [kind, evaluate] of kinds) {
      const parts = runs.map(({ m, r }) => evaluate(m, r));
      const all = parts.map((p) => p.every(Boolean));
      const column = (k: number): string => rate(parts.map((p) => p[k] ?? false));
      out(`  ${profile.name} | ${kind} | ${column(0)} · ${column(1)} | ${column(2)} | ${column(3)} | ${rate(all)} | ${rate(all.map((a, i) => a && (drawdownOk[i] ?? false)))}`);
    }
  }
}

/**
 * Cada parte de A.3.9 con B2 (`b2`); con la condición candidata, que exige además la captura frente a BTC con la
 * exposición que la estrategia tuvo en los periodos alcistas (`bull`); y con la misma condición también en cada bajista,
 * con la exposición de ese episodio (`both`). Sin posición en esos periodos, la condición no añade nada.
 */
function conditioned(profile: RegimeProfile, m: Market, r: Run): { readonly b2: boolean[]; readonly bull: boolean[]; readonly both: boolean[] } {
  const e = measured(m, r, benchmarkExposure(fractions(r.samples)));
  const b2 = passes(profile, e);
  const own = (inside: (record: PeriodRecord) => boolean): RegimeEvidence | null => {
    const exposure = benchmarkExposure(fractions(r.samples).filter((_, k) => {
      const record = r.records[k];
      return record !== undefined && inside(record);
    }));
    return exposure === null ? null : measured(m, r, exposure);
  };
  const n = e.bearEpisodes.length;
  const inBull = own((record) => regimeAt(m.regimes, record.start)?.trend === 'ALCISTA');
  const bullExtra = inBull === null || (passes(profile, inBull)[n] ?? false);
  const bull = b2.map((p, k) => (k === n ? p && bullExtra : p));
  const both = bull.map((p, k) => {
    const w = BEAR_EPISODES[k];
    if (k >= n || w === undefined) return p;
    const inEpisode = own((record) => periodInstant(record) >= w.from && periodInstant(record) < w.to);
    return p && (inEpisode === null || (passes(profile, inEpisode)[k] ?? false));
  });
  return { b2, bull, both };
}

// 4. Participación (la persona, 2026-10-21): ¿pasa A.3.9 una estrategia fuera de la mayor parte del alcista porque su
// benchmark, escalado por su propia exposición, es casi nulo? Fuera del alcista todas están dentro el 90 % del tiempo,
// con las mismas rachas de 30 días en cada camino; solo cambia el tamaño.
const sizes: readonly [string, Size][] = [
  ['0,10 en todo (referencia)', () => 0.1],
  ['0,001 en todo (benchmark casi nulo)', () => 0.001],
  ['0,10 en alcista y polvo (0,001) fuera', (l) => (l === 'alcista' ? 0.1 : 0.001)],
  ['0,10 en alcista y 0,03 fuera', (l) => (l === 'alcista' ? 0.1 : 0.03)],
  ['0,10 en alcista y 0,05 fuera', (l) => (l === 'alcista' ? 0.1 : 0.05)],
];
const cases: readonly [RegimeProfile, readonly number[]][] = [[REGIME_PROFILES.trend, [0.2, 0.4]], [REGIME_PROFILES.meanReversion, [0.1, 0.2]]];
out('\nParticipación: perfil | participación en alcista | tamaño | exposición B2 mediana | alcista: B2 · con la condición | A.3.9: B2 · con la condición · también en bajista');
for (const [profile, levels] of cases) {
  for (const p of levels) {
    for (const [label, size] of sizes) {
      const results = markets.map((m, i) => {
        const r = run(m, participation(m, { alcista: p, lateral: 0.9, bajista: 0.9 }, 30, seededRng(SEED, `participacion-${String(p)}-${String(i)}`)), size);
        return { exposure: benchmarkExposure(fractions(r.samples)), ...conditioned(profile, m, r) };
      });
      const bull = (key: 'b2' | 'bull'): string => rate(results.map((x) => x[key][2] ?? false));
      const all = (key: 'b2' | 'bull' | 'both'): string => rate(results.map((x) => x[key].every(Boolean)));
      out(`${profile.name} | ${String(p)} | ${label} | ${num(median(results.map((x) => x.exposure)))} | ${bull('b2')} · ${bull('bull')} | ${all('b2')} · ${all('bull')} · ${all('both')}`);
    }
  }
}

// 5. La condición en las estrategias del bloque 3, con los mismos caminos: no debería quitarles A.3.9 a las que tienen ventaja.
out('\nLa condición en las estrategias del bloque 3: estrategia | perfil | alcista: B2 · con la condición | A.3.9: B2 · con la condición · también en bajista');
for (const [row, s] of strategies.entries()) {
  const runs = markets.map((m, i) => ({ m, r: run(m, participation(m, s.p, s.mean, seededRng(SEED, `familia-${String(row)}-${String(i)}`)), s.x, s.edge) }));
  for (const profile of s.profiles) {
    const results = runs.map(({ m, r }) => conditioned(profile, m, r));
    const bull = (key: 'b2' | 'bull'): string => rate(results.map((x) => x[key][2] ?? false));
    const all = (key: 'b2' | 'bull' | 'both'): string => rate(results.map((x) => x[key].every(Boolean)));
    out(`${s.name} | ${profile.name} | ${bull('b2')} · ${bull('bull')} | ${all('b2')} · ${all('bull')} · ${all('both')}`);
  }
}
