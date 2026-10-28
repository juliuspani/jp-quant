// Investigación de demostración del dashboard (paso 41C): un Experiment Registry y unas curvas del control aleatorio
// sintéticos, con semilla, para la demo pública. No son resultados de investigación: las familias se llaman «demo-…», los
// veredictos y los criterios salen de un generador de números con semilla y no se ha ejecutado ningún backtest.
// El registro se escribe con register y close de research/registry.ts, así que cumple las mismas reglas que el real
// (esquema, cadena de hashes, N por familia). Lo usan las pruebas, y la prueba del comando comprueba que los archivos de
// demo/fixtures/ son los que salen de aquí.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { experimentsFromRegistry, LUCK_FORMAT } from '../src/app/research-view.ts';
import { seededRng, type Rng } from '../src/kernel/random.ts';
import { CRITERIA, outcomeOf } from '../src/monitoring/research.ts';
import { close, parseRegistry, register, type NewClosing } from '../src/research/registry.ts';
import { canonicalJson, sha256Hex } from '../src/shared/canonical.ts';
import { toUtcIso } from '../src/shared/time.ts';

export const DEMO_RESEARCH_SEED = 20261024;
const FAMILIES = ['demo-tendencia', 'demo-reversion', 'demo-momento', 'demo-estacionalidad'] as const;
const EXPERIMENTS = 36;
const T0 = Date.UTC(2026, 0, 5, 9);
const DAY = 86_400_000;
const POINTS = 120;
const CONTROLS = 400;
const SAMPLES = 48;
// Probabilidad de que cada criterio tumbe a una estrategia rechazada: los de siempre (Deflated Sharpe, operaciones,
// stress y regímenes) caen más, como en la investigación real.
const FAIL_ODDS: Readonly<Record<string, number>> = { 'A.3.2': 0.55, 'A.3.4': 0.3, 'A.3.5': 0.4, 'A.3.7': 0.45, 'A.3.9': 0.5 };

type Plan = 'en curso' | 'invalidado' | 'abortado' | 'fallido' | 'rechazado' | 'no concluyente' | 'aceptado';

function planOf(i: number, rng: Rng): Plan {
  if (i >= EXPERIMENTS - 2) return 'en curso';
  if (i === 30 || i === 33) return 'aceptado';
  const r = rng.next();
  if (i < 8) return r < 0.7 ? 'invalidado' : 'abortado';
  if (r < 0.06) return 'fallido';
  if (r < 0.12) return 'abortado';
  if (r < 0.24) return 'no concluyente';
  return 'rechazado';
}

function criteriaFor(plan: Plan, rng: Rng): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { id } of CRITERIA) {
    if (plan === 'aceptado') out[`criterio_${id}`] = 'PASS';
    else if (id === 'A.3.6' && rng.next() < 0.3) out[`criterio_${id}`] = 'NO CONCLUYENTE';
    else out[`criterio_${id}`] = rng.next() < (FAIL_ODDS[id] ?? 0.08) ? 'FAIL' : 'PASS';
  }
  if (plan === 'rechazado' && !Object.values(out).includes('FAIL')) out['criterio_A.3.2'] = 'FAIL';
  if (plan === 'no concluyente') {
    for (const key of Object.keys(out)) if (out[key] === 'FAIL') out[key] = 'PASS';
    out['criterio_A.3.6'] = 'NO CONCLUYENTE';
  }
  return out;
}

/** El registro sintético, como texto JSONL. */
export function demoRegistry(): string {
  const rng = seededRng(DEMO_RESEARCH_SEED, 'registro');
  const dir = mkdtempSync(join(tmpdir(), 'registro-demo-'));
  const path = join(dir, 'registry.jsonl');
  try {
    const seen = new Set<string>();
    for (let i = 0; i < EXPERIMENTS; i++) {
      const plan = planOf(i, rng);
      const family = FAMILIES[Math.floor(rng.next() * FAMILIES.length)] ?? FAMILIES[0];
      const grid = 1 + Math.floor(rng.next() * 4);
      const variants = Math.floor(rng.next() * 6);
      const at = T0 + i * 7 * DAY;
      const line = register(path, {
        fecha: toUtcIso(at), autor: 'Generador de la demo (datos sintéticos)', familia: family, familia_nueva: !seen.has(family), notas: null,
        previa: false, n_pruebas: grid + variants, variantes: variants,
        hipotesis: 'Sintética: un experimento inventado para enseñar el dashboard', metrica_primaria: 'Sintética', criterios: 'Los de A.3, de forma sintética',
        estrategia: { nombre: family, version: '1.0.0' }, commit: '0'.repeat(40),
        datos: { fuente: 'Sintética, sin datos de mercado', dataset: 'demo', version: '1', timeframe: '1d', rango: { desde: '2020-01-01T00:00:00Z', hasta: '2025-01-01T00:00:00Z' }, hash: '0'.repeat(64) },
        universo: { regla: 'sintético', simbolos: ['DEMO/EUR'] },
        particiones: { tramos: [{ train: { desde: '2020-01-01T00:00:00Z', hasta: '2023-01-01T00:00:00Z' }, validation: { desde: '2023-01-01T00:00:00Z', hasta: '2025-01-01T00:00:00Z' } }], test: null, purging_velas: 5, embargo_velas: 5 },
        costes: { comision: '0.0025', spread: '0.00075', slippage: '0.0005', multiplicador: 1 },
        parametros: { tipo: 'rejilla', rejilla: { periodo: Array.from({ length: grid }, (_, k) => 10 * (k + 1)) } },
        semilla: i + 1, informe: null,
      });
      seen.add(family);
      if (plan === 'en curso') continue;
      const closing: NewClosing = { fecha: toUtcIso(at + 2 * DAY), autor: 'Generador de la demo (datos sintéticos)', id: line.id, estado: 'completado', notas: null, resultado: null };
      if (plan === 'invalidado' || plan === 'abortado' || plan === 'fallido') {
        close(path, { ...closing, estado: plan, notas: 'Sintético' });
        continue;
      }
      const metricas = criteriaFor(plan, rng);
      const veredicto = plan === 'aceptado' ? 'CANDIDATA A PAPER' : plan === 'rechazado' ? 'RECHAZADA' : 'NO CONCLUYENTE';
      close(path, { ...closing, resultado: { metricas, hash_salida: sha256Hex(canonicalJson({ metricas, salida: line.id })), veredicto } });
    }
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const round = (v: number): number => Math.round(v * 100) / 100;

function walk(rng: Rng, drift: number, vol: number): number[] {
  const out = [100];
  for (let t = 1; t < POINTS; t++) out.push((out.at(-1) ?? 100) * (1 + drift + (rng.next() + rng.next() + rng.next() - 1.5) * vol));
  return out;
}

function quantile(sorted: readonly number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  return (sorted[lo] ?? 0) + ((sorted[Math.ceil(pos)] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo);
}

/**
 * Curvas sintéticas del control aleatorio de tres experimentos del registro de demostración: el primero aceptado (una
 * ventaja clara), el primero no concluyente (dudosa) y el último rechazado (suerte).
 */
export function demoControls(registryText: string = demoRegistry()): string {
  const experiments = experimentsFromRegistry(parseRegistry(registryText));
  const pick = (outcome: string, last = false): string => {
    const found = experiments.filter((e) => outcomeOf(e) === outcome);
    const chosen = last ? found.at(-1) : found[0];
    if (chosen === undefined) throw new Error(`la demo no tiene un experimento ${outcome}`);
    return chosen.id;
  };
  const cases = [[pick('aceptado'), 0.0035], [pick('no concluyente'), 0.0009], [pick('rechazado', true), 0.0001]] as const;
  const experimentos = cases.map(([id, drift]) => {
    const rng = seededRng(DEMO_RESEARCH_SEED, id);
    const controls = Array.from({ length: CONTROLS }, () => walk(rng, 0.0003, 0.02));
    const strategy = walk(rng, drift, 0.012);
    const low: number[] = [];
    const high: number[] = [];
    for (let t = 0; t < POINTS; t++) {
      const column = controls.map((c) => c[t] ?? 100).sort((a, b) => a - b);
      low.push(round(quantile(column, 0.05)));
      high.push(round(quantile(column, 0.95)));
    }
    const final = strategy.at(-1) ?? 100;
    const below = controls.filter((c) => (c.at(-1) ?? 100) < final).length;
    return {
      id, simulaciones: CONTROLS, percentil: Math.round((1000 * below) / CONTROLS) / 10,
      estrategia: strategy.map(round), p05: low, p95: high, muestras: controls.slice(0, SAMPLES).map((c) => c.map(round)),
    };
  });
  return `${canonicalJson({ formato: LUCK_FORMAT, experimentos })}\n`;
}

export const DEMO_DIR = resolve(import.meta.dirname, 'fixtures');
export const DEMO_REGISTRY = join(DEMO_DIR, 'demo.registro.jsonl');
export const DEMO_CONTROLS = join(DEMO_DIR, 'demo.controles.json');

// Regenera los archivos de demostración si cambia a propósito este escenario o el formato del registro:
// node demo/research.ts
if (import.meta.main) {
  const registry = demoRegistry();
  writeFileSync(DEMO_REGISTRY, registry, 'utf8');
  writeFileSync(DEMO_CONTROLS, demoControls(registry), 'utf8');
}
