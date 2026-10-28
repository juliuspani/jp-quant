// Comando de la demo pública (paso 49, ADR 0048): páginas deterministas en inglés y en español, el registro real del
// estudio en Investigación y Criterios, el Autopilot rellenado con su bot, servidor local de solo lectura y versión estática
// para GitHub Pages.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEMO_HOST, DEMO_PATHS, demoPage, demoPages, demoServer, autopilotPage } from '../../demo/demo.ts';
import { DASHBOARD_CSP } from '../../src/monitoring/dashboard-html.ts';
import { PAGE_SCRIPT } from '../../src/monitoring/page-script.ts';
import { ROOT } from '../invariants/repo.ts';

const pages = demoPages();
const en = pages.get('/') ?? '';
const es = pages.get('/es/') ?? '';
const scriptHash = createHash('sha256').update(PAGE_SCRIPT, 'utf8').digest('base64');

test('las páginas son siempre las mismas: replay determinista, con la reproducción y la misma CSP en los dos idiomas', () => {
  assert.equal(demoPage('en'), en);
  assert.equal(demoPage('es'), es);
  for (const html of pages.values()) {
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">`));
    assert.ok(DASHBOARD_CSP.includes(`'sha256-${scriptHash}'`), 'el mismo script con hash en todas');
    assert.ok(html.includes(`<script>${PAGE_SCRIPT}</script>`));
  }
  assert.match(en, /class="pb-mk mk-risk"/, 'se ve actuar a Risk');
});

test('inglés por defecto, español en /es/, y un selector que enlaza las dos', () => {
  assert.ok(en.includes('<html lang="en">') && en.includes('Replay in motion') && en.includes('synthetic demo data'));
  assert.ok(es.includes('<html lang="es">') && es.includes('Replay en marcha') && es.includes('datos sintéticos de demostración'));
  assert.ok(en.includes('<a href="es/" hreflang="es">ES</a>') && en.includes('<a href="./" hreflang="en" aria-current="true">EN</a>'));
  assert.ok(es.includes('<a href="../" hreflang="en">EN</a>') && es.includes('<a href="./" hreflang="es" aria-current="true">ES</a>'));
  assert.equal(demoPage(), en);
});

test('Investigación y Criterios usan el registro real: 0 estrategias candidatas aprobadas', () => {
  assert.ok(en.includes('0 candidate strategies approved'));
  assert.ok(es.includes('0 estrategias candidatas aprobadas'));
  assert.ok(!en.includes('demo-momento') && !en.includes('demo-tendencia'), 'sin los experimentos inventados del registro sintético');
  assert.ok(en.includes('tendencia-donchian-atr'), 'con las familias reales');
});

test('el abanico «¿suerte o ventaja?» se ve, etiquetado como ilustración sintética y con las cifras reales del control', () => {
  for (const [html, label, real] of [
    [en, 'Illustration with the demo&#39;s synthetic replay', 'EXP-0027: percentile 99.9 of 1000 random placements'],
    [es, 'Ilustración con el replay sintético de la demo', 'EXP-0027: percentil 99,9 de 1000 colocaciones al azar'],
  ] as const) {
    const card = /<section class="card wide reveal luck">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    assert.ok(card.includes(label), 'dice que es una ilustración');
    assert.ok(card.includes(real), 'con las cifras reales agregadas');
    assert.match(card, /<polyline class="ctl draw"/, 'con las curvas del control');
  }
});

test('la tarjeta del Autopilot sale del replay del Autopilot y enlaza a su página', () => {
  assert.ok(en.includes('From the Autopilot replay on synthetic data') && en.includes('href="autopilot/"'));
  assert.ok(es.includes('Del replay del Autopilot con datos sintéticos') && es.includes('href="../autopilot/es/"'));
  assert.ok(autopilotPage('en').includes('Current allocation against the target'));
});

test('el servidor solo da las páginas de la demo, en 127.0.0.1, con la CSP también en la cabecera', async () => {
  const server = demoServer(pages);
  await new Promise<void>((resolve) => server.listen(0, DEMO_HOST, resolve));
  try {
    const base = `http://${DEMO_HOST}:${String((server.address() as AddressInfo).port)}`;
    for (const path of DEMO_PATHS) {
      const ok = await fetch(`${base}${path}`);
      assert.equal(ok.status, 200, path);
      assert.equal(ok.headers.get('content-security-policy'), DASHBOARD_CSP);
      assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await ok.text(), pages.get(path));
    }
    assert.equal((await fetch(`${base}/index.html?x=1`)).status, 200);
    const redirect = await fetch(`${base}/es`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/es/');
    for (const path of ['/package.json', '/../package.json', '/demo/fixtures/demo.jsonl', '/fr/']) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 404, path);
      await r.text();
    }
    const post = await fetch(`${base}/`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    await post.text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('--static escribe las cuatro páginas y .nojekyll, sin servidor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jp-quant-demo-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'demo', 'demo.ts'), '--static', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const [path, html] of pages) assert.equal(readFileSync(join(dir, ...path.split('/').filter((p) => p !== ''), 'index.html'), 'utf8'), html, path);
    assert.ok(existsSync(join(dir, '.nojekyll')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
