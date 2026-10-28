// Hook PreToolUse de Claude Code (.claude/settings.json). Bloquea, antes de que ocurran:
//   - leer o escribir el contenido de data/holdout/ y config/holdout.lock (comprobar si existen sí se permite);
//   - leer o escribir .env*, salvo .env.example con las herramientas de archivos y solo con nombres sin valor;
//   - comandos destructivos (rm -rf, git push --force, git reset --hard) y saltarse los hooks de git;
//   - llamadas a endpoints de retiro, y escribir código que las haga;
//   - nombrar LIVE_TRADING o su frase de confirmación en un comando: operar en real lo activa una persona.
// Recibe la llamada en JSON por stdin. Salir con código 2 bloquea la herramienta y devuelve stderr a Claude.
// Fail closed: si la entrada no se entiende, se bloquea.

export type ToolInput = Record<string, unknown>;

const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// `.env`, `.env.local`, `dir/.env`… pero no `process.env` ni `.environment`.
const ENV_FILE = /(?<![\w$.)\]])\.env(?![a-zA-Z0-9])/;
// La plantilla versionada: nombres de variables sin valores (ADR 0001, revisión de la decisión 8). Solo se
// exceptúa en las herramientas de archivos; en un comando de shell sigue bloqueada, porque no se puede
// comprobar lo que el comando escribe. secretlint la escanea al hacer commit, como al resto.
const ENV_EXAMPLE = /(^|\/)\.env\.example$/;
// `CLAVE=valor` o `export CLAVE=valor`: el grupo 2 es el valor.
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const HOLDOUT_PATH = /(^|\/)data\/holdout(\/|$)|(^|\/)config\/holdout\.lock$/;
const HOLDOUT_IN_COMMAND = /data[\\/]+holdout|holdout\.lock/i;
// Lo que puede leer contenido o escribir sin que el comando lo nombre: tuberías, redirecciones, sustitución
// de comandos, el operador de llamada de PowerShell y subexpresiones.
const HOLDOUT_UNSAFE_SYNTAX = /[|<>`&]|\$\(|@\(|\{/;
const WITHDRAW_CALL = /https?:\/\/\S*withdraw|\/withdraw|withdraw\w*\s*\(|sapi\w*withdraw/i;
// Desde la shell no se nombra la variable ni su frase: así no se puede activar el modo real para un solo
// comando (`LIVE_TRADING=… npm start`, `export`, `$env:`, `setx`). Para buscarla está la herramienta Grep.
// La frase debe coincidir con LIVE_CONFIRMATION de src/config/environment.ts; no se importa para que el hook no dependa de src/.
const LIVE_TRADING_IN_COMMAND = /LIVE_TRADING|SI_ENTIENDO_EL_RIESGO/i;
const SKIP_GIT_HOOKS = /--no-verify|core\.hookspath/i;

const DELETE_COMMANDS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').toLowerCase();
}

function isRecursiveForceDelete(tokens: string[]): boolean {
  const at = tokens.findIndex((t) => DELETE_COMMANDS.has(t.toLowerCase().replace(/^.*[\\/]/, '')));
  if (at === -1) return false;
  let recursive = false;
  let force = false;
  for (const raw of tokens.slice(at + 1)) {
    const t = raw.toLowerCase();
    if (t === '/s') recursive = force = true; // rmdir /s de cmd borra el árbol entero
    if (!t.startsWith('-')) continue;
    if (t === '--recursive') recursive = true;
    else if (t === '--force') force = true;
    else {
      const body = t.replace(/^-+/, '').replace(/:.*$/, '');
      if (body.length === 0) continue;
      // Parámetros de PowerShell, que admiten abreviatura: -Recurse, -r, -Force, -fo.
      if ('recurse'.startsWith(body)) recursive = true;
      else if ('force'.startsWith(body)) force = true;
      else if (/^[a-z]+$/.test(body)) {
        // Grupo de opciones cortas: -rf, -fr, -Rf.
        if (body.includes('r')) recursive = true;
        if (body.includes('f')) force = true;
      }
    }
  }
  return recursive && force;
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

/**
 * Comprobaciones de existencia que no leen contenido: `ls`, `test -e|-f|-d|-s`, `[ -e … ]`, `Test-Path` y
 * `Get-ChildItem` (o sus alias) sin `-Recurse` ni `-Depth`. Lista cerrada: cualquier otra cosa se bloquea.
 */
function isExistenceCheck(tokens: string[]): boolean {
  const [head, ...args] = tokens.map(unquote);
  const cmd = (head ?? '').toLowerCase();
  if (cmd === 'ls' || cmd === 'test-path') return true;
  if (cmd === 'test' || cmd === '[') {
    const body = cmd === '[' && args.at(-1) === ']' ? args.slice(0, -1) : args;
    if (cmd === '[' && body.length === args.length) return false;
    return body.every((a) => !a.startsWith('-') || ['-e', '-f', '-d', '-s'].includes(a));
  }
  if (cmd === 'get-childitem' || cmd === 'gci' || cmd === 'dir') {
    return args.every((a) => {
      const body = a.toLowerCase().replace(/^-+/, '').replace(/:.*$/, '');
      return !a.startsWith('-') || !(body.startsWith('r') || body.startsWith('dep'));
    });
  }
  return false;
}

/** Un comando que nombra el test final solo pasa si cada orden que lo nombra es una comprobación de existencia. */
function checkHoldoutCommand(command: string): string | null {
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    if (!HOLDOUT_IN_COMMAND.test(segment)) continue;
    const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
    if (HOLDOUT_UNSAFE_SYNTAX.test(segment) || !isExistenceCheck(tokens)) {
      return 'el comando lee o escribe data/holdout/ o config/holdout.lock (solo se permite comprobar si existen)';
    }
  }
  return null;
}

function checkCommand(command: string): string | null {
  if (ENV_FILE.test(command)) return 'el comando toca un archivo .env*';
  const holdout = checkHoldoutCommand(command);
  if (holdout !== null) return holdout;
  if (WITHDRAW_CALL.test(command)) return 'el comando llama a un endpoint de retiro';
  if (LIVE_TRADING_IN_COMMAND.test(command)) return 'el comando nombra LIVE_TRADING: operar en real lo activa una persona';

  for (const segment of command.split(/[|;&\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    if (isRecursiveForceDelete(tokens)) return 'borrado recursivo forzado (rm -rf o equivalente)';

    const git = tokens.findIndex((t) => /^git(\.exe)?$/i.test(t));
    if (git === -1) continue;
    const rest = tokens.slice(git + 1);
    if (rest.includes('push')) {
      const forced = rest.some(
        (t) => t === '-f' || t.startsWith('--force') || /^\+\S/.test(t),
      );
      if (forced) return 'git push forzado';
    }
    if (rest.includes('reset') && rest.includes('--hard')) return 'git reset --hard';
    if (SKIP_GIT_HOOKS.test(segment)) return 'el comando se salta o redirige los hooks de git';
  }
  return null;
}

/** Variables de .env.example que traen un valor. Un valor podría ser un secreto real. */
function envExampleValues(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ENV_ASSIGNMENT.exec(line);
    const name = match?.[1];
    const value = match?.[2] ?? '';
    // Vacío, comillas vacías o solo un comentario cuentan como "sin valor".
    if (name !== undefined && value !== '' && value !== '""' && value !== "''" && !value.startsWith('#')) {
      names.push(name);
    }
  }
  return names;
}

function checkFileTool(tool: string, input: ToolInput): string | null {
  const targets = [input.file_path, input.notebook_path, input.path, input.glob];
  if (tool === 'Glob') targets.push(input.pattern);
  const paths = targets.map(str).filter((p) => p.length > 0).map(normalizePath);
  const written = [input.content, input.new_string, input.new_source].map(str).join('\n');

  const envPaths = paths.filter((p) => ENV_FILE.test(p));
  if (envPaths.some((p) => !ENV_EXAMPLE.test(p))) {
    return 'no se leen ni se escriben archivos .env* (solo se exceptúa .env.example)';
  }
  // Glob solo devuelve nombres, como `ls`: se permite. Read y Grep leen el contenido.
  const holdoutTarget = paths.some((p) => HOLDOUT_PATH.test(p)) || (tool === 'Grep' && /holdout/.test(str(input.glob).toLowerCase()));
  if ((tool === 'Read' || tool === 'Grep') && holdoutTarget) {
    return 'el contenido de data/holdout/ y config/holdout.lock no se lee: el test final es intocable';
  }
  if (!FILE_WRITE_TOOLS.has(tool)) return null;

  if (envPaths.length > 0) {
    const withValue = envExampleValues(written);
    if (withValue.length > 0) {
      return `.env.example solo admite nombres sin valor; tienen valor: ${withValue.join(', ')}`;
    }
  }
  if (paths.some((p) => HOLDOUT_PATH.test(p))) {
    return 'data/holdout/ y config/holdout.lock no se editan: el test final es intocable';
  }
  const isSource = paths.some((p) => /(^|\/)src\//.test(p));
  if (isSource && WITHDRAW_CALL.test(written)) return 'el código llama a un endpoint de retiro';
  return null;
}

// Devuelve el motivo del bloqueo, o null si la llamada puede continuar.
export function evaluate(tool: string, input: ToolInput): string | null {
  if (SHELL_TOOLS.has(tool)) return checkCommand(str(input.command));
  if (FILE_TOOLS.has(tool)) return checkFileTool(tool, input);
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function block(reason: string): never {
  process.stderr.write(`BLOQUEADO por scripts/claude-guard.ts: ${reason}. Regla de CLAUDE.md §2.\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let tool: string;
  let input: ToolInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (typeof parsed !== 'object' || parsed === null) throw new Error('la entrada no es un objeto');
    const call = parsed as { tool_name?: unknown; tool_input?: unknown };
    if (typeof call.tool_name !== 'string') throw new Error('falta tool_name');
    tool = call.tool_name;
    input = typeof call.tool_input === 'object' && call.tool_input !== null ? (call.tool_input as ToolInput) : {};
  } catch (e) {
    block(`entrada del hook ilegible (${e instanceof Error ? e.message : String(e)})`);
  }
  const reason = evaluate(tool, input);
  if (reason !== null) block(reason);
}

if (import.meta.main) await main();
