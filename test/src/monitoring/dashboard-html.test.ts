// Página del dashboard (paso 41B, ADR 0045; consola del paso 41C, ADR 0046): sin recursos externos, con un solo script
// fijo que solo anima, todo texto escapado, el modo imposible de confundir, el significado nunca solo en el color y cada
// visualización hecha con los datos que dice. Estas pruebas comprueban el HTML generado, no cómo lo pinta un navegador
// (eso lo revisan las capturas del paso).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { experimentsFromRegistry, parseLuckFile } from '../../../src/app/research-view.ts';
import { buildDashboard, type DashboardMode, type DashboardSnapshot } from '../../../src/monitoring/dashboard.ts';
import { DASHBOARD_CSP, escapeHtml, renderDashboard, type DashboardPage } from '../../../src/monitoring/dashboard-html.ts';
import { parseJournal } from '../../../src/monitoring/journal.ts';
import { PAGE_SCRIPT } from '../../../src/monitoring/page-script.ts';
import { buildResearch, CRITERIA } from '../../../src/monitoring/research.ts';
import { CHAR_W, funnelRows } from '../../../src/monitoring/research-html.ts';
import { sealFavicon } from '../../../src/monitoring/seal.ts';
import { parseRegistry } from '../../../src/research/registry.ts';
import { DEMO_CONTROLS, DEMO_REGISTRY } from '../../../demo/research.ts';
import { DEMO_CONTEXT, demoRun } from '../../../demo/replay.ts';

const snapshot = buildDashboard(parseJournal(demoRun().jsonl), DEMO_CONTEXT);
const research = buildResearch({
  experiments: experimentsFromRegistry(parseRegistry(readFileSync(DEMO_REGISTRY, 'utf8'))),
  luck: parseLuckFile(readFileSync(DEMO_CONTROLS, 'utf8')),
});
const page: DashboardPage = { snapshot, research, commit: 'abc1234' };
const html = renderDashboard(page);
const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
const render = (s: Partial<DashboardSnapshot>, extra: Partial<DashboardPage> = {}): string => renderDashboard({ ...page, ...extra, snapshot: { ...snapshot, ...s } });
/** El contenido de una vista: desde su apertura hasta la vista siguiente o el pie. */
function section(id: string, text = html): string {
  const start = text.indexOf(`<section class="view" id="${id}">`);
  if (start < 0) return '';
  const ends = [text.indexOf('<section class="view" id="', start + 1), text.indexOf('<footer>', start)].filter((i) => i > start);
  return text.slice(start, Math.min(...ends));
}
const withoutScript = (text: string): string => text.replace(/<script>[\s\S]*?<\/script>/, '');

test('sin recursos externos ni nada que envíe datos: la CSP solo admite su hoja de estilos, su script y el favicon', () => {
  for (const forbidden of [
    /<iframe/i, /<form/i, /<img/i, /<object/i, /<embed/i, /<base/i, /<use/i, /<image/i, /<foreignObject/i, /<video|<audio|<source/i,
    /https?:\/\//i, /\son[a-z]+=/i, /\sstyle=/i, /\s(src|srcset|action|xlink:href)=/i, /javascript:/i, /http-equiv="refresh"/i,
  ]) assert.doesNotMatch(html, forbidden, String(forbidden));
  // Los únicos enlaces: las cuatro vistas (y, en la demo, la metodología provisional) y el favicon en data URI.
  const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.filter((h) => h?.startsWith('#')), ['#resumen', '#investigacion', '#replay', '#criterios', '#criterios']);
  assert.deepEqual(hrefs.filter((h) => !h?.startsWith('#')), [sealFavicon()]);
  assert.equal((html.match(/<link /g) ?? []).length, 1);
  assert.ok(html.includes(`<link rel="icon" type="image/svg+xml" href="${sealFavicon()}">`));
  // Un único script, el fijo de page-script.ts, admitido por su hash; la hoja de estilos, también por su hash.
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]?.[1], '');
  assert.equal(scripts[0]?.[2], PAGE_SCRIPT);
  const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');
  assert.ok(DASHBOARD_CSP.includes(`script-src 'sha256-${hash(PAGE_SCRIPT)}';`));
  assert.ok(DASHBOARD_CSP.includes(`style-src 'sha256-${hash(css)}';`));
  assert.match(DASHBOARD_CSP, /^default-src 'none';/);
  assert.ok(DASHBOARD_CSP.includes("img-src data:;"));
  assert.doesNotMatch(DASHBOARD_CSP, /unsafe|\*|https?:|connect-src|font-src/);
  assert.doesNotMatch(css, /@import|url\(|@font-face/i);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">`));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
});

test('el script solo anima: no pide nada a la red, no guarda nada, no escribe HTML y respeta el movimiento reducido', () => {
  for (const forbidden of [
    /fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\./, /eval\s*\(|new Function|setTimeout\s*\(\s*['"`]/, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    /import\s*\(|localStorage|sessionStorage|indexedDB|cookie/, /location|window\.open|postMessage|\$\{/,
  ]) assert.doesNotMatch(PAGE_SCRIPT, forbidden, String(forbidden));
  for (const required of ["matchMedia('(prefers-reduced-motion: reduce)')", "addEventListener('visibilitychange'", 'document.hidden', 'requestAnimationFrame', 'IntersectionObserver', 'textContent']) {
    assert.ok(PAGE_SCRIPT.includes(required), required);
  }
  // En la hoja de estilos, toda animación cuelga de .anim (la pone el script si el movimiento está permitido), se pausa
  // con .paused (pestaña oculta) y se apaga con prefers-reduced-motion aunque no haya script.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector = '', body = ''] of rules) {
    if (/(^|;)animation:/.test(body) && !/animation:none/.test(body)) assert.match(selector, /\.anim/, `animación sin .anim: ${selector}`);
  }
  assert.match(css, /\.paused \*,\.paused \*::before,\.paused \*::after\{animation-play-state:paused!important\}/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important\}\}/);
});

test('cuatro vistas con su menú; sin JavaScript cambian con :target y sin :target se ve el resumen', () => {
  assert.deepEqual([...html.matchAll(/<section class="view" id="([a-z]+)">/g)].map((m) => m[1]), ['resumen', 'investigacion', 'replay', 'criterios']);
  assert.ok(html.includes('<nav class="nav" aria-label="Vistas"><a href="#resumen">Resumen</a><a href="#investigacion">Investigación</a><a href="#replay">Replay</a><a href="#criterios">Criterios</a></nav>'));
  assert.ok(css.includes('body:has(.view:target) .view:not(:target),body:not(:has(.view:target)) .view:not(#resumen){display:none}'));
  for (const heading of ['Salud del sistema', 'Capital', 'Posiciones', 'Órdenes abiertas', 'Operaciones', 'Órdenes frenadas por el control de riesgo', 'Estrategias', 'Alertas recientes', 'Plan B']) {
    assert.match(section('replay'), new RegExp(`<h2>${escapeHtml(heading)}(<span class="tech">[^<]+</span>)?</h2><p class="lede">[^<]+</p>`), heading);
  }
  for (const heading of ['Evolución frente a comprar y mantener BTC', 'Investigación']) assert.match(section('resumen'), new RegExp(`<h2>${heading}`), heading);
  assert.doesNotMatch(section('resumen'), /<h2>Resumen/, 'sin el título duplicado: la vista ya se llama Resumen');
  assert.match(section('investigacion'), /<h2>Núcleo del registro/);
  assert.match(section('investigacion'), /<h2>¿Suerte o ventaja\?/);
  assert.match(section('criterios'), /<h2>Embudo de criterios/);
  assert.match(section('criterios'), /<h2>Por qué fallan/);
});

test('el modo: línea superior de su color, etiqueta con contorno, borde fino alrededor y el modo en el título', () => {
  const pages = (['REPLAY', 'PAPER', 'SHADOW', 'LIVE'] as const satisfies readonly DashboardMode[]).map((mode) => [mode, render({ mode })] as const);
  for (const [mode, text] of pages) {
    assert.ok(text.includes(`<body class="mode-${mode}">`), mode);
    assert.match(text, new RegExp(`<strong class="modetag" title="[^"]+">MODO ${mode}</strong>`), mode);
    assert.ok(text.includes(`<title>[${mode}] JP Quant · estado</title>`), mode);
  }
  const colors = pages.map(([mode]) => new RegExp(`\\.mode-${mode}\\{--mode:([^}]+)\\}`).exec(css)?.[1]);
  assert.equal(new Set(colors).size, 4, 'un color por modo');
  assert.equal(colors[3], 'var(--live)');
  assert.ok(css.includes('--live:#C78F8F'), 'LIVE, en rosa apagado y más visible');
  assert.match(css, /\.topbar\{position:sticky;top:0;[^}]*border-top:2px solid var\(--mode\)/);
  assert.match(css, /\.modetag\{[^}]*color:var\(--mode\);border:1px solid var\(--mode\)/);
  assert.match(css, /body::after\{[^}]*position:fixed;inset:0;border:1px solid var\(--mode\)/);
  assert.ok(pages.find(([mode]) => mode === 'LIVE')?.[1].includes('DINERO REAL.'));
  assert.match(css, /\.mode-LIVE \.modedetail\{display:inline/, 'en LIVE, el aviso se ve también en el móvil');
});

test('paleta en grises neutros con un único color de datos, el cian; el champán solo para la marca', () => {
  for (const token of [
    '--bg:#0A0A0A', '--surface:#111111', '--raised:#161616', '--border:#232323', '--grid:#1A1A1A', '--text:#EDEDED', '--muted:#A1A1A1', '--faint:#6B6B6B',
    '--accent:#CFC6B4', '--pos:#2E9BC4', '--neg:#8A8A8A', '--inc:#BDBDBD', '--abo:#5A5A5A', '--strat:#2E9BC4', '--bench:#9A9A9A', '--bar:#6B6B6B', '--run:#D6D6D6',
  ]) assert.ok(css.includes(token), token);
  assert.doesNotMatch(css, /pal-B|pal-mono|#3A8FDB|#D65A2E|#C65FB0|#C2822A/, 'las variantes descartadas se borraron');
  // Fuera de los grises neutros, solo el cian de los datos, el champán de la marca, el ocre de los avisos y el rosa de LIVE.
  const allowed = new Set(['#2E9BC4', '#CFC6B4', '#BFA978', '#C78F8F']);
  for (const [hex] of css.matchAll(/#[0-9A-Fa-f]{6}/g)) {
    if (allowed.has(hex.toUpperCase())) continue;
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    assert.ok(r === g && g === b, `${hex}: gris neutro`);
  }
  const withAccent = [...css.matchAll(/([^{}]+)\{[^{}]*var\(--accent\)[^{}]*\}/g)].map((m) => (m[1] ?? '').trim());
  assert.ok(withAccent.length >= 3);
  for (const selector of withAccent) assert.match(selector, /^(\.brand \.seal|footer \.seal|body:not\(:has\(\.view:target\)\) \.nav a)/, selector);
  assert.doesNotMatch(css, /gradient|box-shadow/, 'sin degradados ni sombras');
  assert.ok(!html.includes('pal-mono') && !html.includes('variant'), 'sin opción para alternar variantes');
});

test('colores de datos: el cian para la estrategia, lo aceptado y lo que supera todo; veredictos por tono y forma', () => {
  for (const rule of [
    '.ln-sys{stroke:var(--strat);stroke-width:2}', '.ln-bench{stroke:var(--bench);stroke-dasharray:5 4;stroke-width:1.5}', // estrategia cian, BTC gris discontinuo
    '.ln-dd{fill:none;stroke:var(--strat);stroke-width:1}.area-dd{fill:var(--strat);fill-opacity:.2}', // la caída es de la estrategia
    '.band{fill:var(--muted);fill-opacity:.1;stroke:none}', '.ctl{fill:none;stroke:var(--faint);stroke-width:1;stroke-opacity:.28}', // abanico en grises
    '.end-sys,.end-bench{fill:var(--text)}', // etiquetas finales en color de texto
    '.o-acc{fill:var(--pos);stroke:var(--pos)}.o-rej{fill:var(--neg);stroke:var(--neg)}', // aceptado cian, rechazado gris relleno
    '.pt.o-inc,.pt-key.o-inc{fill:var(--surface);stroke:var(--inc);stroke-width:1.6}', // no concluyente, anillo
    '.pt.o-abo{fill:var(--surface);stroke:var(--abo);stroke-width:1.2}', // abortado, punto hueco
    '.anim .pt.o-run,.anim .sw.o-run{animation:pulse 3.2s ease-in-out infinite}', // en curso, pulso lento
    '.fbar{fill:var(--bar)}.fbar.b-acc{fill:var(--pos)}.fbar.b-fail{fill:var(--bar)}.fbar.b-lost,.fbar.b-inc{fill:#BDBDBD}', // barras grises y la final, cian
    '.gain,.loss{color:var(--text)}', // cifras de ganancia y pérdida en color de texto, con su flecha
  ]) assert.ok(css.includes(rule), rule);
  // Embudo y fallos en barras de 5 px; lo que cae y lo no concluyente, en 3 px; solo la barra final, en cian.
  const funnel = /<svg class="lg bars"[^>]*aria-label="Embudo[^"]*">([\s\S]*?)<\/svg>/.exec(section('criterios'))?.[1] ?? '';
  assert.match(funnel, /<rect class="fbar b-base"[^>]*height="5"/);
  assert.match(funnel, /<rect class="fbar b-lost"[^>]*height="3"/);
  assert.equal((funnel.match(/<rect class="fbar b-acc"[^>]*height="5"/g) ?? []).length, 1);
  const fails = /<svg class="lg bars"[^>]*aria-label="Fallos por criterio">([\s\S]*?)<\/svg>/.exec(section('criterios'))?.[1] ?? '';
  assert.match(fails, /<rect class="fbar b-inc"[^>]*height="3"/);
  // La leyenda de la esfera, siempre visible y con el número de cada desenlace, también los que están a cero.
  const legend = /<ul class="legend-list">([\s\S]*?)<\/ul>/.exec(section('investigacion'))?.[1] ?? '';
  for (const o of research.outcomes) assert.match(legend, new RegExp(`<span class="sw o-[a-z]+"></span>${o.outcome === 'abortado' ? 'abortado o invalidado' : o.outcome} · ${String(o.count)}<`), o.outcome);
});

test('tipografía: cifras en sans ligera con números tabulares y de caja alta; etiquetas en versalitas', () => {
  const rule = (selector: string): string => new RegExp(`(?:^|[}\\n])${selector.replaceAll('.', '\\.')}\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.fig'), /font-weight:300/);
  assert.match(rule('.fig'), /letter-spacing:-\.025em/);
  assert.match(rule('.fig'), /font-feature-settings:"tnum" 1,"lnum" 1/);
  assert.doesNotMatch(rule('.fig'), /mono|bold|[6-9]00/);
  assert.match(rule('.num'), /font-feature-settings:"tnum" 1,"lnum" 1/);
  assert.match(css, /th\.num,td\.num\{text-align:right;/);
  assert.match(rule('.lbl'), /font:500 11px\/1\.4 var\(--sans\);letter-spacing:\.06em;text-transform:uppercase;color:var\(--muted\)/);
  assert.match(css, /--sans:"Segoe UI Variable Text","Segoe UI Variable","SF Pro Text",system-ui/);
});

test('sin marca de agua: con la etiqueta DEMO y el bloque de bienvenida basta', () => {
  assert.doesNotMatch(html, /watermark/);
  assert.doesNotMatch(css, /watermark/);
  assert.ok(html.includes('<span class="chip" title="Datos de demostración"><span class="md">DATOS DE DEMOSTRACIÓN</span><span class="xs">DEMO</span></span>'));
  const real = render({ synthetic: false });
  assert.ok(!real.includes('DATOS DE DEMOSTRACIÓN') && !real.includes('class="intro"'));
});

test('solo en la demo: dos líneas para quien llega de fuera, con la metodología provisional', () => {
  const intro = /<section class="intro">([\s\S]*?)<\/section>/.exec(section('resumen'))?.[1] ?? '';
  assert.equal((intro.match(/<p>/g) ?? []).length, 2);
  assert.match(intro, /<strong>JP Quant<\/strong> es una consola personal de investigación cuantitativa/);
  assert.match(intro, /<strong>datos sintéticos de demostración<\/strong>/);
  assert.ok(intro.includes('<a href="#criterios">Metodología (provisional)</a>'));
  assert.ok(section('resumen').indexOf('class="intro"') < section('resumen').indexOf('class="sentence"'), 'al principio del Resumen');
});

test('móvil: barra superior en dos líneas sin lo secundario, y las tablas pasan a tarjetas con los campos clave arriba', () => {
  assert.match(html, /<span class="sec">Commit <b>/);
  assert.match(html, /<span class="sec" title="[^"]+">Diario <b>/);
  assert.match(css, /@media \(max-width:759\.98px\)\{\n\.stats \.sec\{display:none\}/);
  assert.match(css, /table\.cards thead\{display:none\}/);
  assert.match(css, /table\.cards td::before\{content:attr\(data-label\)/);
  assert.match(css, /table\.cards td\.kf\{order:-1\}/);
  // Cada celda lleva el nombre de su columna; las clave (fecha, par, resultado…) van arriba en la tarjeta.
  const trades = /<h2>Operaciones<\/h2>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(section('replay'))?.[1] ?? '';
  assert.match(trades, /<td class="kf" data-label="Fecha"><time/);
  assert.match(trades, /<td class="num kf" data-label="Importe \(EUR\)">/);
  assert.match(trades, /<td class="long" data-label="Motivo">/);
  const experiments = /<div class="exp-list">([\s\S]*?)<\/div>/.exec(section('investigacion'))?.[1] ?? '';
  assert.match(experiments, /<td class="kf" data-label="Id"><span class="mono">EXP-/);
  assert.match(experiments, /<td class="kf" data-label="Desenlace">/);
  assert.doesNotMatch(css, /gradient/, 'ninguna tabla queda con desplazamiento horizontal: no hace falta el degradado');
});

test('experimentos: con JavaScript, los 10 más recientes y «Ver todos»; sin JavaScript, todos', () => {
  const view = section('investigacion');
  assert.equal((view.match(/<td class="kf" data-label="Id"><span class="mono">EXP-/g) ?? []).length, research.points.length, 'sin script se ven todos');
  assert.ok(view.includes('<button type="button" class="more" hidden data-all="Ver todos (36)" data-few="Ver solo los 10 más recientes">Ver todos (36)</button>'));
  assert.ok(css.includes('.exp-list.clip tbody tr:nth-child(n+11){display:none}'));
  assert.ok(PAGE_SCRIPT.includes("list.classList.add('clip')") && PAGE_SCRIPT.includes('button.hidden = false'));
});

test('cifras pegadas a su unidad con espacio no separable; «en curso» en gris claro; Plan B vacío en una línea', () => {
  const resumen = section('resumen');
  assert.ok(resumen.includes('10.141,04 <i>EUR</i>'));
  assert.ok(resumen.includes('1,41 %'));
  assert.doesNotMatch(withoutScript(html).replace(/<style>[\s\S]*?<\/style>/, ''), /\d %|\d <i>/, 'ninguna cifra separada de su unidad');
  assert.match(section('replay'), /<section class="card wide"><h2>Plan B<\/h2><p class="lede">Sin reparto objetivo todavía: [^<]+<\/p><\/section>/);
});

test('resumen arriba: una frase con los datos, cuatro cifras y el estado con texto', () => {
  assert.ok(html.includes('<p class="sentence">Del 21 ene 2024 al 30 may 2024, el sistema ha ganado un 1,4 %, frente al 9,6 % de comprar y mantener BTC, con una caída máxima del 1,0 %.</p>'));
  for (const label of ['Patrimonio', 'Resultado', 'Frente a BTC', 'Caída máxima']) assert.ok(section('resumen').includes(`<p class="lbl">${label}`), label);
  assert.ok(html.includes('<div class="status" role="status"><span class="st warn"><i class="dot"></i>Requiere atención</span><ul><li>1 hueco en los datos de ETH/EUR</li><li>La posición en BTC/EUR no tiene stop de protección</li></ul></div>'));
  assert.ok(render({ attention: [] }).includes('<span class="st ok"><i class="dot"></i>Todo en orden</span>'));
  assert.ok(render({ attention: [{ level: 'CRITICAL', message: 'el sistema se ha detenido (x)' }] }).includes('<span class="st bad"><i class="dot"></i>Requiere atención</span><ul><li>El sistema se ha detenido (x)</li>'));
  assert.match(render({ account: { ...snapshot.account, pnl: '-250', pnlFraction: '-0.025' } }), /el sistema ha perdido un 2,5 %, frente al 9,6 %/);
  for (const tech of ['drawdown', 'kill switch', 'reconciliación', 'feeds', 'P&amp;L realizado']) assert.ok(html.includes(`<span class="tech">${tech}</span>`), tech);
});

test('el significado nunca va solo en el color: subidas y bajadas con icono y signo; estados con punto y texto', () => {
  const pages = [html, render({ health: { ...snapshot.health, trading: 'detenido', killSwitch: true, executionMode: 'UNKNOWN' } })];
  for (const text of pages) {
    for (const m of text.matchAll(/<span class="gain">([\s\S]{0,200}?)<\/span>/g)) assert.match(m[1] ?? '', /^<svg class="ic"[^>]*>.*<\/svg>\+/, m[0]);
    for (const m of text.matchAll(/<span class="loss">([\s\S]{0,200}?)<\/span>/g)) assert.match(m[1] ?? '', /^<svg class="ic"[^>]*>.*<\/svg>−/, m[0]);
    for (const m of text.matchAll(/<span class="st (ok|warn|bad|off)">([^]*?)<\/span>/g)) assert.match(m[2] ?? '', /^<i class="dot"><\/i>\S/, m[0]);
    assert.doesNotMatch(text, /[✓✕⚠▲▼]/, 'sin glifos: iconos SVG o punto más texto');
  }
  assert.ok(html.includes('<span class="st warn"><i class="dot"></i>sin stop</span>'), 'la posición de BTC queda sin proteger al final del diario');
  assert.match(html, /<span class="loss"><svg class="ic"[^>]*>.*?<\/svg>−8,16 <i>puntos<\/i><\/span>/);
});

test('curva en base 100 frente a comprar y mantener, con el valor final al final de cada línea, y la caída desde el máximo', () => {
  const resumen = section('resumen');
  for (const size of ['sm', 'lg']) {
    const svg = new RegExp(`<svg class="${size}" viewBox="0 0 \\d+ \\d+" role="img" aria-label="Sistema [^"]+ en base 100">([\\s\\S]*?)</svg>`).exec(resumen)?.[1];
    assert.ok(svg !== undefined, size);
    assert.match(svg, /<polyline class="ln ln-sys" points="/);
    assert.match(svg, /<polyline class="ln ln-bench" points="/);
    assert.match(svg, /<line class="base"/, 'la línea de 100 se distingue');
    assert.match(svg, /<tspan class="end-name" x="[\d.]+">Sistema<\/tspan><tspan x="[\d.]+" dy="\d+">101,4<\/tspan>/);
    assert.match(svg, /<tspan class="end-name" x="[\d.]+">BTC<\/tspan><tspan x="[\d.]+" dy="\d+">109,6<\/tspan>/);
  }
  const points = /<polyline class="ln ln-sys" points="([^"]+)"/.exec(resumen)?.[1]?.split(' ') ?? [];
  const yOf100 = /<line class="base" x1="[\d.]+" x2="[\d.]+" y1="([\d.]+)"/.exec(resumen)?.[1];
  assert.equal(points[0]?.split(',')[1], yOf100, 'la primera marca del sistema vale 100');
  assert.equal((resumen.match(/<path class="area-dd" d="M/g) ?? []).length, 2, 'la caída en los dos lienzos');
  assert.ok(resumen.includes('<title>21 ene 2024 · Sistema 100,0 · BTC 99,6</title>'), 'ayuda al pasar el ratón, también sin JavaScript');
});

test('Núcleo del registro: un punto por experimento, con su desenlace; flujos por familia y totales por desenlace', () => {
  const view = section('investigacion');
  const spheres = [...view.matchAll(/<svg class="(sm|lg) sphere"[^>]*>([\s\S]*?)<\/svg>/g)];
  assert.deepEqual(spheres.map((s) => s[1]), ['sm', 'lg']);
  for (const [, , body = ''] of spheres) {
    const dots = [...body.matchAll(/<circle class="pt o-([a-z]+)" tabindex="0" data-p="[-\d.,]+" data-s="[\d.]+" data-info="([^"]+)"[^>]*><title>([^<]+)<\/title><\/circle>/g)];
    assert.equal(dots.length, research.points.length, 'número de puntos = experimentos del registro');
    assert.equal(dots.length, 36);
    assert.deepEqual(dots.map((d) => d[2]?.split(' · ')[0]), research.points.map((p) => p.id));
    const bySlug = (slug: string): number => dots.filter((d) => d[1] === slug).length;
    const count = (o: string): number => research.outcomes.find((x) => x.outcome === o)?.count ?? -1;
    assert.equal(bySlug('acc'), count('aceptado'));
    assert.equal(bySlug('rej'), count('rechazado'));
    assert.equal(bySlug('inc'), count('no concluyente'));
    assert.equal(bySlug('abo'), count('abortado'));
    assert.equal(bySlug('run'), count('en curso'));
    assert.ok(dots.every((d) => d[2] === d[3]), 'la misma información en data-info (script) y en <title> (sin script)');
    assert.equal((body.match(/<polyline class="wire"/g) ?? []).length, 11, 'malla de 5 paralelos y 6 meridianos');
  }
  const lg = spheres[1]?.[2] ?? '';
  for (const family of research.families) {
    assert.ok(lg.includes(`>${family.family}</text>`), family.family);
    assert.ok(lg.includes(`${String(family.experiments)} exp. · ${String(family.trials)} pruebas`), family.family);
  }
  assert.equal((lg.match(/<path class="flow" /g) ?? []).length, research.families.length);
  const present = research.outcomes.filter((o) => o.count > 0);
  assert.equal((lg.match(/<path class="flow o-/g) ?? []).length, present.length);
  for (const o of present) assert.ok(lg.includes(`${String(o.count)} ${o.count === 1 ? 'experimento' : 'experimentos'}`), o.outcome);
  assert.ok(view.includes(`hoy, ${String(research.globalN)}.`), 'el texto del Deflated Sharpe usa la N global');
  assert.ok(view.includes('unas 2,8 desviaciones típicas'));
  assert.ok(html.includes(`N global <b>${String(research.globalN)}</b>`), 'la N global en la barra superior');
});

test('¿Suerte o ventaja?: un solo gráfico con pestañas, el más reciente primero; cada panel, las curvas guardadas de su control', () => {
  const view = section('investigacion');
  const card = /<section class="card wide reveal luck">([\s\S]*?)<\/section>/.exec(view)?.[1] ?? '';
  const dateOf = (id: string): number => research.points.find((p) => p.id === id)?.date ?? 0;
  const expected = [...research.luck].sort((a, b) => dateOf(b.experimentId) - dateOf(a.experimentId)).map((l) => l.experimentId);
  const tabs = [...card.matchAll(/<input type="radio" class="lk-in" name="lk" id="lk-(\d+)"( checked)?><label class="lk-tab" for="lk-\1">([^<]+)<\/label>/g)];
  assert.deepEqual(tabs.map((t) => t[3]), expected, 'una pestaña por experimento con curvas, el más reciente primero');
  assert.deepEqual(tabs.map((t) => t[2] !== undefined), expected.map((_, i) => i === 0), 'marcada por defecto la primera');
  // Sin JavaScript (radios y :has) funciona; sin :has, se ve el primero.
  assert.ok(css.includes('.lk-panel{display:none}.lk-panel:first-of-type{display:block}'));
  assert.ok(css.includes('.luck:has(.lk-in:nth-of-type(2):checked) .lk-panel:nth-of-type(2){display:block}'));
  for (const luck of research.luck) {
    const panel = new RegExp(`<div class="lk-panel" data-exp="${luck.experimentId}">([\\s\\S]*?)</div>\\n?(?=<div class="lk-panel"|</div>)`).exec(card)?.[1] ?? '';
    assert.ok(panel !== '', luck.experimentId);
    assert.equal((panel.match(/<polyline class="ctl draw" pathLength="1"/g) ?? []).length, 2 * luck.samples.length, 'una línea por curva guardada, en cada lienzo');
    assert.equal((panel.match(/<polygon class="band"/g) ?? []).length, 2);
    assert.equal((panel.match(/<polyline class="ln ln-sys draw strat"/g) ?? []).length, 2);
    const percentile = luck.percentile.toFixed(1).replace('.', ',');
    assert.ok(panel.includes(`Percentil ${percentile}.`), percentile);
    assert.ok(panel.includes(luck.percentile >= 95 ? 'difícil de explicar solo con suerte' : 'no se distingue de la suerte'));
  }
  const empty = renderDashboard({ ...page, research: { ...research, luck: [] } });
  assert.ok(section('investigacion', empty).includes('Ningún experimento de este registro guardó las curvas de su control aleatorio'));
});

test('el embudo agrupa los criterios seguidos que no cambian el recuento y marca lo que se pierde en cada uno', () => {
  const rows = funnelRows(research);
  // Cada fila agrupada cubre al menos dos criterios seguidos con el mismo recuento que el paso anterior.
  for (const row of rows.filter((r) => r.label === 'ninguna cae más')) {
    const [from = '', to = ''] = (row.id ?? '').split(' a ');
    const i = research.funnel.findIndex((s) => s.criterion === from);
    const j = research.funnel.findIndex((s) => s.criterion === to);
    assert.ok(j > i && i > 0);
    for (let k = i; k <= j; k++) assert.equal(research.funnel[k]?.count, research.funnel[i - 1]?.count);
  }
  // Lo que se pierde en cada criterio es la diferencia con el paso anterior.
  for (const row of rows.filter((r) => r.id !== null && r.label !== 'ninguna cae más')) {
    const i = research.funnel.findIndex((s) => s.criterion === row.id);
    const lost = (research.funnel[i - 1]?.count ?? 0) - (research.funnel[i]?.count ?? 0);
    assert.equal(row.parts.find((p) => p.cls === 'b-lost')?.value, lost, row.id ?? '');
  }
  assert.ok(rows.some((r) => r.label === 'ninguna cae más'), 'la demo tiene criterios seguidos sin caídas');
  // Los fallos: barras de 5 px y, a 2 px, la parte de NO CONCLUYENTE en un trazo de 3 px; lo que cae en el embudo, 3 px.
  assert.match(section('criterios'), /<rect class="fbar b-lost"[^>]*height="3"/);
  const fails = /<svg class="lg bars"[^>]*aria-label="Fallos por criterio">([\s\S]*?)<\/svg>/.exec(section('criterios'))?.[1] ?? '';
  const both = /<rect class="fbar b-fail" x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="5"[^>]*\/><rect class="fbar b-inc" x="([\d.]+)" y="[\d.]+" width="[\d.]+" height="3"/.exec(fails);
  // En el móvil, una cifra que no cabe al lado de su barra va debajo: ninguna se sale del lienzo de 360.
  const small = /<svg class="sm bars"[^>]*aria-label="Fallos por criterio">([\s\S]*?)<\/svg>/.exec(section('criterios'))?.[1] ?? '';
  for (const m of small.matchAll(/<text class="tk num" x="([\d.]+)"[^>]*>([^<]+)<\/text>/g)) {
    assert.ok(Number(m[1]) + (m[2]?.length ?? 0) * 7.5 <= 360, m[2] ?? '');
  }
  assert.ok(css.includes('.tech-path{display:none}'), 'en el móvil, sin la ruta de docs/ junto al título del embudo');
  assert.ok(section('criterios').includes('<span class="tech tech-path">docs/PROMOTION_CRITERIA.md</span>'));
  assert.ok(both !== null, 'una fila con fallos y no concluyentes');
  assert.equal(Number(both[3]) - (Number(both[1]) + Number(both[2])), 2);
});

test('Embudo de criterios: en orden, cuántos superan cada criterio; y cuántas veces tumbó cada uno', () => {
  const view = section('criterios');
  const lg = /<svg class="lg bars"[^>]*aria-label="Embudo[^"]*">([\s\S]*?)<\/svg>/.exec(view)?.[1] ?? '';
  const labels = [...lg.matchAll(/<text class="flow-label"[^>]*>(?:<tspan class="crit-id">([^<]+)<\/tspan> )?([^<]+)<\/text>/g)].map((m) => [m[1] ?? null, m[2]]);
  const rows = funnelRows(research);
  assert.deepEqual(labels, rows.map((r) => [r.id, r.label]));
  // En orden: cada criterio aparece en su fila o dentro de un grupo, y ninguno falta.
  const covered = rows.flatMap((r) => {
    if (r.id === null) return [];
    if (r.label !== 'ninguna cae más') return [r.id];
    const [from = '', to = ''] = r.id.split(' a ');
    return CRITERIA.slice(CRITERIA.findIndex((c) => c.id === from), CRITERIA.findIndex((c) => c.id === to) + 1).map((c) => c.id);
  });
  assert.deepEqual(covered, CRITERIA.map((c) => c.id));
  const counts = [...lg.matchAll(/<text class="tk num"[^>]*>(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(counts, rows.map((r) => r.parts[0]?.value));
  const fails = /<svg class="lg bars"[^>]*aria-label="Fallos por criterio">([\s\S]*?)<\/svg>/.exec(view)?.[1] ?? '';
  const failed = [...fails.matchAll(/<tspan class="crit-id">([^<]+)<\/tspan>[\s\S]*?<text class="tk num"[^>]*>(\d+) ve(?:z|ces)/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(failed, research.failures.map((f) => [f.criterion, f.fail]));
});

test('ticker: los últimos eventos del diario y, en investigación, los del registro; sin JavaScript, quieto', () => {
  assert.match(html, /<div class="ticker tk-replay has-alt" tabindex="0" aria-label="Últimos eventos del diario"><div class="ticker-track">/);
  assert.match(html, /<div class="ticker tk-research" tabindex="0" aria-label="Últimos movimientos del registro">/);
  const first = research.events[0];
  assert.ok(first !== undefined);
  assert.equal(html.split(escapeHtml(first.text)).length - 1, 2, 'la lista va dos veces para que el desplazamiento no salte');
  assert.match(css, /\.anim \.ticker-track\{animation:ticker 140s linear infinite\}/);
  assert.match(html, /<span class="ticker-copy" aria-hidden="true">/);
});

test('sin registro, la investigación lo dice y el resto de la página sigue igual', () => {
  const alone = renderDashboard({ ...page, research: null });
  assert.ok(section('investigacion', alone).includes('Esta página se generó sin Experiment Registry.'));
  assert.ok(section('criterios', alone).includes('Genera el dashboard con --registro'));
  assert.ok(!alone.includes('N global <b>'));
  assert.ok(!alone.includes('<div class="ticker tk-research"'));
  assert.ok(alone.includes('<div class="ticker tk-replay" tabindex="0" aria-label'), 'sin registro, el ticker del diario se ve en todas las vistas');
  assert.equal(section('replay', alone), section('replay'));
});

test('el sello: en la cabecera, como favicon y en el pie con su línea', () => {
  assert.match(html, /<div class="brand"><svg class="seal seal-top" viewBox="0 0 200 200"/);
  assert.match(html, /<footer>\n<svg class="seal seal-foot" viewBox="0 0 200 200"/);
  assert.ok(html.includes('<p class="seal-line">JP Quant · sello generado del primer commit 902eb0a</p>'));
  assert.ok(html.includes('</svg><span>JP Quant</span></div>'));
  assert.equal((html.match(/<svg class="seal seal-top"[\s\S]*?<\/svg>/)?.[0].match(/<line /g) ?? []).length, 64, 'anillo de marcas radiales');
  assert.doesNotMatch(html, /Inversor JP/, 'el nombre visible es JP Quant');
});

test('fechas en hora de Madrid, con la UTC en el title (invierno +1 h, verano +2 h)', () => {
  assert.ok(html.includes('<time datetime="2024-05-30T00:01:00.000Z" title="2024-05-30 00:01 UTC">30 may 2024, 02:01</time>'));
  assert.ok(render({ asOf: Date.UTC(2024, 0, 15, 12, 30) }).includes('title="Último evento del diario, hora de Madrid">Diario <b>15 ene 13:30</b>'));
});

test('todo texto se escapa: del diario, de la ficha y del registro', () => {
  const evil = '<script>alert("x")</script>';
  const first = snapshot.trades[0];
  assert.ok(first !== undefined);
  const hostileResearch = buildResearch({
    experiments: [{ id: `EXP-0001${evil}`, family: evil, registeredAt: Date.UTC(2026, 0, 1), trials: 1, state: 'registrado', closedAt: null, verdict: null, criteria: {} }],
    luck: [],
  });
  const text = renderDashboard({
    ...page, commit: evil, research: hostileResearch,
    snapshot: {
      ...snapshot, label: evil, runId: evil, trades: [{ ...first, reason: evil, symbol: `${evil}/EUR`, side: evil, kind: evil }],
      attention: [{ level: 'WARNING', message: evil }], curve: { ...snapshot.curve, benchmarkSymbol: `${evil}/EUR` },
    },
  });
  assert.ok(!text.includes(evil));
  assert.ok(text.includes(escapeHtml(evil)));
  assert.equal((text.match(/<script/g) ?? []).length, 1, 'solo el script propio');
});

test('SEC-01 en la página: un código con nombre de Object.prototype se muestra tal cual, sin heredar nada', () => {
  const first = snapshot.trades[0];
  const order = snapshot.orders.open[0];
  assert.ok(first !== undefined && order !== undefined);
  const text = render({
    trades: [{ ...first, side: 'constructor', kind: '__proto__' }],
    orders: { ...snapshot.orders, open: [{ ...order, side: 'toString', type: 'hasOwnProperty', kind: 'valueOf' }] },
  });
  for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) assert.match(text, new RegExp(`<td[^>]*>${word}</td>`), word);
  assert.doesNotMatch(withoutScript(text), /native code|function /);
});

test('es determinista: los mismos datos dan la misma página', () => {
  assert.equal(renderDashboard(page), html);
});

test('Replay en el móvil: operaciones y datos de mercado en líneas compactas (5 y «Ver todas»); posiciones y órdenes, solo los campos clave', () => {
  const replay = section('replay');
  const trades = /<h2>Operaciones<\/h2>[\s\S]*?<div class="only-sm">([\s\S]*?)<\/div>/.exec(replay)?.[1] ?? '';
  const first = /<ul class="lines">([\s\S]*?)<\/ul>/.exec(trades)?.[1] ?? '';
  assert.equal((first.match(/<li>/g) ?? []).length, 5, 'las 5 últimas');
  assert.match(first, /^<li><span><time datetime="[^"]+" title="[^"]+ UTC">\d{2} [a-z]{3} \d{2}:\d{2}<\/time><\/span><span>[A-Z]+\/EUR<\/span><span><span title="(buy|sell)">(Compra|Venta)<\/span><\/span><span><span class="num">[\d.,]+ <i>EUR<\/i><\/span><\/span><\/li>/);
  assert.ok(trades.includes(`<details class="lines-more"><summary>Ver todas (${String(snapshot.trades.length)})</summary>`), 'sin JavaScript, con details');
  assert.match(replay, /<h3>Datos de mercado[\s\S]*?<div class="only-lg">[\s\S]*?<div class="only-sm"><ul class="lines">/);
  assert.match(replay, /<table class="cards compact">[\s\S]*?Ganancia sin cerrar/, 'posiciones, compactas');
  assert.match(replay, /<table class="cards compact">[\s\S]*?Disparo/, 'órdenes, compactas');
  assert.ok(css.includes('table.compact td:not(.kf){display:none}'));
  assert.match(css, /\.only-sm\{display:block\}\.only-lg\{display:none\}/);
  assert.match(css, /@media \(min-width:760px\)\{\.only-lg\{display:block\}/);
});

test('experimentos en el móvil: una línea compacta por experimento (id, familia y desenlace) con «Ver todos»', () => {
  const view = section('investigacion');
  const start = view.indexOf('<h2>Experimentos</h2>');
  const mobile = view.slice(view.indexOf('<div class="only-sm">', start));
  const newest = research.points.at(-1);
  assert.ok(newest !== undefined);
  assert.ok(mobile.startsWith(`<div class="only-sm"><ul class="lines"><li><span><span class="mono">${newest.id}</span></span><span>${newest.family}</span><span><span class="oc"><span class="sw o-`));
  assert.ok(mobile.includes(`<details class="lines-more"><summary>Ver todos (${String(research.points.length)})</summary>`));
  // En escritorio, la tabla y su botón, dentro de only-lg (el botón solo existe ahí).
  assert.ok(view.includes('<div class="only-lg"><div class="exp-list">'));
});

test('embudo y «Por qué fallan»: ninguna etiqueta se monta sobre otra; en escritorio la cifra va siempre a la derecha de su barra', () => {
  const svgs = [...section('criterios').matchAll(/<svg class="(sm|lg) bars"[^>]*>([\s\S]*?)<\/svg>/g)];
  assert.equal(svgs.length, 4, 'embudo y fallos, en móvil y escritorio');
  for (const [, size = '', body = ''] of svgs) {
    const boxes = [...body.matchAll(/<text class="(?:flow-label|tk num)" x="([\d.]+)" y="([\d.]+)">([\s\S]*?)<\/text>/g)].map((m) => {
      const text = (m[3] ?? '').replace(/<[^>]+>/g, '');
      const x = Number(m[1]);
      const y = Number(m[2]);
      return { text, left: x, right: x + text.length * CHAR_W, top: y - 11, bottom: y + 3 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a === undefined || b === undefined) continue;
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        assert.ok(!overlap, `${size}: «${a.text}» se monta sobre «${b.text}»`);
      }
    }
    if (size === 'lg') {
      // Cada cifra, en la misma línea que su barra y a su derecha.
      for (const m of body.matchAll(/<rect class="fbar[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="(\d+)"[^>]*\/>(?:<rect[^>]*\/>)*<text class="tk num" x="([\d.]+)" y="([\d.]+)"/g)) {
        assert.ok(Number(m[5]) >= Number(m[1]) + Number(m[3]), 'a la derecha de la barra');
        const barMid = Number(m[2]) + Number(m[4]) / 2;
        assert.ok(Math.abs(Number(m[6]) - 4 - barMid) <= 3, 'en la línea de la barra, no debajo');
      }
    }
  }
});

test('ticker a unos 30 px por segundo, en pausa con el ratón, el foco o al tocarlo; esfera con una vuelta en no menos de 60 s', () => {
  assert.ok(PAGE_SCRIPT.includes('const TICKER_SPEED = 30;'));
  assert.ok(PAGE_SCRIPT.includes("track.style.animationDuration = (half / TICKER_SPEED).toFixed(1) + 's'"));
  assert.ok(PAGE_SCRIPT.includes("ticker.classList.toggle('hold')"), 'pausa al tocarlo');
  assert.ok(css.includes('.ticker:hover .ticker-track,.ticker:focus-within .ticker-track,.ticker.hold .ticker-track{animation-play-state:paused}'));
  assert.match(html, /<div class="ticker tk-replay[^"]*" tabindex="0"/);
  // Con movimiento reducido no hay .anim: el ticker queda quieto, con el evento más reciente el primero.
  assert.match(css, /\.anim \.ticker-track\{animation:ticker/);
  const speed = Number(/const SPEED = ([\d.]+);/.exec(PAGE_SCRIPT)?.[1]);
  assert.ok(speed > 0 && (2 * Math.PI) / speed >= 60, `una vuelta cada ${String((2 * Math.PI) / speed)} s`);
});
