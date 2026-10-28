// Reproducción de un experimento completado (docs/PROMOTION_CRITERIA.md A.4.3; ADR 0024 y ADR 0034). reproduceExperiment
// exige el código del commit registrado: si desde él solo cambió documentación, se reproduce en este repositorio; si
// cambió código, en un worktree de ese commit, fuera del repositorio, con los módulos de ese commit. En los dos casos, el
// registro es el de este repositorio (reproduceExperiment no escribe en él) y los datos se leen con la guarda del commit y
// las rutas de la de este repositorio, comprobando su hash. El worktree enlaza el node_modules de este repositorio y no se
// borra: se reutiliza.
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PATHS } from '../historical/guard.ts';
import type * as GuardModule from '../historical/guard.ts';
import type * as KrakenModule from '../historical/kraken.ts';
import { cleanCommit, isDocumentation, ReproductionError } from '../research/experiment.ts';
import type * as ExperimentModule from '../research/experiment.ts';
import { gitRepo } from '../research/git.ts';
import type * as GitModule from '../research/git.ts';
import { readRegistry, REGISTRY_FILE, type Resultado } from '../research/registry.ts';
import type * as DatasetsModule from './datasets.ts';
import type * as RunnerModule from './research-runner.ts';

/** Dónde se reproduce: aquí (null) o en el worktree de su commit, si el código cambió desde él. */
export function worktreeFor(commit: string | null, changedSinceCommit: readonly string[], base: string): string | null {
  if (commit === null) throw new ReproductionError('sin commit registrado: solo se reproduce un experimento con este protocolo');
  return changedSinceCommit.some((path) => !isDocumentation(path)) ? join(base, commit) : null;
}

function ensureWorktree(repo: string, path: string, commit: string): void {
  if (!existsSync(path)) execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', path, commit], { stdio: ['ignore', 'ignore', 'pipe'] });
  const modules = join(path, 'node_modules');
  if (!existsSync(modules)) symlinkSync(join(repo, 'node_modules'), modules, 'junction');
}

async function load<T>(root: string, path: string): Promise<T> {
  return (await import(pathToFileURL(join(root, ...path.split('/'))).href)) as T;
}

export interface ReproductionOptions {
  readonly repo: string; // este repositorio: registro, datos y node_modules
  readonly worktrees: string; // carpeta de los worktrees, fuera del repositorio
}

/** Reproduce `id` y devuelve su resultado; lanza ReproductionError si no da exactamente lo mismo. */
export async function reproduce(id: string, options: ReproductionOptions): Promise<{ readonly resultado: Resultado; readonly worktree: string | null }> {
  const registryPath = join(options.repo, ...REGISTRY_FILE.split('/'));
  const experiment = readRegistry(registryPath).experiments.get(id);
  if (experiment === undefined) throw new ReproductionError(`${id} no está en el registro`);
  const here = gitRepo(options.repo);
  cleanCommit(here); // también el código que orquesta la reproducción está confirmado
  const { commit } = experiment.registered;
  const worktree = worktreeFor(commit, commit === null ? [] : here.changedSince(commit), options.worktrees);
  if (worktree !== null && commit !== null) ensureWorktree(options.repo, worktree, commit);
  const root = worktree ?? options.repo;
  const experiments = await load<typeof ExperimentModule>(root, 'src/research/experiment.ts');
  const git = await load<typeof GitModule>(root, 'src/research/git.ts');
  const datasets = await load<typeof DatasetsModule>(root, 'src/app/datasets.ts');
  const runners = await load<typeof RunnerModule>(root, 'src/app/research-runner.ts');
  const guard = await load<typeof GuardModule>(root, 'src/historical/guard.ts');
  const kraken = await load<typeof KrakenModule>(root, 'src/historical/kraken.ts');
  // La guarda es la clase del commit, para que sus velas lleven su Decimal (canonicalJson solo serializa el suyo), con las
  // rutas de la guarda de este repositorio: el worktree no tiene datos.
  const resultado = await experiments.reproduceExperiment(
    {
      registryPath,
      git: git.gitRepo(root),
      datasets: new datasets.HistoricalDatasets({
        guard: new guard.TestFinalGuard({ paths: DEFAULT_PATHS, env: process.env, now: () => Date.now() }),
        researchRoot: DEFAULT_PATHS.researchRoot,
        coverage: datasets.krakenCoverage(kraken.KRAKEN_DELISTINGS_FROM_UTC, guard.TEST_FINAL_START_UTC),
      }),
      runners: runners.libraryRunners(),
      now: () => Date.now(),
    },
    id,
  );
  return { resultado, worktree };
}
