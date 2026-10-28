// Comando del dashboard local (paso 41B, ADR 0045): lee un diario grabado y escribe una página; no lanza backtests
// (INV-14a) ni toca el trading, y si algo falla no escribe nada.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { contextFromCard, DashboardCommandError, dashboardHtml } from '../../../src/app/dashboard-command.ts';
import { CostModelError } from '../../../src/backtest/costs.ts';
import { sealFavicon } from '../../../src/monitoring/seal.ts';
import { parseRegistry, REGISTRY_FILE } from '../../../src/research/registry.ts';
import { DEMO_CONTROLS, DEMO_REGISTRY, demoControls, demoRegistry } from '../../../demo/research.ts';
import { DEMO_CARD, DEMO_CONTEXT, DEMO_COSTS, DEMO_JOURNAL, DEMO_PARAMS, demoRun, demoSpec } from '../../../demo/replay.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const COMMAND = join(ROOT, 'src', 'app', 'dashboard-command.ts');
const dir = mkdtempSync(join(tmpdir(), 'dashboard-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [COMMAND, ...args], { encoding: 'utf8' });

test('el diario de demostración es el que sale del replay sintético, y la ficha describe ese run', () => {
  assert.equal(readFileSync(DEMO_JOURNAL, 'utf8'), demoRun().jsonl, 'si cambió a propósito el backtester: node demo/replay.ts');
  const card = JSON.parse(readFileSync(DEMO_CARD, 'utf8')) as { estrategia: { id: string; version: string; parametros: unknown }; costes: unknown };
  const spec = demoSpec();
  assert.equal(card.estrategia.id, spec.strategy.id);
  assert.equal(card.estrategia.version, spec.strategy.version);
  assert.deepEqual(card.estrategia.parametros, DEMO_PARAMS);
  assert.deepEqual(card.costes, DEMO_COSTS);
  const { clientOrderIdOf, ...fromCard } = contextFromCard(readFileSync(DEMO_CARD, 'utf8'));
  const { clientOrderIdOf: expectedIds, ...expected } = DEMO_CONTEXT;
  assert.deepEqual(fromCard, expected, 'app/ saca de la ficha el contexto que usan las pruebas de monitoring/');
  assert.equal(clientOrderIdOf, expectedIds);
});

test('el registro y las curvas de demostración son los que salen de su generador sintético', () => {
  const registry = demoRegistry();
  assert.equal(readFileSync(DEMO_REGISTRY, 'utf8'), registry, 'si cambió a propósito: node demo/research.ts');
  assert.equal(readFileSync(DEMO_CONTROLS, 'utf8'), demoControls(registry));
  assert.ok([...parseRegistry(registry).experiments.values()].every((x) => x.registered.familia.startsWith('demo-')), 'familias que se ven sintéticas');
});

test('escribe la página a partir del diario y la ficha, y con --registro y --controles, la investigación', () => {
  const out = join(dir, 'estado.html');
  const result = run('--diario', DEMO_JOURNAL, '--ficha', DEMO_CARD, '--salida', out);
  assert.equal(result.status, 0, String(result.stderr));
  const plainPage = readFileSync(out, 'utf8');
  assert.match(plainPage, /<strong class="modetag" title="[^"]+">MODO REPLAY<\/strong>/);
  assert.ok(plainPage.includes('Esta página se generó sin Experiment Registry.'));
  const full = join(dir, 'consola.html');
  const withResearch = run('--diario', DEMO_JOURNAL, '--ficha', DEMO_CARD, '--registro', DEMO_REGISTRY, '--controles', DEMO_CONTROLS, '--salida', full);
  assert.equal(withResearch.status, 0, String(withResearch.stderr));
  const page = readFileSync(full, 'utf8');
  assert.equal((page.match(/<svg class="lg sphere"[\s\S]*?<\/svg>/)?.[0].match(/<circle class="pt /g) ?? []).length, 36);
  assert.ok(page.includes('<body class="mode-REPLAY">'));
  assert.ok(page.includes(sealFavicon()));
  assert.ok(page.includes('<title>[REPLAY] JP Quant · estado</title>'));
  const card = readFileSync(DEMO_CARD, 'utf8');
  const journal = readFileSync(DEMO_JOURNAL, 'utf8');
  assert.throws(() => dashboardHtml(journal, card, { luckTexts: [readFileSync(DEMO_CONTROLS, 'utf8')] }), DashboardCommandError, 'curvas sin su registro');
  // La persona eligió paleta y anillo (paso 41C): las opciones ya no existen.
  for (const removed of [['--paleta', 'B'], ['--anillo', 'puntos']]) {
    assert.equal(run('--diario', DEMO_JOURNAL, '--ficha', DEMO_CARD, ...removed, '--salida', join(dir, 'x.html')).status, 1, removed[0]);
  }
  // Varios archivos de curvas, uno por experimento: se juntan.
  const [first, ...rest] = JSON.parse(readFileSync(DEMO_CONTROLS, 'utf8')).experimentos as unknown[];
  const split = [first, rest].map((items) => JSON.stringify({ formato: 'inversor-controles/1', experimentos: Array.isArray(items) ? items : [items] }));
  const merged = dashboardHtml(journal, card, { registryText: readFileSync(DEMO_REGISTRY, 'utf8'), luckTexts: split });
  assert.equal((merged.match(/<div class="lk-panel" data-exp="EXP-/g) ?? []).length, 3, 'una pestaña por experimento con curvas');
});

test('con el registro real, la investigación muestra todos sus experimentos y su N global (solo en local)', () => {
  const text = readFileSync(join(ROOT, REGISTRY_FILE), 'utf8');
  const registry = parseRegistry(text);
  const page = dashboardHtml(readFileSync(DEMO_JOURNAL, 'utf8'), readFileSync(DEMO_CARD, 'utf8'), { registryText: text });
  assert.equal((page.match(/<svg class="lg sphere"[\s\S]*?<\/svg>/)?.[0].match(/<circle class="pt /g) ?? []).length, registry.experiments.size);
  const globalN = [...registry.experiments.values()].reduce((n, x) => n + x.registered.n_pruebas, 0);
  assert.ok(page.includes(`N global <b>${String(globalN)}</b>`));
  assert.ok(page.includes('Ningún experimento de este registro guardó las curvas de su control aleatorio'), 'el registro real no guardó las curvas');
});

test('si el diario no se entiende o la salida no es .html, no escribe nada y sale con error', () => {
  const broken = join(dir, 'roto.jsonl');
  writeFileSync(broken, readFileSync(DEMO_JOURNAL, 'utf8').split('\n').slice(0, 20).join('\n'));
  const out = join(dir, 'roto.html');
  const result = run('--diario', broken, '--ficha', DEMO_CARD, '--salida', out);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /DashboardError/);
  assert.ok(!existsSync(out));
  // SEC-03: una ficha que no es JSON (p. ej. un archivo de secretos pasado por error) no se repite en la salida de error.
  const secretLike = join(dir, 'no-es-ficha.json');
  writeFileSync(secretLike, 'secreto123456789:AAAAXYZ\n');
  const leaked = run('--diario', DEMO_JOURNAL, '--ficha', secretLike, '--salida', join(dir, 'x.html'));
  assert.equal(leaked.status, 1);
  assert.doesNotMatch(String(leaked.stderr), /secreto|123456789/);
  const notHtml = run('--diario', DEMO_JOURNAL, '--ficha', DEMO_CARD, '--salida', join(dir, 'estado.sh'));
  assert.equal(notHtml.status, 1);
  assert.equal(run().status, 2, 'sin argumentos: el uso');
});

test('la ficha se valida: costes por debajo de los mínimos o un objetivo que suma más de 1 no pasan', () => {
  const card = JSON.parse(readFileSync(DEMO_CARD, 'utf8')) as Record<string, unknown>;
  const text = (overrides: Record<string, unknown>): string => JSON.stringify({ ...card, ...overrides });
  assert.throws(() => contextFromCard(text({ costes: { ...DEMO_COSTS, commission: '0.001' } })), CostModelError);
  assert.throws(() => contextFromCard(text({ planB: { objetivo: { BTC: '0.7', ETH: '0.4' }, proximoRebalanceo: null } })), DashboardCommandError);
  assert.throws(() => contextFromCard(text({ temporalidad: '2d' })), DashboardCommandError);
  const proto = text({ planB: { objetivo: {}, proximoRebalanceo: null } }).replace('"objetivo":{}', '"objetivo":{"__proto__":"0.1"}');
  assert.throws(() => contextFromCard(proto), DashboardCommandError, 'SEC-01: __proto__ no es un activo');
  assert.throws(() => contextFromCard(text({ planB: { objetivo: { 'btc<b>': '0.1' }, proximoRebalanceo: null } })), DashboardCommandError, 'un activo es un código en mayúsculas');
  // Paso 41C: «datos» es obligatorio, sin valor por defecto, para que la marca de demostración no dependa de un olvido.
  const { datos: _omitted, ...withoutData } = card;
  assert.throws(() => contextFromCard(JSON.stringify(withoutData)), DashboardCommandError, 'sin «datos» no hay página');
  assert.throws(() => contextFromCard(text({ datos: 'demo' })), DashboardCommandError);
  assert.equal(contextFromCard(text({ datos: 'reales' })).synthetic, false);
  assert.equal(contextFromCard(text({})).synthetic, true);
  assert.equal(contextFromCard(text({})).mode, 'REPLAY', 'el modo lo pone app/, no la ficha');
  assert.equal(contextFromCard(text({ modo: 'LIVE' })).mode, 'REPLAY');
});

test('el dashboard solo lee: ni monitoring/ ni su comando lanzan un backtest, montan el sistema o envían órdenes', () => {
  const files = [
    'src/app/dashboard-command.ts', 'src/app/research-view.ts', 'src/app/seal-command.ts', 'src/monitoring/dashboard.ts', 'src/monitoring/dashboard-html.ts',
    'src/monitoring/journal.ts', 'src/monitoring/research.ts', 'src/monitoring/research-html.ts', 'src/monitoring/charts-html.ts', 'src/monitoring/html-kit.ts',
    'src/monitoring/page-script.ts', 'src/monitoring/seal.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // Paso 41C: tampoco escribe en el Experiment Registry (register y close son las únicas escrituras).
    for (const forbidden of [/runBacktest|runExperiment|ReplayEngine/, /TradingSystem|ExecutionEngine|RiskEngine/, /\.submit\(|\.cancel\(|onKillSwitch/, /createServer|node:http|node:net/, /\b(register|close)\(/]) {
      assert.doesNotMatch(source, forbidden, `${file}: ${String(forbidden)}`);
    }
  }
});
