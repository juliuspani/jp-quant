// Utilidades de las pruebas de invariantes (SECURITY_AND_TRADING_INVARIANTS.md): qué archivos tiene el repositorio.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');

/** Ejecuta git en la raíz. Si falla, la prueba falla: sin la lista de archivos no se puede afirmar nada. */
export function git(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout };
}

/**
 * Archivos versionados más los nuevos que git no ignora, con barras normales. Incluye los que aún no tienen
 * commit, para que un archivo recién creado no escape de las pruebas hasta que se confirme.
 */
export function repoFiles(): string[] {
  const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (r.status !== 0) throw new Error('git ls-files falló');
  const files = r.stdout.split('\0').filter((f) => f.length > 0 && existsSync(join(ROOT, f)));
  return [...new Set(files)].sort();
}

export function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/** Código que se ejecuta fuera de las pruebas: el bot, el capguard, los scripts y los hooks de git. */
export function runnableCode(): string[] {
  return repoFiles().filter((f) => /^(src|capguard|scripts)\/.*\.(ts|js|cjs|mjs)$/.test(f) || f.startsWith('.githooks/'));
}

/** Líneas que casan con alguno de los patrones, como «archivo:línea: texto». */
export function matchingLines(files: string[], patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (patterns.some((p) => p.test(line))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  return hits;
}
