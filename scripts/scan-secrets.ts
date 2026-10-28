// Escaneo de secretos con secretlint.
//   node scripts/scan-secrets.ts            → todos los archivos versionados
//   node scripts/scan-secrets.ts --staged   → el contenido preparado para el commit (el índice, no el disco)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SECRETLINT = join(ROOT, 'node_modules', 'secretlint', 'bin', 'secretlint.js');
const CONFIG = join(ROOT, '.secretlintrc.json');
const BATCH = 200;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function list(args: string[]): string[] {
  return git(args).split('\0').filter((f) => f.length > 0);
}

// Devuelve true si secretlint no encuentra nada en `files` (rutas relativas a `cwd`).
function scan(cwd: string, files: string[]): boolean {
  let clean = true;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const r = spawnSync(
      process.execPath,
      // --no-gitignore: un archivo ignorado que aun así esté versionado o preparado también se escanea.
      [SECRETLINT, '--secretlintrc', CONFIG, '--no-glob', '--no-gitignore', ...batch],
      { cwd, stdio: 'inherit' },
    );
    if (r.status !== 0) clean = false;
  }
  return clean;
}

const staged = process.argv.includes('--staged');
let clean: boolean;
let count: number;

if (staged) {
  const files = list(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  count = files.length;
  if (count === 0) {
    clean = true;
  } else {
    // Se escanea lo que entra en el commit: una copia del índice, no el archivo del disco.
    const tmp = mkdtempSync(join(tmpdir(), 'inversor-jp-secrets-'));
    try {
      const prefix = `--prefix=${tmp.replaceAll('\\', '/')}/`;
      for (let i = 0; i < files.length; i += BATCH) {
        git(['checkout-index', prefix, '--', ...files.slice(i, i + BATCH)]);
      }
      clean = scan(tmp, files);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
} else {
  const files = list(['ls-files', '-z']);
  count = files.length;
  clean = scan(ROOT, files);
}

if (!clean) {
  process.stderr.write('secretos: posible secreto detectado. No se continúa.\n');
  process.exit(1);
}
process.stdout.write(`secretos: ${count} archivo(s) ${staged ? 'preparados' : 'versionados'} sin secretos\n`);
