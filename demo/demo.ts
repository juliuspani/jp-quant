// Demo pública (paso 49, ADR 0048). Con un solo comando: el replay determinista con precios sintéticos (replay.ts), la
// página del dashboard con el registro y las curvas sintéticas (research.ts) y un servidor local de solo lectura en
// 127.0.0.1 que la sirve y la abre en el navegador. Sin claves, sin red y sin dinero: el replay pasa por Strategy → Risk →
// Execution contra el venue simulado, y ningún dato es de mercado.
// - El servidor solo responde a GET / con la página, con la misma CSP en la cabecera que en la página. Nada más: ni
//   formularios, ni API, ni archivos del disco.
// - --static <carpeta> escribe la página como index.html (la versión de GitHub Pages) y sale, sin servidor.
// - --plan-b muestra el bot de plan B (compras periódicas y rebalanceo en paper, dca/) en lugar de la estrategia BASELINE.
//
// Uso: npm run demo [-- --puerto <n>] [-- --no-abrir] [-- --plan-b]
//      npm run demo -- --static <carpeta>
//      npm run demo:dca
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dashboardHtml } from '../src/app/dashboard-command.ts';
import { DASHBOARD_CSP } from '../src/monitoring/dashboard-html.ts';
import { DEMO_CARD, demoRun, demoSpec, PUBLIC_DEMO_LIMITS } from './replay.ts';
import { planBRun } from './dca/run.ts';
import { DEMO_CONTROLS, DEMO_REGISTRY } from './research.ts';

export const DEMO_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;

/**
 * La página de la demo: lanza el replay determinista, con un tope de exposición bajo para que se vea actuar a Risk, y la
 * genera con la ficha, el registro y las curvas sintéticos.
 */
export function demoPage(): string {
  return dashboardHtml(demoRun(demoSpec(PUBLIC_DEMO_LIMITS)).jsonl, readFileSync(DEMO_CARD, 'utf8'), {
    registryText: readFileSync(DEMO_REGISTRY, 'utf8'),
    luckTexts: [readFileSync(DEMO_CONTROLS, 'utf8')],
    commit: null,
  });
}

/** La página del bot de plan B sobre los mismos precios sintéticos, con el registro sintético. */
export function planBPage(): string {
  const run = planBRun();
  return dashboardHtml(run.jsonl, run.card, {
    registryText: readFileSync(DEMO_REGISTRY, 'utf8'),
    luckTexts: [readFileSync(DEMO_CONTROLS, 'utf8')],
    commit: null,
  });
}

/** Servidor de solo lectura: GET / (o /index.html) da la página; todo lo demás, 404 o 405. */
export function demoServer(html: string): Server {
  return createServer((req, res) => {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD' }).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '/index.html') {
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
  const html = values['plan-b'] === true ? planBPage() : demoPage();
  if (values.static !== undefined) {
    mkdirSync(values.static, { recursive: true });
    writeFileSync(join(values.static, 'index.html'), html, 'utf8');
    writeFileSync(join(values.static, '.nojekyll'), '', 'utf8'); // GitHub Pages sirve los archivos tal cual
    process.stdout.write(`demo: página estática en ${join(values.static, 'index.html')}\n`);
    return;
  }
  const port = values.puerto === undefined ? DEFAULT_PORT : Number(values.puerto);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`puerto no válido: ${String(values.puerto)}`);
  const server = demoServer(html);
  server.on('error', (error) => {
    process.stderr.write(`demo: ${error.message} (prueba con --puerto <otro>)\n`);
    process.exitCode = 1;
  });
  server.listen(port, DEMO_HOST, () => {
    const address = server.address();
    const url = `http://${DEMO_HOST}:${String(typeof address === 'object' && address !== null ? address.port : port)}/`;
    process.stdout.write(`demo: replay sintético listo en ${url} (solo lectura, sin dinero; Ctrl+C para salir)\n`);
    if (values['no-abrir'] !== true) openBrowser(url);
  });
}

if (import.meta.main) main();
