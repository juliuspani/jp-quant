import type { IntelConfig } from './config.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';
import { errMsg } from './util.ts';

export interface Headline {
  title: string;
  source: string;
  ts: number;
  alarm: boolean;
}

export interface IntelSnapshot {
  updatedAt: number;
  /** Factor 0–1 que se aplica al tamaño de las entradas nuevas. */
  riskMultiplier: number;
  blockEntries: boolean;
  fearGreed: { value: number; label: string } | null;
  notes: string[];
  headlines: Headline[];
}

export interface IntelSource {
  snapshot(): IntelSnapshot;
  refresh(now: number): Promise<void>;
}

/** Evaluación de titulares hecha por un modelo de lenguaje (opcional). */
export interface HeadlineAssessment {
  /** 0 = calma total, 100 = evento grave para todo el mercado. */
  marketRisk: number;
  summary: string;
}

export type HeadlineAnalyst = (headlines: Headline[]) => Promise<HeadlineAssessment>;

const NEUTRAL: IntelSnapshot = { updatedAt: 0, riskMultiplier: 1, blockEntries: false, fearGreed: null, notes: [], headlines: [] };

const HEADLINE_WINDOW_MS = 12 * 3_600_000;
const ALARM_WINDOW_MS = 6 * 3_600_000;
const STALE_MS = 6 * 3_600_000;

// Red de seguridad sin IA: palabras que suelen acompañar a eventos que mueven todo el mercado.
const ALARM = /\b(hack(ed|s)?|exploit(ed|s)?|breach(ed)?|drain(ed)?|stolen|insolven(t|cy)|bankrupt(cy)?|(halts?|suspends?|pauses?) withdrawals|depeg(s|ged)?|flash crash|crash(es|ed)?|plunges?|plummets?|liquidations?|emergency|ban(s|ned)?|crackdown|sanctions?)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrae titulares de un RSS sin depender de un parser XML completo. */
export function parseRss(xml: string, source: string, now: number): Headline[] {
  const out: Headline[] = [];
  for (const item of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
    const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '').slice(0, 200);
    const ts = Date.parse(decodeEntities(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/.exec(item)?.[1] ?? ''));
    if (!title || !Number.isFinite(ts) || ts > now + 3_600_000) continue;
    out.push({ title, source, ts, alarm: ALARM.test(title) });
  }
  return out;
}

export interface RiskInputs {
  fearGreed: number | null;
  alarmSources: number;
  assessment: HeadlineAssessment | null;
}

/**
 * Traduce las lecturas a un ajuste de riesgo. La inteligencia SOLO puede
 * reducir el tamaño o bloquear entradas: nunca provoca una compra ni afloja
 * un stop. Las noticias llegan tarde y el sentimiento predice poco; usarlo
 * como freno es prudente, usarlo como acelerador no lo es.
 */
export function assessRisk(i: RiskInputs, cfg: IntelConfig): { riskMultiplier: number; blockEntries: boolean; notes: string[] } {
  let riskMultiplier = 1;
  let blockEntries = false;
  const notes: string[] = [];

  if (i.fearGreed !== null) {
    if (i.fearGreed >= cfg.extremeGreed) {
      riskMultiplier *= 0.5;
      notes.push(`Codicia extrema (${i.fearGreed}): tamaño de entradas a la mitad.`);
    } else if (i.fearGreed <= cfg.extremeFear) {
      riskMultiplier *= 0.5;
      notes.push(`Miedo extremo (${i.fearGreed}): tamaño de entradas a la mitad.`);
    }
  }

  if (i.assessment) {
    notes.push(`Análisis de titulares (riesgo ${i.assessment.marketRisk}/100): ${i.assessment.summary}`);
    if (i.assessment.marketRisk >= 80) {
      blockEntries = true;
      notes.push('Riesgo de mercado muy alto: entradas nuevas bloqueadas.');
    } else if (i.assessment.marketRisk >= 60) {
      riskMultiplier *= 0.5;
    }
  } else if (i.alarmSources >= 2) {
    // Sin modelo de lenguaje: que dos medios distintos den la alarma basta para frenar.
    riskMultiplier *= 0.5;
    notes.push(`Titulares de alarma en ${i.alarmSources} medios en las últimas 6 h: tamaño de entradas a la mitad.`);
  }

  return { riskMultiplier, blockEntries, notes };
}

export class Intel implements IntelSource {
  private cfg: IntelConfig;
  private store: Store;
  private analyst: HeadlineAnalyst | null;
  private current: IntelSnapshot;
  private lastAssessment: { key: string; value: HeadlineAssessment } | null = null;

  constructor(cfg: IntelConfig, store: Store, analyst: HeadlineAnalyst | null) {
    this.cfg = cfg;
    this.store = store;
    this.analyst = analyst;
    this.current = store.get<IntelSnapshot>('intel.snapshot', NEUTRAL);
  }

  snapshot(): IntelSnapshot {
    if (!this.cfg.enabled) return NEUTRAL;
    // Una lectura vieja no debe seguir frenando (ni dejar de frenar) indefinidamente.
    if (this.current.updatedAt > 0 && Date.now() - this.current.updatedAt > STALE_MS) {
      return { ...this.current, riskMultiplier: 1, blockEntries: false, notes: ['Datos de inteligencia caducados: sin ajuste de riesgo.'] };
    }
    return this.current;
  }

  private async fearGreed(): Promise<{ value: number; label: string } | null> {
    const res = await fetch('https://api.alternative.me/fng/?limit=1&format=json', { signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { data?: { value: string; value_classification: string }[] };
    const d = json.data?.[0];
    const value = Number(d?.value);
    return d && Number.isFinite(value) ? { value, label: d.value_classification } : null;
  }

  private async headlines(now: number): Promise<Headline[]> {
    const all: Headline[] = [];
    await Promise.all(
      this.cfg.rssFeeds.map(async (url) => {
        const source = new URL(url).hostname.replace(/^www\./, '');
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0 (inversor-jp)' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          all.push(...parseRss(await res.text(), source, now));
        } catch (e) {
          log('warn', 'intel', `Fuente no disponible (${source}): ${errMsg(e)}`);
        }
      }),
    );
    const seen = new Set<string>();
    return all
      .filter((h) => now - h.ts <= HEADLINE_WINDOW_MS)
      .sort((a, b) => b.ts - a.ts)
      .filter((h) => {
        const key = h.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  /** Si una fuente falla se conserva su última lectura: una caída de datos no debe parar ni acelerar nada. */
  async refresh(now: number): Promise<void> {
    if (!this.cfg.enabled) return;

    let fearGreed = this.current.fearGreed;
    try {
      fearGreed = (await this.fearGreed()) ?? fearGreed;
    } catch (e) {
      log('warn', 'intel', `Índice Miedo/Codicia no disponible: ${errMsg(e)}`);
    }

    const headlines = await this.headlines(now);
    const recentAlarms = headlines.filter((h) => h.alarm && now - h.ts <= ALARM_WINDOW_MS);

    let assessment: HeadlineAssessment | null = null;
    if (this.analyst && headlines.length > 0) {
      const batch = headlines.slice(0, this.cfg.llm.maxHeadlines);
      // Solo se paga una nueva consulta si han cambiado los titulares.
      const key = batch.map((h) => h.title).join('|');
      if (this.lastAssessment?.key === key) {
        assessment = this.lastAssessment.value;
      } else {
        try {
          assessment = await this.analyst(batch);
          this.lastAssessment = { key, value: assessment };
        } catch (e) {
          log('warn', 'intel', `Análisis de titulares no disponible: ${errMsg(e)}`);
        }
      }
    }

    const verdict = assessRisk({ fearGreed: fearGreed?.value ?? null, alarmSources: new Set(recentAlarms.map((h) => h.source)).size, assessment }, this.cfg);
    const previous = this.current;
    this.current = { updatedAt: now, ...verdict, fearGreed, headlines: headlines.slice(0, 30) };
    this.store.set('intel.snapshot', this.current);

    if (previous.riskMultiplier !== verdict.riskMultiplier || previous.blockEntries !== verdict.blockEntries) {
      log('info', 'intel', `Riesgo ×${verdict.riskMultiplier}${verdict.blockEntries ? ', entradas bloqueadas' : ''}. ${verdict.notes.join(' ')}`);
    }
  }
}
