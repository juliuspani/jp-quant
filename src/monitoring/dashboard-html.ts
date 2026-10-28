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
import { lang, phrase, t } from './i18n.ts';
import { PAGE_SCRIPT, PAGE_SCRIPT_HASH } from './page-script.ts';
import { playbackCard } from './playback-html.ts';
import { experimentsCard, funnelCards, luckCards, type LuckIllustration, MAX_LUCK_TABS, RECENT_EXPERIMENTS, researchBrief, sphereCard } from './research-html.ts';
import type { ResearchSnapshot } from './research.ts';
import { FIRST_COMMIT, PROJECT_NAME, sealFavicon, sealSvg } from './seal.ts';

export { escapeHtml };

function modes(): Readonly<Record<DashboardMode, { readonly title: string; readonly detail: string }>> {
  return {
    REPLAY: { title: 'REPLAY', detail: t('Simulación sobre un diario grabado. Sin dinero real.', 'Simulation over a recorded journal. No real money.') },
    PAPER: { title: 'PAPER', detail: t('Datos en vivo y dinero ficticio.', 'Live data and paper money.') },
    SHADOW: { title: 'SHADOW', detail: t('Cuenta real en solo lectura. No se transmite ninguna orden.', 'Real account, read only. No order is sent.') },
    LIVE: { title: 'LIVE', detail: t('DINERO REAL.', 'REAL MONEY.') },
  };
}

export interface DashboardPage {
  readonly snapshot: DashboardSnapshot;
  readonly research: ResearchSnapshot | null; // null: generado sin registro
  readonly commit: string | null; // hash corto del último commit, si se conoce
  readonly languages?: { readonly es: string; readonly en: string }; // enlaces del selector de idioma; sin ellos, no hay selector
  readonly planB?: DashboardSnapshot; // el replay del bot de plan B, para su tarjeta (demo pública)
  readonly luckIllustration?: LuckIllustration; // abanico ilustrativo con el replay sintético, si el registro no guardó curvas
  readonly planBLink?: string; // enlace a la página completa del Autopilot (antes «bot de plan B»)
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
.langs{display:flex;gap:.6rem;font:500 11px/1 var(--mono);letter-spacing:.12em}.langs a{color:var(--muted);text-decoration:none;padding:.3rem .2rem;border-bottom:1px solid transparent}.langs a:hover,.langs a:focus-visible{color:var(--text)}.langs a[aria-current]{color:var(--text);border-color:var(--text)}
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

// Funciones y no constantes: el texto depende del idioma de la página (i18n.ts).
const sides = (): ReadonlyMap<string, string> => new Map([['buy', t('Compra', 'Buy')], ['sell', t('Venta', 'Sell')]]);
const kinds = (): ReadonlyMap<string, string> => new Map([['entry', t('Entrada', 'Entry')], ['exit', t('Salida', 'Exit')], ['protective_stop', t('Stop de protección', 'Protective stop')], ['stop_update', t('Ajuste del stop', 'Stop update')]]);
const orderTypes = (): ReadonlyMap<string, string> => new Map([['market', t('A mercado', 'Market')], ['limit', t('Limitada', 'Limit')], ['stop_market', t('Stop a mercado', 'Stop market')], ['stop_limit', t('Stop limitada', 'Stop limit')]]);
const orderStates = (): ReadonlyMap<string, string> => new Map([
  ['PENDING_SEND', t('Por enviar', 'To send')], ['SENT', t('Enviada', 'Sent')], ['OPEN', t('Abierta', 'Open')], ['PARTIALLY_FILLED', t('Ejecutada en parte', 'Partly filled')], ['CANCEL_PENDING', t('Cancelándose', 'Cancelling')],
  ['FILLED', t('Ejecutada', 'Filled')], ['CANCELED', t('Cancelada', 'Cancelled')], ['EXPIRED', t('Caducada', 'Expired')], ['REJECTED', t('Rechazada', 'Rejected')], ['NOT_SENT', t('No enviada', 'Not sent')], ['UNKNOWN', t('En duda', 'Unknown')],
]);
const layers = (): ReadonlyMap<string, string> => new Map([['risk', t('Control de riesgo', 'Risk control')], ['execution', t('Ejecución', 'Execution')], ['capguard', t('Tope de capital', 'Capital guard')], ['exchange', 'Exchange']]);
const decisions = (): ReadonlyMap<string, string> => new Map([['REJECTED', t('Rechazada', 'Rejected')], ['REDUCED', t('Reducida', 'Reduced')], ['APPROVED', t('Aprobada', 'Approved')]]);
const actions = (): ReadonlyMap<string, string> => new Map([['hold', t('esperar', 'hold')], ['enter', t('entrar', 'enter')], ['exit', t('salir', 'exit')], ['buy', t('comprar', 'buy')], ['sell', t('vender', 'sell')]]);
const levels = (): Readonly<Record<AlertLevel, { readonly text: string; readonly tone: 'bad' | 'warn' | 'off' }>> => ({
  CRITICAL: { text: t('Crítica', 'Critical'), tone: 'bad' }, WARNING: { text: t('Aviso', 'Warning'), tone: 'warn' }, INFO: { text: 'Info', tone: 'off' },
});

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
  if (first === undefined || last === undefined) return t('Aún no hay datos suficientes para resumir el periodo: el sistema no ha evaluado ninguna vela.', 'Not enough data to summarise the period yet: the system has not evaluated any candle.');
  const dd = floatPercent(Decimal.parse(s.account.maxDrawdown).toAnalysis());
  if (lang() === 'en') {
    const verb = Math.abs(r.system) < 0.0005 ? 'stayed flat' : r.system > 0 ? `gained ${floatPercent(r.system)}` : `lost ${floatPercent(-r.system)}`;
    const versus = r.bench === null ? '' : `, against ${floatPercent(r.bench)} for buying and holding ${r.benchName}`;
    return `From ${day(first)} to ${day(last)}, the system ${verb}${versus}, with a maximum drawdown of ${dd}.`;
  }
  const verb = Math.abs(r.system) < 0.0005 ? 'se ha quedado igual' : r.system > 0 ? `ha ganado un ${floatPercent(r.system)}` : `ha perdido un ${floatPercent(-r.system)}`;
  const versus = r.bench === null ? '' : `, frente al ${floatPercent(r.bench)} de comprar y mantener ${r.benchName}`;
  return `Del ${day(first)} al ${day(last)}, el sistema ${verb}${versus}, con una caída máxima del ${dd}.`;
}

function attentionBlock(s: DashboardSnapshot): string {
  if (s.attention.length === 0) return `<div class="status" role="status">${status('ok', t('Todo en orden', 'All clear'))}</div>`;
  const critical = s.attention.some((a) => a.level === 'CRITICAL');
  const items = s.attention.map((a) => `<li>${e(a.message.charAt(0).toUpperCase() + a.message.slice(1))}</li>`).join('');
  return `<div class="status" role="status">${status(critical ? 'bad' : 'warn', t('Requiere atención', 'Needs attention'))}<ul>${items}</ul></div>`;
}

function summary(s: DashboardSnapshot, r: Returns): string {
  const a = s.account;
  const q = s.quoteCurrency;
  const diff = r.bench === null ? null : (r.system - r.bench) * 100;
  const versus = diff === null
    ? kpi(`${t('Frente a', 'Against')} ${r.benchName}`, '—', e(s.curve.benchmarkNote ?? ''))
    : kpi(`${t('Frente a', 'Against')} ${r.benchName}`, delta(Math.abs(diff) < 0.005 ? 0 : Math.sign(diff), `${float(Math.abs(diff), 2)}${NBSP}<i>${t('puntos', 'points')}</i>`),
      e(`${r.benchName} ${t('comprado y sin tocar', 'bought and held')}: ${floatPercent(r.bench ?? 0, 2)}`));
  return `<section class="card wide">
<p class="sentence">${e(sentence(s, r))}</p>
${attentionBlock(s)}
<div class="kpis">
${kpi(t('Patrimonio', 'Equity'), withCurrency(money(a.equity), q), e(`${t('Empezó con', 'Started with')} ${money(a.startingCash)}${NBSP}${q}`))}
${kpi(t('Resultado', 'Result'), delta(decimalSign(a.pnl), withCurrency(money(a.pnl), q)), e(percent(a.pnlFraction)))}
${versus}
${kpi(t('Caída máxima', 'Max drawdown'), percent(a.maxDrawdown), e(`${t('La peor bajada desde un máximo. Ahora', 'The worst fall from a peak. Now')}: ${percent(a.drawdown)}`), 'drawdown')}
</div></section>`;
}

function evolution(s: DashboardSnapshot, r: Returns): string {
  const { at, equity, benchmark } = s.curve;
  const title = t(`Evolución frente a comprar y mantener ${r.benchName}`, `Equity against buying and holding ${r.benchName}`);
  const lede = t('Las dos líneas parten de 100. Si la del sistema queda por encima, le va mejor que comprar y no tocar nada. Valorado al cierre de cada vela, sin los costes de vender.', 'Both lines start at 100. If the system line ends higher, it did better than buying and doing nothing. Valued at each candle close, before selling costs.');
  if (equity.length < 2) return `<section class="card wide">${head(title, lede)}<p class="note">${t('Aún no hay curva: el sistema no ha evaluado dos velas.', 'No curve yet: the system has not evaluated two candles.')}</p></section>`;
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
  const legend = `<p class="legend"><span><span class="key"></span>${t('Sistema', 'System')}</span>${bench === null ? `<span>${e(`${t('Sin comprar y mantener', 'No buy-and-hold')}: ${s.curve.benchmarkNote ?? ''}`)}</span>` : `<span><span class="key bench"></span>${e(t(`Comprar y mantener ${r.benchName}, con el coste de la compra`, `Buy and hold ${r.benchName}, with the cost of buying`))}</span>`}</p>`;
  return `<section class="card wide">${head(title, lede)}
${legend}
<div class="chart">${MAIN_FRAMES.map((f) => mainChart(f, at, system, bench, r.benchName)).join('')}</div>
<h3>${t('Caída desde el máximo', 'Drawdown from the peak')}<span class="tech">drawdown</span></h3>
<p class="lede">${t('Cuánto está el patrimonio por debajo de su punto más alto. Es el peor momento que habría que aguantar.', 'How far equity is below its highest point: the worst moment you would have to sit through.')}</p>
<div class="chart">${DRAWDOWN_FRAMES.map((f) => drawdownChart(f, at, drawdown)).join('')}</div>
<p class="note">${worstValue < 0 && worstWhen !== undefined ? `${t('Peor momento', 'Worst moment')}: ${e(`${float(worstValue, 2)}${NBSP}%`)} ${t('el', 'on')} ${when(worstWhen)}.` : t('Sin caídas: el patrimonio no ha bajado de su máximo.', 'No drawdown: equity never fell below its peak.')}</p>
</section>`;
}

function researchSummary(research: ResearchSnapshot | null): string {
  if (research === null) return '';
  const figures = researchBrief(research).map((row) => kpi(row.label, e(row.value))).join('');
  return `<section class="card wide">${head(t('Investigación', 'Research'), t('El registro de experimentos en cuatro cifras. La N global cuenta todas las pruebas hechas, también las que fallaron.', 'The experiment registry in four figures. The global N counts every test run, including the ones that failed.'), 'Experiment Registry')}
<div class="kpis">${figures}</div></section>`;
}

// ---- Replay ----

function health(s: DashboardSnapshot): string {
  const h = s.health;
  const trading = h.trading === 'operando' ? status('ok', t('operando', 'running')) : h.trading === 'detenido' ? status('bad', t('detenido', 'halted')) : status('warn', t('sin empezar', 'not started'));
  const reconciliation = h.reconciliation.lastResolved === null ? status('warn', t('sin comprobar', 'not checked')) : h.reconciliation.lastResolved ? status('ok', t('cuadran', 'match')) : status('bad', t('no cuadran', 'mismatch'));
  const feeds = h.feeds.map((f) => [
    e(f.symbol), f.stale ? status('warn', t('con retraso', 'late')) : status('ok', t('al día', 'up to date')), when(f.lastCloseAt), String(f.candles),
    f.gaps > 0 ? status('warn', String(f.gaps)) : '0', String(f.discarded),
  ]);
  return `<section class="card">${head(t('Salud del sistema', 'System health'), t('Si funciona, si los datos llegan a tiempo y si sus cuentas cuadran con el exchange.', 'Whether it runs, whether data arrives on time and whether its books match the exchange.'))}
<div class="kpis">
${kpi(t('Estado', 'Status'), trading, e(h.haltedReason ?? ''))}
${kpi(t('Freno de emergencia', 'Emergency brake'), h.killSwitch ? status('bad', t('activado', 'on')) : status('ok', t('inactivo', 'off')), t('Solo se ve: se acciona fuera de esta página', 'Display only: it is operated outside this page'), 'kill switch')}
${kpi(t('Envío de órdenes', 'Order sending'), h.executionMode === 'NORMAL' ? status('ok', 'normal') : status('bad', h.executionMode), '', 'execution')}
${kpi(t('Cuentas', 'Books'), reconciliation, `${e(String(h.reconciliation.count))} ${h.reconciliation.count === 1 ? t('comprobación', 'check') : t('comprobaciones', 'checks')} · ${t('última', 'last')} ${when(h.reconciliation.lastAt)}`, t('reconciliación', 'reconciliation'))}
</div>
<h3>${t('Datos de mercado', 'Market data')}<span class="tech">feeds</span></h3>
<p class="lede">${t('Las velas de cada par: si la última llegó a tiempo y si faltó alguna.', 'The candles of each pair: whether the last one arrived on time and whether any were missing.')}</p>
<div class="only-lg">${table([{ label: t('Par', 'Pair'), key: true }, { label: t('Estado', 'Status'), key: true }, { label: t('Último cierre', 'Last close') }, { label: t('Velas', 'Candles'), num: true }, { label: t('Huecos', 'Gaps'), num: true, tech: 'gaps' }, { label: t('Descartadas', 'Discarded'), num: true }], feeds, t('Sin datos de mercado en el diario.', 'No market data in the journal.'))}</div>
${compactLines(h.feeds.map((f) => [whenShort(f.lastCloseAt), e(f.symbol), f.stale ? status('warn', t('con retraso', 'late')) : status('ok', t('al día', 'up to date')), `<span class="num">${e(f.gaps === 1 ? t('1 hueco', '1 gap') : `${String(f.gaps)} ${t('huecos', 'gaps')}`)}</span>`]), t('Sin datos de mercado en el diario.', 'No market data in the journal.'))}
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
  return `<section class="card">${head('Capital', t('Dónde está el dinero: en efectivo o invertido, lo ganado en operaciones cerradas y lo pagado en comisiones.', 'Where the money is: cash or invested, what closed trades made and what was paid in fees.'))}
<div class="kpis">
${kpi(t('Efectivo', 'Cash'), withCurrency(money(a.cash), q), '', t('liquidez', 'liquidity'))}
${kpi(t('Invertido', 'Invested'), withCurrency(money(a.exposure), q), e(`${percent(a.exposureFraction)} ${t('del patrimonio', 'of equity')}`), t('exposición', 'exposure'))}
${kpi(t('Ganado en ventas', 'Realised from sales'), delta(decimalSign(a.realizedPnl), withCurrency(money(a.realizedPnl), q)), t('Operaciones ya cerradas', 'Closed trades'), t('P&L realizado', 'realised P&L'))}
${kpi(t('Comisiones pagadas', 'Fees paid'), withCurrency(money(a.fees), q))}
</div></section>`;
}

function positionsAndOrders(s: DashboardSnapshot): string {
  const q = s.quoteCurrency;
  const positions = s.positions.map((p) => [
    e(p.symbol), amount(p.quantity), money(p.averageEntry), money(p.lastClose), money(p.value), delta(decimalSign(p.unrealizedPnl), money(p.unrealizedPnl)),
    p.protectiveStop === null ? status('warn', t('sin stop', 'no stop')) : `${status('ok', t('activo', 'active'))} ${money(p.protectiveStop)}`,
  ]);
  const orders = s.orders.open.map((o) => [
    e(o.symbol), plain(sides(), o.side), plain(orderTypes(), o.type), plain(kinds(), o.kind), plain(orderStates(), o.state), o.quantity === null ? '?' : amount(o.quantity),
    amount(o.filled), o.triggerPrice === null ? '—' : money(o.triggerPrice), when(o.updatedAt),
  ]);
  const states = Object.entries(s.orders.byState).sort(([a], [b]) => (a < b ? -1 : 1)).map(([state, n]) => `${orderStates().get(state) ?? state}: ${String(n)}`).join(' · ');
  return `<section class="card wide">${head(t('Posiciones', 'Positions'), t('Lo que el sistema tiene comprado ahora y cuánto ganaría o perdería si lo vendiera al último precio.', 'What the system holds now and what it would gain or lose selling at the last price.'))}
${table([{ label: t('Par', 'Pair'), key: true }, { label: t('Cantidad', 'Quantity'), num: true }, { label: t('Precio medio', 'Average price'), num: true, tech: t('entrada media, con comisiones', 'average entry, with fees') }, { label: t('Último precio', 'Last price'), num: true }, { label: `${t('Valor', 'Value')} (${q})`, num: true }, { label: t('Ganancia sin cerrar', 'Open gain'), num: true, tech: t('P&L no realizado', 'unrealised P&L'), key: true }, { label: t('Stop de protección', 'Protective stop'), num: true, tech: t('stop que ya espera en el exchange', 'stop already resting on the exchange'), key: true }], positions, t('Sin posiciones abiertas.', 'No open positions.'), { compact: true })}
<p class="note">${t('Valor al último cierre del diario, sin los costes de vender. El stop de protección vende solo si el precio cae hasta él; sin él, una caída no tiene freno.', 'Value at the last close in the journal, before selling costs. The protective stop sells only if the price falls to it; without it, a fall has no brake.')}</p></section>
<section class="card wide">${head(t('Órdenes abiertas', 'Open orders'), t('Órdenes enviadas que aún no se han ejecutado del todo ni cancelado.', 'Orders sent that are not yet fully filled or cancelled.'))}
${table([{ label: t('Par', 'Pair'), key: true }, { label: t('Lado', 'Side'), key: true }, { label: t('Tipo', 'Type') }, { label: t('Para', 'Purpose') }, { label: t('Estado', 'Status'), key: true }, { label: t('Cantidad', 'Quantity'), num: true }, { label: t('Ejecutada', 'Filled'), num: true }, { label: t('Disparo', 'Trigger'), num: true, tech: 'trigger', key: true }, { label: t('Actualizada', 'Updated') }], orders, t('Ninguna orden abierta.', 'No open orders.'), { compact: true })}
<p class="note">${e(states === '' ? t('Sin órdenes en el diario.', 'No orders in the journal.') : `${t('Todas las órdenes del periodo', 'All orders in the period')}: ${states}.`)}</p></section>`;
}

function activity(s: DashboardSnapshot): string {
  const trades = s.trades.map((t) => [
    when(t.at), e(t.symbol), plain(sides(), t.side), plain(kinds(), t.kind), amount(t.quantity), money(t.price), money(t.notional), money(t.fee), { long: e(phrase(t.reason)) },
  ]);
  const rejections = s.rejections.map((r) => [
    when(r.at), plain(layers(), r.layer), plain(decisions(), r.decision), `<span class="mono">${e(r.reasonCode)}</span>`, e(r.symbol ?? '—'), r.side === null ? '—' : plain(sides(), r.side),
    r.kind === null ? '—' : plain(kinds(), r.kind), { long: `<span class="mono">${e(r.reasonCodes.join(', '))}</span>` },
  ]);
  const shown = (n: number, total: number): string => (total > n ? t(` Se muestran las ${String(n)} más recientes de ${String(total)}.`, ` Showing the ${String(n)} most recent of ${String(total)}.`) : '');
  return `<section class="card wide">${head(t('Operaciones', 'Trades'), t('Compras y ventas ejecutadas, las más recientes primero, con su motivo y su comisión.', 'Filled buys and sells, most recent first, with their reason and fee.'))}
<div class="only-lg">${table([{ label: t('Fecha', 'Date'), key: true }, { label: t('Par', 'Pair'), key: true }, { label: t('Lado', 'Side'), key: true }, { label: t('Para', 'Purpose') }, { label: t('Cantidad', 'Quantity'), num: true }, { label: t('Precio', 'Price'), num: true }, { label: `${t('Importe', 'Amount')} (${s.quoteCurrency})`, num: true, key: true }, { label: t('Comisión', 'Fee'), num: true }, { label: t('Motivo', 'Reason') }], trades, t('Ninguna operación todavía.', 'No trades yet.'))}</div>
${compactLines(s.trades.map((tr) => [whenShort(tr.at), e(tr.symbol), plain(sides(), tr.side), `<span class="num">${withCurrency(money(tr.notional), s.quoteCurrency)}</span>`]), t('Ninguna operación todavía.', 'No trades yet.'))}
<p class="note">${e(`${t('La comisión es el coste explícito; el spread y el deslizamiento (slippage) ya van en el precio.', 'The fee is the explicit cost; spread and slippage are already in the price.')}${shown(s.trades.length, s.tradesTotal)}`)}</p></section>
<section class="card wide">${head(t('Órdenes frenadas por el control de riesgo', 'Orders stopped by the risk control'), t('Órdenes que el control de riesgo rechazó o redujo antes de enviarse, con su motivo. Así se ve que los límites actúan.', 'Orders the risk control rejected or reduced before they were sent, with the reason. This is how you see the limits at work.'))}
${table([{ label: t('Fecha', 'Date'), key: true }, { label: t('Quién', 'Who') }, { label: t('Decisión', 'Decision'), key: true }, { label: t('Motivo', 'Reason'), tech: 'reason_code', key: true }, { label: t('Par', 'Pair') }, { label: t('Lado', 'Side') }, { label: t('Para', 'Purpose') }, { label: t('Todos los motivos', 'All reasons'), tech: 'reason_codes' }], rejections, t('Ninguna orden frenada.', 'No orders stopped.'))}
<p class="note">${e(`${t('El motivo es un código fijo del catálogo de riesgo (reason_code).', 'The reason is a fixed code from the risk catalogue (reason_code).')}${shown(s.rejections.length, s.rejectionsTotal)}`)}</p></section>`;
}

function strategiesAndAlerts(s: DashboardSnapshot): string {
  const strategies = s.strategies.map((st) => {
    const params = Object.entries(st.params).map(([k, v]) => `${k} = ${String(v)}`).join(', ');
    const last = st.last.map((l) => `${e(l.symbol)}: ${l.action === null ? t('sin acción', 'no action') : plain(actions(), l.action)} <span class="tech">${e(l.reason === null ? t('sin motivo', 'no reason') : phrase(l.reason))}</span>`).join('<br>');
    return [
      `<span class="mono">${e(`${st.id}@${st.version}`)}</span>`, st.state === 'activa' ? status('ok', t('activa', 'active')) : status('bad', t('detenida', 'halted')),
      { long: `<span class="mono">${e(params)}</span>` }, String(st.evaluations), String(st.intents), { long: last },
    ];
  });
  const lv = levels();
  const alerts = s.alerts.map((a) => [when(a.at), status(lv[a.level].tone, lv[a.level].text), { long: e(a.message) }]);
  const counts = (['CRITICAL', 'WARNING', 'INFO'] as const satisfies readonly AlertLevel[]).map((level) => `${lv[level].text}: ${String(s.alertCounts[level])}`).join(' · ');
  return `<section class="card wide">${head(t('Estrategias', 'Strategies'), t('Las reglas que deciden comprar o vender, con qué parámetros y qué decidieron la última vez en cada par.', 'The rules that decide to buy or sell, their parameters and their last decision on each pair.'))}
${table([{ label: t('Estrategia', 'Strategy'), key: true }, { label: t('Estado', 'Status'), key: true }, { label: t('Parámetros', 'Parameters') }, { label: t('Evaluaciones', 'Evaluations'), num: true }, { label: t('Intenciones', 'Intents'), num: true, tech: t('órdenes propuestas a Risk', 'orders proposed to Risk') }, { label: t('Última decisión por par', 'Last decision per pair') }], strategies, t('Ninguna estrategia.', 'No strategy.'))}</section>
<section class="card wide">${head(t('Alertas recientes', 'Recent alerts'), t('Avisos que salen solos de lo ocurrido, con una tabla fija de reglas. Las más recientes primero.', 'Warnings raised automatically from what happened, with a fixed rule table. Most recent first.'))}
${table([{ label: t('Fecha', 'Date'), key: true }, { label: t('Nivel', 'Level'), key: true }, { label: t('Mensaje', 'Message') }], alerts, t('Ninguna alerta.', 'No alerts.'))}
<p class="note">${e(`${t('En total', 'In total')}: ${counts}.`)}</p></section>`;
}

/**
 * La tarjeta del Autopilot (DCA pasivo y rebalanceo; antes «plan B»; en el código y en la ficha sigue llamándose planB).
 * Con `source` (la demo pública), sus cifras salen del replay del Autopilot y no del diario de
 * la estrategia; sin reparto objetivo, un estado vacío que explica por qué.
 */
function planB(page: DashboardPage, s: DashboardSnapshot): string {
  const source = page.planB ?? s;
  const p = source.planB;
  const q = source.quoteCurrency;
  const link = page.planBLink === undefined ? '' : ` <a href="${e(page.planBLink)}">${t('Ver el replay completo del Autopilot', 'See the full Autopilot replay')}</a>`;
  if (!p.hasTarget) return `<section class="card wide"><h2>Autopilot<span class="tech">${t('DCA pasivo y rebalanceo', 'passive DCA & rebalancing')}</span></h2><p class="lede">${e(t('Este diario no tiene reparto objetivo: es el de una estrategia, no el del Autopilot (compras periódicas y rebalanceo). El proyecto no fija ni recomienda ningún reparto.', 'This journal has no target allocation: it belongs to a strategy, not to the Autopilot (regular purchases and rebalancing). The project does not set or recommend any allocation.'))}${link}</p></section>`;
  const width = 200;
  const rows = p.allocation.map((row) => {
    const bar = (fractionText: string | null, cls: string, y: number): string => {
      if (fractionText === null) return '';
      const share = Math.min(Math.max(Decimal.parse(fractionText).toAnalysis(), 0), 1);
      return `<rect class="${cls}" x="0" y="${String(y)}" width="${(share * width).toFixed(1)}" height="5" rx="1"/>`;
    };
    const svg = `<svg viewBox="0 0 ${String(width)} 14" width="120" height="9" role="img" aria-label="${t('Reparto de', 'Allocation of')} ${e(row.asset)}">${bar(row.current, 'bars-cur', 0)}${bar(row.target, 'bars-tgt', 8)}</svg>`;
    return [
      e(row.asset), money(row.value), percent(row.current), row.target === null ? '—' : percent(row.target),
      row.deviation === null ? '—' : delta(decimalSign(row.deviation), percent(row.deviation)), svg,
    ];
  });
  const origin = page.planB === undefined ? '' : `<p class="note">${e(t(`Del replay del Autopilot con datos sintéticos (${source.label}).`, `From the Autopilot replay on synthetic data (${source.label}).`))}${link}</p>`;
  return `<section class="card wide">${head('Autopilot', t('DCA pasivo y rebalanceo: lo aportado y el reparto actual frente al objetivo. No intenta batir al mercado.', 'Passive DCA & rebalancing: money put in and the current allocation against the target. It does not try to beat the market.'), t('DCA pasivo y rebalanceo', 'passive DCA & rebalancing'))}
${origin}
<div class="kpis">
${kpi(t('Aportado', 'Put in'), withCurrency(money(p.contributions), q), e(p.contributionsNote))}
${kpi(t('Próximo rebalanceo', 'Next rebalance'), p.nextRebalanceAt === null ? '—' : when(p.nextRebalanceAt), p.nextRebalanceAt === null ? t('Sin calendario', 'No schedule') : '')}
</div>
<h3>${t('Reparto actual frente al objetivo', 'Current allocation against the target')}</h3>
<p class="lede">${t('Qué parte del patrimonio está en cada activo.', 'Which share of equity is in each asset.')}</p>
${table([{ label: t('Activo', 'Asset') }, { label: `${t('Valor', 'Value')} (${q})`, num: true }, { label: t('Actual', 'Current'), num: true }, { label: t('Objetivo', 'Target'), num: true }, { label: t('Desviación', 'Deviation'), num: true }, { label: t('Actual / objetivo', 'Current / target') }], rows, t('Sin patrimonio.', 'No equity.'))}
<p class="note">${e(t('Barra en color: reparto actual. Barra gris: objetivo. El reparto es un ejemplo, no una recomendación.', 'Coloured bar: current allocation. Grey bar: target. The allocation is an example, not a recommendation.'))}</p></section>`;
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
  const sd = sides();
  const kd = kinds();
  const lv = levels();
  const trades = s.trades.map((tr) => ({ at: tr.at, text: `${sd.get(tr.side) ?? tr.side} ${tr.symbol} ${amount(tr.quantity)} ${t('a', 'at')} ${money(tr.price)} · ${kd.get(tr.kind) ?? tr.kind}` }));
  const alerts = s.alerts.map((a) => ({ at: a.at, text: `${lv[a.level].text}: ${a.message}` }));
  return [...trades, ...alerts].sort((a, b) => b.at - a.at);
}

function topbar(page: DashboardPage): string {
  const s = page.snapshot;
  const mode = modes()[s.mode];
  const m = madrid(s.asOf);
  const research = page.research;
  const stats = [
    research === null ? '' : `<span>N global <b>${e(String(research.globalN))}</b></span>`,
    page.commit === null ? '' : `<span class="sec">Commit <b>${e(page.commit)}</b></span>`,
    `<span class="sec" title="${e(t('Último evento del diario, hora de Madrid', 'Last journal event, Madrid time'))}">${t('Diario', 'Journal')} <b>${e(`${m.day} ${m.month} ${m.time}`)}</b></span>`,
    '<time id="reloj" hidden></time>',
  ].join('');
  const replay = tickerHtml(`tk-replay${research === null ? '' : ' has-alt'}`, replayEvents(s), t('Últimos eventos del diario', 'Latest journal events'));
  const registry = research === null ? '' : tickerHtml('tk-research', research.events, t('Últimos movimientos del registro', 'Latest registry entries'));
  return `<header class="topbar">
<div class="bar">
<div class="brand">${sealSvg({ className: 'seal-top' })}<span>${e(PROJECT_NAME)}</span></div>
<strong class="modetag" title="${e(mode.detail)}">${t('MODO', 'MODE')} ${e(mode.title)}</strong>
<span class="modedetail">${e(mode.detail)}</span>
${s.synthetic ? `<span class="chip" title="${t('Datos de demostración', 'Demo data')}"><span class="md">${t('DATOS DE DEMOSTRACIÓN', 'DEMO DATA')}</span><span class="xs">DEMO</span></span>` : ''}
<div class="stats">${stats}</div>${languageSwitch(page)}
</div>
${replay}${registry}
</header>`;
}

/**
 * Solo con datos sintéticos: unas líneas para quien llega de fuera. Con registro, Investigación y Criterios son el registro
 * real del estudio (paso 49: no lleva precios); el replay y el Autopilot son sintéticos.
 */
function intro(withResearch: boolean): string {
  return t(
    `<section class="intro"><p><strong>JP Quant</strong> es una consola de investigación cuantitativa en cripto: cada estrategia se registra antes de probarla y se juzga con criterios fijados de antemano. El replay y el Autopilot usan <strong>datos sintéticos de demostración</strong>${withResearch ? '; Investigación y Criterios muestran el <strong>registro real</strong> del estudio, en el que ninguna estrategia ha sido aprobada' : ''}.</p>
<p>Lee de arriba abajo: Resumen dice cómo va el replay; en Investigación cada punto es un experimento; Criterios cuenta cuántos superan cada criterio y por qué fallan. Los datos sintéticos traen a propósito un hueco en ETH/EUR, para que se vea cómo lo detecta el sistema.</p></section>`,
    `<section class="intro"><p><strong>JP Quant</strong> is a quantitative crypto research console: every strategy is registered before it is tested and judged against criteria fixed in advance. The replay and the Autopilot use <strong>synthetic demo data</strong>${withResearch ? '; Research and Criteria show the <strong>real registry</strong> of the study, in which no strategy has been approved' : ''}.</p>
<p>Read from top to bottom: Overview shows how the replay is doing; in Research each dot is an experiment; Criteria counts how many pass each criterion and why they fail. The synthetic data has a deliberate gap in ETH/EUR, to show that the system detects it.</p></section>`,
  );
}

function nav(): string {
  return `<nav class="nav" aria-label="${t('Vistas', 'Views')}"><a href="#resumen">${t('Resumen', 'Overview')}</a><a href="#investigacion">${t('Investigación', 'Research')}</a><a href="#replay">Replay</a><a href="#criterios">${t('Criterios', 'Criteria')}</a></nav>`;
}

/** El selector de idioma: dos enlaces a las dos páginas generadas, sin JavaScript. */
function languageSwitch(page: DashboardPage): string {
  const links = page.languages;
  if (links === undefined) return '';
  const link = (code: 'es' | 'en', href: string): string => `<a href="${e(href)}" hreflang="${code}"${lang() === code ? ' aria-current="true"' : ''}>${code.toUpperCase()}</a>`;
  return `<nav class="langs" aria-label="${t('Idioma', 'Language')}">${link('en', links.en)}${link('es', links.es)}</nav>`;
}

function viewHead(title: string, subtitle: string): string {
  return `<header class="viewhead"><p class="lbl">${e(subtitle)}</p><h1>${e(title)}</h1></header>`;
}

function noResearch(title: string): string {
  return `<section class="card wide">${head(title, t('Esta página se generó sin Experiment Registry.', 'This page was generated without the Experiment Registry.'))}<p class="note">${t('Genera el dashboard con --registro para ver la investigación.', 'Generate the dashboard with --registro to see the research.')}</p></section>`;
}

/** La página completa. Pura: con los mismos datos da el mismo texto. */
export function renderDashboard(page: DashboardPage): string {
  const s = page.snapshot;
  const research = page.research;
  const mode = modes()[s.mode];
  const r = returns(s);
  const label = s.label;
  return `<!doctype html>
<html lang="${lang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>${e(`[${mode.title}] ${PROJECT_NAME} · ${t('estado', 'status')}`)}</title>
<link rel="icon" type="image/svg+xml" href="${sealFavicon()}">
<style>${CSS}</style>
</head>
<body class="mode-${e(s.mode)}">
${topbar(page)}
<div class="shell">
${nav()}
<main>
<section class="view" id="resumen">
${viewHead(t('Resumen', 'Overview'), label)}
${s.synthetic ? intro(research !== null) : ''}
${summary(s, r)}
${playbackCard(s, r.benchName)}
${evolution(s, r)}
${researchSummary(research)}
</section>
<section class="view" id="investigacion">
${viewHead(t('Investigación', 'Research'), 'Experiment Registry')}
${research === null ? noResearch(t('Núcleo del registro', 'Registry core')) : `${sphereCard(research)}\n${luckCards(research, page.luckIllustration)}\n${experimentsCard(research)}`}
</section>
<section class="view" id="replay">
${viewHead('Replay', `${label} · run ${s.runId} · ${String(s.health.events)} ${t('eventos', 'events')}`)}
${health(s)}
${capital(s)}
${positionsAndOrders(s)}
${activity(s)}
${strategiesAndAlerts(s)}
${planB(page, s)}
</section>
<section class="view" id="criterios">
${viewHead(t('Criterios', 'Criteria'), t('Criterios congelados del paso 27', 'Criteria frozen at step 27'))}
${research === null ? noResearch(t('Embudo de criterios', 'Criteria funnel')) : funnelCards(research)}
</section>
<footer>
${sealSvg({ className: 'seal-foot' })}
<p class="seal-line">${e(`${PROJECT_NAME} · ${t('sello generado del primer commit', 'seal generated from the first commit')} ${FIRST_COMMIT.slice(0, 7)}`)}</p>
<p>${t('Solo lectura: esta página no puede enviar órdenes, cambiar la configuración ni activar el freno de emergencia. Se genera a partir del diario y del registro, sin servidor ni acceso remoto. Fechas en hora de Madrid; al pasar el ratón se ve la UTC.', 'Read only: this page cannot send orders, change the configuration or trigger the emergency brake. It is generated from the journal and the registry, with no server and no remote access. Dates in Madrid time; hover to see UTC.')}</p>
</footer>
</main>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}
