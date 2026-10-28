// Script de la página del dashboard (paso 41C, ADR 0046): solo anima lo que ya está pintado. Sin él, la página se ve
// completa como imagen fija.
// - Es un texto fijo, sin datos interpolados: lee los datos de los atributos del SVG y escribe con textContent, nunca HTML.
//   La CSP lo admite por su SHA-256 y no admite ningún otro script.
// - No pide nada a la red ni guarda nada: ni fetch, ni almacenamiento, ni formularios.
// - Respeta prefers-reduced-motion (sin animación) y lo pausa todo cuando la pestaña no está visible o la esfera no está en
//   pantalla. La esfera gira con requestAnimationFrame y solo actualiza unos cientos de atributos por fotograma.
// - La proyección de la esfera es la misma que la de research-html.ts.
import { createHash } from 'node:crypto';

export const PAGE_SCRIPT = `(() => {
  'use strict';
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let moving = !motion.matches;
  const applyMotion = () => {
    moving = !motion.matches;
    root.classList.toggle('anim', moving);
  };
  const syncHidden = () => root.classList.toggle('paused', document.hidden);
  applyMotion();
  syncHidden();

  const clock = document.getElementById('reloj');
  if (clock) {
    const fmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const tick = () => { if (!document.hidden) clock.textContent = 'MADRID ' + fmt.format(Date.now()); };
    tick();
    clock.hidden = false;
    setInterval(tick, 1000);
  }

  // Ticker: unos 30 px por segundo, sea cual sea su longitud (la lista va dos veces: recorre la mitad en cada vuelta).
  // Se pausa con el ratón encima, con el foco o al tocarlo; con la pestaña oculta, como todo, con .paused.
  const TICKER_SPEED = 30;
  const tracks = Array.from(document.querySelectorAll('.ticker-track'));
  const fitTickers = () => {
    for (const track of tracks) {
      const half = track.scrollWidth / 2;
      if (half > 0) track.style.animationDuration = (half / TICKER_SPEED).toFixed(1) + 's';
    }
  };
  fitTickers();
  window.addEventListener('resize', fitTickers);
  window.addEventListener('hashchange', fitTickers);
  for (const track of tracks) {
    const ticker = track.parentElement;
    if (ticker) ticker.addEventListener('touchstart', () => ticker.classList.toggle('hold'), { passive: true });
  }

  const reveal = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        reveal.unobserve(entry.target);
      }
    }
  }, { threshold: 0.2 });
  for (const el of document.querySelectorAll('.reveal')) reveal.observe(el);

  // Tabla de experimentos: sin script se ven todos; con script, los más recientes y un botón para el resto.
  for (const button of document.querySelectorAll('button.more')) {
    const list = button.previousElementSibling;
    if (!list || !list.classList.contains('exp-list')) continue;
    list.classList.add('clip');
    button.hidden = false;
    button.addEventListener('click', () => {
      const clipped = list.classList.toggle('clip');
      button.textContent = clipped ? button.dataset.all : button.dataset.few;
    });
  }

  const nums = (text) => text.split(',').map(Number);
  const spheres = Array.from(document.querySelectorAll('svg.sphere'), (svg) => ({
    svg,
    cx: Number(svg.dataset.cx), cy: Number(svg.dataset.cy), r: Number(svg.dataset.r), a: Number(svg.dataset.a), t: Number(svg.dataset.t),
    on: false,
    pts: Array.from(svg.querySelectorAll('.pt'), (c) => ({ c, p: nums(c.dataset.p), s: Number(c.dataset.s) })),
    wires: Array.from(svg.querySelectorAll('.wire'), (l) => ({ l, p: l.dataset.p.split(' ').map(nums) })),
  }));
  const SPEED = 0.05; // rad/s: una vuelta completa cada ~126 s (nunca menos de 60)
  let angle = 0;
  let last = 0;
  let raf = 0;
  const shown = (s) => s.on && s.svg.getClientRects().length > 0;
  function draw(s) {
    const a = s.a + angle;
    const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(s.t), st = Math.sin(s.t);
    const at = (p) => {
      const x1 = p[0] * ca + p[2] * sa;
      const z1 = -p[0] * sa + p[2] * ca;
      return [s.cx + s.r * x1, s.cy - s.r * (p[1] * ct - z1 * st), p[1] * st + z1 * ct];
    };
    for (const w of s.wires) {
      let out = '';
      for (const p of w.p) { const q = at(p); out += q[0].toFixed(1) + ',' + q[1].toFixed(1) + ' '; }
      w.l.setAttribute('points', out);
    }
    for (const pt of s.pts) {
      const q = at(pt.p);
      const depth = (q[2] + 1) / 2;
      pt.c.setAttribute('cx', q[0].toFixed(1));
      pt.c.setAttribute('cy', q[1].toFixed(1));
      pt.c.setAttribute('r', (pt.s * (0.7 + 0.3 * depth)).toFixed(2));
      pt.c.setAttribute('opacity', (0.3 + 0.7 * depth).toFixed(2));
    }
  }
  function frame(now) {
    raf = 0;
    if (!moving || document.hidden || !spheres.some(shown)) { last = 0; return; }
    if (last) angle += (Math.min(now - last, 100) / 1000) * SPEED;
    last = now;
    for (const s of spheres) if (shown(s)) draw(s);
    raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf) raf = requestAnimationFrame(frame); }
  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) for (const s of spheres) if (s.svg === entry.target) s.on = entry.isIntersecting;
    wake();
  });
  for (const s of spheres) {
    watch.observe(s.svg);
    const info = s.svg.closest('.card') && s.svg.closest('.card').querySelector('.sphere-info');
    if (!info) continue;
    const show = (event) => {
      const dot = event.target instanceof Element ? event.target.closest('.pt') : null;
      if (dot) info.textContent = dot.dataset.info;
    };
    s.svg.addEventListener('pointerover', show);
    s.svg.addEventListener('focusin', show);
  }
  motion.addEventListener('change', () => { applyMotion(); wake(); });
  document.addEventListener('visibilitychange', () => { syncHidden(); wake(); });
  window.addEventListener('hashchange', wake);

  // Reproducción del replay (paso 49, playback-html.ts): unos 16 s recorriendo la curva, 4 s quieta al final y vuelta a
  // empezar. Cada paso recorta las líneas (data-p) y muestra las marcas y los eventos cuyo data-i ya se alcanzó. Sin
  // movimiento, o sin script, se ve el final.
  const PLAY_MS = 16000;
  const HOLD_MS = 4000;
  const FEED_ROWS = 6;
  const plays = Array.from(document.querySelectorAll('section.playback'), (card) => ({
    card,
    lines: Array.from(card.querySelectorAll('.pb-line'), (l) => ({ l, p: l.dataset.p.split(' ') })),
    marks: Array.from(card.querySelectorAll('.pb-mk'), (m) => ({ m, i: Number(m.dataset.i) })),
    feed: Array.from(card.querySelectorAll('.pb-ev[data-i]'), (li) => ({ li, i: Number(li.dataset.i), k: li.dataset.k })),
    dates: (card.dataset.d || '').split('|'),
    sys: (card.dataset.s || '').split('|'),
    bench: (card.dataset.b || '').split('|'),
    when: card.querySelector('.pb-when'),
    sysOut: card.querySelector('.pb-sys'),
    benchOut: card.querySelector('.pb-bench'),
    counts: Array.from(card.querySelectorAll('.pb-n'), (n) => ({ n, k: n.dataset.k })),
    on: false, t: 0, last: -1,
  }));
  const stepsOf = (p) => (p.lines.length > 0 ? p.lines[0].p.length : 0);
  function showStep(p, k) {
    if (k === p.last) return;
    p.last = k;
    for (const ln of p.lines) ln.l.setAttribute('points', ln.p.slice(0, k + 1).join(' '));
    for (const mk of p.marks) mk.m.classList.toggle('on', mk.i <= k);
    const tally = { trade: 0, risk: 0 };
    let shown = 0;
    for (let j = p.feed.length - 1; j >= 0; j--) {
      const ev = p.feed[j];
      const reached = ev.i <= k;
      if (reached) tally[ev.k === 'risk' ? 'risk' : 'trade'] += 1;
      ev.li.hidden = !reached || (shown += 1) > FEED_ROWS;
    }
    for (const c of p.counts) c.n.textContent = String(tally[c.k === 'risk' ? 'risk' : 'trade']);
    if (p.when && p.dates[k] !== undefined) p.when.textContent = p.dates[k];
    if (p.sysOut && p.sys[k] !== undefined) p.sysOut.textContent = p.sys[k];
    if (p.benchOut && p.bench[k] !== undefined) p.benchOut.textContent = p.bench[k];
  }
  const showEnd = () => { for (const p of plays) showStep(p, stepsOf(p) - 1); };
  let playLast = 0;
  let playRaf = 0;
  function playFrame(now) {
    playRaf = 0;
    const active = plays.filter((p) => p.on && stepsOf(p) > 1);
    if (!moving || document.hidden || active.length === 0) { playLast = 0; return; }
    const dt = playLast ? Math.min(now - playLast, 100) : 0;
    playLast = now;
    for (const p of active) {
      p.t = (p.t + dt) % (PLAY_MS + HOLD_MS);
      showStep(p, Math.min(stepsOf(p) - 1, Math.floor((p.t / PLAY_MS) * stepsOf(p))));
    }
    playRaf = requestAnimationFrame(playFrame);
  }
  function playWake() {
    if (!moving) { showEnd(); return; }
    if (!playRaf) playRaf = requestAnimationFrame(playFrame);
  }
  const playWatch = new IntersectionObserver((entries) => {
    for (const entry of entries) for (const p of plays) if (p.card === entry.target) p.on = entry.isIntersecting;
    playWake();
  });
  for (const p of plays) playWatch.observe(p.card);
  motion.addEventListener('change', playWake);
  document.addEventListener('visibilitychange', playWake);
  window.addEventListener('hashchange', playWake);
})();`;

export const PAGE_SCRIPT_HASH = createHash('sha256').update(PAGE_SCRIPT, 'utf8').digest('base64');
