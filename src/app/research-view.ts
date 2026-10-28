// Datos de la vista de investigación del dashboard (paso 41C): app/ lee el registro con research/registry.ts (que comprueba
// la cadena de hashes y el esquema, fail closed) y lo entrega a monitoring/ como datos planos. Solo lee lo guardado; no
// lanza ningún backtest (INV-14a).
// Las curvas del control aleatorio no las guarda hoy el registro (solo el percentil, en el informe): llegan en un archivo
// aparte, con el formato inversor-controles/1. La demo pública lo trae sintético; con resultados reales, solo en local.
import { z } from 'zod';
import { CRITERION_STATUSES, type CriterionStatus, type LuckCurves, type ResearchExperiment } from '../monitoring/research.ts';
import type { Registry } from '../research/registry.ts';
import { parseUtcIso } from '../shared/time.ts';

export const LUCK_FORMAT = 'inversor-controles/1';
const CRITERION_KEY = /^criterio_(A\.3\.\d+)$/;

export class ResearchViewError extends Error {
  override readonly name = 'ResearchViewError';
}

function isStatus(value: unknown): value is CriterionStatus {
  return typeof value === 'string' && (CRITERION_STATUSES as readonly string[]).includes(value);
}

/** Cada experimento con su alta y su último cierre; los criterios de A.3, de las métricas del cierre completado. */
export function experimentsFromRegistry(registry: Registry): ResearchExperiment[] {
  return [...registry.experiments.values()].map(({ registered, closings }) => {
    const last = closings.at(-1);
    const criteria: Record<string, CriterionStatus> = {};
    for (const [key, value] of Object.entries(last?.resultado?.metricas ?? {})) {
      const match = CRITERION_KEY.exec(key);
      if (match?.[1] === undefined) continue;
      if (!isStatus(value)) throw new ResearchViewError(`${registered.id}: ${key} no es PASS, FAIL ni NO CONCLUYENTE`);
      criteria[match[1]] = value;
    }
    return {
      id: registered.id,
      family: registered.familia,
      registeredAt: parseUtcIso(registered.fecha),
      trials: registered.n_pruebas,
      state: last?.estado ?? 'registrado',
      closedAt: last === undefined ? null : parseUtcIso(last.fecha),
      verdict: last?.resultado?.veredicto ?? null,
      criteria,
    };
  });
}

const Series = z.array(z.number().finite()).min(2).max(2000);
const LuckFile = z.object({
  formato: z.literal(LUCK_FORMAT),
  experimentos: z.array(z.object({
    id: z.string().regex(/^EXP-\d{4,}$/),
    simulaciones: z.number().int().positive(),
    percentil: z.number().min(0).max(100),
    estrategia: Series,
    p05: Series,
    p95: Series,
    muestras: z.array(Series).max(200),
  }).strict()).max(500),
}).strict();

/** Lee el archivo de curvas del control. Fail closed: un archivo que no cumple el formato no se pinta. */
export function parseLuckFile(text: string): LuckCurves[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ResearchViewError('el archivo de controles no es JSON'); // sin repetir su contenido (SEC-03)
  }
  const result = LuckFile.safeParse(parsed);
  if (!result.success) throw new ResearchViewError(`el archivo de controles no cumple ${LUCK_FORMAT}: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return result.data.experimentos.map((e) => ({
    experimentId: e.id, simulations: e.simulaciones, percentile: e.percentil, strategy: e.estrategia, low: e.p05, high: e.p95, samples: e.muestras,
  }));
}
