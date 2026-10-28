// Comando de reproducción (docs/PROMOTION_CRITERIA.md A.4.3; ADR 0024 y ADR 0034): vuelve a ejecutar un experimento
// completado por su id y comprueba que da las mismas métricas, el mismo hash de salida y el mismo veredicto. No escribe en
// el registro: no es una prueba nueva, sino la comprobación de una que ya cuenta. Si el código cambió desde su commit,
// corre en un worktree de ese commit en la carpeta temporal (reproduction.ts).
//
// Uso: npm run reproduce -- --id EXP-NNNN
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { reproduce } from './reproduction.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const USAGE = 'Uso: npm run reproduce -- --id EXP-NNNN\n';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { id: { type: 'string' } } });
  if (values.id === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const { resultado, worktree } = await reproduce(values.id, { repo: REPO, worktrees: join(tmpdir(), 'inversor-jp-reproducciones') });
  process.stdout.write(
    `${values.id} reproducido${worktree === null ? ' en este repositorio' : ` en el worktree ${worktree}`}: mismo hash de salida ` +
      `(${resultado.hash_salida}), mismas métricas y mismo veredicto (${resultado.veredicto ?? 'sin calcular'}).\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`reproduce: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  process.exitCode = 1;
});
