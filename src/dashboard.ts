import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { log } from './log.ts';
import type { Reporter } from './report.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function authorized(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Panel de solo lectura. Por defecto escucha únicamente en esta máquina; para
 * abrirlo a la red (p. ej. verlo desde el móvil por Tailscale) es obligatorio
 * definir DASHBOARD_PASSWORD.
 */
export function startDashboard(reporter: Reporter, host: string, port: number, password: string | undefined): Server | null {
  if (!LOOPBACK.has(host) && !password) {
    log('error', 'panel', `El panel no arranca en ${host} sin DASHBOARD_PASSWORD en .env. Usa 127.0.0.1 o define la contraseña.`);
    return null;
  }

  const server = createServer((req, res) => {
    if (password && !authorized(req.headers.authorization, password)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Inversor JP"' }).end('Acceso restringido');
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405).end();
    } else if (path === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(reporter.state()));
    } else if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
    } else {
      res.writeHead(404).end('No encontrado');
    }
  });
  server.on('error', (e) => log('error', 'panel', `Error del panel: ${e.message}`));
  server.listen(port, host, () => log('info', 'panel', `Panel disponible en http://${host}:${port}`));
  return server;
}

const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inversor JP</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --text:#16181d; --muted:#6b7280; --line:#e5e7eb; --up:#0a8f5b; --down:#d23f3f; --accent:#2f5bea; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e1116; --card:#171b22; --text:#e7e9ee; --muted:#8b93a1; --line:#262c36; --up:#3ecf8e; --down:#ff6b6b; --accent:#7aa2ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--text); font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:760px; margin:0 auto; display:grid; gap:12px; }
  header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  h1 { font-size:18px; margin:0; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 8px; font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .badge { font-size:12px; font-weight:600; padding:3px 9px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }
  .big { font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-top:10px; }
  .kv span { display:block; font-size:12px; color:var(--muted); }
  .kv b { font-variant-numeric:tabular-nums; }
  .up { color:var(--up); } .down { color:var(--down); } .muted { color:var(--muted); }
  .row { padding:9px 0; border-top:1px solid var(--line); display:flex; justify-content:space-between; gap:10px; }
  .row:first-of-type { border-top:0; }
  .row small { display:block; color:var(--muted); }
  .row .r { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .flag { border-left:3px solid var(--down); padding:8px 10px; margin-top:8px; background:color-mix(in srgb, var(--down) 10%, transparent); border-radius:6px; }
  svg { width:100%; height:90px; display:block; }
  .log { font:12px/1.5 ui-monospace,Consolas,monospace; color:var(--muted); overflow-wrap:anywhere; }
</style>
</head>
<body>
<main>
  <header><h1>Inversor JP</h1><span id="mode" class="badge">…</span></header>
  <section class="card">
    <h2>Patrimonio</h2>
    <div class="big" id="equity">…</div>
    <div id="total" class="muted"></div>
    <svg id="chart" viewBox="0 0 300 90" preserveAspectRatio="none"></svg>
    <div class="grid" id="kpis"></div>
    <div id="flags"></div>
  </section>
  <section class="card"><h2>Posiciones abiertas</h2><div id="positions"></div></section>
  <section class="card"><h2>Últimas operaciones</h2><div id="fills"></div></section>
  <section class="card"><h2>Inteligencia de mercado</h2><div id="intel"></div></section>
  <section class="card"><h2>Registro</h2><div id="events" class="log"></div></section>
  <p class="muted" id="updated" style="text-align:center;font-size:12px"></p>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const n = (v, d = 2) => Number(v).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
const price = (v) => Number(v).toLocaleString('es-ES', { maximumFractionDigits: v >= 100 ? 2 : v >= 1 ? 4 : v >= 0.01 ? 6 : 8 });
const pct = (v) => '<span class="' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '+' : '') + n(v) + '%</span>';
const when = (ts) => new Date(ts).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';
const empty = (t) => '<div class="muted">' + t + '</div>';

function chart(points) {
  if (points.length < 2) { $('chart').innerHTML = ''; return; }
  const ys = points.map((p) => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const d = points.map((p, i) => (i ? 'L' : 'M') + (i / (points.length - 1) * 300).toFixed(1) + ' ' + (85 - (p[1] - min) / span * 80).toFixed(1)).join(' ');
  const color = ys[ys.length - 1] >= ys[0] ? 'var(--up)' : 'var(--down)';
  $('chart').innerHTML = '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.8" vector-effect="non-scaling-stroke"/>';
}

async function refresh() {
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    const q = esc(s.quote);
    $('mode').textContent = (s.mode === 'paper' ? 'SIMULADO' : s.sandbox ? 'TESTNET' : 'REAL') + ' · ' + s.exchange;
    $('equity').textContent = n(s.valuation.equity) + ' ' + s.quote;
    $('total').innerHTML = pct(s.totalPnlPct) + ' desde el inicio (' + n(s.totalPnl) + ' ' + q + ')';
    chart(s.equity);
    const wr = s.stats.trades ? n(s.stats.wins / s.stats.trades * 100, 0) + '%' : '—';
    $('kpis').innerHTML =
      kv('Hoy', pct(s.risk.dayPnlPct)) + kv('Caída desde máximo', n(s.risk.drawdownPct) + '%') +
      kv('Caja', n(s.valuation.cash) + ' ' + q) + kv('Invertido', n(s.valuation.exposure) + ' ' + q) +
      kv('Operaciones cerradas', s.stats.trades + ' (' + wr + ' ganadoras)') +
      kv('Régimen', s.regime ? (s.regime.ok ? '<span class="up">Alcista</span>' : '<span class="down">Bajista</span>') : 'Pendiente');
    const flags = [];
    const stale = s.now - s.heartbeat > 5 * 60000;
    if (stale) flags.push('El bot no da señales de vida desde ' + (s.heartbeat ? when(s.heartbeat) : 'el arranque'));
    if (s.risk.paused) flags.push('En pausa manual');
    if (s.risk.halted) flags.push('Detenido: ' + esc(s.risk.halted));
    if (s.risk.dayBlocked) flags.push('Límite de pérdida diaria alcanzado');
    if (s.now < s.risk.cooldownUntil) flags.push('Enfriamiento hasta ' + when(s.risk.cooldownUntil));
    $('flags').innerHTML = flags.map((f) => '<div class="flag">' + f + '</div>').join('');
    $('positions').innerHTML = s.positions.length ? s.positions.map((p) =>
      '<div class="row"><div><b>' + esc(p.symbol) + '</b> <span class="muted">' + (p.bucket === 'core' ? 'núcleo' : 'explorador') + '</span>' +
      '<small>entrada ' + price(p.entryPrice) + ' · stop ' + price(p.stopPrice) + '</small></div>' +
      '<div class="r">' + n(p.value) + ' ' + q + '<small>' + pct(p.pnlPct) + '</small></div></div>').join('') : empty('Sin posiciones abiertas');
    $('fills').innerHTML = s.fills.length ? s.fills.slice(0, 15).map((f) =>
      '<div class="row"><div><b class="' + (f.side === 'buy' ? '' : 'muted') + '">' + (f.side === 'buy' ? 'Compra' : 'Venta') + ' ' + esc(f.symbol) + '</b>' +
      '<small>' + when(f.ts) + ' · ' + esc(f.reason) + '</small></div>' +
      '<div class="r">' + n(f.quote) + ' ' + q + '<small>a ' + price(f.price) + '</small></div></div>').join('') : empty('Todavía no hay operaciones');
    const i = s.intel;
    $('intel').innerHTML =
      '<div class="grid" style="margin-top:0">' + kv('Multiplicador de riesgo', '×' + n(i.riskMultiplier)) +
      kv('Miedo / Codicia', i.fearGreed ? i.fearGreed.value + ' · ' + esc(i.fearGreed.label) : '—') + '</div>' +
      (i.notes.length ? i.notes.map((t) => '<div class="row"><div>' + esc(t) + '</div></div>').join('') : '') +
      '<div class="muted" style="margin-top:8px;font-size:12px">' + (i.updatedAt ? 'Actualizado ' + when(i.updatedAt) : 'Sin datos todavía') + '</div>';
    $('events').innerHTML = s.events.slice(0, 25).map((e) => when(e.ts) + ' [' + esc(e.kind) + '] ' + esc(e.message)).join('<br>') || 'Sin eventos';
    $('updated').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-ES');
  } catch (e) {
    $('updated').textContent = 'Sin conexión con el bot';
  }
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
