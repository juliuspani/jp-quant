// Comando de la matriz del PBO de la ronda (docs/PROMOTION_CRITERIA.md A.3.6; ADR 0034). Lee las salidas guardadas de los
// experimentos que se le nombran, cada una comprobada contra el hash_salida de su cierre (readOutput), junta todas sus
// configuraciones y da el PBO por CSCV dentro de cada familia y en la ronda. Da también el DSR global de cada uno, con la N
// de todo el registro en este momento (A.3.2, ADR 0039). No ejecuta ningún backtest ni escribe en el registro: mide sobre
// lo que ya se ejecutó y cuenta en N.
//
// Uso: npm run pbo-ronda -- --id EXP-0025 --id EXP-0026
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { PboOutcome } from '../analytics/robustness.ts';
import { OUTPUTS_DIR, readOutput, registryTrials } from '../research/experiment.ts';
import { readRegistry, REGISTRY_FILE } from '../research/registry.ts';
import { outputConfigurations, roundDeflatedSharpe, roundMatrix, RoundMatrixError } from './round-matrix.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const USAGE = 'Uso: npm run pbo-ronda -- --id EXP-NNNN --id EXP-NNNN …\n';

function describe(outcome: PboOutcome): string {
  if (!outcome.measured) return `sin medir (${String(outcome.configurations)} configuraciones): ${outcome.reason}`;
  const { pbo, configurations, combinations, blocks } = outcome.result;
  return `PBO ${pbo.toFixed(3)} con ${String(configurations)} configuraciones, ${String(outcome.periods)} periodos en común, S = ${String(blocks)} (${String(combinations)} combinaciones)`;
}

function main(): void {
  const { values } = parseArgs({ options: { id: { type: 'string', multiple: true } } });
  const ids = values.id ?? [];
  if (ids.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const registry = readRegistry(join(REPO, ...REGISTRY_FILE.split('/')));
  const candidates = ids.map((id) => {
    const resultado = registry.experiments.get(id)?.closings.find((c) => c.estado === 'completado')?.resultado ?? null;
    if (resultado === null) throw new RoundMatrixError(`${id}: no es un experimento completado del registro`);
    return { id, resultado, salida: readOutput(join(REPO, ...OUTPUTS_DIR.split('/'), `${id}.json`), resultado) };
  });
  const matrix = roundMatrix(candidates.flatMap((c) => outputConfigurations(c.id, c.salida)));
  process.stdout.write(`Configuraciones de la ronda (${String(matrix.configurations.length)}), de ${ids.join(', ')}:\n`);
  for (const c of matrix.configurations) process.stdout.write(`  ${c.family}: ${c.id} (${String(c.periods)} periodos)\n`);
  for (const f of matrix.families) process.stdout.write(`Dentro de ${f.family}: ${describe(f.outcome)}\n`);
  process.stdout.write(`Entre familias (A.3.6, toda la ronda): ${describe(matrix.round)}\n`);
  const trials = registryTrials(registry);
  process.stdout.write(`DSR global (A.3.2), con la N de todo el registro en este momento: N = ${String(trials)} (ADR 0039)\n`);
  for (const c of candidates) {
    const lag = c.resultado.metricas['bootstrap_bloque_medio'];
    if (typeof lag !== 'number') throw new RoundMatrixError(`${c.id}: el cierre no tiene bootstrap_bloque_medio`);
    const { report, note } = roundDeflatedSharpe(c.id, c.salida, trials, lag);
    process.stdout.write(report === null
      ? `  ${c.id}: sin DSR (${note ?? 'sin motivo'})\n`
      : `  ${c.id}: DSR ${report.dsr.toFixed(4)}; Sharpe por periodo ${report.sharpe.toFixed(4)}, SR₀ ${report.sr0.toFixed(4)}, V ${report.trialVariance.toExponential(3)}, T = ${String(report.periods)}\n`);
  }
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`pbo-ronda: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  process.exitCode = 1;
}
