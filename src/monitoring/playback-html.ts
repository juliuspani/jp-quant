// Tarjeta «Replay en marcha» (paso 49, ADR 0048): la curva del sistema frente a comprar y mantener, con las operaciones y
// las órdenes frenadas por el control de riesgo como marcas, y una lista de esos eventos en orden de tiempo.
// - Sin script se ve completa, como imagen fija. El script fijo de la página (page-script.ts) la reproduce: redibuja las
//   líneas paso a paso desde data-p y va mostrando marcas y eventos según su data-i (el paso de la curva en que ocurren).
// - Los datos van en atributos ya formateados y escapados: el script no formatea, solo copia texto (textContent).
// - Como mucho MAX_PLAYBACK_POINTS pasos: con diarios largos, la curva se muestrea a intervalos regulares.
import type { UtcMillis } from '../shared/time.ts';
import { Decimal } from '../shared/decimal.ts';
import type { CurveMark, DashboardSnapshot } from './dashboard.ts';
import { day, e, float, head, money, withCurrency } from './html-kit.ts';

export const MAX_PLAYBACK_POINTS = 400;
const W = 720;
const H = 240;
const LEFT = 40;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 14;

const KIND_LABEL: Readonly<Record<CurveMark['kind'], string>> = { buy: 'Compra', sell: 'Venta', risk: 'Risk' };

/** Índices de la curva que se dibujan: todos, o MAX_PLAYBACK_POINTS repartidos con el primero y el último. */
export function playbackIndices(n: number): number[] {
  if (n <= MAX_PLAYBACK_POINTS) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: MAX_PLAYBACK_POINTS }, (_, i) => Math.round((i * (n - 1)) / (MAX_PLAYBACK_POINTS - 1)));
}

/** El paso de la curva en que se ve una marca: el primero cuyo instante no es anterior al de la marca. */
export function stepOf(at: UtcMillis, times: readonly UtcMillis[]): number {
  const i = times.findIndex((t) => t >= at);
  return i < 0 ? times.length - 1 : i;
}

function detail(mark: CurveMark, quote: string): string {
  return mark.kind === 'risk' ? `<span class="mono">${e(mark.detail)}</span>` : withCurrency(money(mark.detail), quote);
}

export function playbackCard(s: DashboardSnapshot, benchName: string): string {
  const { at, equity, benchmark, marks } = s.curve;
  if (equity.length < 2) return '';
  const start = Decimal.parse(s.account.startingCash).toAnalysis();
  const idx = playbackIndices(equity.length);
  const times = idx.map((i) => at[i] ?? 0);
  const system = idx.map((i) => ((equity[i] ?? start) / start) * 100);
  const bench = benchmark === null ? null : idx.map((i) => ((benchmark[i] ?? start) / start) * 100);
  const all = bench === null ? system : [...system, ...bench];
  const lo = Math.min(...all, 100);
  const hi = Math.max(...all, 100);
  const pad = Math.max((hi - lo) * 0.08, 0.5);
  const x = (i: number): number => LEFT + (idx.length === 1 ? 0 : (i / (idx.length - 1)) * (W - LEFT - RIGHT));
  const y = (v: number): number => TOP + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - TOP - BOTTOM);
  const pts = (values: readonly number[]): string => values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const line = (cls: string, values: readonly number[]): string => {
    const p = pts(values);
    return `<polyline class="ln ${cls} pb-line" data-p="${p}" points="${p}"/>`;
  };
  const steps = marks.map((m) => stepOf(m.at, times));
  const shapes = marks.map((m, j) => {
    const i = steps[j] ?? 0;
    const cx = x(i).toFixed(1);
    const cy = y(system[i] ?? 100);
    const title = `<title>${e(`${day(m.at)} · ${KIND_LABEL[m.kind]} ${m.symbol ?? ''} · ${m.detail}`)}</title>`;
    if (m.kind === 'risk') {
      const yy = cy + 10;
      return `<path class="pb-mk mk-risk" data-i="${String(i)}" d="M${(x(i) - 3).toFixed(1)} ${(yy - 3).toFixed(1)}l6 6m0 -6l-6 6">${title}</path>`;
    }
    return `<circle class="pb-mk mk-${m.kind}" data-i="${String(i)}" cx="${cx}" cy="${cy.toFixed(1)}" r="3.5">${title}</circle>`;
  }).join('');
  const feed = marks.map((m, j) => `<li class="pb-ev ev-${m.kind}" data-i="${String(steps[j] ?? 0)}" data-k="${m.kind === 'risk' ? 'risk' : 'trade'}"><time>${e(day(m.at))}</time><b>${KIND_LABEL[m.kind]}</b><span>${e(m.symbol ?? '—')}</span><span>${detail(m, s.quoteCurrency)}</span></li>`).join('');
  const trades = marks.filter((m) => m.kind !== 'risk').length;
  const stopped = marks.length - trades;
  const last = idx.length - 1;
  const fmt = (v: number): string => float(v, 1);
  const base = y(100).toFixed(1);
  return `<section class="card wide playback" data-d="${e(times.map(day).join('|'))}" data-s="${e(system.map(fmt).join('|'))}" data-b="${e(bench === null ? '' : bench.map(fmt).join('|'))}">
${head('Replay en marcha', 'El sistema vuelve a recorrer el periodo: la curva avanza, cada punto es una compra o una venta y cada aspa, una orden que el control de riesgo frenó o redujo.', 'replay')}
<p class="pb-status"><span class="pb-when">${e(day(times[last] ?? 0))}</span><span>Sistema <b class="pb-sys">${e(fmt(system[last] ?? 100))}</b></span>${bench === null ? '' : `<span>${e(benchName)} <b class="pb-bench">${e(fmt(bench[last] ?? 100))}</b></span>`}<span><b class="pb-n" data-k="trade">${String(trades)}</b> operaciones</span><span><b class="pb-n" data-k="risk">${String(stopped)}</b> frenadas por Risk</span></p>
<svg class="pb-chart" viewBox="0 0 ${String(W)} ${String(H)}" role="img" aria-label="${e(`Reproducción del replay: ${String(trades)} operaciones y ${String(stopped)} órdenes frenadas por el control de riesgo, en base 100`)}">
<line class="pb-base" x1="${String(LEFT)}" y1="${base}" x2="${String(W - RIGHT)}" y2="${base}"/><text class="pb-axis" x="${String(LEFT - 6)}" y="${base}">100</text>
${bench === null ? '' : line('ln-bench', bench)}
${line('ln-sys', system)}
${shapes}
</svg>
<p class="legend"><span><span class="key"></span>Sistema</span>${bench === null ? '' : `<span><span class="key bench"></span>${e(`Comprar y mantener ${benchName}`)}</span>`}<span><span class="pk buy"></span>Compra</span><span><span class="pk sell"></span>Venta</span><span><span class="pk risk">×</span>Frenada por Risk</span></p>
<ol class="pb-feed">${feed === '' ? '<li class="pb-ev">Ninguna operación ni orden frenada en el periodo.</li>' : feed}</ol>
</section>`;
}
