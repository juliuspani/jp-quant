// Exportación de la copia pública (paso 49; decisión de la persona del 2026-10-28, docs/EXPORT_PUBLIC.md). Este repositorio
// privado es la fuente de verdad: juliuspani/jp-quant no se desarrolla directamente, se actualiza en cada versión con este
// script y la lista de docs/EXPORT_PUBLIC.md.
// Lo que hace, con el mismo filtro de seguridad del paso 49:
// - Toma lo confirmado en HEAD (git archive), nunca el árbol de trabajo, sin el registro de trabajo privado (EXCLUDED).
// - Ajusta el texto que en la copia pública habla de lo que no se publica (publicText), endurece los permisos de Claude
//   (publicSettings) y reduce las salidas de los experimentos, que dejaban despejar precios de Kraken (reduceOutput).
// - Sustituye por su versión pública las pruebas que leen archivos privados (export/overlay/). Cada una guarda la huella de
//   la versión privada de la que salió: si esa cambió, la exportación se niega hasta revisar la versión pública.
// - Escribe el resultado en la carpeta de jp-quant, que tiene que ser un repositorio git sin cambios, borrando lo que ya
//   no se exporta. No hace commit ni push: eso, tras los checks de docs/EXPORT_PUBLIC.md.
// Cualquier ancla que falte detiene la exportación: un texto que no se transforma no se publica en silencio.
//
// Uso: node scripts/export-public.ts --destino <carpeta de jp-quant>
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../src/shared/canonical.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** Lo que nunca sale: el registro de trabajo privado, los comandos de sesión, archivos locales y la propia exportación. */
export const EXCLUDED: readonly string[] = [
  'PROGRESS.md', 'docs/progress/', '.claude/commands/', '.claude/launch.json', '.claude/settings.local.json', 'export/',
  'test/scripts/export-public.test.ts', // lee export/, que no se publica
];

export function isExported(path: string): boolean {
  return !EXCLUDED.some((x) => (x.endsWith('/') ? path.startsWith(x) : path === x));
}

export class ExportError extends Error {
  override readonly name = 'ExportError';
}

function replaceOnce(text: string, before: string, after: string, where: string): string {
  if (!text.includes(before)) throw new ExportError(`${where}: no está el ancla «${before.slice(0, 60)}»`);
  return text.replace(before, () => after);
}

const PLAN_MAP_ADRS = [
  'docs/adr/0001-enforcement-automatico.md', 'docs/adr/0002-protocolo-quant-research.md', 'docs/adr/0003-trading-risk.md',
  'docs/adr/0005-exchange-execution.md', 'docs/adr/0007-ccxt-y-exchange-adapter.md', 'docs/adr/0010-regla-de-decisiones-y-nuevo-plan.md',
];
const NOTE_DOCS = ['ARCHITECTURE.md', 'SECURITY_AND_TRADING_INVARIANTS.md', 'STRATEGY_RESEARCH.md'];
const PRIVATE_LOG = '(registro de trabajo privado, no publicado)';
const DOC_NOTE = '\n> **Copia pública (paso 49).** Las menciones a `PROGRESS.md` y `docs/progress/` se refieren al registro de trabajo\n> privado del proyecto, que no se publica. Guía en inglés de la documentación: [docs/README.md](docs/README.md).\n';
const CLAUDE_NOTE = '\n> **Copia pública (paso 49, ADR 0048).** Es la constitución con la que se construyó el proyecto con agentes de IA. `PROGRESS.md`\n> y `docs/progress/` son el registro de trabajo privado de la persona y no se publican: las referencias a ellos en este archivo,\n> los skills y los ADRs se refieren a ese registro. El repositorio público se llama `jp-quant`; los identificadores de\n> formato (`inversor-replay/1` y similares) conservan el nombre anterior porque forman parte de huellas ya registradas.\n';

/** Los archivos de texto que cambian en la copia pública. Los demás salen tal cual. */
export const TRANSFORMED: readonly string[] = ['CLAUDE.md', 'docs/DECISION_POINT.md', ...PLAN_MAP_ADRS, ...NOTE_DOCS, '.claude/settings.json'];

/** El texto público de un archivo transformado; lanza si falta un ancla. */
export function publicText(path: string, text: string): string {
  if (path === 'CLAUDE.md') {
    const start = text.indexOf('# JP Quant');
    if (start < 0) throw new ExportError('CLAUDE.md: falta el título «# JP Quant»');
    const body = text.slice(start); // sin el import de las notas personales ni la regla del segundo cerebro
    const intro = 'aquí solo están las reglas permanentes y dónde encontrar lo demás.\n';
    return replaceOnce(body, intro, intro + CLAUDE_NOTE, path);
  }
  if (PLAN_MAP_ADRS.includes(path)) return replaceOnce(text, '[docs/progress/PLAN_MAP.md](../progress/PLAN_MAP.md)', `\`docs/progress/PLAN_MAP.md\` ${PRIVATE_LOG}`, path);
  if (path === 'docs/DECISION_POINT.md') return replaceOnce(text, '([PLAN_MAP.md](progress/PLAN_MAP.md))', '(`docs/progress/PLAN_MAP.md`, registro de trabajo privado, no publicado)', path);
  if (NOTE_DOCS.includes(path)) {
    const eol = text.indexOf('\n');
    if (!text.startsWith('# ') || eol < 0) throw new ExportError(`${path}: no empieza por un título`);
    return text.slice(0, eol + 1) + DOC_NOTE + text.slice(eol + 1);
  }
  if (path === '.claude/settings.json') return publicSettings(text);
  return text;
}

interface Settings {
  permissions: { defaultMode?: string; allow: string[]; ask: string[] };
}

/** Permisos de Claude para quien abra la copia pública: push y red, siempre preguntando (SEC-03). */
export function publicSettings(text: string): string {
  const settings = JSON.parse(text) as Settings;
  const p = settings.permissions;
  p.defaultMode = 'default';
  p.allow = p.allow.filter((x) => !/git push|^(Bash|PowerShell)\(npm ci( \*)?\)$|^WebFetch$|^WebSearch$/.test(x));
  for (const shell of ['Bash', 'PowerShell']) {
    const at = p.allow.indexOf(`${shell}(npm run *)`);
    if (at < 0) throw new ExportError(`.claude/settings.json: falta «${shell}(npm run *)»`);
    p.allow.splice(at, 0, `${shell}(npm ci --ignore-scripts)`);
  }
  p.ask = ['Bash(git push *)', 'PowerShell(git push *)', ...p.ask.filter((x) => !x.startsWith('Bash(git push *)') && !x.startsWith('PowerShell(git push *)'))];
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** La salida de un experimento sin curvas, operaciones ni series de la rejilla (SEC-02), en su JSON canónico. */
export function reduceOutput(text: string): string {
  const data = JSON.parse(text) as { salida?: Record<string, unknown> };
  const salida = data.salida;
  if (salida === undefined) return text;
  delete salida['series_rejilla'];
  if (Array.isArray(salida['tramos'])) {
    for (const tramo of salida['tramos'] as Record<string, unknown>[]) {
      delete tramo['curva'];
      delete tramo['operaciones'];
    }
  }
  return `${canonicalJson(data)}\n`;
}

const OUTPUT = /^docs\/research\/experiments\/salidas\/EXP-\d{4}\.json$/;

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function git(args: string[], cwd = ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Las pruebas públicas que sustituyen a las privadas, comprobadas contra la huella de su origen en HEAD. */
export function overlays(): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'export', 'overlay.json'), 'utf8')) as Record<string, string>;
  const out = new Map<string, string>();
  for (const [path, expected] of Object.entries(manifest)) {
    const source = execFileSync('git', ['show', `HEAD:${path}`], { cwd: ROOT });
    if (sha256(source) !== expected) throw new ExportError(`${path} cambió desde que se hizo su versión pública: revisa export/overlay/${path}.txt y su huella`);
    out.set(path, readFileSync(join(ROOT, 'export', 'overlay', `${path}.txt`), 'utf8'));
  }
  return out;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path).split('\\').join('/')];
  });
}

function main(): void {
  const { values } = parseArgs({ options: { destino: { type: 'string' } } });
  if (values.destino === undefined) throw new ExportError('falta --destino <carpeta de jp-quant>');
  const target = resolve(values.destino);
  if (git(['status', '--porcelain']).trim() !== '') throw new ExportError('el repositorio privado tiene cambios sin confirmar: se exporta HEAD, confírmalos antes');
  if (git(['status', '--porcelain'], target).trim() !== '') throw new ExportError(`${target} tiene cambios sin confirmar`);
  const replacements = overlays();
  const work = mkdtempSync(join(tmpdir(), 'jp-quant-export-'));
  try {
    const tar = join(work, 'head.tar');
    const tree = join(work, 'tree');
    mkdirSync(tree);
    execFileSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD', '--', '.', ...EXCLUDED.map((x) => `:!${x.replace(/\/$/, '')}`)], { cwd: ROOT });
    // Rutas relativas: el tar de Git para Windows toma «C:» por un servidor remoto.
    const untar = spawnSync('tar', ['-xf', 'head.tar', '-C', 'tree'], { cwd: work });
    if (untar.status !== 0) throw new ExportError(`tar: ${String(untar.stderr)}`);
    const files = walk(tree);
    for (const path of files) {
      if (!isExported(path)) throw new ExportError(`${path} no debería exportarse`);
      const full = join(tree, path);
      if (TRANSFORMED.includes(path)) writeFileSync(full, publicText(path, readFileSync(full, 'utf8')));
      else if (OUTPUT.test(path)) writeFileSync(full, reduceOutput(readFileSync(full, 'utf8')));
      const overlay = replacements.get(path);
      if (overlay !== undefined) writeFileSync(full, overlay);
    }
    for (const path of TRANSFORMED) if (!files.includes(path)) throw new ExportError(`${path} no está en HEAD`);
    // Lo que ya no se exporta desaparece de jp-quant; lo demás se sobrescribe con la versión de HEAD.
    const exported = new Set(files);
    for (const path of git(['ls-files'], target).split('\n').filter((p) => p !== '')) {
      if (!exported.has(path)) rmSync(join(target, path));
    }
    for (const path of files) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      writeFileSync(join(target, path), readFileSync(join(tree, path)));
    }
    process.stdout.write(`export-public: ${String(files.length)} archivos en ${target} desde ${git(['rev-parse', '--short', 'HEAD']).trim()}. Sigue docs/EXPORT_PUBLIC.md (checks, revisión del diff, commit, etiqueta).\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`export-public: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
