// Ejecuta dependency-cruiser sobre las raíces de código del directorio actual: src/ siempre y capguard/ cuando
// exista (ADR 0003). dependency-cruiser falla si se le pasa una carpeta que no existe, y capguard/ todavía no
// existe. Los argumentos extra (--ignore-known, --output-type json…) se pasan tal cual.
// Fail closed: sin src/ no hay nada que comprobar y se considera un error.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DEPCRUISE = join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const CONFIG = join(ROOT, '.dependency-cruiser.cjs');

if (!existsSync('src')) {
  process.stderr.write(`boundaries: no existe src/ en ${process.cwd()}\n`);
  process.exit(1);
}

const roots = ['src', 'capguard'].filter((dir) => existsSync(dir));
const result = spawnSync(process.execPath, [DEPCRUISE, ...roots, '--config', CONFIG, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (result.error) {
  process.stderr.write(`boundaries: no se pudo ejecutar dependency-cruiser: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
