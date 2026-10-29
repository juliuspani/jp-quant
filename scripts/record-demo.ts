// Graba el GIF del README y la imagen de vista previa para redes desde la demo sintética (paso 49, ADR 0048). Nunca desde
// un dashboard con datos reales: sirve las mismas páginas que `npm run demo`, en 127.0.0.1 y en un puerto libre.
// - Abre un Chrome o Edge sin ventana (--navegador) y lo maneja por el DevTools Protocol con el WebSocket de Node: sin
//   dependencias. El perfil del navegador es una carpeta temporal que se borra al terminar.
// - Fluido sin tocar el script de la página (su hash está en la CSP): graba en tiempo real con el screencast del
//   navegador, que entrega los fotogramas del compositor con su marca de tiempo, y después ffmpeg acelera el tiempo
//   (SPEEDUP) y lo remuestrea a FPS fijos, con una paleta por GIF. Así la reproducción de 16 s queda en unos 11 s.
// - Falla si el GIF pasa de 5 MB. ffmpeg tiene que estar en el PATH.
// No forma parte de check:all: es una herramienta manual, que necesita un navegador y ffmpeg.
//
// - --solo-og saca solo la imagen de Open Graph (og-demo.png, 1200×627): la tarjeta «Replay en marcha» en inglés, con la
//   etiqueta DEMO de la barra superior a la vista. Emula el movimiento reducido, así que la tarjeta sale terminada.
//
// Uso: node scripts/record-demo.ts --navegador <ruta a chrome o msedge> [--salida docs/assets] [--solo-og]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEMO_HOST, demoPages, demoServer } from '../demo/demo.ts';

const WIDTH = 1280;
const HEIGHT = 720;
const RECORD_SECONDS = 18; // 16 s de recorrido y 2 s del final quieto
const SPEEDUP = 1.6; // 18 s grabados quedan en unos 11 s
const FPS = 25;
const GIF_WIDTH = 800;
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

type Handler = (params: Record<string, unknown>) => void;

class Cdp {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  #handlers = new Map<string, Handler>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
      if (msg.id === undefined) {
        if (msg.method !== undefined) this.#handlers.get(msg.method)?.(msg.params ?? {});
        return;
      }
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

  on(method: string, handler: Handler): void {
    this.#handlers.set(method, handler);
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

/** Graba el screencast durante `seconds` y deja los fotogramas con una lista de duraciones para ffmpeg. */
async function screencast(cdp: Cdp, frames: string, seconds: number): Promise<number> {
  const stamps: { file: string; at: number }[] = [];
  cdp.on('Page.screencastFrame', (params) => {
    const data = params.data;
    const meta = params['metadata'] as { timestamp?: number } | undefined;
    const file = join(frames, `f${String(stamps.length).padStart(5, '0')}.jpg`);
    if (typeof data === 'string' && typeof meta?.timestamp === 'number') {
      writeFileSync(file, Buffer.from(data, 'base64'));
      stamps.push({ file, at: meta.timestamp });
    }
    void cdp.send('Page.screencastFrameAck', { sessionId: params['sessionId'] });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  await delay(seconds * 1000);
  await cdp.send('Page.stopScreencast');
  if (stamps.length < 2) throw new Error('el screencast no dio fotogramas');
  // Formato concat de ffmpeg: cada fotograma con lo que dura hasta el siguiente; el último, repetido.
  const lines = stamps.flatMap((s, i) => [`file '${s.file.split('\\').join('/')}'`, `duration ${(((stamps[i + 1]?.at ?? s.at + 0.04) - s.at)).toFixed(4)}`]);
  lines.push(`file '${(stamps.at(-1)?.file ?? '').split('\\').join('/')}'`);
  writeFileSync(join(frames, 'list.txt'), `${lines.join('\n')}\n`);
  return stamps.length;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { navegador: { type: 'string' }, salida: { type: 'string' }, 'solo-og': { type: 'boolean' } } });
  if (values.navegador === undefined) throw new Error('falta --navegador <ruta a chrome o msedge>');
  const out = values.salida ?? join('docs', 'assets');
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'jp-quant-gif-'));
  const profile = join(work, 'perfil');
  const frames = join(work, 'frames');
  mkdirSync(frames);
  const server = demoServer(demoPages());
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
    if (values['solo-og'] === true) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 627, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url });
      await delay(1500);
      await cdp.send('Runtime.evaluate', { expression: "window.scrollTo(0, document.querySelector('section.playback').getBoundingClientRect().top + window.scrollY - 70)" });
      await delay(500);
      await screenshot(cdp, join(out, 'og-demo.png'));
      cdp.close();
      process.stdout.write(`record-demo: ${join(out, 'og-demo.png')} (1200×627)\n`);
      return;
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url });
    await delay(1500);
    // El resumen y la tarjeta «Replay en marcha» arriba: la curva y la lista de eventos a la vista. Al volver a cargar, la
    // reproducción empieza desde el principio justo cuando se graba.
    await cdp.send('Runtime.evaluate', { expression: "window.scrollTo(0, document.querySelector('section.playback').getBoundingClientRect().top + window.scrollY - 70)" });
    await delay(300);
    const count = await screencast(cdp, frames, RECORD_SECONDS);
    // Vista previa para redes: 1280×640, al final del recorrido.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 640, deviceScaleFactor: 1, mobile: false });
    await delay(500);
    await screenshot(cdp, join(out, 'social-preview.png'));
    cdp.close();
    const gif = join(out, 'demo.gif');
    const ff = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'),
      '-vf', `setpts=PTS/${String(SPEEDUP)},fps=${String(FPS)},scale=${String(GIF_WIDTH)}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop', '0', gif,
    ], { encoding: 'utf8' });
    if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr || String(ff.error)}`);
    const bytes = statSync(gif).size;
    if (bytes > MAX_GIF_BYTES) throw new Error(`el GIF pesa ${String(bytes)} bytes: más de 5 MB`);
    process.stdout.write(`record-demo: ${gif} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${String(count)} fotogramas grabados, ${String(FPS)} fps, ×${String(SPEEDUP)}) y ${join(out, 'social-preview.png')}\n`);
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
