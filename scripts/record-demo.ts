// Graba el GIF del README y la imagen de vista previa para redes desde la demo sintética (paso 49, ADR 0048). Nunca desde
// un dashboard con datos reales: sirve la misma página que `npm run demo`, en 127.0.0.1 y en un puerto libre.
// - Abre un Chrome o Edge sin ventana (--navegador) y lo maneja por el DevTools Protocol con el WebSocket de Node: sin
//   dependencias. El perfil del navegador es una carpeta temporal que se borra al terminar.
// - Captura fotogramas mientras la tarjeta «Replay en marcha» recorre la curva y los une con ffmpeg (tiene que estar en el
//   PATH) en un GIF de paleta reducida. Falla si el GIF pasa de 5 MB.
// No forma parte de check:all: es una herramienta manual, que necesita un navegador y ffmpeg.
//
// Uso: node scripts/record-demo.ts --navegador <ruta a chrome o msedge> [--salida docs/assets]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEMO_HOST, demoPage, demoServer } from '../demo/demo.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const SECONDS = 19; // 16 s de recorrido y 3 s del final quieto
const FPS = 8;
const MAX_GIF_BYTES = 5 * 1024 * 1024;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que el navegador escriba el puerto de depuración en su perfil. */
async function devToolsPort(profile: string): Promise<number> {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await delay(100);
  }
  throw new Error('el navegador no abrió el puerto de depuración');
}

class Cdp {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      if (msg.id === undefined) return;
      const waiter = this.#pending.get(msg.id);
      if (waiter === undefined) return;
      this.#pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result ?? {});
    });
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('no se pudo conectar con el navegador')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close(): void {
    this.#ws.close();
  }
}

async function screenshot(cdp: Cdp, path: string): Promise<void> {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (typeof data !== 'string') throw new Error('captura vacía');
  writeFileSync(path, Buffer.from(data, 'base64'));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { navegador: { type: 'string' }, salida: { type: 'string' } } });
  if (values.navegador === undefined) throw new Error('falta --navegador <ruta a chrome o msedge>');
  const out = values.salida ?? join('docs', 'assets');
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'jp-quant-gif-'));
  const profile = join(work, 'perfil');
  const frames = join(work, 'frames');
  mkdirSync(frames);
  const server = demoServer(demoPage());
  await new Promise<void>((resolve) => server.listen(0, DEMO_HOST, resolve));
  const url = `http://${DEMO_HOST}:${String((server.address() as AddressInfo).port)}/`;
  const browser = spawn(values.navegador, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${String(WIDTH)},${String(HEIGHT)}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const port = await devToolsPort(profile);
    const targets = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (page === undefined) throw new Error('el navegador no tiene ninguna página');
    const cdp = await Cdp.open(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url });
    await delay(1500);
    // La tarjeta arriba, bajo la barra superior, para que se vean la curva y la lista de eventos.
    await cdp.send('Runtime.evaluate', { expression: "window.scrollTo(0, document.querySelector('section.playback').getBoundingClientRect().top + window.scrollY - 70)" });
    const start = performance.now();
    let n = 0;
    while (performance.now() - start < SECONDS * 1000) {
      const due = start + (n * 1000) / FPS;
      if (performance.now() < due) await delay(due - performance.now());
      await screenshot(cdp, join(frames, `f${String(n).padStart(4, '0')}.png`));
      n += 1;
    }
    const fps = n / ((performance.now() - start) / 1000);
    // Vista previa para redes: 1280×640, al final del recorrido.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 640, deviceScaleFactor: 1, mobile: false });
    await delay(500);
    await screenshot(cdp, join(out, 'social-preview.png'));
    cdp.close();
    const gif = join(out, 'demo.gif');
    const ff = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', fps.toFixed(3), '-i', join(frames, 'f%04d.png'),
      '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      gif,
    ], { encoding: 'utf8' });
    if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr || String(ff.error)}`);
    const bytes = statSync(gif).size;
    if (bytes > MAX_GIF_BYTES) throw new Error(`el GIF pesa ${String(bytes)} bytes: más de 5 MB`);
    process.stdout.write(`record-demo: ${gif} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${String(n)} fotogramas) y ${join(out, 'social-preview.png')}\n`);
  } finally {
    browser.kill();
    server.close();
    await delay(500);
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`record-demo: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
