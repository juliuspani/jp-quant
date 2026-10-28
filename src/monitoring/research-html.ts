// Visualizaciones de la vista de investigación (paso 41C), en SVG generado como texto y sin librerías. Cada una pinta datos
// del registro o de las salidas guardadas; ninguna es decorativa. Sin JavaScript se ven completas, como imagen fija; el
// script de la página solo las anima (rotación de la esfera, líneas que se dibujan, barras que crecen).
// 1. Núcleo del registro: una esfera con un punto por experimento, coloreado por su desenlace; entran flujos por familia
//    y salen los totales por desenlace.
// 2. ¿Suerte o ventaja?: el abanico de curvas del control aleatorio, su banda del 5 al 95 % y la estrategia encima.
// 3. Embudo de criterios: cuántos experimentos superan cada criterio congelado, en orden, y qué criterio tumbó a cuántos.
import { extent, niceStep, points, yGrid, type Frame } from './charts-html.ts';
import { compactLines, day, e, float, head, table, when } from './html-kit.ts';
import { familyName, t } from './i18n.ts';
import type { LuckCurves, Outcome, ResearchSnapshot } from './research.ts';

const OUTCOME_SLUG: ReadonlyMap<Outcome, string> = new Map([
  ['aceptado', 'acc'], ['rechazado', 'rej'], ['no concluyente', 'inc'], ['abortado', 'abo'], ['en curso', 'run'],
]);
// Una función y no una constante: el texto depende del idioma de la página (i18n.ts).
const outcomeLabel = (o: Outcome): string => new Map<Outcome, string>([
  ['aceptado', t('aceptado', 'accepted')], ['rechazado', t('rechazado', 'rejected')], ['no concluyente', t('no concluyente', 'inconclusive')],
  ['abortado', t('abortado o invalidado', 'aborted or invalidated')], ['en curso', t('en curso', 'in progress')],
]).get(o) ?? o;

const slug = (o: Outcome): string => OUTCOME_SLUG.get(o) ?? 'abo';

/** El desenlace con la misma muestra que su punto en la esfera (hueca si abortado) y su nombre: nunca solo el color. */
function outcomeTag(o: Outcome, suffix = ''): string {
  return `<span class="oc"><span class="sw o-${slug(o)}"></span>${e(`${outcomeLabel(o)}${suffix}`)}</span>`;
}

// ---- 1. Núcleo del registro ----

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const SPHERE_ANGLE = 0.6; // giro inicial alrededor del eje vertical, en radianes
export const SPHERE_TILT = 0.38; // inclinación hacia el observador

type Vec = readonly [number, number, number];

/** Punto i de n repartido sobre la esfera unidad (espiral de Fibonacci): el orden de los ids fija el sitio. */
function fibonacci(i: number, n: number): Vec {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN;
  return [r * Math.cos(phi), y, r * Math.sin(phi)];
}

/** La misma proyección que usa el script de la página: giro en Y, inclinación en X y vista ortográfica. */
function project(p: Vec, cx: number, cy: number, radius: number, angle = SPHERE_ANGLE, tilt = SPHERE_TILT): Vec {
  const [x, y, z] = p;
  const x1 = x * Math.cos(angle) + z * Math.sin(angle);
  const z1 = -x * Math.sin(angle) + z * Math.cos(angle);
  const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt);
  const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
  return [cx + radius * x1, cy - radius * y2, z2];
}

/** Malla: cinco paralelos y seis meridianos (círculos máximos), de 64 tramos cada uno. */
function wireframe(): Vec[][] {
  const ring = (f: (t: number) => Vec): Vec[] => Array.from({ length: 65 }, (_, k) => f((k / 64) * 2 * Math.PI));
  const out: Vec[][] = [];
  for (const lat of [-60, -30, 0, 30, 60]) {
    const phi = (lat * Math.PI) / 180;
    out.push(ring((t) => [Math.cos(phi) * Math.cos(t), Math.sin(phi), Math.cos(phi) * Math.sin(t)]));
  }
  for (let m = 0; m < 6; m++) {
    const lon = (m * Math.PI) / 6;
    out.push(ring((t) => [Math.cos(t) * Math.cos(lon), Math.sin(t), Math.cos(t) * Math.sin(lon)]));
  }
  return out;
}

const r3 = (v: number): string => v.toFixed(3);

interface SphereFrame {
  readonly cls: 'sm' | 'lg';
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
}

const SPHERE_FRAMES: readonly SphereFrame[] = [
  { cls: 'sm', width: 360, height: 320, cx: 180, cy: 160, radius: 132 },
  { cls: 'lg', width: 1000, height: 440, cx: 500, cy: 220, radius: 160 },
];

function sphereSvg(f: SphereFrame, r: ResearchSnapshot): string {
  const n = r.points.length;
  const maxTrials = r.points.reduce((m, p) => Math.max(m, p.trials), 1);
  const wires = wireframe().map((ring) => {
    const data = ring.map((p) => p.map(r3).join(',')).join(' ');
    const projected = ring.map((p) => {
      const [x, y] = project(p, f.cx, f.cy, f.radius);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polyline class="wire" data-p="${data}" points="${projected}"/>`;
  }).join('');
  const dots = r.points.map((p, i) => {
    const unit = fibonacci(i, n);
    const [x, y, z] = project(unit, f.cx, f.cy, f.radius);
    const depth = (z + 1) / 2;
    const size = (f.cls === 'sm' ? 2.2 : 2.6) + (f.cls === 'sm' ? 3 : 3.8) * Math.sqrt(p.trials / maxTrials);
    const info = `${p.id} · ${familyName(p.family)} · ${day(p.date)} · ${outcomeLabel(p.outcome)} · ${String(p.trials)} ${p.trials === 1 ? t('prueba', 'test') : t('pruebas', 'tests')}`;
    return `<circle class="pt o-${slug(p.outcome)}" tabindex="0" data-p="${unit.map(r3).join(',')}" data-s="${size.toFixed(2)}" data-info="${e(info)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(size * (0.7 + 0.3 * depth)).toFixed(2)}" opacity="${(0.3 + 0.7 * depth).toFixed(2)}"><title>${e(info)}</title></circle>`;
  }).join('');
  const flows = f.cls === 'lg' ? flowsSvg(f, r) : '';
  return `<svg class="${f.cls} sphere" viewBox="0 0 ${String(f.width)} ${String(f.height)}" data-cx="${String(f.cx)}" data-cy="${String(f.cy)}" data-r="${String(f.radius)}" data-a="${String(SPHERE_ANGLE)}" data-t="${String(SPHERE_TILT)}" role="img" aria-label="${e(`${t('Núcleo del registro', 'Registry core')}: ${String(n)} ${t('experimentos', 'experiments')}, ${t('N global', 'global N')} ${String(r.globalN)}`)}">
${flows}<g class="wires">${wires}</g><g class="pts">${dots}</g>
</svg>`;
}

/** Separación mínima entre los centros de dos etiquetas de una columna: cada una ocupa dos líneas (nombre y recuento). */
export const LABEL_STEP = 32;

/**
 * Centros de una columna de etiquetas: cada elemento ocupa una franja proporcional a su recuento, pero nunca menos de
 * LABEL_STEP entre centros, para que los nombres no se monten (familias pequeñas juntas, como dca-btc y regimen-btc-sma200).
 */
export function stackLabels(counts: readonly number[], total: number, top: number, height: number): number[] {
  const gap = 14;
  const usable = Math.max(0, height - gap * Math.max(0, counts.length - 1));
  const ys: number[] = [];
  let y = top;
  for (const count of counts) {
    const h = Math.max(6, (count / Math.max(1, total)) * usable);
    const center = Math.max(y + h / 2, (ys.at(-1) ?? -Infinity) + LABEL_STEP);
    ys.push(center);
    y = center + h / 2 + gap;
  }
  return ys;
}

/** Flujos finos: a la izquierda entran las familias; a la derecha salen los totales por desenlace. */
function flowsSvg(f: SphereFrame, r: ResearchSnapshot): string {
  const total = Math.max(1, r.points.length);
  const out: string[] = [];
  const column = (items: readonly { readonly key: string; readonly count: number }[], top: number, height: number): { readonly key: string; readonly count: number; readonly y: number }[] => {
    const ys = stackLabels(items.map((item) => item.count), total, top, height);
    return items.map((item, i) => ({ ...item, y: ys[i] ?? top }));
  };
  const width = (count: number): number => 0.8 + 4.5 * (count / total);
  const curve = (x0: number, y0: number, x1: number, y1: number): string => `M${x0.toFixed(1)} ${y0.toFixed(1)}C${(x0 + 110).toFixed(1)} ${y0.toFixed(1)} ${(x1 - 110).toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  const left = column(r.families.map((fam) => ({ key: fam.family, count: fam.experiments })), 60, f.height - 120);
  left.forEach((node, i) => {
    const fam = r.families[i];
    const target = f.cy + ((i + 0.5) / left.length - 0.5) * f.radius * 0.9;
    const d = curve(232, node.y, f.cx - f.radius * 0.94, target);
    out.push(`<path class="flow" d="${d}" stroke-width="${width(node.count).toFixed(2)}"/><path class="flow-dash" d="${d}"/>`);
    out.push(`<line class="node" x1="230" x2="230" y1="${(node.y - 7).toFixed(1)}" y2="${(node.y + 7).toFixed(1)}"/>`);
    out.push(`<text class="flow-label" x="0" y="${(node.y - 2).toFixed(1)}">${e(familyName(node.key))}</text>`);
    out.push(`<text class="tk" x="0" y="${(node.y + 13).toFixed(1)}">${e(`${String(node.count)} exp. · ${String(fam?.trials ?? 0)} ${t('pruebas', 'tests')}`)}</text>`);
  });
  const present = r.outcomes.filter((o) => o.count > 0);
  const right = column(present.map((o) => ({ key: o.outcome, count: o.count })), 70, f.height - 140);
  right.forEach((node, i) => {
    const outcome = present[i]?.outcome ?? 'abortado';
    const source = f.cy + ((i + 0.5) / right.length - 0.5) * f.radius * 0.9;
    const d = curve(f.cx + f.radius * 0.94, source, 800, node.y);
    out.push(`<path class="flow o-${slug(outcome)}" d="${d}" stroke-width="${width(node.count).toFixed(2)}"/><path class="flow-dash" d="${d}"/>`);
    out.push(`<circle class="pt-key o-${slug(outcome)}" cx="806" cy="${node.y.toFixed(1)}" r="3.5"/>`);
    out.push(`<text class="flow-label" x="818" y="${(node.y - 2).toFixed(1)}">${e(outcomeLabel(outcome))}</text>`);
    out.push(`<text class="tk" x="818" y="${(node.y + 13).toFixed(1)}">${e(`${String(node.count)} ${node.count === 1 ? t('experimento', 'experiment') : t('experimentos', 'experiments')}`)}</text>`);
  });
  return `<g class="flows">${out.join('')}</g>`;
}

export function sphereCard(r: ResearchSnapshot): string {
  const legend = r.outcomes.map((o) => `<li>${outcomeTag(o.outcome, ` · ${String(o.count)}`)}</li>`).join('');
  const families = r.families.map((fam) => `<li><span>${e(familyName(fam.family))}</span><span class="num">${e(`${String(fam.experiments)} exp. · ${String(fam.trials)} ${t('pruebas', 'tests')}`)}</span></li>`).join('');
  return `<section class="card wide">${head(t('Núcleo del registro', 'Registry core'), t('Cada punto es un experimento del registro, con el color de su desenlace y el tamaño según sus pruebas. Entran por familia y salen por desenlace.', 'Each dot is an experiment in the registry, coloured by its outcome and sized by its tests. They come in by family and leave by outcome.'), 'Experiment Registry')}
<ul class="legend-list">${legend}</ul>
<div class="chart">${SPHERE_FRAMES.map((f) => sphereSvg(f, r)).join('')}</div>
<p class="sphere-info" aria-live="polite">${t('Pasa por un punto para ver su experimento, su familia, su fecha y su desenlace.', 'Hover over a dot to see its experiment, family, date and outcome.')}</p>
<ul class="rows only-sm">${families}</ul>
<div class="divider"></div>
<p class="explain">${e(t(`Cada experimento suma sus pruebas a la N global: hoy, ${String(r.globalN)}. Cuantas más pruebas se hacen, más alto sale el mejor resultado por pura suerte: con ${String(r.globalN)}, el mejor Sharpe de estrategias sin ninguna ventaja quedaría a unas ${float(r.expectedMaxSharpe, 1)} desviaciones típicas por encima de cero; con una sola prueba, en cero. El Deflated Sharpe exige superar ese listón, así que cada prueba nueva lo hace más exigente, también las fallidas, abortadas o invalidadas.`, `Each experiment adds its tests to the global N: ${String(r.globalN)} today. The more tests you run, the higher the best result comes out by pure luck: with ${String(r.globalN)}, the best Sharpe of strategies with no edge at all would sit about ${float(r.expectedMaxSharpe, 1)} standard deviations above zero; with a single test, at zero. The Deflated Sharpe requires clearing that bar, so every new test raises it, including failed, aborted or invalidated ones.`))}</p>
</section>`;
}

// ---- 2. ¿Suerte o ventaja? ----

const FAN_FRAMES: readonly Frame[] = [
  { cls: 'sm', width: 360, height: 220, left: 34, right: 64, top: 12, bottom: 22, font: 11, xTicks: 2 },
  { cls: 'lg', width: 1000, height: 280, left: 44, right: 110, top: 14, bottom: 26, font: 12, xTicks: 2 },
];

function fanSvg(f: Frame, luck: ResearchSnapshot['luck'][number]): string {
  const n = luck.strategy.length;
  const range = extent([luck.strategy, luck.low, luck.high, ...luck.samples]);
  const step = niceStep(Math.max(range.max - range.min, 1), f.cls === 'sm' ? 4 : 5);
  const lo = Math.floor(range.min / step) * step;
  const hi = Math.ceil(range.max / step) * step;
  const plotW = f.width - f.left - f.right;
  const plotH = f.height - f.top - f.bottom;
  const x = (i: number): number => f.left + (i / (n - 1)) * plotW;
  const y = (v: number): number => f.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const band = `${points(luck.high, x, y)} ${[...luck.low].reverse().map((v, k) => `${x(n - 1 - k).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}`;
  const samples = luck.samples.map((s) => `<polyline class="ctl draw" pathLength="1" points="${points(s, x, y)}"/>`).join('');
  const last = luck.strategy.at(-1) ?? 100;
  const label = `<text class="end end-sys" x="${(x(n - 1) + 8).toFixed(1)}" y="${(y(last) - 2).toFixed(1)}"><tspan class="end-name" x="${(x(n - 1) + 8).toFixed(1)}">${t('Percentil', 'Percentile')}</tspan><tspan x="${(x(n - 1) + 8).toFixed(1)}" dy="${String(f.font + 2)}">${e(float(luck.percentile, 1))}</tspan></text>`;
  return `<svg class="${f.cls}" viewBox="0 0 ${String(f.width)} ${String(f.height)}" role="img" aria-label="${e(t(`${luck.experimentId}: la estrategia queda en el percentil ${float(luck.percentile, 1)} de ${String(luck.simulations)} colocaciones al azar`, `${luck.experimentId}: the strategy sits at percentile ${float(luck.percentile, 1)} of ${String(luck.simulations)} random placements`))}">
${yGrid(f, lo, hi, step, y, (v) => float(v, 0), 100)}
<polygon class="band" points="${band}"/>
<g class="ctls">${samples}</g>
<polyline class="ln ln-sys draw strat" pathLength="1" points="${points(luck.strategy, x, y)}"/>
${label}
<text class="tk" x="${String(f.left)}" y="${String(f.height - 6)}">${t('inicio', 'start')}</text>
<text class="tk" x="${(f.width - f.right).toFixed(1)}" y="${String(f.height - 6)}" text-anchor="end">${e(`${t('fin', 'end')} · ${String(n)} ${t('periodos', 'periods')}`)}</text>
</svg>`;
}

/** Pestañas como máximo: los experimentos más recientes con curvas. La hoja de estilos tiene una regla por pestaña. */
export const MAX_LUCK_TABS = 12;

/** El control aleatorio de un experimento real, en cifras agregadas de su salida (A.3.12): sin series ni operaciones. */
export interface RealControl {
  readonly id: string;
  readonly percentile: number; // de 0 a 100
  readonly simulations: number;
  readonly sharpe: number;
  readonly p95: number; // Sharpe del percentil 95 del control
}

/**
 * Ilustración del abanico con el replay sintético de la demo (paso 49): cuando el registro no guardó curvas del control,
 * enseña cómo se lee con datos inventados y, debajo, las cifras reales agregadas del control de los experimentos.
 */
export interface LuckIllustration {
  readonly luck: LuckCurves;
  readonly real: readonly RealControl[];
}

function illustrationCard(ill: LuckIllustration): string {
  const luck = ill.luck;
  const real = ill.real.map((c) => `<li>${e(t(
    `${c.id}: percentil ${float(c.percentile, 1)} de ${String(c.simulations)} colocaciones al azar con sus mismas operaciones (Sharpe ${float(c.sharpe, 2)}; el percentil 95 del control, ${float(c.p95, 2)}).`,
    `${c.id}: percentile ${float(c.percentile, 1)} of ${String(c.simulations)} random placements with its same trades (Sharpe ${float(c.sharpe, 2)}; the control's 95th percentile, ${float(c.p95, 2)}).`,
  ))}</li>`).join('');
  return `<section class="card wide reveal luck">${head(t('¿Suerte o ventaja?', 'Luck or edge?'), t('La estrategia (en color) frente a colocaciones al azar con las mismas operaciones, duración y costes. Cada línea gris es una; la banda va del percentil 5 al 95.', 'The strategy (in colour) against random placements with the same trades, durations and costs. Each grey line is one; the band runs from the 5th to the 95th percentile.'), t('control aleatorio', 'random control'))}
<p class="status illustration">${e(t('Ilustración con el replay sintético de la demo (BASELINE sobre precios inventados): no es un resultado de investigación. El registro real no guardó las curvas de su control, solo sus cifras.', 'Illustration with the demo\'s synthetic replay (BASELINE on invented prices): not a research result. The real registry did not save the curves of its control, only its figures.'))}</p>
<div class="chart">${FAN_FRAMES.map((f) => fanSvg(f, luck)).join('')}</div>
<p class="explain">${e(`${t('Percentil de la ilustración', 'Percentile of the illustration')}: ${float(luck.percentile, 1)}.`)}</p>
${real === '' ? '' : `<h3>${t('En el estudio real', 'In the real study')}</h3>\n<ul class="real-controls">${real}</ul>\n<p class="note">${e(t('Superar el control aleatorio no basta: ninguna estrategia superó todos los criterios congelados.', 'Beating the random control is not enough: no strategy passed every frozen criterion.'))}</p>`}
</section>`;
}

/**
 * Un solo gráfico con pestañas para elegir el experimento, el más reciente primero. Las pestañas son radios con CSS: sin
 * JavaScript funcionan, y si el navegador no entiende :has, se ve el primero.
 */
export function luckCards(r: ResearchSnapshot, illustration?: LuckIllustration): string {
  if (r.luck.length === 0 && illustration !== undefined) return illustrationCard(illustration);
  if (r.luck.length === 0) {
    return `<section class="card wide">${head(t('¿Suerte o ventaja?', 'Luck or edge?'), t('La estrategia frente a colocaciones al azar con las mismas operaciones, duración y costes.', 'The strategy against random placements with the same trades, durations and costs.'), t('control aleatorio', 'random control'))}
<p class="note">${e(t('Ningún experimento de este registro guardó las curvas de su control aleatorio: los anteriores al paso 41C solo conservan el percentil, y si el simulador no representa el control (A.3.12 usa el backtester), tampoco se guardan. El dashboard no relanza backtests.', 'No experiment in this registry saved the curves of its random control: those before step 41C keep only the percentile, and they are not saved either when the simulator does not represent the control (A.3.12 uses the backtester). The dashboard does not re-run backtests.'))}</p></section>`;
  }
  const dateOf = (id: string): number => r.points.find((p) => p.id === id)?.date ?? 0;
  const ordered = [...r.luck].sort((a, b) => dateOf(b.experimentId) - dateOf(a.experimentId) || (a.experimentId < b.experimentId ? 1 : -1)).slice(0, MAX_LUCK_TABS);
  const tabs = ordered.map((luck, i) => `<input type="radio" class="lk-in" name="lk" id="lk-${String(i)}"${i === 0 ? ' checked' : ''}><label class="lk-tab" for="lk-${String(i)}">${e(luck.experimentId)}</label>`).join('');
  const panels = ordered.map((luck) => {
    const point = r.points.find((p) => p.id === luck.experimentId);
    const verdict = luck.percentile >= 95
      ? t('Por encima del percentil 95 del control: difícil de explicar solo con suerte.', 'Above the 95th percentile of the control: hard to explain by luck alone.')
      : t('Dentro del abanico del control: no se distingue de la suerte.', 'Inside the control fan: indistinguishable from luck.');
    return `<div class="lk-panel" data-exp="${e(luck.experimentId)}">
<p class="meta-line">${e(point === undefined ? luck.experimentId : `${luck.experimentId} · ${familyName(point.family)} · ${day(point.date)} · ${outcomeLabel(point.outcome)} · ${String(luck.simulations)} ${t('colocaciones', 'placements')}`)}</p>
<div class="chart">${FAN_FRAMES.map((f) => fanSvg(f, luck)).join('')}</div>
<p class="explain">${e(`${t('Percentil', 'Percentile')} ${float(luck.percentile, 1)}. ${verdict}`)}</p></div>`;
  }).join('\n');
  const more = r.luck.length > ordered.length ? `<p class="note">${e(t(`Se muestran los ${String(ordered.length)} más recientes de ${String(r.luck.length)}.`, `Showing the ${String(ordered.length)} most recent of ${String(r.luck.length)}.`))}</p>` : '';
  return `<section class="card wide reveal luck">${head(t('¿Suerte o ventaja?', 'Luck or edge?'), t('La estrategia (en color) frente a colocaciones al azar con las mismas operaciones, duración y costes. Cada línea gris es una; la banda va del percentil 5 al 95.', 'The strategy (in colour) against random placements with the same trades, durations and costs. Each grey line is one; the band runs from the 5th to the 95th percentile.'), t('control aleatorio', 'random control'))}
<div class="lk-tabs" role="group" aria-label="${t('Experimento', 'Experiment')}">${tabs}</div>
<div class="lk-panels">${panels}</div>
${more}</section>`;
}

/** Filas visibles de la tabla de experimentos antes de «Ver todos». */
export const RECENT_EXPERIMENTS = 10;

/** Todos los experimentos; con JavaScript, solo los 10 más recientes y un botón que despliega el resto. */
export function experimentsCard(r: ResearchSnapshot): string {
  const rows = [...r.points].reverse().map((p) => [
    `<span class="mono">${e(p.id)}</span>`, e(familyName(p.family)), when(p.date), String(p.trials), outcomeTag(p.outcome),
  ]);
  const extra = rows.length - RECENT_EXPERIMENTS;
  const button = extra > 0 ? `<button type="button" class="more" hidden data-all="${e(`${t('Ver todos', 'See all')} (${String(rows.length)})`)}" data-few="${e(t(`Ver solo los ${String(RECENT_EXPERIMENTS)} más recientes`, `See only the ${String(RECENT_EXPERIMENTS)} most recent`))}">${e(`${t('Ver todos', 'See all')} (${String(rows.length)})`)}</button>` : '';
  return `<section class="card wide">${head(t('Experimentos', 'Experiments'), t('Los del registro, los más recientes primero. Las pruebas de cada uno cuentan en la N global, también las abortadas o invalidadas.', 'Those in the registry, most recent first. Each one\'s tests count towards the global N, including aborted or invalidated ones.'))}
<div class="only-lg"><div class="exp-list">${table([{ label: 'Id', key: true }, { label: t('Familia', 'Family') }, { label: t('Fecha', 'Date'), key: true }, { label: t('Pruebas', 'Tests'), num: true, tech: 'n_pruebas' }, { label: t('Desenlace', 'Outcome'), key: true }], rows, t('El registro está vacío.', 'The registry is empty.'))}</div>
${button}</div>
${compactLines([...r.points].reverse().map((p) => [`<span class="mono">${e(p.id)}</span>`, e(familyName(p.family)), outcomeTag(p.outcome)]), t('El registro está vacío.', 'The registry is empty.'), t('Ver todos', 'See all'))}</section>`;
}

// ---- 3. Embudo de criterios ----

interface BarRow {
  readonly id: string | null;
  readonly label: string;
  readonly parts: readonly { readonly cls: string; readonly value: number; readonly thin?: boolean }[]; // thin: 3 px, centrada
  readonly text: string;
}

interface BarStyle {
  readonly height: { readonly lg: number; readonly sm: number };
  readonly row: { readonly lg: number; readonly sm: number };
  readonly gap: number; // separación entre las partes de una barra
}

const THIN = 3; // lo que cae en el embudo y lo no concluyente: un trazo fino, centrado en la barra
/** Anchura estimada de un carácter de las cifras (12–13 px): decide si la cifra cabe al lado de la barra en el móvil. */
export const CHAR_W = 7.5;
const FUNNEL_BARS: BarStyle = { height: { lg: 5, sm: 5 }, row: { lg: 24, sm: 48 }, gap: 0 };
const FAILURE_BARS: BarStyle = { height: { lg: 5, sm: 5 }, row: { lg: 22, sm: 48 }, gap: 2 };

function barsSvg(cls: 'sm' | 'lg', rows: readonly BarRow[], max: number, aria: string, style: BarStyle): string {
  const lg = cls === 'lg';
  const width = lg ? 1000 : 360;
  const rowH = style.row[cls];
  const barH = style.height[cls];
  const barX = lg ? 360 : 0;
  const barW = lg ? 440 : 290; // en escritorio queda sitio a la derecha para la cifra más larga
  const height = rows.length * rowH + 8;
  const body = rows.map((row, i) => {
    const top = i * rowH + 4;
    const labelY = lg ? top + Math.round(rowH / 2) + 3 : top + 14;
    const barY = lg ? top + Math.round((rowH - barH) / 2) : top + 22;
    let x = barX;
    const bars = row.parts.filter((part) => part.value > 0).map((part, k) => {
      if (k > 0) x += style.gap;
      const w = max === 0 ? 0 : Math.max((part.value / max) * barW, 1.5);
      const h = part.thin === true ? THIN : barH;
      const rect = `<rect class="fbar ${part.cls}" x="${x.toFixed(1)}" y="${String(barY + (barH - h) / 2)}" width="${w.toFixed(1)}" height="${String(h)}" rx="${String(Math.min(2, h / 4))}"/>`;
      x += w;
      return rect;
    }).join('');
    const id = row.id === null ? '' : `<tspan class="crit-id">${e(row.id)}</tspan> `;
    // Escritorio: la cifra siempre a la derecha de la barra (hay sitio). Móvil: al lado si cabe y, si no, debajo, dentro de
    // la altura reservada de la fila, así que nunca se monta sobre la siguiente.
    const fits = lg || x + 8 + row.text.length * CHAR_W <= width; // en escritorio, siempre a la derecha
    const count = fits
      ? `<text class="tk num" x="${(x + 8).toFixed(1)}" y="${String(barY + barH / 2 + 4)}">${e(row.text)}</text>`
      : `<text class="tk num" x="${String(barX)}" y="${String(barY + barH + 13)}">${e(row.text)}</text>`;
    return `<text class="flow-label" x="0" y="${String(labelY)}">${id}${e(row.label)}</text>${bars}${count}`;
  }).join('');
  return `<svg class="${cls} bars" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${e(aria)}">${body}</svg>`;
}

/**
 * Filas del embudo: cada barra mide lo que llegaba a ese criterio; en gris lo que lo supera y, al final, en naranja tenue,
 * lo que se pierde ahí. Varios criterios seguidos que no cambian el recuento van en una sola fila.
 */
export function funnelRows(r: ResearchSnapshot): BarRow[] {
  const rows: BarRow[] = [];
  const steps = r.funnel;
  const lastIndex = steps.length - 1;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const previous = i === 0 ? null : steps[i - 1]?.count ?? null;
    if (step.criterion !== null && previous !== null && previous === step.count) {
      let j = i;
      while (steps[j + 1]?.criterion != null && steps[j + 1]?.count === step.count) j++;
      if (j > i) {
        const last = steps[j];
        rows.push({
          id: `${step.criterion} ${t('a', 'to')} ${last?.criterion ?? ''}`, label: t('ninguna cae más', 'no further drop'),
          parts: [{ cls: j === lastIndex && step.count > 0 ? 'b-acc' : 'b-base', value: step.count }], text: String(step.count),
        });
        i = j;
        continue;
      }
    }
    const lost = step.criterion !== null && previous !== null && previous > step.count ? previous - step.count : 0;
    rows.push({
      id: step.criterion, label: step.label,
      parts: [{ cls: i === lastIndex && step.count > 0 ? 'b-acc' : 'b-base', value: step.count }, { cls: 'b-lost', value: lost, thin: true }],
      text: `${String(step.count)}${lost > 0 ? ` (−${String(lost)})` : ''}`,
    });
  }
  return rows;
}

export function funnelCards(r: ResearchSnapshot): string {
  const top = r.funnel[0]?.count ?? 0;
  const rows = funnelRows(r);
  const maxFail = r.failures.reduce((m, row) => Math.max(m, row.fail + row.inconclusive), 0);
  const failRows: BarRow[] = r.failures.map((row) => ({
    id: row.criterion, label: row.label,
    parts: [{ cls: 'b-fail', value: row.fail }, { cls: 'b-inc', value: row.inconclusive, thin: true }],
    text: `${String(row.fail)} ${row.fail === 1 ? t('vez', 'time') : t('veces', 'times')}${row.inconclusive > 0 ? ` · ${String(row.inconclusive)} ${t('sin concluir', 'inconclusive')}` : ''}`,
  }));
  const survivors = r.funnel.at(-1)?.count ?? 0;
  return `<section class="card wide reveal">${head(t('Embudo de criterios', 'Criteria funnel'), t(`De los ${String(top)} experimentos del registro, ${String(r.evaluated)} se evaluaron con los criterios congelados de A.3. Cada barra cuenta los que superan ese criterio y todos los anteriores, en su orden; al final de la barra, en un trazo más fino, los que caen en él.`, `Of the ${String(top)} experiments in the registry, ${String(r.evaluated)} were evaluated against the frozen A.3 criteria. Each bar counts those that pass that criterion and all the previous ones, in order; at the end of the bar, in a thinner stroke, those that fail it.`), 'docs/PROMOTION_CRITERIA.md', 'tech-path')}
<div class="chart">${(['sm', 'lg'] as const).map((cls) => barsSvg(cls, rows, top, t(`Embudo: de ${String(top)} experimentos, ${String(survivors)} superan todos los criterios`, `Funnel: of ${String(top)} experiments, ${String(survivors)} pass every criterion`), FUNNEL_BARS)).join('')}</div>
<p class="explain">${e(survivors === 0 ? t('0 estrategias candidatas aprobadas: ninguna supera todos los criterios ni pasa a la siguiente etapa.', '0 candidate strategies approved: none passes every criterion or moves on to the next stage.') : t(`${String(survivors)} ${survivors === 1 ? 'supera' : 'superan'} todos los criterios.`, `${String(survivors)} ${survivors === 1 ? 'passes' : 'pass'} every criterion.`))}</p></section>
<section class="card wide reveal">${head(t('Por qué fallan', 'Why they fail'), t('Cuántas veces tumbó cada criterio a una estrategia evaluada y, a continuación, cuántas veces no se pudo concluir.', 'How many times each criterion knocked out an evaluated strategy and, next to it, how many times it was inconclusive.'), 'FAIL · NO CONCLUYENTE')}
${failRows.length === 0 ? `<p class="note">${t('Ningún criterio ha tumbado a ninguna estrategia todavía.', 'No criterion has knocked out any strategy yet.')}</p>` : `<div class="chart">${(['sm', 'lg'] as const).map((cls) => barsSvg(cls, failRows, maxFail, t('Fallos por criterio', 'Failures per criterion'), FAILURE_BARS)).join('')}</div>`}
<p class="note">${e(t(`Sobre ${String(r.evaluated)} experimentos evaluados. Una estrategia puede caer en varios criterios a la vez.`, `Out of ${String(r.evaluated)} evaluated experiments. A strategy can fail several criteria at once.`))}</p></section>`;
}

/** Cifras de investigación para el resumen. */
export function researchBrief(r: ResearchSnapshot): readonly { readonly label: string; readonly value: string }[] {
  const count = (o: Outcome): number => r.outcomes.find((row) => row.outcome === o)?.count ?? 0;
  return [
    { label: 'N global', value: String(r.globalN) },
    { label: 'Experimentos', value: String(r.points.length) },
    { label: 'Rechazados', value: String(count('rechazado')) },
    { label: 'Aceptados', value: String(count('aceptado')) },
  ];
}
