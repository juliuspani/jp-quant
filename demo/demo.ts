// Demo pública (paso 49, ADR 0048). Con un solo comando: el replay determinista con precios sintéticos (replay.ts), la
// página del dashboard y un servidor local de solo lectura en 127.0.0.1 que la sirve y la abre en el navegador. Sin
// claves, sin red y sin dinero: el replay pasa por Strategy → Risk → Execution contra el venue simulado, y ningún dato es
// de mercado.
// - Cuatro páginas, en inglés (por defecto) y en español: la demo (/, /es/) y el bot de plan B (/plan-b/, /plan-b/es/).
//   El selector de idioma son enlaces entre ellas: la CSP y el script fijo de la página no cambian.
// - Investigación y Criterios leen el registro real del estudio (docs/research/experiments/registry.jsonl, público y sin
//   precios), así que el embudo dice la verdad: ninguna estrategia aprobada. El replay y el plan B son sintéticos.
// - El servidor solo responde a GET de esas cuatro rutas, con la misma CSP en la cabecera que en la página. Nada más: ni
//   formularios, ni API, ni archivos del disco.
// - --static <carpeta> escribe las cuatro páginas (la versión de GitHub Pages) y sale, sin servidor.
//
// Uso: npm run demo [-- --puerto <n>] [-- --no-abrir] [-- --plan-b]
//      npm run demo -- --static <carpeta>
//      npm run demo:dca
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { contextFromCard, researchFrom } from '../src/app/dashboard-command.ts';
import { buildDashboard, type DashboardSnapshot } from '../src/monitoring/dashboard.ts';
import { DASHBOARD_CSP, renderDashboard } from '../src/monitoring/dashboard-html.ts';
import { t, withLang, type Lang } from '../src/monitoring/i18n.ts';
import { parseJournal } from '../src/monitoring/journal.ts';
import { REGISTRY_FILE } from '../src/research/registry.ts';
import { planBRun } from './dca/run.ts';
import { DEMO_CARD, demoRun, publicDemoSpec } from './replay.ts';

export const DEMO_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;

/** Las páginas de la demo, por ruta. La ruta de cada una fija sus enlaces relativos. */
export const DEMO_PATHS = ['/', '/es/', '/plan-b/', '/plan-b/es/'] as const;
export type DemoPath = (typeof DEMO_PATHS)[number];

const REGISTRY = resolve(import.meta.dirname, '..', ...REGISTRY_FILE.split('/'));

function strategySnapshot(): DashboardSnapshot {
  const snapshot = buildDashboard(parseJournal(demoRun(publicDemoSpec()).jsonl), contextFromCard(readFileSync(DEMO_CARD, 'utf8')));
  return { ...snapshot, label: t(snapshot.label, 'Demo with synthetic data: BASELINE, a reference strategy that is not meant for trading') };
}

function planBSnapshot(): DashboardSnapshot {
  const run = planBRun();
  const snapshot = buildDashboard(parseJournal(run.jsonl), contextFromCard(run.card));
  return { ...snapshot, label: t(snapshot.label, 'Demo with synthetic data: plan B bot, regular purchases and rebalancing in paper. The allocation is an example, not a recommendation') };
}

/**
 * La página de la demo: el replay determinista de BASELINE, con un tope de exposición bajo para que se vea actuar a Risk,
 * el registro real del estudio y, en la tarjeta del plan B, el replay del bot de plan B.
 */
export function demoPage(language: Lang = 'en'): string {
  return withLang(language, () => renderDashboard({
    snapshot: strategySnapshot(),
    research: researchFrom(readFileSync(REGISTRY, 'utf8'), []),
    commit: null,
    languages: language === 'en' ? { en: './', es: 'es/' } : { en: '../', es: './' },
    planB: planBSnapshot(),
    planBLink: language === 'en' ? 'plan-b/' : '../plan-b/es/',
  }));
}

/** La página del bot de plan B sobre los mismos precios sintéticos, con el registro real del estudio. */
export function planBPage(language: Lang = 'en'): string {
  return withLang(language, () => renderDashboard({
    snapshot: planBSnapshot(),
    research: researchFrom(readFileSync(REGISTRY, 'utf8'), []),
    commit: null,
    languages: language === 'en' ? { en: './', es: 'es/' } : { en: '../', es: './' },
  }));
}

/** Todas las páginas, por ruta. */
export function demoPages(): ReadonlyMap<DemoPath, string> {
  return new Map<DemoPath, string>([['/', demoPage('en')], ['/es/', demoPage('es')], ['/plan-b/', planBPage('en')], ['/plan-b/es/', planBPage('es')]]);
}

/**
 * Servidor de solo lectura: GET de las rutas de la demo (o su index.html) da su página; la ruta sin la barra final
 * redirige a la que la lleva, para que los enlaces relativos funcionen; todo lo demás, 404 o 405.
 */
export function demoServer(pages: ReadonlyMap<string, string>): Server {
  return createServer((req, res) => {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const route = path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
    const html = pages.get(route);
    if (html === undefined) {
      if (pages.has(`${route}/`)) {
        res.writeHead(301, { ...headers, location: `${route}/` }).end();
        return;
      }
      res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado');
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DASHBOARD_CSP });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
}

/** Abre la dirección en el navegador del sistema. Si no se puede, basta con la dirección escrita en la terminal. */
function openBrowser(url: string): void {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
  child.on('error', (error) => process.stderr.write(`demo: no se pudo abrir el navegador (${error.message}); abre ${url}\n`));
  child.unref();
}

function main(): void {
  const { values } = parseArgs({ options: { puerto: { type: 'string' }, 'no-abrir': { type: 'boolean' }, static: { type: 'string' }, 'plan-b': { type: 'boolean' } } });
  const pages = demoPages();
  if (values.static !== undefined) {
    for (const [route, html] of pages) {
      const dir = join(values.static, ...route.split('/').filter((part) => part !== ''));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), html, 'utf8');
    }
    writeFileSync(join(values.static, '.nojekyll'), '', 'utf8'); // GitHub Pages sirve los archivos tal cual
    process.stdout.write(`demo: ${String(pages.size)} páginas estáticas en ${values.static}\n`);
    return;
  }
  const port = values.puerto === undefined ? DEFAULT_PORT : Number(values.puerto);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`puerto no válido: ${String(values.puerto)}`);
  const server = demoServer(pages);
  server.on('error', (error) => {
    process.stderr.write(`demo: ${error.message} (prueba con --puerto <otro>)\n`);
    process.exitCode = 1;
  });
  server.listen(port, DEMO_HOST, () => {
    const address = server.address();
    const base = `http://${DEMO_HOST}:${String(typeof address === 'object' && address !== null ? address.port : port)}/`;
    const url = values['plan-b'] === true ? `${base}plan-b/` : base;
    process.stdout.write(`demo: replay sintético listo en ${url} (solo lectura, sin dinero; Ctrl+C para salir)\n`);
    if (values['no-abrir'] !== true) openBrowser(url);
  });
}

if (import.meta.main) main();
