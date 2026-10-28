// Informe del sandbox (paso 49): una página HTML local con el veredicto en lenguaje llano, el porqué, las cifras clave,
// la curva fuera de muestra y todos los criterios congelados. Autocontenida y sin script: la CSP solo admite su hoja de
// estilos por su hash. Todo texto que viene de fuera (nombres, etiquetas) se escapa. En inglés por defecto o en español.
import { createHash } from 'node:crypto';
import { e, float } from '../src/monitoring/html-kit.ts';
import { lang, t, withLang, type Lang } from '../src/monitoring/i18n.ts';
import { CRITERIA } from '../src/monitoring/research.ts';
import { toUtcIso } from '../src/shared/time.ts';
import { MIN_TRADES, type CheckResult, type SandboxResult } from './pipeline.ts';

const CSS = `
:root{color-scheme:dark;--bg:#0A0A0A;--card:#111;--border:#232323;--text:#EDEDED;--muted:#A1A1A1;--faint:#6B6B6B;--data:#2E9BC4;--ok:#7FB98A;--warn:#BFA978;--bad:#C78F8F;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--sans)}
main{max-width:960px;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.4rem;font-weight:400;margin:.2rem 0 1rem}h2{font-size:1rem;font-weight:500;margin:0 0 .6rem}
.lbl{font:500 11px/1.4 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.25rem;margin:0 0 1rem}
.verdict{border-left:4px solid var(--muted)}.verdict.edge{border-left-color:var(--ok)}.verdict.luck{border-left-color:var(--bad)}.verdict.insufficient{border-left-color:var(--warn)}
.big{font-size:1.6rem;font-weight:300;margin:.2rem 0 .5rem}
ul{margin:.4rem 0 0;padding-left:1.2rem}li{margin:.25rem 0}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.4rem .5rem;border-top:1px solid var(--border);vertical-align:top}
td.num{text-align:right;font-family:var(--mono)}
.st{font:500 11px/1 var(--mono);letter-spacing:.08em;padding:.2rem .4rem;border:1px solid var(--border);border-radius:4px}.st.PASS{color:var(--ok)}.st.FAIL{color:var(--bad)}.st.NC{color:var(--warn)}
svg{display:block;width:100%;height:auto}.ln{fill:none;stroke:var(--data);stroke-width:2}.base{stroke:var(--border);stroke-dasharray:3 4}.tk{fill:var(--faint);font:10px var(--mono)}
.note{color:var(--muted);font-size:.85rem}footer{color:var(--faint);font-size:.8rem;margin-top:1.5rem}
@media (max-width:600px){th:nth-child(4),td:nth-child(4){display:none}}
`;
const CSS_HASH = createHash('sha256').update(CSS, 'utf8').digest('base64');
export const REPORT_CSP = `default-src 'none'; style-src 'sha256-${CSS_HASH}'; img-src data:; base-uri 'none'; form-action 'none'`;

function num(metrics: SandboxResult['metrics'], key: string): number | null {
  const v = metrics[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmt(v: number | null, digits = 2, suffix = ''): string {
  return v === null ? '—' : `${float(v, digits)}${suffix}`;
}

const percentOf = (fraction: number | null): number | null => (fraction === null ? null : fraction * 100);

function headline(r: SandboxResult): { readonly title: string; readonly lede: string } {
  if (r.verdict === 'edge') {
    return {
      title: t('Parece ventaja real', 'Looks like a real edge'),
      lede: t('Con estos datos, supera las pruebas de suerte: fuera de muestra, Deflated Sharpe, intervalo de confianza y control aleatorio. No es una recomendación: falta probarla hacia delante y el resto de criterios.', 'On this data it passes the luck tests: out of sample, Deflated Sharpe, confidence interval and random control. This is not a recommendation: it still needs forward testing and the remaining criteria.'),
    };
  }
  if (r.verdict === 'luck') {
    return {
      title: t('No se distingue de la suerte', 'Indistinguishable from luck'),
      lede: t('Con los datos que hay, el resultado está dentro de lo que el azar produce. No es prueba de una ventaja.', 'With the data available, the result is within what luck produces. It is not evidence of an edge.'),
    };
  }
  return {
    title: t('Datos insuficientes', 'Not enough data'),
    lede: t('No hay datos bastantes para separar habilidad de suerte. Más historia, o una estrategia que opere más, darían un veredicto.', 'There is not enough data to tell skill from luck. More history, or a strategy that trades more often, would give a verdict.'),
  };
}

function control(r: SandboxResult): { readonly percentile: number | null; readonly simulations: number | null } {
  const v = r.criteria.find((c) => c.id === 'A.3.12')?.value as { percentil_estrategia?: number; simulaciones?: number } | null | undefined;
  return { percentile: typeof v?.percentil_estrategia === 'number' ? v.percentil_estrategia * 100 : null, simulations: v?.simulaciones ?? null };
}

function reasonText(reason: string, r: SandboxResult): string {
  const trades = num(r.metrics, 'operaciones_cerradas');
  const dsr = num(r.metrics, 'dsr');
  const c = control(r);
  switch (reason) {
    case 'sample':
      return t(`Solo ${fmt(trades, 0)} operaciones cerradas fuera de muestra: hacen falta al menos ${String(MIN_TRADES)} para separar habilidad de suerte.`, `Only ${fmt(trades, 0)} closed trades out of sample: at least ${String(MIN_TRADES)} are needed to tell skill from luck.`);
    case 'track-record':
      return t('El Sharpe es positivo, pero la historia es demasiado corta para que sea significativo (MinTRL) o los datos no incluyen un mercado bajista completo (2018 o 2022).', 'The Sharpe is positive, but the track record is too short for it to be significant (MinTRL), or the data has no full bear market (2018 or 2022).');
    case 'oos-missing':
      return t('No se pudo medir ningún resultado fuera de muestra.', 'No out-of-sample result could be measured.');
    case 'oos':
      return t('Fuera de muestra pierde dinero en conjunto o en la mayoría de los tramos.', 'Out of sample it loses money overall or in most periods.');
    case 'dsr':
      return t(`Deflated Sharpe de ${fmt(dsr, 3)} (hace falta 0,95): contando tus ${String(r.localN)} pruebas con esta estrategia (también las variantes de robustez que la herramienta hace por ti), el resultado está dentro de lo que da la suerte.`, `Deflated Sharpe of ${fmt(dsr, 3)} (0.95 needed): counting your ${String(r.localN)} tests of this strategy (including the robustness variants the tool runs for you), the result is within what luck produces.`);
    case 'ci':
      return t('El intervalo de confianza al 95 % del Sharpe incluye el cero o queda por debajo.', 'The 95% confidence interval of the Sharpe includes zero or lies below it.');
    case 'control':
      return c.percentile === null
        ? t('No se pudo comparar con operaciones al azar.', 'It could not be compared with random trades.')
        : t(`Operaciones al azar con los mismos tiempos y costes lo hacen igual: queda en el percentil ${fmt(c.percentile, 1)} de ${fmt(c.simulations, 0)} (hace falta superar el 95).`, `Random trades with the same timing and costs do as well: it sits at percentile ${fmt(c.percentile, 1)} of ${fmt(c.simulations, 0)} (it needs to beat the 95th).`);
    case 'pbo':
      return t('Con varios juegos de parámetros, el elegido en entrenamiento no suele ser el mejor fuera de muestra (PBO ≥ 0,20): señal de sobreajuste.', 'With several parameter sets, the one chosen on training data tends not to be the best out of sample (PBO ≥ 0.20): a sign of overfitting.');
    default:
      return reason.startsWith('short: ') ? t(`Datos demasiado cortos: ${reason.slice(7)}.`, `The data is too short: ${reason.slice(7)}.`) : reason;
  }
}

/** El nombre del criterio en el idioma de la página. */
function criterionName(id: string, fallback: string): string {
  const known = CRITERIA.find((c) => c.id === id);
  return known === undefined ? fallback : t(known.label, known.labelEn);
}

const VERDICTS_EN: Readonly<Record<string, string>> = { RECHAZADA: 'REJECTED', 'NO CONCLUYENTE': 'INCONCLUSIVE', 'CANDIDATA A TEST FINAL': 'CANDIDATE FOR THE FINAL TEST', 'CANDIDATA A PAPER': 'CANDIDATE FOR PAPER' };

function statusTag(status: CheckResult['status']): string {
  const text = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : t('NO CONCLUYENTE', 'INCONCLUSIVE');
  return `<span class="st ${status === 'NO CONCLUYENTE' ? 'NC' : status}">${e(text)}</span>`;
}

function curveSvg(returns: readonly number[]): string {
  if (returns.length < 2) return `<p class="note">${t('Sin curva fuera de muestra.', 'No out-of-sample curve.')}</p>`;
  const equity = [100];
  for (const r of returns) equity.push((equity.at(-1) ?? 100) * (1 + r));
  const step = Math.max(1, Math.ceil(equity.length / 600));
  const pts = equity.filter((_, i) => i % step === 0 || i === equity.length - 1);
  const lo = Math.min(...pts, 100);
  const hi = Math.max(...pts, 100);
  const W = 900, H = 220, L = 40, R = 10, T = 10, B = 10;
  const x = (i: number): number => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v: number): number => T + (1 - (v - lo) / Math.max(hi - lo, 1e-9)) * (H - T - B);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${String(W)} ${String(H)}" role="img" aria-label="${e(t(`Patrimonio fuera de muestra en base 100: termina en ${fmt(equity.at(-1) ?? 100, 1)}`, `Out-of-sample equity, base 100: ends at ${fmt(equity.at(-1) ?? 100, 1)}`))}"><line class="base" x1="${String(L)}" x2="${String(W - R)}" y1="${y(100).toFixed(1)}" y2="${y(100).toFixed(1)}"/><text class="tk" x="${String(L - 6)}" y="${(y(100) + 3).toFixed(1)}" text-anchor="end">100</text><polyline class="ln" points="${line}"/></svg>`;
}

/** La página del informe. */
export function reportHtml(r: SandboxResult, language: Lang = 'en'): string {
  return withLang(language, () => {
    const h = headline(r);
    const c = control(r);
    const rows: [string, string][] = [
      [t('Sharpe neto anualizado (no decide solo)', 'Net annualised Sharpe (not decisive alone)'), fmt(num(r.metrics, 'sharpe_anualizado'))],
      [t(`Deflated Sharpe (con tus ${String(r.localN)} pruebas)`, `Deflated Sharpe (with your ${String(r.localN)} tests)`), fmt(num(r.metrics, 'dsr'), 3)],
      [t('Operaciones cerradas fuera de muestra', 'Closed trades out of sample'), fmt(num(r.metrics, 'operaciones_cerradas'), 0)],
      [t('Caída máxima', 'Maximum drawdown'), fmt(percentOf(num(r.metrics, 'caida_maxima')), 1, ' %')],
      [t('Crecimiento anual compuesto', 'Compound annual growth'), fmt(percentOf(num(r.metrics, 'cagr')), 1, ' %')],
      [t('Percentil frente al control aleatorio', 'Percentile against the random control'), c.percentile === null ? '—' : `${fmt(c.percentile, 1)} / ${fmt(c.simulations, 0)}`],
      ['PBO', r.configurations >= 3 ? fmt(num(r.metrics, 'pbo'), 3) : t('— (una sola configuración)', '— (single configuration)')],
    ];
    const criteria = r.criteria.map((cr) => `<tr><td class="num">${e(cr.id)}</td><td>${e(criterionName(cr.id, cr.name))}</td><td>${statusTag(cr.status)}</td></tr>`).join('');
    const reasons = r.reasons.map((reason) => `<li>${e(reasonText(reason, r))}</li>`).join('');
    const fullVerdict = r.fullVerdict === null ? '' : `<p class="note">${e(t(`Veredicto con todos los criterios congelados: ${r.fullVerdict}. Con datos propios, el régimen, la ablación y el universo alternativo quedan sin medir, así que la investigación oficial pediría más; superar la suerte no basta para operar.`, `Verdict against every frozen criterion: ${VERDICTS_EN[r.fullVerdict] ?? r.fullVerdict}. With your own data, regimes, ablation and an alternative universe cannot be measured, so the official research would ask for more; beating luck is not enough to trade.`))}</p>`;
    return `<!doctype html>
<html lang="${lang()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="referrer" content="no-referrer">
<title>${e(`JP Quant · ${r.strategy}`)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<p class="lbl">${e(t('Prueba de estrategia · JP Quant', 'Strategy test · JP Quant'))}</p>
<h1>${e(r.strategy)}</h1>
<p class="note">${e(t(`Datos: ${r.dataLabel} · ${String(r.candles)} velas de ${r.timeframe} · del ${toUtcIso(r.from).slice(0, 10)} al ${toUtcIso(r.to).slice(0, 10)} · ${String(r.configurations)} configuración(es) · ejecución ${r.runId}`, `Data: ${r.dataLabel} · ${String(r.candles)} ${r.timeframe} candles · ${toUtcIso(r.from).slice(0, 10)} to ${toUtcIso(r.to).slice(0, 10)} · ${String(r.configurations)} configuration(s) · run ${r.runId}`))}</p>
<section class="card verdict ${r.verdict}">
<p class="lbl">${e(t('Veredicto', 'Verdict'))}</p>
<p class="big">${e(h.title)}</p>
<p>${e(h.lede)}</p>
${reasons === '' ? '' : `<h2>${e(t('Por qué', 'Why'))}</h2><ul>${reasons}</ul>`}
${fullVerdict}
</section>
<section class="card"><h2>${e(t('Cifras clave', 'Key numbers'))}</h2><table>${rows.map(([k, v]) => `<tr><td>${e(k)}</td><td class="num">${e(v)}</td></tr>`).join('')}</table></section>
<section class="card"><h2>${e(t('Patrimonio fuera de muestra', 'Out-of-sample equity'))}</h2><p class="note">${e(t('Solo los tramos de validación, con costes, en base 100. Lo que la estrategia hizo con datos que no vio al elegir.', 'Validation periods only, after costs, base 100: what the strategy did on data it never saw when it was chosen.'))}</p>${curveSvg(r.returns)}</section>
${criteria === '' ? '' : `<section class="card"><h2>${e(t('Criterios congelados', 'Frozen criteria'))}</h2><table>${criteria}</table></section>`}
<footer>${e(t(`Ejecución local, guardada en tu carpeta del sandbox. No entra en el registro oficial, no suma a su N y no cambia los criterios congelados. Llevas ${String(r.localN)} pruebas con esta estrategia. No es asesoramiento financiero ni promete rentabilidad.`, `Local run, saved in your sandbox folder. It is not added to the official registry, does not count towards its N and does not change the frozen criteria. You have run ${String(r.localN)} tests of this strategy. Not financial advice; no returns are promised.`))}</footer>
</main>
</body>
</html>
`;
  });
}
