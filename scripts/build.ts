// «Build» de un proyecto sin paso de compilación: Node ejecuta el TypeScript directamente, así que lo que
// puede romperse es que Node no sepa cargar un archivo. Este check pasa `node --check` a cada .ts.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'scripts', 'test', 'demo', 'sandbox', 'examples'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap(tsFiles);
const failed: string[] = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    failed.push(file);
  }
}

if (failed.length > 0) {
  process.stderr.write(`build: Node no puede cargar ${failed.length} archivo(s):\n  ${failed.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write(`build: ${files.length} archivos .ts cargables por Node\n`);
