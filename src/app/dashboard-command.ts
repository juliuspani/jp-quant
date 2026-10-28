// Dashboard local (paso 41B, versión local; ADR 0045). Lee el diario de un replay y una ficha del run y escribe una página
// HTML autocontenida que se abre en el navegador como archivo. No hay servidor, acceso remoto ni kill switch: eso queda
// para la versión con VPN o túnel autenticado.
// No lanza ningún backtest (INV-14a): solo lee un diario ya grabado. Es un proceso aparte que no comparte nada con el
// trading, así que su fallo no lo afecta: si algo no se entiende, no escribe la página y sale con error.
//
// Paso 41C: con --registro, la vista de investigación lee el Experiment Registry (y, con --controles, las curvas guardadas
// del control aleatorio). Solo lee: no relanza ningún experimento. La demo pública usa un registro sintético; con el
// registro real, la página se queda en local (CLAUDE.md §1).
//
// Uso: npm run dashboard -- --diario <diario.jsonl> --ficha <ficha.json> --salida <página.html>
//        [--registro <registry.jsonl> [--controles <EXP-NNNN.controles.json> …]]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { executionCosts, type CostSpec } from '../backtest/costs.ts';
import { clientOrderIdFor } from '../execution/client-order-id.ts';
import { buildDashboard, type DashboardContext } from '../monitoring/dashboard.ts';
import { renderDashboard } from '../monitoring/dashboard-html.ts';
import { parseJournal } from '../monitoring/journal.ts';
import { buildResearch, type ResearchSnapshot } from '../monitoring/research.ts';
import { gitRepo, GitError } from '../research/git.ts';
import { parseRegistry } from '../research/registry.ts';
import { Decimal } from '../shared/decimal.ts';
import { isTimeframe, parseUtcIso, timeframeMs } from '../shared/time.ts';
import { experimentsFromRegistry, parseLuckFile } from './research-view.ts';

const USAGE = 'Uso: npm run dashboard -- --diario <diario.jsonl> --ficha <ficha.json> --salida <página.html> [--registro <registry.jsonl> [--controles <EXP-NNNN.controles.json> …]]\n';
const STALE_BARS = 2; // un feed sin vela cerrada en dos velas está retrasado
const ASSET = /^[A-Z0-9]{1,20}$/;
const DECIMAL = /^\d{1,20}(\.\d{1,20})?$/;

export class DashboardCommandError extends Error {
  override readonly name = 'DashboardCommandError';
}

function record(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DashboardCommandError(`${where}: no es un objeto`);
  return value as Readonly<Record<string, unknown>>;
}

function str(object: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '') throw new DashboardCommandError(`${where}: «${key}» debe ser un texto no vacío`);
  return value;
}

/** Fracciones objetivo del plan B: cada una en [0, 1] y sumando como mucho 1. */
function target(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null) return null;
  const weights = record(value, 'ficha.planB.objetivo');
  let total = Decimal.parse('0');
  const out: Record<string, string> = {};
  for (const [asset, weight] of Object.entries(weights)) {
    // Un código de activo en mayúsculas: ni «__proto__» ni marcado (SEC-01).
    if (!ASSET.test(asset)) throw new DashboardCommandError('ficha.planB.objetivo: un activo debe ser un código en mayúsculas (p. ej. BTC)');
    if (typeof weight !== 'string' || !DECIMAL.test(weight)) throw new DashboardCommandError(`ficha.planB.objetivo.${asset}: debe ser un decimal en texto`);
    const fraction = Decimal.parse(weight);
    if (fraction.isNegative() || fraction.gt(Decimal.parse('1'))) throw new DashboardCommandError(`ficha.planB.objetivo.${asset}: fuera de [0, 1]`);
    total = total.plus(fraction);
    out[asset] = fraction.toString();
  }
  if (total.gt(Decimal.parse('1'))) throw new DashboardCommandError('ficha.planB.objetivo: las fracciones suman más de 1');
  return Object.freeze(out);
}

/** La ficha del run: lo que el diario no dice (qué se ve, la estrategia con sus parámetros, los costes y el plan B). */
export function contextFromCard(text: string): DashboardContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Sin el mensaje de V8, que repite un trozo del archivo: si por error es uno de secretos, no sale por la terminal (SEC-03).
    throw new DashboardCommandError('la ficha no es JSON');
  }
  const card = record(parsed, 'ficha');
  const strategy = record(card['estrategia'], 'ficha.estrategia');
  const params = record(strategy['parametros'], 'ficha.estrategia.parametros');
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new DashboardCommandError(`ficha.estrategia.parametros.${key}: debe ser texto o número`);
  }
  const timeframe = str(card, 'temporalidad', 'ficha');
  if (!isTimeframe(timeframe)) throw new DashboardCommandError(`ficha.temporalidad: ${timeframe} no es una temporalidad`);
  // El benchmark paga por lado lo mismo que el modelo de costes del run, con sus mínimos (fail closed si no llega).
  const costCard = record(card['costes'], 'ficha.costes');
  const multiplier = costCard['multiplier'];
  if (typeof multiplier !== 'number') throw new DashboardCommandError('ficha.costes.multiplier: debe ser un número');
  const spec: CostSpec = {
    commission: str(costCard, 'commission', 'ficha.costes'), halfSpread: str(costCard, 'halfSpread', 'ficha.costes'),
    minSlippage: str(costCard, 'minSlippage', 'ficha.costes'), multiplier,
  };
  const costs = executionCosts(spec);
  const planB = record(card['planB'], 'ficha.planB');
  const next = planB['proximoRebalanceo'];
  if (next !== null && typeof next !== 'string') throw new DashboardCommandError('ficha.planB.proximoRebalanceo: fecha ISO o null');
  const stale = STALE_BARS * timeframeMs(timeframe);
  // Obligatorio y sin valor por defecto: la marca de agua de demostración no puede aparecer ni faltar por omisión.
  const data = card['datos'];
  if (data !== 'sinteticos' && data !== 'reales') throw new DashboardCommandError('ficha.datos: «sinteticos» o «reales»');
  return Object.freeze({
    mode: 'REPLAY',
    label: str(card, 'etiqueta', 'ficha'),
    synthetic: data === 'sinteticos',
    strategy: Object.freeze({ id: str(strategy, 'id', 'ficha.estrategia'), version: str(strategy, 'version', 'ficha.estrategia'), params: params as Readonly<Record<string, string | number>> }),
    benchmark: Object.freeze({ symbol: str(card, 'referencia', 'ficha'), costRate: costs.commission.plus(costs.halfSpread).plus(costs.minSlippage).toAnalysis(), maxStaleMs: stale }),
    planB: Object.freeze({ target: target(planB['objetivo'] ?? null), nextRebalanceAt: next === null ? null : parseUtcIso(next) }),
    feedMaxAgeMs: stale,
    clientOrderIdOf: clientOrderIdFor,
  });
}

export interface DashboardSources {
  readonly registryText?: string; // el Experiment Registry, si se pasa
  readonly luckTexts?: readonly string[]; // archivos de curvas del control aleatorio (inversor-controles/1), uno o varios
  readonly commit?: string | null; // hash corto del último commit
}

/** La vista de investigación a partir del registro y de las curvas guardadas. */
export function researchFrom(registryText: string, luckTexts: readonly string[] = []): ResearchSnapshot {
  return buildResearch({ experiments: experimentsFromRegistry(parseRegistry(registryText)), luck: luckTexts.flatMap((text) => parseLuckFile(text)) });
}

/** La página a partir del texto del diario y de la ficha, y opcionalmente del registro. */
export function dashboardHtml(journalText: string, cardText: string, sources: DashboardSources = {}): string {
  const luckTexts = sources.luckTexts ?? [];
  if (luckTexts.length > 0 && sources.registryText === undefined) throw new DashboardCommandError('las curvas del control necesitan su registro (--registro)');
  return renderDashboard({
    snapshot: buildDashboard(parseJournal(journalText), contextFromCard(cardText)),
    research: sources.registryText === undefined ? null : researchFrom(sources.registryText, luckTexts),
    commit: sources.commit ?? null,
  });
}

/** El commit corto de HEAD, solo para mostrarlo; sin git (p. ej. una copia sin repositorio), la página no lo enseña. */
function shortHead(): string | null {
  try {
    return gitRepo(process.cwd()).head().slice(0, 7);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      diario: { type: 'string' }, ficha: { type: 'string' }, salida: { type: 'string' }, registro: { type: 'string' }, controles: { type: 'string', multiple: true },
    },
  });
  if (values.diario === undefined || values.ficha === undefined || values.salida === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!values.salida.toLowerCase().endsWith('.html')) throw new DashboardCommandError('la salida debe ser un archivo .html');
  const html = dashboardHtml(readFileSync(values.diario, 'utf8'), readFileSync(values.ficha, 'utf8'), {
    ...(values.registro === undefined ? {} : { registryText: readFileSync(values.registro, 'utf8') }),
    luckTexts: (values.controles ?? []).map((path) => readFileSync(path, 'utf8')),
    commit: shortHead(),
  });
  writeFileSync(values.salida, html, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`dashboard: ${values.salida} (ábrelo en el navegador; es un archivo local de solo lectura)\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    // Sin caracteres de control: un texto del diario no puede mover el cursor ni colorear la terminal (SEC-03).
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`dashboard: ${message.replace(/\p{Cc}/gu, '?')}\n`);
    process.exitCode = 1;
  }
}
