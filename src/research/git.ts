// Estado del código para el registro de experimentos (ADR 0024): qué commit se ejecuta y si el árbol de trabajo tiene
// cambios sin confirmar. Se lee con el binario de git, sin red. Cualquier fallo de git es un error: sin saber qué
// código corre, no hay experimento (fail closed).
import { execFileSync } from 'node:child_process';

export interface GitPort {
  head(): string; // hash completo del commit de HEAD
  dirtyPaths(): readonly string[]; // cambios sin confirmar, también los archivos nuevos que git no ignora
  changedSince(commit: string): readonly string[]; // archivos que difieren entre ese commit y HEAD
}

export class GitError extends Error {
  override readonly name = 'GitError';
}

function paths(output: string): string[] {
  return output.split('\0').filter((p) => p.length > 0);
}

/** git en la carpeta `dir`. Sin renombrados: un archivo movido aparece por su ruta vieja y por la nueva. */
export function gitRepo(dir: string): GitPort {
  const run = (args: readonly string[]): string => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new GitError(`git ${args.join(' ')} falló en ${dir}: ${(e as Error).message}`);
    }
  };
  return {
    head: () => run(['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
    // Formato v1 con -z: «XY ruta» separado por NUL; sin renombrados, cada entrada es una sola ruta.
    dirtyPaths: () => paths(run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).map((entry) => entry.slice(3)),
    changedSince: (commit) => {
      run(['rev-parse', '--verify', `${commit}^{commit}`]); // un commit desconocido es un error, no «nada cambió»
      return paths(run(['diff', '--name-only', '-z', '--no-renames', commit, 'HEAD']));
    },
  };
}
