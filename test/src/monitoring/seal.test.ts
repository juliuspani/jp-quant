// Sello del proyecto (paso 41C): el mismo hash da siempre exactamente el mismo SVG, sale del primer commit del
// historial original (privado: la copia pública empieza con un único commit nuevo, paso 49) y no lleva datos personales.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { FIRST_COMMIT, PROJECT_NAME, SEAL_ACCENT, SEAL_MARKS, SealError, sealFavicon, sealProfile, sealSvg } from '../../../src/monitoring/seal.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

test('el mismo hash da siempre exactamente el mismo SVG (huellas fijadas)', () => {
  // Si cambia a propósito el dibujo o el nombre, se actualizan estas huellas en el mismo commit y se regenera lo exportado.
  assert.equal(sha(sealSvg({ standalone: true })), 'fe39cc6e584e40ca260ee82476fa092357a94669e6f6dc6b679a46053f31a34d');
  assert.equal(sha(sealSvg({ standalone: true, small: true })), 'bf6a181afdc4005b602fa1b7afb01022430c4182685617218b50f592f824a330');
  assert.equal(sealSvg(), sealSvg({ hash: FIRST_COMMIT }), 'el primer commit es el hash por defecto');
  assert.equal(PROJECT_NAME, 'JP Quant');
});

test('sale del hash completo del primer commit original: 64 marcas cuyo largo y grosor dependen de él', () => {
  assert.match(FIRST_COMMIT, /^[0-9a-f]{40}$/);
  const profile = sealProfile();
  assert.equal(profile.heights.length, SEAL_MARKS);
  assert.equal(profile.weights.length, SEAL_MARKS);
  assert.ok(profile.heights.every((h) => h >= 0 && h <= 1) && profile.weights.every((w) => w >= 0 && w <= 1));
  assert.equal(Math.min(...profile.heights), 0);
  assert.equal(Math.max(...profile.heights), 1);
  assert.equal((sealSvg().match(/<line /g) ?? []).length, SEAL_MARKS);
  assert.equal((sealSvg({ small: true }).match(/<line /g) ?? []).length, SEAL_MARKS / 2, 'a 16 px, la mitad de marcas');
  // Cambiar la última cifra del hash cambia el anillo: depende del hash completo, no de un prefijo.
  const other = `${FIRST_COMMIT.slice(0, 39)}${FIRST_COMMIT.endsWith('8') ? '9' : '8'}`;
  assert.notEqual(sealSvg({ hash: other }), sealSvg());
  assert.throws(() => sealSvg({ hash: '902eb0a' }), SealError, 'solo el hash completo');
});

test('sin datos personales: solo «JP», el nombre del proyecto y el hash corto; el favicon es un data URI sin cargas externas', () => {
  // La identidad de autor de este repositorio (también antes del primer commit): el autor del primer commit original no
  // está en la copia pública.
  const ident = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(execFileSync('git', ['-C', ROOT, 'var', 'GIT_AUTHOR_IDENT'], { encoding: 'utf8' }).trim());
  assert.ok(ident, 'git var GIT_AUTHOR_IDENT no da nombre y email');
  const author = [ident[1] ?? '', ident[2] ?? ''];
  const svg = sealSvg({ standalone: true });
  for (const personal of author) assert.ok(personal === '' || !svg.toLowerCase().includes(personal.toLowerCase()), 'sin nombre ni email del autor');
  assert.doesNotMatch(svg, /@/);
  assert.ok(svg.includes('Sello de JP Quant, generado del primer commit 902eb0a'));
  assert.ok(!svg.includes(FIRST_COMMIT), 'el hash completo no se escribe, solo el corto');
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''), /https?:|href|<image|<script|<text|<circle cx="(?!100")/i);
  const favicon = sealFavicon();
  assert.match(favicon, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(favicon.split(',')[1] ?? '', 'base64').toString('utf8'), sealSvg({ small: true, standalone: true }));
  const inPage = sealSvg({ className: 'seal-top' });
  assert.match(inPage, /^<svg class="seal seal-top" viewBox="0 0 200 200" role="img"/);
  assert.ok(inPage.includes('stroke="currentColor"'), 'en la página toma el acento de la hoja de estilos');
  assert.doesNotMatch(inPage, /xmlns|#CFC6B4/);
});

test('el sello transparente es el de la cabecera de la demo: mismo dibujo, el acento y sin fondo', () => {
  const solid = sealSvg({ standalone: true });
  const clear = sealSvg({ standalone: true, transparent: true });
  assert.equal(clear, solid.replace(/<rect [^>]*\/>/, ''), 'solo se quita el fondo');
  const inner = (svg: string): string => svg.replace(/^<svg[^>]*>(<title>[^<]*<\/title>)?/, '').replace(/<\/svg>$/, '');
  assert.equal(inner(clear), inner(sealSvg({ className: 'seal-top' })).replaceAll('currentColor', SEAL_ACCENT));
  const page = readFileSync(resolve(ROOT, 'src', 'monitoring', 'dashboard-html.ts'), 'utf8');
  assert.ok(page.includes(`--accent:${SEAL_ACCENT}`) && page.includes('.brand .seal{width:26px;height:26px;color:var(--accent)}'), 'la cabecera pinta el sello con el acento');
  assert.equal(sealSvg({ transparent: true }), sealSvg(), 'en la página, la opción no cambia nada');
});
