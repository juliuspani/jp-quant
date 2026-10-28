// Comando de backtest (paso 23). Sustituye al src/backtest.ts previo, que bajaba velas con ccxt y no registraba nada.
// Cada ejecución es un experimento del registro (quant-research §10, ADR 0024): pre-registro, datos de historical/
// comprobados contra su hash, backtest por tramos y cierre con las métricas netas de costes y la declaración del modelo de
// ejecución. No hay otra forma de obtener un resultado: todo run pasa por el Experiment Registry.
// Las estrategias se dan de alta en RESEARCH_RUNNERS con su ejecutor: las de la biblioteca (paso 25, ADR 0028). Sin
// ejecutor, con una rejilla de más de MAX_GRID_CONFIGURATIONS puntos o con cambios sin confirmar, el comando se niega
// antes de registrar nada.
// Desde el paso 27B (ADR 0031), el veredicto sale de los criterios congelados del paso 27. Antes de registrar nada, el
// comando comprueba que los documentos congelados en disco son los que implementa el evaluador; al terminar, guarda la
// salida completa junto al registro, verificada contra su hash.
// Desde el paso 28 (ADR 0032), admite un barrido: el ejecutor elige en el train de cada tramo.
// Desde el paso 41C (ADR 0047), junto a la salida guarda EXP-NNNN.controles.json con las curvas del control aleatorio y,
// con --diarios, el diario de cada tramo y su ficha del dashboard en una carpeta que git ignora (llevan datos reales).
//
// Uso: npm run backtest -- --spec <experimento.json> [--diarios <carpeta ignorada por git>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FROZEN_DOCUMENTS } from '../analytics/criteria.ts';
import { DEFAULT_PATHS, defaultGuard, TEST_FINAL_START_UTC } from '../historical/guard.ts';
import { KRAKEN_DELISTINGS_FROM_UTC } from '../historical/kraken.ts';
import { OUTPUTS_DIR, runExperiment, writeOutput, type ExperimentSpec, type Runner } from '../research/experiment.ts';
import { gitRepo } from '../research/git.ts';
import { gridSize, REGISTRY_FILE } from '../research/registry.ts';
import { MAX_GRID_CONFIGURATIONS } from '../strategy/library.ts';
import { HistoricalDatasets, krakenCoverage } from './datasets.ts';
import { writeControls, writeJournals } from './experiment-artefacts.ts';
import { libraryRunners } from './research-runner.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const USAGE = 'Uso: npm run backtest -- --spec <experimento.json> [--diarios <carpeta ignorada por git>]\n';

/** Si git ignora la ruta: los diarios con datos reales solo se escriben donde no se pueden versionar. */
function ignoredByGit(path: string): boolean {
  const result = spawnSync('git', ['-C', REPO, 'check-ignore', '-q', path], { encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore falló (${String(result.status)}): no se escriben los diarios`);
}

/** Estrategias que se pueden investigar, por `nombre@versión` (runnerKey de research/): las de la biblioteca (paso 25). */
const RESEARCH_RUNNERS: ReadonlyMap<string, Runner> = libraryRunners();

/** Los criterios congelados en disco son los que implementa el evaluador (SHA-256 con finales LF); si no, no se ejecuta nada. */
function checkFrozenDocuments(): void {
  for (const { path, sha256 } of FROZEN_DOCUMENTS) {
    const text = readFileSync(join(REPO, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n');
    const actual = createHash('sha256').update(text, 'utf8').digest('hex');
    if (actual !== sha256) throw new Error(`${path} no es el documento congelado que implementa el evaluador (${actual} ≠ ${sha256}): parada obligatoria, ADR 0030`);
  }
}

function readSpec(path: string): ExperimentSpec {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || !('parametros' in value)) throw new Error('la especificación no es un experimento');
  const { parametros } = value;
  if (typeof parametros !== 'object' || parametros === null || !('tipo' in parametros) || (parametros.tipo !== 'valores' && parametros.tipo !== 'rejilla')) {
    throw new Error('parametros.tipo debe ser «valores» o «rejilla»');
  }
  // Un barrido pequeño (docs/PROMOTION_CRITERIA.md C.1 y paso 28): uno más grande no llega a registrarse.
  const size = gridSize(parametros as ExperimentSpec['parametros']);
  if (size === null || size > MAX_GRID_CONFIGURATIONS) throw new Error(`la rejilla tiene ${String(size)} puntos: como mucho ${String(MAX_GRID_CONFIGURATIONS)} (ADR 0032)`);
  // Las ejecuciones de robustez cuentan en N (ADR 0031): se declaran siempre, también cuando son 0.
  if (!('variantes' in value) || !Number.isSafeInteger(value.variantes) || (value.variantes as number) < 0) {
    throw new Error('la especificación debe declarar «variantes»: las ejecuciones de robustez que cuentan en N (ADR 0031)');
  }
  // El registro valida la línea entera con su esquema antes de escribirla: una especificación mal formada no entra.
  return value as ExperimentSpec;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { spec: { type: 'string' }, diarios: { type: 'string' } } });
  if (values.spec === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  checkFrozenDocuments();
  const spec = readSpec(values.spec);
  const { closed, salida, artefactos } = await runExperiment(
    {
      registryPath: join(REPO, ...REGISTRY_FILE.split('/')),
      git: gitRepo(REPO),
      datasets: new HistoricalDatasets({
        guard: defaultGuard(),
        researchRoot: DEFAULT_PATHS.researchRoot,
        coverage: krakenCoverage(KRAKEN_DELISTINGS_FROM_UTC, TEST_FINAL_START_UTC),
      }),
      runners: RESEARCH_RUNNERS,
      now: () => Date.now(),
    },
    spec,
  );
  const outputs = join(REPO, ...OUTPUTS_DIR.split('/'));
  if (closed.resultado !== null) writeOutput(join(outputs, `${closed.id}.json`), closed.resultado, salida);
  if (closed.resultado !== null && artefactos !== null) {
    const controls = writeControls(outputs, closed.id, salida, artefactos);
    process.stdout.write(controls === null ? 'Sin curvas del control: el motivo está en la salida (archivos.controles).\n' : `Curvas del control: ${controls}\n`);
    if (values.diarios !== undefined) {
      const written = writeJournals(values.diarios, ignoredByGit, closed.id, spec, salida, artefactos);
      process.stdout.write(`Diarios con datos reales, solo en local (${String(written.length / 2)} tramos): ${values.diarios}\n`);
    }
  }
  const verdict = closed.resultado?.veredicto ?? 'sin calcular';
  process.stdout.write(`${closed.id} ${closed.estado}. Cifras netas de costes; veredicto (criterios congelados del paso 27): ${verdict}.\n`);
  for (const [key, value] of Object.entries(closed.resultado?.metricas ?? {})) process.stdout.write(`  ${key}: ${String(value)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`backtest: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  process.exitCode = 1;
});
