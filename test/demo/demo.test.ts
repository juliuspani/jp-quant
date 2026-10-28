// Comando de la demo pública (paso 49, ADR 0048): página determinista con datos sintéticos, servidor local de solo lectura
// y versión estática para GitHub Pages.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEMO_HOST, demoPage, demoServer } from '../../demo/demo.ts';
import { DASHBOARD_CSP } from '../../src/monitoring/dashboard-html.ts';
import { ROOT } from '../invariants/repo.ts';

const page = demoPage();

test('la página es siempre la misma: replay determinista, con la reproducción y la CSP', () => {
  assert.equal(demoPage(), page);
  assert.ok(page.includes(`<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">`));
  assert.ok(page.includes('Replay en marcha'));
  assert.match(page, /class="pb-mk mk-risk"/, 'se ve actuar a Risk');
  assert.ok(page.includes('datos sintéticos de demostración'));
});

test('el servidor solo da la página, en 127.0.0.1, con la CSP también en la cabecera', async () => {
  const server = demoServer(page);
  await new Promise<void>((resolve) => server.listen(0, DEMO_HOST, resolve));
  try {
    const base = `http://${DEMO_HOST}:${String((server.address() as AddressInfo).port)}`;
    const ok = await fetch(`${base}/`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-security-policy'), DASHBOARD_CSP);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await ok.text(), page);
    assert.equal((await fetch(`${base}/index.html?x=1`)).status, 200);
    for (const path of ['/package.json', '/../package.json', '/demo/fixtures/demo.jsonl']) {
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

test('--static escribe index.html y .nojekyll, sin servidor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jp-quant-demo-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'demo', 'demo.ts'), '--static', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), page);
    assert.ok(existsSync(join(dir, '.nojekyll')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
