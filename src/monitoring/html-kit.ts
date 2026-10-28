// Piezas comunes de la página del dashboard (paso 41C): escape, cifras, fechas en hora de Madrid, iconos y tablas.
// - Todo texto que viene de fuera pasa por escapeHtml.
// - Las traducciones se buscan en Map, nunca en objetos literales, para no heredar de Object.prototype (SEC-01).
// - El significado nunca va solo en el color: las subidas y bajadas llevan icono y signo; los estados, un punto y texto.
import { Decimal } from '../shared/decimal.ts';
import { toUtcIso, type UtcMillis } from '../shared/time.ts';
import { lang, t } from './i18n.ts';

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export const e = escapeHtml;

// ---- Cifras: en español, miles «.» y decimal «,»; en inglés, miles «,» y decimal «.» ----

export function grouped(text: string): string {
  const negative = text.startsWith('-');
  const [whole = '0', decimals] = (negative ? text.slice(1) : text).split('.');
  const [thousands, point] = lang() === 'en' ? [',', '.'] : ['.', ','];
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  return `${negative ? '−' : ''}${withSeparators}${decimals === undefined ? '' : `${point}${decimals}`}`;
}

/** Dos decimales siempre: la forma canónica de Decimal quita los ceros finales. */
function twoDecimals(value: Decimal): string {
  const [whole = '0', decimals = ''] = value.roundToScale(2, 'HALF_EVEN').toString().split('.');
  return `${whole}.${decimals.padEnd(2, '0')}`;
}

export function money(text: string): string {
  return grouped(twoDecimals(Decimal.parse(text)));
}

export function amount(text: string): string {
  return grouped(Decimal.parse(text).roundToScale(8, 'HALF_EVEN').toString());
}

/** Espacio no separable: una cifra nunca queda separada de su unidad al partir la línea. */
export const NBSP = ' ';

export function percent(fractionText: string): string {
  return `${grouped(twoDecimals(Decimal.parse(fractionText).times(Decimal.parse('100'))))}${NBSP}%`;
}

/** Un float con `digits` decimales, sin «−0,0». */
export function float(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return grouped(Number(text) === 0 ? (0).toFixed(digits) : text);
}

/** Una fracción en float como porcentaje: 0.014 → «1,4 %». */
export function floatPercent(fraction: number, digits = 1): string {
  return `${float(fraction * 100, digits)}${NBSP}%`;
}

export function decimalSign(text: string): number {
  const value = Decimal.parse(text);
  return value.isPositive() ? 1 : value.isNegative() ? -1 : 0;
}

// ---- Iconos: trazo fino, del color del texto que acompañan ----

const ICON_UP = '<svg class="ic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2.5M2.8 5.7 6 2.5l3.2 3.2"/></svg>';
const ICON_DOWN = '<svg class="ic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v7.5M2.8 6.3 6 9.5l3.2-3.2"/></svg>';

/** Subida o bajada con icono y signo además del color. `formatted` puede llegar con su «−» o sin él. */
export function delta(sign: number, formatted: string): string {
  const magnitude = formatted.replace(/^−/, '');
  if (sign > 0) return `<span class="gain">${ICON_UP}+${magnitude}</span>`;
  if (sign < 0) return `<span class="loss">${ICON_DOWN}−${magnitude}</span>`;
  return `<span class="flat">= ${magnitude}</span>`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'off';

/** Un estado: punto de color más texto. El texto dice lo mismo que el color. */
export function status(tone: Tone, text: string): string {
  return `<span class="st ${tone}"><i class="dot"></i>${e(text)}</span>`;
}

// ---- Fechas: hora de Madrid a la vista y UTC en el title ----

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MADRID = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function madrid(at: UtcMillis): { readonly day: string; readonly month: string; readonly year: string; readonly time: string } {
  const parts = new Map(MADRID.formatToParts(at).map((p) => [p.type, p.value]));
  const month = (lang() === 'en' ? MONTHS_EN : MONTHS)[Number(parts.get('month')) - 1] ?? '?';
  return { day: parts.get('day') ?? '?', month, year: parts.get('year') ?? '?', time: `${parts.get('hour') ?? '?'}:${parts.get('minute') ?? '?'}` };
}

export function utc(at: UtcMillis): string {
  return `${toUtcIso(at).slice(0, 16).replace('T', ' ')} UTC`;
}

/** «21 ene 2024» */
export function day(at: UtcMillis): string {
  const m = madrid(at);
  return `${m.day} ${m.month} ${m.year}`;
}

/** «21 ene 2024, 01:01» con la UTC en el title. */
export function when(at: UtcMillis | null): string {
  if (at === null) return '—';
  const m = madrid(at);
  return `<time datetime="${e(toUtcIso(at))}" title="${e(utc(at))}">${e(`${m.day} ${m.month} ${m.year}, ${m.time}`)}</time>`;
}

// ---- Bloques ----

/** Traduce un código a lenguaje claro; el código queda en el title. Lo desconocido se muestra tal cual, escapado. */
export function plain(words: ReadonlyMap<string, string>, code: string): string {
  const text = words.get(code);
  return text === undefined ? e(code) : `<span title="${e(code)}">${e(text)}</span>`;
}

/** Cabecera de una tarjeta: título, término técnico opcional y una línea que explica qué es y por qué importa. */
export function head(title: string, lede: string, tech = '', techClass = ''): string {
  return `<h2>${e(title)}${tech === '' ? '' : `<span class="tech${techClass === '' ? '' : ` ${techClass}`}">${e(tech)}</span>`}</h2><p class="lede">${e(lede)}</p>`;
}

export interface Column {
  readonly label: string;
  readonly num?: boolean;
  readonly tech?: string; // el término técnico, en el title de la cabecera
  readonly key?: boolean; // en el móvil, la tabla pasa a tarjetas y estos campos van arriba
}

/** Celda de texto largo, que puede partirse en varias líneas. */
export interface LongCell {
  readonly long: string;
}

export function table(columns: readonly Column[], rows: readonly (readonly (string | LongCell)[])[], empty: string, options: { readonly compact?: boolean } = {}): string {
  if (rows.length === 0) return `<p class="note">${e(empty)}</p>`;
  const th = columns.map((c) => `<th${c.num === true ? ' class="num"' : ''}${c.tech === undefined ? '' : ` title="${e(c.tech)}"`}>${e(c.label)}</th>`).join('');
  // En el móvil, cada fila es una tarjeta (CSS): cada celda lleva el nombre de su columna y las clave van primero.
  const body = rows.map((cells) => `<tr>${cells.map((cell, i) => {
    const column = columns[i];
    const classes = [typeof cell === 'string' ? (column?.num === true ? 'num' : '') : 'long', column?.key === true ? 'kf' : ''].filter((c) => c !== '').join(' ');
    return `<td${classes === '' ? '' : ` class="${classes}"`} data-label="${e(column?.label ?? '')}">${typeof cell === 'string' ? cell : cell.long}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="scroll"><table class="cards${options.compact === true ? ' compact' : ''}"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Una cifra clave: etiqueta en versalitas, la cifra grande y ligera, y una nota opcional (HTML ya escapado). */
export function kpi(label: string, figureHtml: string, note = '', tech = ''): string {
  return `<div class="kpi"><p class="lbl">${e(label)}${tech === '' ? '' : `<span class="tech">${e(tech)}</span>`}</p><p class="fig">${figureHtml}</p>${note === '' ? '' : `<p class="sub">${note}</p>`}</div>`;
}

export function withCurrency(number: string, currency: string): string {
  return `${number}${NBSP}<i>${e(currency)}</i>`;
}

/** Solo en el móvil: las 5 primeras filas en una línea compacta y el resto tras «Ver todas» (details: sin JavaScript). */
export const COMPACT_LINES = 5;

export function compactLines(lines: readonly (readonly string[])[], empty: string, more = t('Ver todas', 'See all')): string {
  if (lines.length === 0) return `<p class="note only-sm">${e(empty)}</p>`;
  const li = (cells: readonly string[]): string => `<li>${cells.map((c) => `<span>${c}</span>`).join('')}</li>`;
  const rest = lines.slice(COMPACT_LINES);
  return `<div class="only-sm"><ul class="lines">${lines.slice(0, COMPACT_LINES).map(li).join('')}</ul>${rest.length === 0 ? '' : `<details class="lines-more"><summary>${e(`${more} (${String(lines.length)})`)}</summary><ul class="lines">${rest.map(li).join('')}</ul></details>`}</div>`;
}
