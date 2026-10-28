// Gráficos SVG del dashboard (paso 41C), generados como texto y sin librerías. Cada gráfico se dibuja en dos lienzos, uno
// estrecho para el móvil y otro ancho para el escritorio, y la hoja de estilos muestra uno u otro (ADR 0046, decisión 2).
// Las curvas son float: solo se pintan.
import type { UtcMillis } from '../shared/time.ts';
import { day, e, float, madrid, NBSP } from './html-kit.ts';
import { t } from './i18n.ts';

export interface Frame {
  readonly cls: 'sm' | 'lg';
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly font: number;
  readonly xTicks: number;
}

export const MAIN_FRAMES: readonly Frame[] = [
  { cls: 'sm', width: 360, height: 230, left: 36, right: 54, top: 12, bottom: 24, font: 11, xTicks: 3 },
  { cls: 'lg', width: 1000, height: 300, left: 46, right: 84, top: 14, bottom: 28, font: 12, xTicks: 6 },
];
const DRAWDOWN_FRAMES: readonly Frame[] = MAIN_FRAMES.map((f) => ({ ...f, height: f.cls === 'sm' ? 110 : 130, top: 8 }));

export function niceStep(span: number, maxTicks: number): number {
  const raw = span / maxTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * magnitude >= raw) return m * magnitude;
  return 10 * magnitude;
}

/** Mínimo y máximo con un bucle: Math.min(...) con series largas desborda la pila (SEC-05). */
export function extent(series: readonly (readonly number[])[]): { readonly min: number; readonly max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const values of series) {
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

export function points(values: readonly number[], x: (i: number) => number, y: (v: number) => number): string {
  return values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
}

/** Rejilla horizontal con sus rótulos, de `lo` a `hi` cada `step`; la línea de `base` se distingue. */
export function yGrid(f: Frame, lo: number, hi: number, step: number, y: (v: number) => number, label: (v: number) => string, base: number | null): string {
  const out: string[] = [];
  for (let k = 0; lo + k * step <= hi + step / 1000; k++) {
    const v = lo + k * step;
    const cls = base !== null && Math.abs(v - base) < step / 1000 ? 'base' : 'grid';
    out.push(`<line class="${cls}" x1="${String(f.left)}" x2="${String(f.width - f.right)}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    out.push(`<text class="tk" x="${String(f.left - 6)}" y="${(y(v) + f.font / 3).toFixed(1)}" text-anchor="end">${e(label(v))}</text>`);
  }
  return out.join('');
}

function xAxis(f: Frame, at: readonly UtcMillis[], x: (i: number) => number): string {
  const n = at.length;
  const out: string[] = [];
  for (let k = 0; k < f.xTicks; k++) {
    const i = Math.round((k * (n - 1)) / (f.xTicks - 1));
    const t = at[i];
    if (t === undefined) continue;
    const m = madrid(t);
    const anchor = k === 0 ? 'start' : k === f.xTicks - 1 ? 'end' : 'middle';
    const label = f.cls === 'sm' ? `${m.day} ${m.month}` : `${m.day} ${m.month} ${m.year}`;
    out.push(`<text class="tk" x="${x(i).toFixed(1)}" y="${String(f.height - 7)}" text-anchor="${anchor}">${e(label)}</text>`);
  }
  return out.join('');
}

/** Rótulos finales en dos líneas (nombre y valor) a la derecha de cada línea, separados si se pisan. */
export function endLabels(f: Frame, x: number, labels: readonly { readonly cls: string; readonly name: string; readonly value: string; readonly y: number }[]): string {
  const gap = 2 * f.font + 6;
  const placed = [...labels].sort((a, b) => a.y - b.y).map((l) => ({ ...l }));
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (prev !== undefined && cur !== undefined && cur.y - prev.y < gap) {
      const mid = (prev.y + cur.y) / 2;
      prev.y = mid - gap / 2;
      cur.y = mid + gap / 2;
    }
  }
  const at = x.toFixed(1);
  return placed.map((l) => `<text class="end ${l.cls}" x="${at}" y="${(l.y - 2).toFixed(1)}"><tspan class="end-name" x="${at}">${e(l.name)}</tspan><tspan x="${at}" dy="${String(f.font + 2)}">${e(l.value)}</tspan></text>`).join('');
}

/** Curva en base 100 del sistema frente a comprar y mantener, con su valor final al final de cada línea. */
export function mainChart(f: Frame, at: readonly UtcMillis[], system: readonly number[], bench: readonly number[] | null, benchName: string): string {
  const n = system.length;
  const range = extent([system, bench ?? []]);
  const step = niceStep(Math.max(range.max - range.min, 1), f.cls === 'sm' ? 4 : 5);
  const lo = Math.floor(range.min / step) * step;
  const hi = Math.ceil(range.max / step) * step;
  const plotW = f.width - f.left - f.right;
  const plotH = f.height - f.top - f.bottom;
  const x = (i: number): number => f.left + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number): number => f.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const digits = step < 1 ? 1 : 0;
  const lastSystem = system.at(-1) ?? 100;
  const lastBench = bench?.at(-1) ?? null;
  const labels = [{ cls: 'end-sys', name: t('Sistema', 'System'), value: float(lastSystem, 1), y: y(lastSystem) }];
  if (lastBench !== null) labels.push({ cls: 'end-bench', name: benchName, value: float(lastBench, 1), y: y(lastBench) });
  let hits = '';
  if (f.cls === 'lg') {
    // Ayuda al pasar el ratón sin JavaScript: una franja invisible por instante, con su <title>.
    const half = n === 1 ? plotW / 2 : plotW / (n - 1) / 2;
    hits = at.map((when, i) => {
      const b = bench?.[i];
      const label = `${day(when)} · ${t('Sistema', 'System')} ${float(system[i] ?? 0, 1)}${b === undefined ? '' : ` · ${benchName} ${float(b, 1)}`}`;
      return `<rect class="hit" x="${(x(i) - half).toFixed(1)}" y="${String(f.top)}" width="${(2 * half).toFixed(1)}" height="${String(plotH)}"><title>${e(label)}</title></rect>`;
    }).join('');
  }
  return `<svg class="${f.cls}" viewBox="0 0 ${String(f.width)} ${String(f.height)}" role="img" aria-label="${e(`${t('Sistema', 'System')} ${float(lastSystem, 1)} ${t('frente a', 'against')} ${benchName} ${lastBench === null ? t('sin datos', 'no data') : float(lastBench, 1)}, ${t('en base 100', 'base 100')}`)}">
${yGrid(f, lo, hi, step, y, (v) => float(v, digits), 100)}
${bench === null ? '' : `<polyline class="ln ln-bench" points="${points(bench, x, y)}"/>`}
<polyline class="ln ln-sys" points="${points(system, x, y)}"/>
${endLabels(f, x(n - 1) + 8, labels)}
${xAxis(f, at, x)}
${hits}
</svg>`;
}

/** Caída desde el máximo, en porcentaje (≤ 0), como área bajo cero. */
export function drawdownChart(f: Frame, at: readonly UtcMillis[], drawdown: readonly number[]): string {
  const n = drawdown.length;
  const worst = Math.min(extent([drawdown]).min, -0.1);
  const step = niceStep(-worst, 2);
  const lo = Math.floor(worst / step) * step;
  const plotW = f.width - f.left - f.right;
  const plotH = f.height - f.top - f.bottom;
  const x = (i: number): number => f.left + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number): number => f.top + (v / lo) * plotH;
  const digits = step < 1 ? 1 : 0;
  const line = points(drawdown, x, y);
  const area = `M${x(0).toFixed(1)},${y(0).toFixed(1)} L${line.replaceAll(' ', ' L')} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} Z`;
  return `<svg class="${f.cls}" viewBox="0 0 ${String(f.width)} ${String(f.height)}" role="img" aria-label="${e(`${t('Caída desde el máximo; la peor', 'Drawdown from the peak; worst')}, ${float(worst, 1)}${NBSP}%`)}">
${yGrid(f, lo, 0, step, y, (v) => `${float(v, digits)}${NBSP}%`, 0)}
<path class="area-dd" d="${area}"/>
<polyline class="ln-dd" points="${line}"/>
${xAxis(f, at, x)}
</svg>`;
}

export { DRAWDOWN_FRAMES };
