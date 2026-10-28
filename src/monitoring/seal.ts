// Sello del proyecto (paso 41C): el monograma «JP» con trazos finos y, alrededor, un anillo de 64 marcas radiales cuya
// longitud y grosor salen del hash completo del primer commit del historial original (el privado: la copia pública del
// paso 49 empieza con un único commit nuevo y conserva este sello). Recuerda a un gráfico de mercado enrollado
// en círculo: las longitudes siguen un paseo aleatorio cerrado (un puente browniano) que sale de los bits del hash.
// - Determinista: el mismo hash da exactamente el mismo SVG (lo comprueba su prueba). Sin azar, reloj ni librerías.
// - Sin datos personales: solo «JP» y el hash corto. El hash no identifica a nadie fuera del repositorio.
// - Anillo de marcas radiales finas (elegido por la persona en el paso 41C). A 16 px (favicon) se dibuja con la mitad de
//   marcas y trazos más gruesos, para que se lea.
import { createHash } from 'node:crypto';
import { t } from './i18n.ts';

export const PROJECT_NAME = 'JP Quant';
export const FIRST_COMMIT = '902eb0a7a7cc618c1c00d9de9f21522dc571fad8';
export const SEAL_ACCENT = '#CFC6B4';
export const SEAL_BACKGROUND = '#0A0A0A';
export const SEAL_MARKS = 64;

export class SealError extends Error {
  override readonly name = 'SealError';
}

export interface SealOptions {
  readonly hash?: string; // por defecto, el primer commit
  readonly small?: boolean; // para 16 a 32 px
  readonly standalone?: boolean; // archivo .svg o favicon: con xmlns, fondo y color fijos; en la página, currentColor
  readonly className?: string;
}

/** El perfil del anillo: 64 alturas en [0, 1] y 64 grosores en [0, 1], sacados del SHA-512 del hash. */
export function sealProfile(hash: string = FIRST_COMMIT): { readonly heights: readonly number[]; readonly weights: readonly number[] } {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new SealError('el hash debe ser un commit completo de 40 caracteres hexadecimales');
  // SHA-512 da 128 cifras hexadecimales: 64 para el paseo y 64 para el grosor, sin repetir ninguna.
  const nibbles = [...createHash('sha512').update(hash, 'utf8').digest('hex')].map((c) => Number.parseInt(c, 16));
  const steps = nibbles.slice(0, SEAL_MARKS).map((n) => (n - 7.5) / 7.5);
  const walk = [0];
  for (const step of steps) walk.push((walk.at(-1) ?? 0) + step);
  const end = walk.at(-1) ?? 0;
  // Puente: se resta la tendencia para que el paseo vuelva a su inicio y el anillo cierre sin salto.
  const bridge = walk.slice(0, SEAL_MARKS).map((w, i) => w - (i / SEAL_MARKS) * end);
  let min = Infinity;
  let max = -Infinity;
  for (const b of bridge) {
    min = Math.min(min, b);
    max = Math.max(max, b);
  }
  const heights = bridge.map((b) => (max > min ? (b - min) / (max - min) : 0.5));
  const weights = nibbles.slice(SEAL_MARKS, 2 * SEAL_MARKS).map((n) => n / 15);
  return Object.freeze({ heights: Object.freeze(heights), weights: Object.freeze(weights) });
}

const f = (n: number): string => n.toFixed(2);

// Lienzo de 200 × 200 con el centro en (100, 100). La J y la P, geométricas: rectas y arcos de radio 14.
const MONOGRAM = 'M95 72V113a14 14 0 0 1-28 0M107 128V72h13a14 14 0 0 1 0 28h-13';

/** El sello como SVG. Puro: con las mismas opciones, el mismo texto. */
export function sealSvg(options: SealOptions = {}): string {
  const { heights, weights } = sealProfile(options.hash);
  const small = options.small === true;
  // A 16 px se promedian las marcas de dos en dos: 32 trazos gruesos se leen; 64 finos se emborronan.
  const count = small ? SEAL_MARKS / 2 : SEAL_MARKS;
  const pick = (values: readonly number[], i: number): number => (small ? ((values[2 * i] ?? 0) + (values[2 * i + 1] ?? 0)) / 2 : (values[i] ?? 0));
  const marks: string[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i / count) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const h = pick(heights, i);
    const w = pick(weights, i);
    const inner = small ? 58 : 64;
    const outer = inner + (small ? 10 + 28 * h : 6 + 26 * h);
    const width = small ? 6 + 2 * w : 0.8 + 1.0 * w;
    marks.push(`<line x1="${f(100 + inner * cos)}" y1="${f(100 + inner * sin)}" x2="${f(100 + outer * cos)}" y2="${f(100 + outer * sin)}" stroke-width="${f(width)}"/>`);
  }
  const color = options.standalone === true ? SEAL_ACCENT : 'currentColor';
  const ringGroup = `<g fill="none" stroke="${color}" stroke-linecap="round">${marks.join('')}</g>`;
  const inner = small ? '' : `<circle cx="100" cy="100" r="57" fill="none" stroke="${color}" stroke-width="0.8" stroke-opacity="0.45"/>`;
  const monogram = `<path d="${MONOGRAM}" fill="none" stroke="${color}" stroke-width="${small ? '12' : '3.4'}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const short = (options.hash ?? FIRST_COMMIT).slice(0, 7);
  const label = t(`Sello de ${PROJECT_NAME}, generado del primer commit ${short}`, `${PROJECT_NAME} seal, generated from the first commit ${short}`);
  if (options.standalone === true) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="${label}"><title>${label}</title><rect width="200" height="200" rx="40" fill="${SEAL_BACKGROUND}"/>${inner}${ringGroup}${monogram}</svg>`;
  }
  const cls = options.className === undefined ? 'seal' : `seal ${options.className}`;
  return `<svg class="${cls}" viewBox="0 0 200 200" role="img" aria-label="${label}">${inner}${ringGroup}${monogram}</svg>`;
}

/** El favicon: el sello pequeño, autocontenido, como data URI en base64 (sin ninguna carga externa). */
export function sealFavicon(): string {
  return `data:image/svg+xml;base64,${Buffer.from(sealSvg({ small: true, standalone: true }), 'utf8').toString('base64')}`;
}
