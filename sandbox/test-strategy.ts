// `npm run test-strategy` (paso 49): prueba una estrategia de usuario con sus velas en CSV, por el mismo pipeline que la
// investigación oficial, y escribe un informe HTML local con el veredicto en lenguaje llano. Nunca toca el registro oficial.
//
// Uso: npm run test-strategy -- --strategy examples/my-strategy.ts --data examples/candles/synthetic-daily.csv
//        [--name <etiqueta de los datos>] [--timeframe 1d] [--dir sandbox-runs] [--idioma en|es]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CsvError, parseCandlesCsv } from './csv.ts';
import { StrategyDefinitionError, type Params, type SandboxStrategy } from './define.ts';
import { SandboxError, testStrategy } from './pipeline.ts';
import { reportHtml } from './report.ts';

export const DEFAULT_DIR = 'sandbox-runs';
const USAGE = 'Usage: npm run test-strategy -- --strategy <file.ts> --data <candles.csv> [--name <label>] [--timeframe 1d] [--dir sandbox-runs] [--idioma en|es]\n';

function isSandboxStrategy(value: unknown): value is SandboxStrategy<Params> {
  return typeof value === 'object' && value !== null && 'definition' in value && 'entry' in value && 'configurations' in value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { strategy: { type: 'string' }, data: { type: 'string' }, name: { type: 'string' }, timeframe: { type: 'string' }, dir: { type: 'string' }, idioma: { type: 'string' } } });
  if (values.strategy === undefined || values.data === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const language = values.idioma === 'es' ? 'es' : 'en';
  const module = (await import(pathToFileURL(resolve(values.strategy)).href)) as { default?: unknown };
  if (!isSandboxStrategy(module.default)) throw new SandboxError(`${values.strategy} has no strategy: export default defineStrategy({ ... }) (see examples/my-strategy.ts)`);
  const strategy = module.default;
  const label = values.name ?? basename(values.data);
  const { candles, timeframe, gaps } = parseCandlesCsv(readFileSync(values.data, 'utf8'), label, values.timeframe);
  const dir = values.dir ?? DEFAULT_DIR;
  process.stdout.write(`test-strategy: ${strategy.definition.name} on ${String(candles.length)} ${timeframe} candles${gaps > 0 ? ` (${String(gaps)} missing)` : ''}. Walk-forward, costs, Deflated Sharpe, PBO and 1000 random-control runs: this can take a few minutes...\n`);
  const result = await testStrategy({ strategy, candles, timeframe, dataLabel: label, dir });
  const path = join(dir, `${result.runId}.html`);
  writeFileSync(path, reportHtml(result, language), 'utf8');
  const verdict = { edge: 'looks like a real edge', luck: 'indistinguishable from luck', insufficient: 'not enough data' }[result.verdict];
  process.stdout.write(`Verdict: ${verdict}. Report: ${resolve(path)} (open it in your browser). Local run ${String(result.localN)} for this strategy; the official registry is untouched.\n`);
}

main().catch((error: unknown) => {
  // Los errores del usuario (CSV, estrategia, datos) se dicen tal cual; lo demás, con su tipo, sin caracteres de control.
  const known = error instanceof CsvError || error instanceof StrategyDefinitionError || error instanceof SandboxError;
  const text = error instanceof Error ? (known ? error.message : `${error.name}: ${error.message}`) : String(error);
  process.stderr.write(`test-strategy: ${text.replace(/\p{Cc}/gu, '?')}\n`);
  process.exitCode = 1;
});
