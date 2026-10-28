// Etiquetas de la esfera del registro (paso 49, revisión pública): las familias pequeñas no se montan, en español ni en
// inglés, y en inglés llevan un nombre legible sin cambiar el id del registro.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { researchFrom } from '../../../src/app/dashboard-command.ts';
import { familyName, withLang } from '../../../src/monitoring/i18n.ts';
import { LABEL_STEP, sphereCard, stackLabels } from '../../../src/monitoring/research-html.ts';
import { REGISTRY_FILE } from '../../../src/research/registry.ts';
import { ROOT } from '../../invariants/repo.ts';

const research = researchFrom(readFileSync(join(ROOT, ...REGISTRY_FILE.split('/')), 'utf8'), []);

function labelYs(html: string): { readonly y: number; readonly text: string }[] {
  const svg = /<svg class="lg sphere"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
  return [...svg.matchAll(/<text class="flow-label" x="(0|818)" y="([\d.]+)">([^<]*)</g)].map((m) => ({ y: Number(m[2]), text: `${m[1] ?? ''}:${m[3] ?? ''}` }));
}

function assertSeparated(html: string): void {
  for (const side of ['0:', '818:']) {
    const ys = labelYs(html).filter((l) => l.text.startsWith(side)).map((l) => l.y);
    assert.ok(ys.length > 0);
    for (let i = 1; i < ys.length; i++) assert.ok((ys[i] ?? 0) - (ys[i - 1] ?? 0) >= LABEL_STEP - 0.05, `${side} etiquetas a ${String((ys[i] ?? 0) - (ys[i - 1] ?? 0))} px`);
  }
}

test('una columna nunca pone dos centros a menos de LABEL_STEP, aunque las familias sean muy pequeñas', () => {
  const ys = stackLabels([1, 1, 1, 1, 50, 1], 55, 60, 320);
  for (let i = 1; i < ys.length; i++) assert.ok((ys[i] ?? 0) - (ys[i - 1] ?? 0) >= LABEL_STEP);
});

test('con el registro real, las etiquetas de la esfera no se solapan en español ni en inglés', () => {
  assertSeparated(sphereCard(research));
  assertSeparated(withLang('en', () => sphereCard(research)));
});

test('en inglés, nombres de familia legibles; en español, el id del registro', () => {
  const en = withLang('en', () => sphereCard(research));
  assert.ok(en.includes('>BTC DCA<') && en.includes('>BTC regime (SMA 200)<') && !en.includes('>dca-btc<'));
  assert.ok(sphereCard(research).includes('>dca-btc<'));
  assert.equal(withLang('en', () => familyName('familia-nueva')), 'familia-nueva', 'una familia sin nombre inglés sale con su id');
});
