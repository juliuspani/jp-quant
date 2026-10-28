// Ningún código fuera de la guarda nombra rutas de data/ (paso 19B, ADR 0022, INV-13): toda lectura de datos de
// investigación, de brutos o del test final pasa por src/historical/guard.ts, que decide qué se puede abrir. Comprueba
// texto, como las demás pruebas de este tipo: no ve una ruta que llega en tiempo de ejecución (un argumento, la
// configuración) ni una construida por partes. Los comentarios no cuentan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { read, runnableCode } from '../invariants/repo.ts';

// Pueden nombrar data/: la guarda, que la protege, y el hook de Claude, que bloquea leer el test final.
const ALLOWED = new Set(['src/historical/guard.ts', 'scripts/claude-guard.ts']);
// Excepción del código previo, con su número de líneas. Solo puede bajar: el valor por defecto de `dataDir`, la carpeta
// de SQLite y del bloqueo de src/main.ts, que se sustituye en el paso 32.
const KNOWN = new Map([['src/config/schema.ts', 1]]);

const PATTERNS = [
  /['"`](?:\.\/)?data[\\/]/, // 'data/…' o './data/…'
  // El segmento 'data' en un join o resolve, o como valor; no el evento 'data' de un stream.
  /(?<!\.(?:on|once|off|addListener|removeListener|prependListener|emit)\(\s*)['"`]data['"`]/,
];

function offending(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .filter((line) => PATTERNS.some((p) => p.test(line)));
}

test('los patrones ven rutas de data/ y no confunden el evento «data» de un stream', () => {
  for (const bad of ["join(REPO, 'data', 'raw')", "readFileSync('data/raw/x.zip')", 'resolve(`./data/historical`)', "const dir = \"data\\\\raw\";", "z.string().default('data')"]) {
    assert.equal(offending(bad).length, 1, bad);
  }
  for (const ok of ["body.on('data', (chunk) => hash.update(chunk))", "stream.once('data', f)", '// lee data/raw/ a través de la guarda', "const metadata = 'x'"]) {
    assert.equal(offending(ok).length, 0, ok);
  }
});

test('solo la guarda nombra rutas de data/; la excepción conocida no crece y desaparece al quitarla', () => {
  const found = new Map<string, string[]>();
  for (const file of runnableCode().filter((f) => !ALLOWED.has(f))) {
    const lines = offending(read(file));
    if (lines.length > 0) found.set(file, lines);
  }
  for (const [file, lines] of found) {
    const max = KNOWN.get(file);
    assert.ok(max !== undefined, `${file} nombra rutas de data/: pásalas por src/historical/guard.ts\n${lines.join('\n')}`);
    assert.ok(lines.length <= max, `${file}: ${String(lines.length)} rutas de data/, el máximo registrado es ${String(max)}`);
  }
  for (const file of KNOWN.keys()) assert.ok(found.has(file), `${file} ya no nombra data/: quítalo de KNOWN`);
});
