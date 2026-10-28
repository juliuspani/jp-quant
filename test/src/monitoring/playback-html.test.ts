// Tarjeta «Replay en marcha» (paso 49, ADR 0048): curva muestreada, marcas en su paso, todo escapado y, sin script, el
// estado final completo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_CONTEXT, demoRun, demoSpec, PUBLIC_DEMO_LIMITS } from '../../../demo/replay.ts';
import { buildDashboard, type DashboardSnapshot } from '../../../src/monitoring/dashboard.ts';
import { parseJournal } from '../../../src/monitoring/journal.ts';
import { PAGE_SCRIPT } from '../../../src/monitoring/page-script.ts';
import { MAX_PLAYBACK_POINTS, playbackCard, playbackIndices, stepOf } from '../../../src/monitoring/playback-html.ts';
import type { UtcMillis } from '../../../src/shared/time.ts';

const snapshot = buildDashboard(parseJournal(demoRun(demoSpec(PUBLIC_DEMO_LIMITS)).jsonl), DEMO_CONTEXT);
const card = playbackCard(snapshot, 'BTC');

test('la curva se muestrea a como mucho MAX_PLAYBACK_POINTS pasos, con el primero y el último', () => {
  assert.deepEqual(playbackIndices(3), [0, 1, 2]);
  const many = playbackIndices(5000);
  assert.equal(many.length, MAX_PLAYBACK_POINTS);
  assert.equal(many[0], 0);
  assert.equal(many.at(-1), 4999);
  assert.ok(many.every((v, i) => i === 0 || v > (many[i - 1] ?? -1)), 'índices crecientes y sin repetir');
});

test('una marca cae en el primer paso no anterior a ella; después del último, en el último', () => {
  const times = [10, 20, 30] as UtcMillis[];
  assert.equal(stepOf(5 as UtcMillis, times), 0);
  assert.equal(stepOf(20 as UtcMillis, times), 1);
  assert.equal(stepOf(21 as UtcMillis, times), 2);
  assert.equal(stepOf(99 as UtcMillis, times), 2);
});

test('la demo pública muestra operaciones y órdenes frenadas por Risk, cada una con su marca y su evento', () => {
  const marks = snapshot.curve.marks;
  const risk = marks.filter((m) => m.kind === 'risk').length;
  assert.ok(risk > 0, 'la demo pública debe tener órdenes frenadas por Risk');
  assert.ok(marks.length - risk > 0, 'y operaciones');
  assert.equal((card.match(/class="pb-mk /g) ?? []).length, marks.length);
  assert.equal((card.match(/<li class="pb-ev ev-/g) ?? []).length, marks.length);
  assert.ok(card.includes(`<b class="pb-n" data-k="risk">${String(risk)}</b> frenadas por Risk`), 'sin script, los contadores dicen el total');
  const steps = [...card.matchAll(/data-i="(\d+)"/g)].map((m) => Number(m[1]));
  const points = (/data-p="([^"]*)"/.exec(card)?.[1] ?? '').split(' ').length;
  assert.ok(steps.every((i) => i >= 0 && i < points), 'cada marca cae dentro de la curva');
  assert.equal((/data-d="([^"]*)"/.exec(card)?.[1] ?? '').split('|').length, points, 'una fecha por paso');
});

test('sin script se ve el final: las líneas completas en points, igual que en data-p', () => {
  for (const m of card.matchAll(/<polyline class="ln [^"]*" data-p="([^"]*)" points="([^"]*)"/g)) assert.equal(m[1], m[2]);
});

test('los textos del diario se escapan en atributos, títulos y eventos', () => {
  const evil: DashboardSnapshot = {
    ...snapshot,
    curve: { ...snapshot.curve, marks: [{ at: snapshot.curve.at[1] ?? (0 as UtcMillis), kind: 'risk', symbol: '<img src=x>', detail: '"><script>' }] },
  };
  const html = playbackCard(evil, '<u>');
  assert.doesNotMatch(html, /<img|<script|<u>/);
  assert.ok(html.includes('&lt;img src=x&gt;') && html.includes('&lt;u&gt;'));
});

test('sin dos puntos de curva no hay tarjeta', () => {
  assert.equal(playbackCard({ ...snapshot, curve: { ...snapshot.curve, at: [], equity: [], benchmark: null, marks: [] } }, 'BTC'), '');
});

test('el script la reproduce leyendo atributos, con pausa y movimiento reducido', () => {
  for (const required of ["querySelectorAll('section.playback')", 'dataset.p', 'dataset.i', 'textContent', 'playWatch', 'showEnd']) {
    assert.ok(PAGE_SCRIPT.includes(required), required);
  }
});
