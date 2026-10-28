// Página del dashboard (paso 41B, ADR 0045; consola de investigación del paso 41C, ADR 0046): un HTML autocontenido, de
// solo lectura, en negros y grises, con cuatro vistas (Resumen, Investigación, Replay y Criterios).
// - Sin recursos externos: la CSP solo admite su hoja de estilos y su script, por su SHA-256, y el favicon como data URI.
//   No hay formularios; los únicos enlaces son a las vistas de la propia página (#…).
// - Las vistas cambian con :target, sin JavaScript. El script solo anima; sin él, todo se ve como imagen fija.
// - Todo texto que viene del diario, de la ficha o del registro se escapa (html-kit.ts).
// - El modo se ve en una línea superior de su color, una etiqueta con contorno, un borde fino alrededor de la página y el
//   título de la pestaña. Con datos sintéticos, una marca de agua.
// - No muestra secretos: el diario no los lleva y la página solo lee el estado.
import { createHash } from 'node:crypto';
import { Decimal } from '../shared/decimal.ts';
import { toUtcIso, type UtcMillis } from '../shared/time.ts';
import { DRAWDOWN_FRAMES, drawdownChart, MAIN_FRAMES, mainChart } from './charts-html.ts';
import type { AlertLevel, DashboardMode, DashboardSnapshot } from './dashboard.ts';
import {
  amount, compactLines, day, decimalSign, delta, e, escapeHtml, float, floatPercent, head, kpi, madrid, money, NBSP, percent, plain, status, table, utc, when, withCurrency,
} from './html-kit.ts';
import { PAGE_SCRIPT, PAGE_SCRIPT_HASH } from './page-script.ts';
import { playbackCard } from './playback-html.ts';
import { experimentsCard, funnelCards, luckCards, MAX_LUCK_TABS, RECENT_EXPERIMENTS, researchBrief, sphereCard } from './research-html.ts';
import type { ResearchSnapshot } from './research.ts';
import { FIRST_COMMIT, PROJECT_NAME, sealFavicon, sealSvg } from './seal.ts';

export { escapeHtml };

const MODES: Readonly<Record<DashboardMode, { readonly title: string; readonly detail: string }>> = {
  REPLAY: { title: 'REPLAY', detail: 'Simulación sobre un diario grabado. Sin dinero real.' },
  PAPER: { title: 'PAPER', detail: 'Datos en vivo y dinero ficticio.' },
  SHADOW: { title: 'SHADOW', detail: 'Cuenta real en solo lectura. No se transmite ninguna orden.' },
  LIVE: { title: 'LIVE', detail: 'DINERO REAL.' },
};

export interface DashboardPage {
  readonly snapshot: DashboardSnapshot;
  readonly research: ResearchSnapshot | null; // null: generado sin registro
  readonly commit: string | null; // hash corto del último commit, si se conoce
}

const CSS = `
:root{color-scheme:dark;--bg:#0A0A0A;--surface:#111111;--raised:#161616;--border:#232323;--grid:#1A1A1A;--bar:#6B6B6B;--run:#D6D6D6;--text:#EDEDED;--muted:#A1A1A1;--faint:#6B6B6B;--accent:#CFC6B4;--pos:#2E9BC4;--neg:#8A8A8A;--inc:#BDBDBD;--abo:#5A5A5A;--strat:#2E9BC4;--bench:#9A9A9A;--warn:#BFA978;--live:#C78F8F;--mode:#8C8C8C;--sans:"Segoe UI Variable Text","Segoe UI Variable","SF Pro Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono","Segoe UI Mono",Menlo,Consolas,monospace}
.mode-REPLAY{--mode:#8C8C8C}.mode-PAPER{--mode:#B4B4B4}.mode-SHADOW{--mode:#DCDCDC}.mode-LIVE{--mode:var(--live)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:#0A0A0A;scroll-padding-top:7rem}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.55 var(--sans);padding-bottom:4.5rem}
body::after{content:"";position:fixed;inset:0;border:1px solid var(--mode);pointer-events:none;z-index:60}
.topbar{position:sticky;top:0;z-index:40;background:var(--bg);border-top:2px solid var(--mode);border-bottom:1px solid var(--border)}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.25rem;padding:.65rem 1rem}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:500;letter-spacing:.01em}
.brand .seal{width:26px;height:26px;color:var(--accent)}
.modetag{font:500 11px/1 var(--mono);letter-spacing:.16em;color:var(--mode);border:1px solid var(--mode);border-radius:4px;padding:.3rem .5rem}
.modedetail{display:none;color:var(--muted);font-size:.8rem}.mode-LIVE .modedetail{display:inline;color:var(--live)}
.stats{display:flex;flex-wrap:wrap;gap:.35rem 1.25rem;margin-left:auto;font:500 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);white-space:nowrap;max-width:100%}
.chip .xs{display:none}
.stats b{font-weight:500;color:var(--text)}
.chip{font:500 10px/1 var(--mono);letter-spacing:.14em;color:var(--muted);border:1px solid #3A3A3A;border-radius:4px;padding:.3rem .45rem}
.ticker{overflow-x:auto;border-top:1px solid var(--border);font:500 10.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);white-space:nowrap}
.anim .ticker{overflow:hidden}
.ticker-track{display:inline-flex;gap:2.75rem;padding:.55rem 1rem;min-width:max-content}
.anim .ticker-track{animation:ticker 140s linear infinite}
.ticker:hover .ticker-track,.ticker:focus-within .ticker-track,.ticker.hold .ticker-track{animation-play-state:paused}
@keyframes ticker{to{transform:translateX(-50%)}}
.tk-research{display:none}
body:has(#investigacion:target) .tk-research,body:has(#criterios:target) .tk-research{display:block}
body:has(#investigacion:target) .tk-replay.has-alt,body:has(#criterios:target) .tk-replay.has-alt{display:none}
.nav{position:fixed;left:0;right:0;bottom:0;z-index:40;display:flex;justify-content:space-around;background:var(--bg);border-top:1px solid var(--border);padding:.35rem .5rem calc(.35rem + env(safe-area-inset-bottom))}
.nav a{color:var(--muted);text-decoration:none;font:500 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;padding:.7rem .5rem;border-top:1px solid transparent}
.nav a:hover,.nav a:focus-visible{color:var(--text)}
body:not(:has(.view:target)) .nav a[href="#resumen"],body:has(#resumen:target) .nav a[href="#resumen"],body:has(#investigacion:target) .nav a[href="#investigacion"],body:has(#replay:target) .nav a[href="#replay"],body:has(#criterios:target) .nav a[href="#criterios"]{color:var(--accent);border-color:var(--accent)}
main{padding:1.5rem 1rem 2rem;max-width:1280px;margin:0 auto;min-width:0}
.view{display:grid;grid-template-columns:minmax(0,1fr);gap:1.25rem;margin-bottom:2.5rem}
body:has(.view:target) .view:not(:target),body:not(:has(.view:target)) .view:not(#resumen){display:none}
.viewhead{grid-column:1/-1;margin:.25rem 0 .25rem}
.viewhead h1{font-size:1.5rem;font-weight:300;letter-spacing:-.01em;margin:.15rem 0 0}
.lbl{font:500 11px/1.4 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1.5rem 1.25rem;min-width:0}
h2{font-size:1rem;font-weight:500;letter-spacing:.005em;margin:0}
h3{font-size:.9rem;font-weight:500;margin:1.75rem 0 0}
.lede{color:var(--muted);font-size:.86rem;margin:.3rem 0 1.25rem;max-width:72ch}
.tech{font:400 11px var(--mono);letter-spacing:0;text-transform:none;color:var(--faint);margin-left:.5rem}
.sentence{font-size:clamp(1.15rem,3.6vw,1.45rem);font-weight:300;line-height:1.45;letter-spacing:-.005em;margin:.25rem 0 1.25rem;max-width:58ch;font-feature-settings:"tnum" 1,"lnum" 1}
.status{border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin:0 0 1.5rem;color:var(--muted);font-size:.88rem}
.status ul{margin:.4rem 0 0;padding-left:1.15rem}
.status .st{color:var(--text)}
.kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 1.5rem}
.kpi{border-top:1px solid var(--border);padding:.9rem 0 1rem;min-width:0}
.kpi .tech{display:block;margin:.1rem 0 0}
.fig{font-weight:300;font-size:clamp(1.45rem,5.4vw,2.05rem);line-height:1.15;letter-spacing:-.025em;font-feature-settings:"tnum" 1,"lnum" 1;margin:.35rem 0 .2rem;overflow-wrap:anywhere}
.fig i{font-style:normal;font-size:.5em;letter-spacing:.04em;color:var(--muted);margin-left:.3rem}
.fig .ic{width:.55em;height:.55em}
.sub{color:var(--muted);font-size:.8rem;margin:0}
.num{font-feature-settings:"tnum" 1,"lnum" 1}
.mono{font-family:var(--mono);font-size:.85em}
.gain,.loss{color:var(--text)}.flat{color:var(--muted)}
.ic{width:.8em;height:.8em;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round;vertical-align:-.04em;margin-right:.3em}
.st{white-space:nowrap}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--faint);margin-right:.5em;vertical-align:.12em}
.st.ok .dot{background:var(--pos)}.st.warn .dot{background:var(--warn)}.st.bad .dot{background:var(--neg)}.st.off .dot{background:var(--faint)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{font:500 11px/1.4 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-align:left;padding:.55rem .75rem .55rem 0;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:.65rem .75rem .65rem 0;border-bottom:1px solid var(--border);white-space:nowrap}
tr:last-child td{border-bottom:0}
th.num,td.num{text-align:right;font-feature-settings:"tnum" 1,"lnum" 1}
td.long{white-space:normal;min-width:14rem;color:var(--muted)}
.note{color:var(--muted);font-size:.8rem;margin:1rem 0 0}
.explain{color:var(--muted);font-size:.88rem;line-height:1.6;max-width:78ch;margin:1rem 0 0}
.meta-line{font:500 11px/1.4 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:-.5rem 0 1rem}
.divider{border-top:1px solid var(--border);margin:1.25rem 0 0}
.lvl{display:inline-block;font:500 10.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--border);border-radius:4px;padding:.3rem .45rem;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;color:var(--muted);font-size:.8rem;margin:0 0 .75rem}
.key{display:inline-block;width:18px;border-top:2px solid var(--strat);vertical-align:middle;margin-right:.4rem}
.key.bench{border-top:1.5px dashed var(--bench)}
.legend-list{display:flex;flex-wrap:wrap;gap:.35rem 1.25rem;list-style:none;padding:0;margin:0 0 .75rem;font-size:.82rem;color:var(--text)}
.oc{white-space:nowrap}
.rows{list-style:none;padding:0;margin:.5rem 0 0;font-size:.85rem}
.rows li{display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-top:1px solid var(--border);color:var(--muted)}
.sphere-info{font:500 11px/1.5 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:.5rem 0 0;min-height:1.5em}
.chart svg{display:block;width:100%;height:auto;font-feature-settings:"tnum" 1,"lnum" 1}
.chart .lg{display:none}
.grid{stroke:var(--grid);stroke-width:1}.base{stroke:#2E2E2E;stroke-width:1}
.tk{fill:var(--faint);font-family:var(--sans)}
.sm text{font-size:11px}.lg text{font-size:12px}
.end{font-weight:500}.end-name{fill:var(--muted);font-weight:400}
.end-sys,.end-bench{fill:var(--text)}
.ln{fill:none;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.ln-sys{stroke:var(--strat);stroke-width:2}.ln-bench{stroke:var(--bench);stroke-dasharray:5 4;stroke-width:1.5}
.pb-chart{display:block;width:100%;height:auto;margin:.5rem 0}.pb-base{stroke:var(--border);stroke-dasharray:2 4}.pb-axis{fill:var(--faint);font:10px var(--mono);text-anchor:end;dominant-baseline:middle}
.pb-mk{stroke:var(--bg);stroke-width:1}.mk-buy{fill:var(--strat)}.mk-sell{fill:var(--text)}.mk-risk{fill:none;stroke:var(--warn);stroke-width:1.8}
.anim .pb-mk{opacity:0;transition:opacity .3s}.anim .pb-mk.on{opacity:1}
.pb-status{display:flex;flex-wrap:wrap;gap:.35rem 1.25rem;margin:.25rem 0 0;font:500 12px/1.4 var(--mono);color:var(--muted)}.pb-status b{font-weight:500;color:var(--text)}
.pk{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.4rem;vertical-align:middle}.pk.buy{background:var(--strat)}.pk.sell{background:var(--text)}.pk.risk{width:auto;height:auto;border-radius:0;color:var(--warn);font-weight:600}
.pb-feed{list-style:none;margin:.5rem 0 0;padding:0;display:flex;flex-direction:column-reverse;max-height:13rem;overflow:auto;font:12px/1.5 var(--mono)}.anim .pb-feed{overflow:hidden}
.pb-ev[hidden]{display:none}.pb-ev{display:flex;flex-wrap:wrap;gap:.2rem .9rem;padding:.3rem 0;border-top:1px solid var(--grid);color:var(--muted)}.pb-ev b{font-weight:500;color:var(--text);min-width:4.5em}.pb-ev.ev-risk b{color:var(--warn)}
.anim .pb-ev:not([hidden]){animation:pbin .4s ease-out}
@keyframes pbin{from{opacity:0;transform:translateY(-4px)}}
.ln-dd{fill:none;stroke:var(--strat);stroke-width:1}.area-dd{fill:var(--strat);fill-opacity:.2}
.hit{fill:transparent}.hit:hover{fill:rgba(237,237,237,.04)}
.wire{fill:none;stroke:#3A3A3A;stroke-width:.6;opacity:.55}
.pt{stroke:var(--bg);stroke-width:.6;outline:none}.pt:focus-visible,.pt:hover{stroke:var(--text);stroke-width:1.2}
.o-acc{fill:var(--pos);stroke:var(--pos)}.o-rej{fill:var(--neg);stroke:var(--neg)}.o-inc{fill:var(--inc);stroke:var(--inc)}.o-abo{fill:none;stroke:var(--abo)}.o-run{fill:var(--run);stroke:var(--run)}
.pt.o-acc,.pt.o-rej,.pt.o-inc,.pt.o-run{stroke:var(--bg)}.pt.o-abo{fill:var(--surface);stroke:var(--abo);stroke-width:1.2}
.flow{fill:none;stroke:#3A3A3A;stroke-opacity:.6}.flow.o-acc,.flow.o-rej,.flow.o-inc,.flow.o-abo,.flow.o-run{fill:none;stroke-opacity:.45}
.sw{display:inline-block;width:8px;height:8px;border-radius:50%;border:1.2px solid transparent;margin-right:.45em;vertical-align:.05em}.sw.o-acc{background:var(--pos)}.sw.o-rej{background:var(--neg)}.sw.o-inc{background:var(--inc)}.sw.o-abo{background:transparent;border-color:var(--abo)}.sw.o-run{background:var(--run)}
.flow-dash{fill:none;stroke:var(--muted);stroke-width:.6;stroke-dasharray:1 9;stroke-opacity:.5}
.anim .flow-dash{animation:flow 9s linear infinite}
@keyframes flow{to{stroke-dashoffset:-40}}
.pt-key{stroke:none}.pt-key.o-abo{fill:var(--surface);stroke:var(--abo);stroke-width:1.2}.node{stroke:var(--muted);stroke-width:1.5}
.flow-label{fill:var(--muted);font-family:var(--sans)}.crit-id{fill:var(--faint);font-family:var(--mono)}
.band{fill:var(--muted);fill-opacity:.1;stroke:none}
.ctl{fill:none;stroke:var(--faint);stroke-width:1;stroke-opacity:.28}
.fbar{fill:var(--bar)}.fbar.b-acc{fill:var(--pos)}.fbar.b-fail{fill:var(--bar)}.fbar.b-lost,.fbar.b-inc{fill:#BDBDBD}
.anim .reveal .draw{stroke-dasharray:1;stroke-dashoffset:1}
.anim .reveal.in .draw{animation:draw 2.8s cubic-bezier(.3,.6,.2,1) forwards}
.anim .reveal.in .strat{animation-duration:2.2s;animation-delay:1s}
@keyframes draw{to{stroke-dashoffset:0}}
.anim .reveal .band{opacity:0;transition:opacity 1.8s ease .4s}.anim .reveal.in .band{opacity:1}
.anim .reveal .fbar{transform:scaleX(0);transform-box:fill-box;transform-origin:0 50%;transition:transform 1.4s cubic-bezier(.2,.7,.2,1)}
.anim .reveal.in .fbar{transform:scaleX(1)}
.paused *,.paused *::before,.paused *::after{animation-play-state:paused!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.bars-cur{fill:var(--strat)}.bars-tgt{fill:var(--faint)}
footer{border-top:1px solid var(--border);margin-top:1rem;padding:2rem 0 1rem;display:grid;gap:1rem;justify-items:start;color:var(--muted);font-size:.8rem}
footer .seal{width:120px;height:120px;color:var(--accent)}
footer .seal-line{font:500 11px/1.5 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0}
.only-sm{display:block}.only-lg{display:none}
.lines{list-style:none;margin:0;padding:0;font-size:.85rem}
.lines li{display:grid;grid-template-columns:auto 1fr auto auto;gap:.65rem;align-items:baseline;padding:.5rem 0;border-top:1px solid var(--border);white-space:nowrap}
.lines li>span:last-child{text-align:right;font-feature-settings:"tnum" 1,"lnum" 1}.lines i{font-style:normal;color:var(--muted);font-size:.85em}
.lines-more summary{display:inline-block;margin-top:.6rem;cursor:pointer;list-style:none;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:.55rem .8rem;font:500 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}
.lines-more summary::-webkit-details-marker{display:none}.lines-more[open] summary{margin-bottom:.4rem}
.pt.o-inc,.pt-key.o-inc{fill:var(--surface);stroke:var(--inc);stroke-width:1.6}.sw.o-inc{background:transparent;border-color:var(--inc)}
.anim .pt.o-run,.anim .sw.o-run{animation:pulse 3.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.lk-tabs{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1rem}
.lk-in{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.lk-tab{cursor:pointer;font:500 11px/1 var(--mono);letter-spacing:.1em;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:.5rem .65rem}
.lk-in:checked+.lk-tab{color:var(--text);border-color:var(--text)}.lk-in:focus-visible+.lk-tab{outline:1px solid var(--text);outline-offset:2px}
.lk-panel{display:none}.lk-panel:first-of-type{display:block}
.luck:has(.lk-in:checked:not(:first-of-type)) .lk-panel:first-of-type{display:none}
${Array.from({ length: MAX_LUCK_TABS - 1 }, (_, k) => `.luck:has(.lk-in:nth-of-type(${String(k + 2)}):checked) .lk-panel:nth-of-type(${String(k + 2)}){display:block}`).join('')}
.exp-list.clip tbody tr:nth-child(n+${String(RECENT_EXPERIMENTS + 1)}){display:none}
.more{margin-top:1rem;background:none;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:.55rem .8rem;font:500 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;cursor:pointer}.more:hover,.more:focus-visible{color:var(--text)}
.intro{grid-column:1/-1;border:1px solid var(--border);border-radius:10px;padding:1rem 1.25rem;color:var(--muted);font-size:.88rem;line-height:1.6}
.intro p{margin:0}.intro strong{color:var(--text);font-weight:500}.intro a{color:var(--text)}
@media (max-width:759.98px){
.stats .sec{display:none}.chip .xs{display:inline}.chip .md{display:none}
table.cards,table.cards tbody{display:block}table.cards thead{display:none}
table.cards tr{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;padding:.55rem .75rem;margin:0 0 .6rem}
table.cards td{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:.2rem 0;border:0;white-space:normal;text-align:right}
table.cards td::before{content:attr(data-label);flex:none;max-width:45%;text-align:left;color:var(--muted);font:500 11px/1.4 var(--sans);letter-spacing:.06em;text-transform:uppercase}
table.compact td:not(.kf){display:none}.tech-path{display:none}table.cards td.kf{order:-1}table.cards td.long{display:block;min-width:0;text-align:left}table.cards td.long::before{display:block;max-width:none;margin-bottom:.15rem}
}
.bars.sm text{font-size:13px}
@media (min-width:760px){.only-lg{display:block}.modedetail{display:inline}.chart .sm{display:none}.chart .lg{display:block}.only-sm{display:none}.kpis{grid-template-columns:repeat(4,minmax(0,1fr))}.card{padding:1.75rem}}
@media (min-width:1024px){body{padding-bottom:0}.shell{display:grid;grid-template-columns:190px minmax(0,1fr)}.nav{position:sticky;top:6.5rem;align-self:start;flex-direction:column;justify-content:flex-start;gap:.25rem;border-top:0;background:transparent;padding:2rem 0 0 1.5rem;z-index:1}.nav a{border-top:0;border-left:1px solid transparent;padding:.6rem .9rem}body:not(:has(.view:target)) .nav a[href="#resumen"],body:has(#resumen:target) .nav a[href="#resumen"],body:has(#investigacion:target) .nav a[href="#investigacion"],body:has(#replay:target) .nav a[href="#replay"],body:has(#criterios:target) .nav a[href="#criterios"]{border-left-color:var(--accent)}main{padding:2rem 2rem 3rem}.view{grid-template-columns:repeat(2,minmax(0,1fr))}.wide{grid-column:1/-1}.card:not(.wide) .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

const CSS_HASH = createHash('sha256').update(CSS, 'utf8').digest('base64');

/** La CSP: nada salvo su hoja de estilos y su script, por su hash, y el favicon en data URI. La comprueban las pruebas. */
export const DASHBOARD_CSP = `default-src 'none'; style-src 'sha256-${CSS_HASH}'; script-src 'sha256-${PAGE_SCRIPT_HASH}'; img-src data:; base-uri 'none'; form-action 'none'`;

const SIDES: ReadonlyMap<string, string> = new Map([['buy', 'Compra'], ['sell', 'Venta']]);
const KINDS: ReadonlyMap<string, string> = new Map([['entry', 'Entrada'], ['exit', 'Salida'], ['protective_stop', 'Stop de protección'], ['stop_update', 'Ajuste del stop']]);
const ORDER_TYPES: ReadonlyMap<string, string> = new Map([['market', 'A mercado'], ['limit', 'Limitada'], ['stop_market', 'Stop a mercado'], ['stop_limit', 'Stop limitada']]);
const ORDER_STATES: ReadonlyMap<string, string> = new Map([
  ['PENDING_SEND', 'Por enviar'], ['SENT', 'Enviada'], ['OPEN', 'Abierta'], ['PARTIALLY_FILLED', 'Ejecutada en parte'], ['CANCEL_PENDING', 'Cancelándose'],
  ['FILLED', 'Ejecutada'], ['CANCELED', 'Cancelada'], ['EXPIRED', 'Caducada'], ['REJECTED', 'Rechazada'], ['NOT_SENT', 'No enviada'], ['UNKNOWN', 'En duda'],
]);
const LAYERS: ReadonlyMap<string, string> = new Map([['risk', 'Control de riesgo'], ['execution', 'Ejecución'], ['capguard', 'Tope de capital'], ['exchange', 'Exchange']]);
const DECISIONS: ReadonlyMap<string, string> = new Map([['REJECTED', 'Rechazada'], ['REDUCED', 'Reducida'], ['APPROVED', 'Aprobada']]);
const ACTIONS: ReadonlyMap<string, string> = new Map([['hold', 'esperar'], ['enter', 'entrar'], ['exit', 'salir']]);
const LEVELS: Readonly<Record<AlertLevel, { readonly text: string; readonly tone: 'bad' | 'warn' | 'off' }>> = {
  CRITICAL: { text: 'Crítica', tone: 'bad' }, WARNING: { text: 'Aviso', tone: 'warn' }, INFO: { text: 'Info', tone: 'off' },
};

// ---- Resumen ----

interface Returns {
  readonly system: number; // fracción
  readonly bench: number | null;
  readonly benchName: string; // «BTC»
}

function returns(s: DashboardSnapshot): Returns {
  const start = Decimal.parse(s.account.startingCash).toAnalysis();
  const lastBench = s.curve.benchmark?.at(-1);
  const [base = s.curve.benchmarkSymbol] = s.curve.benchmarkSymbol.split('/');
  return {
    system: Decimal.parse(s.account.pnlFraction).toAnalysis(),
    bench: lastBench === undefined || start <= 0 ? null : lastBench / start - 1,
    benchName: base,
  };
}

function sentence(s: DashboardSnapshot, r: Returns): string {
  const first = s.curve.at[0];
  const last = s.curve.at.at(-1);
  if (first === undefined || last === undefined) return 'Aún no hay datos suficientes para resumir el periodo: el sistema no ha evaluado ninguna vela.';
  const verb = Math.abs(r.system) < 0.0005 ? 'se ha quedado igual' : r.system > 0 ? `ha ganado un ${floatPercent(r.system)}` : `ha perdido un ${floatPercent(-r.system)}`;
  const versus = r.bench === null ? '' : `, frente al ${floatPercent(r.bench)} de comprar y mantener ${r.benchName}`;
  return `Del ${day(first)} al ${day(last)}, el sistema ${verb}${versus}, con una caída máxima del ${floatPercent(Decimal.parse(s.account.maxDrawdown).toAnalysis())}.`;
}

function attentionBlock(s: DashboardSnapshot): string {
  if (s.attention.length === 0) return `<div class="status" role="status">${status('ok', 'Todo en orden')}</div>`;
  const critical = s.attention.some((a) => a.level === 'CRITICAL');
  const items = s.attention.map((a) => `<li>${e(a.message.charAt(0).toUpperCase() + a.message.slice(1))}</li>`).join('');
  return `<div class="status" role="status">${status(critical ? 'bad' : 'warn', 'Requiere atención')}<ul>${items}</ul></div>`;
}

function summary(s: DashboardSnapshot, r: Returns): string {
  const a = s.account;
  const q = s.quoteCurrency;
  const diff = r.bench === null ? null : (r.system - r.bench) * 100;
  const versus = diff === null
    ? kpi(`Frente a ${r.benchName}`, '—', e(s.curve.benchmarkNote ?? ''))
    : kpi(`Frente a ${r.benchName}`, delta(Math.abs(diff) < 0.005 ? 0 : Math.sign(diff), `${float(Math.abs(diff), 2)}${NBSP}<i>puntos</i>`),
      e(`${r.benchName} comprado y sin tocar: ${floatPercent(r.bench ?? 0, 2)}`));
  return `<section class="card wide">
<p class="sentence">${e(sentence(s, r))}</p>
${attentionBlock(s)}
<div class="kpis">
${kpi('Patrimonio', withCurrency(money(a.equity), q), e(`Empezó con ${money(a.startingCash)}${NBSP}${q}`))}
${kpi('Resultado', delta(decimalSign(a.pnl), withCurrency(money(a.pnl), q)), e(percent(a.pnlFraction)))}
${versus}
${kpi('Caída máxima', percent(a.maxDrawdown), e(`La peor bajada desde un máximo. Ahora: ${percent(a.drawdown)}`), 'drawdown')}
</div></section>`;
}

function evolution(s: DashboardSnapshot, r: Returns): string {
  const { at, equity, benchmark } = s.curve;
  const title = `Evolución frente a comprar y mantener ${r.benchName}`;
  const lede = 'Las dos líneas parten de 100. Si la del sistema queda por encima, le va mejor que comprar y no tocar nada. Valorado al cierre de cada vela, sin los costes de vender.';
  if (equity.length < 2) return `<section class="card wide">${head(title, lede)}<p class="note">Aún no hay curva: el sistema no ha evaluado dos velas.</p></section>`;
  const start = Decimal.parse(s.account.startingCash).toAnalysis();
  const system = equity.map((v) => (v / start) * 100);
  const bench = benchmark === null ? null : benchmark.map((v) => (v / start) * 100);
  // El pico parte del capital inicial, como la caída máxima del estado (dashboard.ts).
  let peak = start;
  const drawdown = equity.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? -((peak - v) / peak) * 100 : 0;
  });
  const worst = drawdown.reduce((low, v, i) => (v < (drawdown[low] ?? 0) ? i : low), 0);
  const worstValue = drawdown[worst] ?? 0;
  const worstWhen = at[worst];
  const legend = `<p class="legend"><span><span class="key"></span>Sistema</span>${bench === null ? `<span>${e(`Sin comprar y mantener: ${s.curve.benchmarkNote ?? ''}`)}</span>` : `<span><span class="key bench"></span>${e(`Comprar y mantener ${r.benchName}, con el coste de la compra`)}</span>`}</p>`;
  return `<section class="card wide">${head(title, lede)}
${legend}
<div class="chart">${MAIN_FRAMES.map((f) => mainChart(f, at, system, bench, r.benchName)).join('')}</div>
<h3>Caída desde el máximo<span class="tech">drawdown</span></h3>
<p class="lede">Cuánto está el patrimonio por debajo de su punto más alto. Es el peor momento que habría que aguantar.</p>
<div class="chart">${DRAWDOWN_FRAMES.map((f) => drawdownChart(f, at, drawdown)).join('')}</div>
<p class="note">${worstValue < 0 && worstWhen !== undefined ? `Peor momento: ${e(`${float(worstValue, 2)}${NBSP}%`)} el ${when(worstWhen)}.` : 'Sin caídas: el patrimonio no ha bajado de su máximo.'}</p>
</section>`;
}

function researchSummary(research: ResearchSnapshot | null): string {
  if (research === null) return '';
  const figures = researchBrief(research).map((row) => kpi(row.label, e(row.value))).join('');
  return `<section class="card wide">${head('Investigación', 'El registro de experimentos en cuatro cifras. La N global cuenta todas las pruebas hechas, también las que fallaron.', 'Experiment Registry')}
<div class="kpis">${figures}</div></section>`;
}

// ---- Replay ----

function health(s: DashboardSnapshot): string {
  const h = s.health;
  const trading = h.trading === 'operando' ? status('ok', 'operando') : h.trading === 'detenido' ? status('bad', 'detenido') : status('warn', 'sin empezar');
  const reconciliation = h.reconciliation.lastResolved === null ? status('warn', 'sin comprobar') : h.reconciliation.lastResolved ? status('ok', 'cuadran') : status('bad', 'no cuadran');
  const feeds = h.feeds.map((f) => [
    e(f.symbol), f.stale ? status('warn', 'con retraso') : status('ok', 'al día'), when(f.lastCloseAt), String(f.candles),
    f.gaps > 0 ? status('warn', String(f.gaps)) : '0', String(f.discarded),
  ]);
  return `<section class="card">${head('Salud del sistema', 'Si funciona, si los datos llegan a tiempo y si sus cuentas cuadran con el exchange.')}
<div class="kpis">
${kpi('Estado', trading, e(h.haltedReason ?? ''))}
${kpi('Freno de emergencia', h.killSwitch ? status('bad', 'activado') : status('ok', 'inactivo'), 'Solo se ve: se acciona fuera de esta página', 'kill switch')}
${kpi('Envío de órdenes', h.executionMode === 'NORMAL' ? status('ok', 'normal') : status('bad', h.executionMode), '', 'execution')}
${kpi('Cuentas', reconciliation, `${e(String(h.reconciliation.count))} ${h.reconciliation.count === 1 ? 'comprobación' : 'comprobaciones'} · última ${when(h.reconciliation.lastAt)}`, 'reconciliación')}
</div>
<h3>Datos de mercado<span class="tech">feeds</span></h3>
<p class="lede">Las velas de cada par: si la última llegó a tiempo y si faltó alguna.</p>
<div class="only-lg">${table([{ label: 'Par', key: true }, { label: 'Estado', key: true }, { label: 'Último cierre' }, { label: 'Velas', num: true }, { label: 'Huecos', num: true, tech: 'gaps' }, { label: 'Descartadas', num: true }], feeds, 'Sin datos de mercado en el diario.')}</div>
${compactLines(h.feeds.map((f) => [whenShort(f.lastCloseAt), e(f.symbol), f.stale ? status('warn', 'con retraso') : status('ok', 'al día'), `<span class="num">${e(f.gaps === 1 ? '1 hueco' : `${String(f.gaps)} huecos`)}</span>`]), 'Sin datos de mercado en el diario.')}
</section>`;
}

/** «26 may 02:01», con la UTC en el title: la fecha corta de las líneas compactas del móvil. */
function whenShort(at: UtcMillis | null): string {
  if (at === null) return '—';
  const m = madrid(at);
  return `<time datetime="${e(toUtcIso(at))}" title="${e(utc(at))}">${e(`${m.day} ${m.month} ${m.time}`)}</time>`;
}


function capital(s: DashboardSnapshot): string {
  const a = s.account;
  const q = s.quoteCurrency;
  return `<section class="card">${head('Capital', 'Dónde está el dinero: en efectivo o invertido, lo ganado en operaciones cerradas y lo pagado en comisiones.')}
<div class="kpis">
${kpi('Efectivo', withCurrency(money(a.cash), q), '', 'liquidez')}
${kpi('Invertido', withCurrency(money(a.exposure), q), e(`${percent(a.exposureFraction)} del patrimonio`), 'exposición')}
${kpi('Ganado en ventas', delta(decimalSign(a.realizedPnl), withCurrency(money(a.realizedPnl), q)), 'Operaciones ya cerradas', 'P&L realizado')}
${kpi('Comisiones pagadas', withCurrency(money(a.fees), q))}
</div></section>`;
}

function positionsAndOrders(s: DashboardSnapshot): string {
  const q = s.quoteCurrency;
  const positions = s.positions.map((p) => [
    e(p.symbol), amount(p.quantity), money(p.averageEntry), money(p.lastClose), money(p.value), delta(decimalSign(p.unrealizedPnl), money(p.unrealizedPnl)),
    p.protectiveStop === null ? status('warn', 'sin stop') : `${status('ok', 'activo')} ${money(p.protectiveStop)}`,
  ]);
  const orders = s.orders.open.map((o) => [
    e(o.symbol), plain(SIDES, o.side), plain(ORDER_TYPES, o.type), plain(KINDS, o.kind), plain(ORDER_STATES, o.state), o.quantity === null ? '?' : amount(o.quantity),
    amount(o.filled), o.triggerPrice === null ? '—' : money(o.triggerPrice), when(o.updatedAt),
  ]);
  const states = Object.entries(s.orders.byState).sort(([a], [b]) => (a < b ? -1 : 1)).map(([state, n]) => `${ORDER_STATES.get(state) ?? state}: ${String(n)}`).join(' · ');
  return `<section class="card wide">${head('Posiciones', 'Lo que el sistema tiene comprado ahora y cuánto ganaría o perdería si lo vendiera al último precio.')}
${table([{ label: 'Par', key: true }, { label: 'Cantidad', num: true }, { label: 'Precio medio', num: true, tech: 'entrada media, con comisiones' }, { label: 'Último precio', num: true }, { label: `Valor (${q})`, num: true }, { label: 'Ganancia sin cerrar', num: true, tech: 'P&L no realizado', key: true }, { label: 'Stop de protección', num: true, tech: 'stop que ya espera en el exchange', key: true }], positions, 'Sin posiciones abiertas.', { compact: true })}
<p class="note">Valor al último cierre del diario, sin los costes de vender. El stop de protección vende solo si el precio cae hasta él; sin él, una caída no tiene freno.</p></section>
<section class="card wide">${head('Órdenes abiertas', 'Órdenes enviadas que aún no se han ejecutado del todo ni cancelado.')}
${table([{ label: 'Par', key: true }, { label: 'Lado', key: true }, { label: 'Tipo' }, { label: 'Para' }, { label: 'Estado', key: true }, { label: 'Cantidad', num: true }, { label: 'Ejecutada', num: true }, { label: 'Disparo', num: true, tech: 'trigger', key: true }, { label: 'Actualizada' }], orders, 'Ninguna orden abierta.', { compact: true })}
<p class="note">${e(states === '' ? 'Sin órdenes en el diario.' : `Todas las órdenes del periodo: ${states}.`)}</p></section>`;
}

function activity(s: DashboardSnapshot): string {
  const trades = s.trades.map((t) => [
    when(t.at), e(t.symbol), plain(SIDES, t.side), plain(KINDS, t.kind), amount(t.quantity), money(t.price), money(t.notional), money(t.fee), { long: e(t.reason) },
  ]);
  const rejections = s.rejections.map((r) => [
    when(r.at), plain(LAYERS, r.layer), plain(DECISIONS, r.decision), `<span class="mono">${e(r.reasonCode)}</span>`, e(r.symbol ?? '—'), r.side === null ? '—' : plain(SIDES, r.side),
    r.kind === null ? '—' : plain(KINDS, r.kind), { long: `<span class="mono">${e(r.reasonCodes.join(', '))}</span>` },
  ]);
  const shown = (n: number, total: number): string => (total > n ? ` Se muestran las ${String(n)} más recientes de ${String(total)}.` : '');
  return `<section class="card wide">${head('Operaciones', 'Compras y ventas ejecutadas, las más recientes primero, con su motivo y su comisión.')}
<div class="only-lg">${table([{ label: 'Fecha', key: true }, { label: 'Par', key: true }, { label: 'Lado', key: true }, { label: 'Para' }, { label: 'Cantidad', num: true }, { label: 'Precio', num: true }, { label: `Importe (${s.quoteCurrency})`, num: true, key: true }, { label: 'Comisión', num: true }, { label: 'Motivo' }], trades, 'Ninguna operación todavía.')}</div>
${compactLines(s.trades.map((t) => [whenShort(t.at), e(t.symbol), plain(SIDES, t.side), `<span class="num">${withCurrency(money(t.notional), s.quoteCurrency)}</span>`]), 'Ninguna operación todavía.')}
<p class="note">${e(`La comisión es el coste explícito; el spread y el deslizamiento (slippage) ya van en el precio.${shown(s.trades.length, s.tradesTotal)}`)}</p></section>
<section class="card wide">${head('Órdenes frenadas por el control de riesgo', 'Órdenes que el control de riesgo rechazó o redujo antes de enviarse, con su motivo. Así se ve que los límites actúan.')}
${table([{ label: 'Fecha', key: true }, { label: 'Quién' }, { label: 'Decisión', key: true }, { label: 'Motivo', tech: 'reason_code', key: true }, { label: 'Par' }, { label: 'Lado' }, { label: 'Para' }, { label: 'Todos los motivos', tech: 'reason_codes' }], rejections, 'Ninguna orden frenada.')}
<p class="note">${e(`El motivo es un código fijo del catálogo de riesgo (reason_code).${shown(s.rejections.length, s.rejectionsTotal)}`)}</p></section>`;
}

function strategiesAndAlerts(s: DashboardSnapshot): string {
  const strategies = s.strategies.map((st) => {
    const params = Object.entries(st.params).map(([k, v]) => `${k} = ${String(v)}`).join(', ');
    const last = st.last.map((l) => `${e(l.symbol)}: ${l.action === null ? 'sin acción' : plain(ACTIONS, l.action)} <span class="tech">${e(l.reason ?? 'sin motivo')}</span>`).join('<br>');
    return [
      `<span class="mono">${e(`${st.id}@${st.version}`)}</span>`, st.state === 'activa' ? status('ok', 'activa') : status('bad', 'detenida'),
      { long: `<span class="mono">${e(params)}</span>` }, String(st.evaluations), String(st.intents), { long: last },
    ];
  });
  const alerts = s.alerts.map((a) => [when(a.at), status(LEVELS[a.level].tone, LEVELS[a.level].text), { long: e(a.message) }]);
  const counts = (['CRITICAL', 'WARNING', 'INFO'] as const satisfies readonly AlertLevel[]).map((level) => `${LEVELS[level].text}: ${String(s.alertCounts[level])}`).join(' · ');
  return `<section class="card wide">${head('Estrategias', 'Las reglas que deciden comprar o vender, con qué parámetros y qué decidieron la última vez en cada par.')}
${table([{ label: 'Estrategia', key: true }, { label: 'Estado', key: true }, { label: 'Parámetros' }, { label: 'Evaluaciones', num: true }, { label: 'Intenciones', num: true, tech: 'órdenes propuestas a Risk' }, { label: 'Última decisión por par' }], strategies, 'Ninguna estrategia.')}</section>
<section class="card wide">${head('Alertas recientes', 'Avisos que salen solos de lo ocurrido, con una tabla fija de reglas. Las más recientes primero.')}
${table([{ label: 'Fecha', key: true }, { label: 'Nivel', key: true }, { label: 'Mensaje' }], alerts, 'Ninguna alerta.')}
<p class="note">${e(`En total: ${counts}.`)}</p></section>`;
}

function planB(s: DashboardSnapshot): string {
  const p = s.planB;
  const q = s.quoteCurrency;
  if (!p.hasTarget) return `<section class="card wide"><h2>Plan B</h2><p class="lede">${e('Sin reparto objetivo todavía: lo fija la persona en los pasos 49 a 52. El proyecto no lo decide ni lo recomienda.')}</p></section>`;
  const width = 200;
  const rows = p.allocation.map((row) => {
    const bar = (fractionText: string | null, cls: string, y: number): string => {
      if (fractionText === null) return '';
      const share = Math.min(Math.max(Decimal.parse(fractionText).toAnalysis(), 0), 1);
      return `<rect class="${cls}" x="0" y="${String(y)}" width="${(share * width).toFixed(1)}" height="5" rx="1"/>`;
    };
    const svg = `<svg viewBox="0 0 ${String(width)} 14" width="120" height="9" role="img" aria-label="Reparto de ${e(row.asset)}">${bar(row.current, 'bars-cur', 0)}${bar(row.target, 'bars-tgt', 8)}</svg>`;
    return [
      e(row.asset), money(row.value), percent(row.current), row.target === null ? '—' : percent(row.target),
      row.deviation === null ? '—' : delta(decimalSign(row.deviation), percent(row.deviation)), svg,
    ];
  });
  return `<section class="card wide">${head('Plan B', 'Lo aportado y el reparto actual frente al objetivo, cuando la persona lo fije.')}
<div class="kpis">
${kpi('Aportado', withCurrency(money(p.contributions), q), e(p.contributionsNote))}
${kpi('Próximo rebalanceo', p.nextRebalanceAt === null ? '—' : when(p.nextRebalanceAt), p.nextRebalanceAt === null ? 'Sin calendario: lo fija la persona en los pasos 49 a 52' : '')}
</div>
<h3>Reparto actual frente al objetivo</h3>
<p class="lede">Qué parte del patrimonio está en cada activo.</p>
${table([{ label: 'Activo' }, { label: `Valor (${q})`, num: true }, { label: 'Actual', num: true }, { label: 'Objetivo', num: true }, { label: 'Desviación', num: true }, { label: 'Actual / objetivo' }], rows, 'Sin patrimonio.')}
<p class="note">${e(p.hasTarget ? 'Barra en color: reparto actual. Barra gris: objetivo.' : 'Sin reparto objetivo: lo fija la persona en los pasos 49 a 52. El proyecto no lo decide ni lo recomienda.')}</p></section>`;
}

// ---- Marco: barra superior, ticker, menú y pie ----

const TICKER_ITEMS = 24;

function tickerHtml(cls: string, items: readonly { readonly at: UtcMillis; readonly text: string }[], label: string): string {
  if (items.length === 0) return '';
  const entry = (item: { readonly at: UtcMillis; readonly text: string }): string => {
    const m = madrid(item.at);
    return `<span>${e(`${m.day} ${m.month} ${m.year} ${m.time} · ${item.text}`)}</span>`;
  };
  const list = items.slice(0, TICKER_ITEMS).map(entry).join('');
  // La lista va dos veces para que el desplazamiento no tenga salto; la copia no la leen los lectores de pantalla.
  return `<div class="ticker ${cls}" tabindex="0" aria-label="${e(label)}"><div class="ticker-track">${list}<span class="ticker-copy" aria-hidden="true">${list}</span></div></div>`;
}

function replayEvents(s: DashboardSnapshot): { readonly at: UtcMillis; readonly text: string }[] {
  const trades = s.trades.map((t) => ({ at: t.at, text: `${SIDES.get(t.side) ?? t.side} ${t.symbol} ${amount(t.quantity)} a ${money(t.price)} · ${KINDS.get(t.kind) ?? t.kind}` }));
  const alerts = s.alerts.map((a) => ({ at: a.at, text: `${LEVELS[a.level].text}: ${a.message}` }));
  return [...trades, ...alerts].sort((a, b) => b.at - a.at);
}

function topbar(page: DashboardPage): string {
  const s = page.snapshot;
  const mode = MODES[s.mode];
  const m = madrid(s.asOf);
  const research = page.research;
  const stats = [
    research === null ? '' : `<span>N global <b>${e(String(research.globalN))}</b></span>`,
    page.commit === null ? '' : `<span class="sec">Commit <b>${e(page.commit)}</b></span>`,
    `<span class="sec" title="${e(`Último evento del diario, hora de Madrid`)}">Diario <b>${e(`${m.day} ${m.month} ${m.time}`)}</b></span>`,
    '<time id="reloj" hidden></time>',
  ].join('');
  const replay = tickerHtml(`tk-replay${research === null ? '' : ' has-alt'}`, replayEvents(s), 'Últimos eventos del diario');
  const registry = research === null ? '' : tickerHtml('tk-research', research.events, 'Últimos movimientos del registro');
  return `<header class="topbar">
<div class="bar">
<div class="brand">${sealSvg({ className: 'seal-top' })}<span>${e(PROJECT_NAME)}</span></div>
<strong class="modetag" title="${e(mode.detail)}">MODO ${e(mode.title)}</strong>
<span class="modedetail">${e(mode.detail)}</span>
${s.synthetic ? '<span class="chip" title="Datos de demostración"><span class="md">DATOS DE DEMOSTRACIÓN</span><span class="xs">DEMO</span></span>' : ''}
<div class="stats">${stats}</div>
</div>
${replay}${registry}
</header>`;
}

/** Solo en la demo: dos líneas para quien llega de fuera. El enlace a la metodología es provisional hasta el paso 49. */
const INTRO = `<section class="intro"><p><strong>JP Quant</strong> es una consola personal de investigación cuantitativa en cripto: cada estrategia se registra antes de probarla y se juzga con criterios fijados de antemano. Todo lo que ves son <strong>datos sintéticos de demostración</strong>.</p>
<p>Lee de arriba abajo: Resumen dice cómo va; en Investigación cada punto es un experimento; Criterios cuenta cuántos superan cada criterio y por qué fallan. <a href="#criterios">Metodología (provisional)</a></p></section>`;

const NAV = '<nav class="nav" aria-label="Vistas"><a href="#resumen">Resumen</a><a href="#investigacion">Investigación</a><a href="#replay">Replay</a><a href="#criterios">Criterios</a></nav>';

function viewHead(title: string, subtitle: string): string {
  return `<header class="viewhead"><p class="lbl">${e(subtitle)}</p><h1>${e(title)}</h1></header>`;
}

function noResearch(title: string): string {
  return `<section class="card wide">${head(title, 'Esta página se generó sin Experiment Registry.')}<p class="note">Genera el dashboard con --registro para ver la investigación. La demo pública usa un registro sintético; los resultados reales solo se ven en local.</p></section>`;
}

/** La página completa. Pura: con los mismos datos da el mismo texto. */
export function renderDashboard(page: DashboardPage): string {
  const s = page.snapshot;
  const research = page.research;
  const mode = MODES[s.mode];
  const r = returns(s);
  const label = s.label;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>${e(`[${mode.title}] ${PROJECT_NAME} · estado`)}</title>
<link rel="icon" type="image/svg+xml" href="${sealFavicon()}">
<style>${CSS}</style>
</head>
<body class="mode-${e(s.mode)}">
${topbar(page)}
<div class="shell">
${NAV}
<main>
<section class="view" id="resumen">
${viewHead('Resumen', label)}
${s.synthetic ? INTRO : ''}
${summary(s, r)}
${playbackCard(s, r.benchName)}
${evolution(s, r)}
${researchSummary(research)}
</section>
<section class="view" id="investigacion">
${viewHead('Investigación', 'Experiment Registry')}
${research === null ? noResearch('Núcleo del registro') : `${sphereCard(research)}\n${luckCards(research)}\n${experimentsCard(research)}`}
</section>
<section class="view" id="replay">
${viewHead('Replay', `${label} · run ${s.runId} · ${String(s.health.events)} eventos`)}
${health(s)}
${capital(s)}
${positionsAndOrders(s)}
${activity(s)}
${strategiesAndAlerts(s)}
${planB(s)}
</section>
<section class="view" id="criterios">
${viewHead('Criterios', 'Criterios congelados del paso 27')}
${research === null ? noResearch('Embudo de criterios') : funnelCards(research)}
</section>
<footer>
${sealSvg({ className: 'seal-foot' })}
<p class="seal-line">${e(`${PROJECT_NAME} · sello generado del primer commit ${FIRST_COMMIT.slice(0, 7)}`)}</p>
<p>Solo lectura: esta página no puede enviar órdenes, cambiar la configuración ni activar el freno de emergencia. Se genera a partir del diario y del registro, sin servidor ni acceso remoto. Fechas en hora de Madrid; al pasar el ratón se ve la UTC.</p>
</footer>
</main>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
