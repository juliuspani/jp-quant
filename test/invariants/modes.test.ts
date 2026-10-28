// INV-12 (SECURITY_AND_TRADING_INVARIANTS.md): los modos están separados. Solo la composición sabe en qué modo
// corre el bot (ARCHITECTURE.md §14), y las pruebas nunca cargan las claves de .env.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchingLines, read, repoFiles } from './repo.ts';

// Preguntar por el modo: compararlo, mirar el sandbox o la confirmación del modo real.
const MODE = [/\bmode\s*[!=]==|[!=]==\s*['"](paper|live|shadow|backtest)['"]/, /\.sandbox\b|setSandboxMode/, /liveConfirmed|LIVE_CONFIRMATION/];

// Código previo que pregunta por el modo. La lista solo encoge: se quita cada archivo al llevarlo a app/.
const LEGACY = ['src/dashboard.ts', 'src/main.ts', 'src/market.ts', 'src/report.ts'];

const knowsMode = (f: string) => f === 'src/config.ts' || /^src\/(app|config)\//.test(f);

test('INV-12a: fuera de app/ y config/ nadie pregunta por el modo, salvo el código previo de la lista', () => {
  const code = repoFiles().filter((f) => /^src\/.*\.ts$/.test(f) && !knowsMode(f));
  const asking = [...new Set(matchingLines(code, MODE).map((hit) => hit.slice(0, hit.indexOf(':'))))].sort();
  const extra = asking.filter((f) => !LEGACY.includes(f));
  assert.deepEqual(extra, [], 'código nuevo que pregunta por el modo: solo src/app/ puede');
  const stale = LEGACY.filter((f) => !asking.includes(f));
  assert.deepEqual(stale, [], 'quita de LEGACY los archivos que ya no preguntan por el modo');
});

test('INV-12b: las pruebas no cargan .env', () => {
  // Las pruebas del hook citan .env como dato, y esta misma prueba contiene los patrones.
  const data = new Set(['test/enforcement/claude-guard.test.ts', 'test/invariants/modes.test.ts']);
  const tests = repoFiles().filter((f) => /^test\/.*\.ts$/.test(f) && !data.has(f));
  const loads = [/loadEnvFile|--env-file/, /loadSecrets\(\s*\)/, /loadSecrets\(\s*['"`][^'"`]*\.env['"`]/];
  assert.deepEqual(matchingLines(tests, loads), []);
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert.doesNotMatch(scripts['test'] ?? '', /env-file|\.env/);
});
