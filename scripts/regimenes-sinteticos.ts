// Mercado y estrategias sintéticas de los estudios de A.3.9 (ADR 0042): el estudio de diseño (regimenes-alcanzables.ts) y
// su validación con caminos nuevos (regimenes-validacion.ts). Solo datos sintéticos con semilla; no lee datos reales ni
// el registro.
//
// Un BTC sintético diario con la volatilidad de BTC y un calendario fijo de regímenes (bajistas en 2018 y 2022, los
// episodios de A.3.9), etiquetado con regimen-precio@1 como en un experimento. Las estrategias tienen una ventaja fijada
// de antemano: están dentro una fracción del tiempo que depende del régimen real del camino.
import type { PeriodRecord } from '../src/analytics/breakdown.ts';
import { priceRegime, regimeAt, regimeSeries } from '../src/analytics/regime.ts';
import type { Candle } from '../src/kernel/market-data.ts';
import type { Rng } from '../src/kernel/random.ts';
import type { RegimeView } from '../src/kernel/regime.ts';
import { Decimal } from '../src/shared/decimal.ts';
import type { UtcMillis } from '../src/shared/time.ts';

const DAY = 86_400_000;
const LATENCY = 60_000; // la vela se recibe un minuto después de cerrar, como las marcas de la curva
export const VOL = 0.035; // desviación típica diaria de la log-rentabilidad
export const DOF = 5; // grados de libertad de la t de Student
export const DRIFT = { alcista: 0.8, bajista: -1, lateral: 0 } as const; // log-rentabilidad por año
export type Latent = keyof typeof DRIFT;
const SCHEDULE: ReadonlyMap<number, Latent> = new Map([
  [2015, 'lateral'], [2016, 'alcista'], [2017, 'alcista'], [2018, 'bajista'], [2019, 'lateral'], [2020, 'alcista'],
  [2021, 'alcista'], [2022, 'bajista'], [2023, 'lateral'], [2024, 'alcista'], [2025, 'lateral'],
]);
const FIRST_FOLD = 2016; // diez tramos de validación de un año; 2015 calienta el régimen
const LAST_FOLD = 2025;
export const COST = 0.0035; // por lado: comisión taker del 0,25 %, slippage del 0,05 % y medio spread del 0,05 %

export interface Market {
  readonly days: readonly { readonly open: UtcMillis; readonly latent: Latent; readonly ret: number; readonly trend: RegimeView['trend'] }[];
  readonly regimes: readonly RegimeView[];
  readonly folds: readonly { readonly from: UtcMillis; readonly to: UtcMillis }[];
}

function gaussian(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
}

/** t de Student con varianza 1. */
function studentT(rng: Rng): number {
  let chi = 0;
  for (let i = 0; i < DOF; i++) chi += gaussian(rng) ** 2;
  return (gaussian(rng) / Math.sqrt(chi / DOF)) * Math.sqrt((DOF - 2) / DOF);
}

function latentOf(t: UtcMillis): Latent {
  const latent = SCHEDULE.get(new Date(t).getUTCFullYear());
  if (latent === undefined) throw new Error(`sin régimen para ${new Date(t).toISOString()}`);
  return latent;
}

/** Un camino: velas diarias de 2015 a 2025, sus etiquetas y, de cada día de validación, su rentabilidad y su etiqueta. */
export function market(rng: Rng): Market {
  const start = Date.UTC(2015, 0, 1);
  const end = Date.UTC(LAST_FOLD + 1, 0, 1);
  const candles: Candle[] = [];
  const closes: number[] = [];
  let price = 10_000;
  for (let t = start; t < end; t += DAY) {
    price *= Math.exp(DRIFT[latentOf(t)] / 365 + VOL * studentT(rng));
    closes.push(price);
    const p = Decimal.parse(price.toFixed(8));
    candles.push({ symbol: 'BTC/EUR', timeframe: '1d', openTime: t, closeTime: t + DAY, open: p, high: p, low: p, close: p, volume: Decimal.parse('1') });
  }
  const regimes = regimeSeries(candles, priceRegime(), '1d');
  const first = (Date.UTC(FIRST_FOLD, 0, 1) - start) / DAY;
  const days = closes.slice(first).map((close, k) => {
    const open = Date.UTC(FIRST_FOLD, 0, 1) + k * DAY;
    // La etiqueta del periodo es la de la última vela cerrada al empezarlo: la del día anterior (point-in-time).
    const trend = regimeAt(regimes, open)?.trend ?? null;
    return { open, latent: latentOf(open), ret: close / (closes[first + k - 1] ?? Number.NaN) - 1, trend };
  });
  const folds = Array.from({ length: LAST_FOLD - FIRST_FOLD + 1 }, (_, i) => ({ from: Date.UTC(FIRST_FOLD + i, 0, 1), to: Date.UTC(FIRST_FOLD + i + 1, 0, 1) }));
  return { days, regimes, folds };
}

export type Participation = Readonly<Record<Latent, number>>;

/** Dentro o fuera cada día: rachas dentro de duración media `mean` días y, en cada régimen real, una fracción `p` dentro. */
export function participation(m: Market, p: Participation, mean: number, rng: Rng): boolean[] {
  let inside = rng.next() < p[m.days[0]?.latent ?? 'lateral'];
  return m.days.map((d) => {
    const q = p[d.latent];
    if (q >= 1) inside = true;
    else if (q <= 0) inside = false;
    else if (inside) inside = rng.next() >= 1 / mean;
    else inside = rng.next() < Math.min(1, q / (1 - q) / mean);
    return inside;
  });
}

export interface Run {
  // Con la exposición de cada periodo: la posición que no es polvo entre patrimonio al cerrarlo, como en el backtester
  readonly records: PeriodRecord[];
  readonly samples: { readonly equity: number; readonly exposure: number }[]; // en cada marca, con el polvo
  readonly returns: number[];
}

/** Fracción del patrimonio con la que entra, según el régimen real del día de la entrada. */
export type Size = (latent: Latent) => number;

/**
 * Un tramo por año: empieza en liquidez, entra con la fracción x del patrimonio al empezar un día «dentro», sale al
 * empezar uno «fuera» y vende lo abierto al acabar el tramo, pagando COST por lado. Mientras está dentro, la posición
 * gana lo que BTC más `edge` al día. Una posición abierta en un régimen que `dust` marca es polvo: vale y gana como las
 * demás, pero no cuenta en la exposición de los periodos. El buy-and-hold de BTC con todo el capital compra al empezar
 * cada tramo y vende al acabarlo, con los mismos costes.
 */
export function run(m: Market, inside: readonly boolean[], x: number | Size, edge = 0, dust: (latent: Latent) => boolean = () => false): Run {
  const size: Size = typeof x === 'number' ? () => x : x;
  const records: PeriodRecord[] = [];
  const samples: { equity: number; exposure: number }[] = [];
  const returns: number[] = [];
  let d = 0;
  for (const fold of m.folds) {
    let before = 1;
    let cash = 1;
    let position = 0;
    let isDust = false;
    let bench = 1 - COST; // el buy-and-hold, relativo al capital del tramo: compra al empezar
    let benchBefore = 1;
    let length = 0;
    for (; d < m.days.length && (m.days[d]?.open ?? Number.POSITIVE_INFINITY) < fold.to; d++, length++) {
      const day = m.days[d];
      if (day === undefined) break;
      if ((inside[d] ?? false) && position === 0) {
        position = size(day.latent) * before * (1 - COST);
        cash = before - size(day.latent) * before;
        isDust = dust(day.latent);
      } else if (!(inside[d] ?? false) && position > 0) {
        cash += position * (1 - COST);
        position = 0;
      }
      position *= 1 + day.ret + (position > 0 ? edge : 0);
      bench *= 1 + day.ret;
      const last = (m.days[d + 1]?.open ?? Number.POSITIVE_INFINITY) >= fold.to;
      const marked = cash + position;
      const value = last ? cash + position * (1 - COST) : marked;
      const benchValue = last ? bench * (1 - COST) : bench;
      records.push({
        start: length === 0 ? fold.from : day.open + LATENCY,
        end: day.open + DAY + LATENCY,
        ret: value / before - 1,
        benchmark: benchValue / benchBefore - 1,
        inMarket: position > 0,
        exposure: position > 0 && !isDust && marked > 0 ? position / marked : 0,
      });
      samples.push({ equity: marked, exposure: position });
      returns.push(value / before - 1);
      before = value;
      benchBefore = benchValue;
    }
  }
  return { records, samples, returns };
}

/** Fracción de los días de validación de cada régimen real: igual en todos los caminos (el calendario es fijo). */
export function regimeShares(m: Market): Participation {
  const share = (latent: Latent): number => m.days.filter((d) => d.latent === latent).length / Math.max(1, m.days.length);
  return { alcista: share('alcista'), lateral: share('lateral'), bajista: share('bajista') };
}

export function median(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 === 1 ? (v[mid] ?? null) : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2;
}

export const pct = (x: number): string => `${(100 * x).toFixed(1)} %`;
export const num = (x: number | null): string => (x === null ? '—' : x.toFixed(3));
export const rate = (flags: readonly boolean[]): string => pct(flags.filter(Boolean).length / Math.max(1, flags.length));
export const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
