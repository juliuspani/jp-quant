// Visualizaciones de la vista de investigación (paso 41C), en SVG generado como texto y sin librerías. Cada una pinta datos
// del registro o de las salidas guardadas; ninguna es decorativa. Sin JavaScript se ven completas, como imagen fija; el
// script de la página solo las anima (rotación de la esfera, líneas que se dibujan, barras que crecen).
// 1. Núcleo del registro: una esfera con un punto por experimento, coloreado por su desenlace; entran flujos por familia
//    y salen los totales por desenlace.
// 2. ¿Suerte o ventaja?: el abanico de curvas del control aleatorio, su banda del 5 al 95 % y la estrategia encima.
// 3. Embudo de criterios: cuántos experimentos superan cada criterio congelado, en orden, y qué criterio tumbó a cuántos.
import { extent, niceStep, points, yGrid, type Frame } from './charts-html.ts';
import { compactLines, day, e, float, head, table, when } from './html-kit.ts';
import type { Outcome, ResearchSnapshot } from './research.ts';

const OUTCOME_SLUG: ReadonlyMap<Outcome, string> = new Map([
  ['aceptado', 'acc'], ['rechazado', 'rej'], ['no concluyente', 'inc'], ['abortado', 'abo'], ['en curso', 'run'],
]);
const OUTCOME_LABEL: ReadonlyMap<Outcome, string> = new Map([
  ['aceptado', 'aceptado'], ['rechazado', 'rechazado'], ['no concluyente', 'no concluyente'], ['abortado', 'abortado o invalidado'], ['en curso', 'en curso'],
]);

const slug = (o: Outcome): string => OUTCOME_SLUG.get(o) ?? 'abo';

/** El desenlace con la misma muestra que su punto en la esfera (hueca si abortado) y su nombre: nunca solo el color. */
function outcomeTag(o: Outcome, suffix = ''): string {
  return `<span class="oc"><span class="sw o-${slug(o)}"></span>${e(`${OUTCOME_LABEL.get(o) ?? o}${suffix}`)}</span>`;
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
    const info = `${p.id} · ${p.family} · ${day(p.date)} · ${OUTCOME_LABEL.get(p.outcome) ?? p.outcome} · ${String(p.trials)} ${p.trials === 1 ? 'prueba' : 'pruebas'}`;
    return `<circle class="pt o-${slug(p.outcome)}" tabindex="0" data-p="${unit.map(r3).join(',')}" data-s="${size.toFixed(2)}" data-info="${e(info)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(size * (0.7 + 0.3 * depth)).toFixed(2)}" opacity="${(0.3 + 0.7 * depth).toFixed(2)}"><title>${e(info)}</title></circle>`;
  }).join('');
  const flows = f.cls === 'lg' ? flowsSvg(f, r) : '';
  return `<svg class="${f.cls} sphere" viewBox="0 0 ${String(f.width)} ${String(f.height)}" data-cx="${String(f.cx)}" data-cy="${String(f.cy)}" data-r="${String(f.radius)}" data-a="${String(SPHERE_ANGLE)}" data-t="${String(SPHERE_TILT)}" role="img" aria-label="${e(`Núcleo del registro: ${String(n)} experimentos, N global ${String(r.globalN)}`)}">
${flows}<g class="wires">${wires}</g><g class="pts">${dots}</g>
</svg>`;
}

/** Flujos finos: a la izquierda entran las familias; a la derecha salen los totales por desenlace. */
function flowsSvg(f: SphereFrame, r: ResearchSnapshot): string {
  const total = Math.max(1, r.points.length);
  const out: string[] = [];
  const column = (items: readonly { readonly key: string; readonly count: number }[], top: number, height: number): { readonly key: string; readonly count: number; readonly y: number }[] => {
    const gap = 14;
    const usable = height - gap * Math.max(0, items.length - 1);
    let y = top;
    return items.map((item) => {
      const h = Math.max(6, (item.count / total) * usable);
      const placed = { ...item, y: y + h / 2 };
      y += h + gap;
      return placed;
    });
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
    out.push(`<text class="flow-label" x="0" y="${(node.y - 2).toFixed(1)}">${e(node.key)}</text>`);
    out.push(`<text class="tk" x="0" y="${(node.y + 13).toFixed(1)}">${e(`${String(node.count)} exp. · ${String(fam?.trials ?? 0)} pruebas`)}</text>`);
  });
  const present = r.outcomes.filter((o) => o.count > 0);
  const right = column(present.map((o) => ({ key: o.outcome, count: o.count })), 70, f.height - 140);
  right.forEach((node, i) => {
    const outcome = present[i]?.outcome ?? 'abortado';
    const source = f.cy + ((i + 0.5) / right.length - 0.5) * f.radius * 0.9;
    const d = curve(f.cx + f.radius * 0.94, source, 800, node.y);
    out.push(`<path class="flow o-${slug(outcome)}" d="${d}" stroke-width="${width(node.count).toFixed(2)}"/><path class="flow-dash" d="${d}"/>`);
    out.push(`<circle class="pt-key o-${slug(outcome)}" cx="806" cy="${node.y.toFixed(1)}" r="3.5"/>`);
    out.push(`<text class="flow-label" x="818" y="${(node.y - 2).toFixed(1)}">${e(OUTCOME_LABEL.get(outcome) ?? outcome)}</text>`);
    out.push(`<text class="tk" x="818" y="${(node.y + 13).toFixed(1)}">${e(`${String(node.count)} ${node.count === 1 ? 'experimento' : 'experimentos'}`)}</text>`);
  });
  return `<g class="flows">${out.join('')}</g>`;
}

export function sphereCard(r: ResearchSnapshot): string {
  const legend = r.outcomes.map((o) => `<li>${outcomeTag(o.outcome, ` · ${String(o.count)}`)}</li>`).join('');
  const families = r.families.map((fam) => `<li><span>${e(fam.family)}</span><span class="num">${e(`${String(fam.experiments)} exp. · ${String(fam.trials)} pruebas`)}</span></li>`).join('');
  return `<section class="card wide">${head('Núcleo del registro', 'Cada punto es un experimento del registro, con el color de su desenlace y el tamaño según sus pruebas. Entran por familia y salen por desenlace.', 'Experiment Registry')}
<ul class="legend-list">${legend}</ul>
<div class="chart">${SPHERE_FRAMES.map((f) => sphereSvg(f, r)).join('')}</div>
<p class="sphere-info" aria-live="polite">Pasa por un punto para ver su experimento, su familia, su fecha y su desenlace.</p>
<ul class="rows only-sm">${families}</ul>
<div class="divider"></div>
<p class="explain">${e(`Cada experimento suma sus pruebas a la N global: hoy, ${String(r.globalN)}. Cuantas más pruebas se hacen, más alto sale el mejor resultado por pura suerte: con ${String(r.globalN)}, el mejor Sharpe de estrategias sin ninguna ventaja quedaría a unas ${float(r.expectedMaxSharpe, 1)} desviaciones típicas por encima de cero; con una sola prueba, en cero. El Deflated Sharpe exige superar ese listón, así que cada prueba nueva lo hace más exigente, también las fallidas, abortadas o invalidadas.`)}</p>
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
  const label = `<text class="end end-sys" x="${(x(n - 1) + 8).toFixed(1)}" y="${(y(last) - 2).toFixed(1)}"><tspan class="end-name" x="${(x(n - 1) + 8).toFixed(1)}">Percentil</tspan><tspan x="${(x(n - 1) + 8).toFixed(1)}" dy="${String(f.font + 2)}">${e(float(luck.percentile, 1))}</tspan></text>`;
  return `<svg class="${f.cls}" viewBox="0 0 ${String(f.width)} ${String(f.height)}" role="img" aria-label="${e(`${luck.experimentId}: la estrategia queda en el percentil ${float(luck.percentile, 1)} de ${String(luck.simulations)} colocaciones al azar`)}">
${yGrid(f, lo, hi, step, y, (v) => float(v, 0), 100)}
<polygon class="band" points="${band}"/>
<g class="ctls">${samples}</g>
<polyline class="ln ln-sys draw strat" pathLength="1" points="${points(luck.strategy, x, y)}"/>
${label}
<text class="tk" x="${String(f.left)}" y="${String(f.height - 6)}">inicio</text>
<text class="tk" x="${(f.width - f.right).toFixed(1)}" y="${String(f.height - 6)}" text-anchor="end">${e(`fin · ${String(n)} periodos`)}</text>
</svg>`;
}

/** Pestañas como máximo: los experimentos más recientes con curvas. La hoja de estilos tiene una regla por pestaña. */
export const MAX_LUCK_TABS = 12;

/**
 * Un solo gráfico con pestañas para elegir el experimento, el más reciente primero. Las pestañas son radios con CSS: sin
 * JavaScript funcionan, y si el navegador no entiende :has, se ve el primero.
 */
export function luckCards(r: ResearchSnapshot): string {
  if (r.luck.length === 0) {
    return `<section class="card wide">${head('¿Suerte o ventaja?', 'La estrategia frente a colocaciones al azar con las mismas operaciones, duración y costes.', 'control aleatorio')}
<p class="note">${e('Ningún experimento de este registro guardó las curvas de su control aleatorio: los anteriores al paso 41C solo conservan el percentil, y si el simulador no representa el control (A.3.12 usa el backtester), tampoco se guardan. El dashboard no relanza backtests.')}</p></section>`;
  }
  const dateOf = (id: string): number => r.points.find((p) => p.id === id)?.date ?? 0;
  const ordered = [...r.luck].sort((a, b) => dateOf(b.experimentId) - dateOf(a.experimentId) || (a.experimentId < b.experimentId ? 1 : -1)).slice(0, MAX_LUCK_TABS);
  const tabs = ordered.map((luck, i) => `<input type="radio" class="lk-in" name="lk" id="lk-${String(i)}"${i === 0 ? ' checked' : ''}><label class="lk-tab" for="lk-${String(i)}">${e(luck.experimentId)}</label>`).join('');
  const panels = ordered.map((luck) => {
    const point = r.points.find((p) => p.id === luck.experimentId);
    const verdict = luck.percentile >= 95
      ? 'Por encima del percentil 95 del control: difícil de explicar solo con suerte.'
      : 'Dentro del abanico del control: no se distingue de la suerte.';
    return `<div class="lk-panel" data-exp="${e(luck.experimentId)}">
<p class="meta-line">${e(point === undefined ? luck.experimentId : `${luck.experimentId} · ${point.family} · ${day(point.date)} · ${OUTCOME_LABEL.get(point.outcome) ?? point.outcome} · ${String(luck.simulations)} colocaciones`)}</p>
<div class="chart">${FAN_FRAMES.map((f) => fanSvg(f, luck)).join('')}</div>
<p class="explain">${e(`Percentil ${float(luck.percentile, 1)}. ${verdict}`)}</p></div>`;
  }).join('\n');
  const more = r.luck.length > ordered.length ? `<p class="note">${e(`Se muestran los ${String(ordered.length)} más recientes de ${String(r.luck.length)}.`)}</p>` : '';
  return `<section class="card wide reveal luck">${head('¿Suerte o ventaja?', 'La estrategia (en color) frente a colocaciones al azar con las mismas operaciones, duración y costes. Cada línea gris es una; la banda va del percentil 5 al 95.', 'control aleatorio')}
<div class="lk-tabs" role="group" aria-label="Experimento">${tabs}</div>
<div class="lk-panels">${panels}</div>
${more}</section>`;
}

/** Filas visibles de la tabla de experimentos antes de «Ver todos». */
export const RECENT_EXPERIMENTS = 10;

/** Todos los experimentos; con JavaScript, solo los 10 más recientes y un botón que despliega el resto. */
export function experimentsCard(r: ResearchSnapshot): string {
  const rows = [...r.points].reverse().map((p) => [
    `<span class="mono">${e(p.id)}</span>`, e(p.family), when(p.date), String(p.trials), outcomeTag(p.outcome),
  ]);
  const extra = rows.length - RECENT_EXPERIMENTS;
  const button = extra > 0 ? `<button type="button" class="more" hidden data-all="${e(`Ver todos (${String(rows.length)})`)}" data-few="${e(`Ver solo los ${String(RECENT_EXPERIMENTS)} más recientes`)}">${e(`Ver todos (${String(rows.length)})`)}</button>` : '';
  return `<section class="card wide">${head('Experimentos', 'Los del registro, los más recientes primero. Las pruebas de cada uno cuentan en la N global, también las abortadas o invalidadas.')}
<div class="only-lg"><div class="exp-list">${table([{ label: 'Id', key: true }, { label: 'Familia' }, { label: 'Fecha', key: true }, { label: 'Pruebas', num: true, tech: 'n_pruebas' }, { label: 'Desenlace', key: true }], rows, 'El registro está vacío.')}</div>
${button}</div>
${compactLines([...r.points].reverse().map((p) => [`<span class="mono">${e(p.id)}</span>`, e(p.family), outcomeTag(p.outcome)]), 'El registro está vacío.', 'Ver todos')}</section>`;
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
          id: `${step.criterion} a ${last?.criterion ?? ''}`, label: 'ninguna cae más',
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
    text: `${String(row.fail)} ${row.fail === 1 ? 'vez' : 'veces'}${row.inconclusive > 0 ? ` · ${String(row.inconclusive)} sin concluir` : ''}`,
  }));
  const survivors = r.funnel.at(-1)?.count ?? 0;
  return `<section class="card wide reveal">${head('Embudo de criterios', `De los ${String(top)} experimentos del registro, ${String(r.evaluated)} se evaluaron con los criterios congelados de A.3. Cada barra cuenta los que superan ese criterio y todos los anteriores, en su orden; al final de la barra, en un trazo más fino, los que caen en él.`, 'docs/PROMOTION_CRITERIA.md', 'tech-path')}
<div class="chart">${(['sm', 'lg'] as const).map((cls) => barsSvg(cls, rows, top, `Embudo: de ${String(top)} experimentos, ${String(survivors)} superan todos los criterios`, FUNNEL_BARS)).join('')}</div>
<p class="explain">${e(survivors === 0 ? 'Ninguno supera todos los criterios: ninguna estrategia pasa a la siguiente etapa.' : `${String(survivors)} ${survivors === 1 ? 'supera' : 'superan'} todos los criterios.`)}</p></section>
<section class="card wide reveal">${head('Por qué fallan', 'Cuántas veces tumbó cada criterio a una estrategia evaluada y, a continuación, cuántas veces no se pudo concluir.', 'FAIL · NO CONCLUYENTE')}
${failRows.length === 0 ? '<p class="note">Ningún criterio ha tumbado a ninguna estrategia todavía.</p>' : `<div class="chart">${(['sm', 'lg'] as const).map((cls) => barsSvg(cls, failRows, maxFail, 'Fallos por criterio', FAILURE_BARS)).join('')}</div>`}
<p class="note">${e(`Sobre ${String(r.evaluated)} experimentos evaluados. Una estrategia puede caer en varios criterios a la vez.`)}</p></section>`;
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
