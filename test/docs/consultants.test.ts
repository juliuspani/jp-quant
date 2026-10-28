// Los consultores de .claude/agents/ son revisores de solo lectura (pasos 11 y 11B, ADR 0009). Estas pruebas
// comprueban el texto de los agentes y de docs/CONSULTANTS.md: que solo existan los cuatro, que no tengan
// shell, herramientas de escritura, red ni subagentes, que su descripción limite el uso a cuando un paso lo
// pide y que las reglas comunes sean idénticas en todos. No pueden comprobar lo que hace un agente al
// ejecutarse.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const AGENTS_DIR = join(ROOT, '.claude', 'agents');
const DOC = join(ROOT, 'docs', 'CONSULTANTS.md');
const ADR = join(ROOT, 'docs', 'adr', '0009-consultores-de-solo-lectura.md');

const CONSULTANTS = ['consultor-quant', 'consultor-execution-risk', 'consultor-security', 'consultor-software'];
const TOOLS = ['Read', 'Grep', 'Glob'];
const DISALLOWED = ['Bash', 'PowerShell', 'Agent', 'Skill', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const START = '<!-- consultores:comun:inicio -->';
const END = '<!-- consultores:comun:fin -->';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function agentPath(name: string): string {
  return join(AGENTS_DIR, `${name}.md`);
}

function frontmatter(text: string, file: string): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${file}: falta el frontmatter`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return fields;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function commonBlock(text: string, file: string): string {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  assert.ok(start >= 0 && end > start, `${file}: faltan las marcas del bloque común`);
  return text.slice(start, end + END.length);
}

test('solo existen los cuatro consultores', () => {
  const files = readdirSync(AGENTS_DIR).sort();
  assert.deepEqual(files, CONSULTANTS.map((name) => `${name}.md`).sort());
});

test('cada consultor tiene nombre, solo herramientas de lectura y las prohibidas fuera', () => {
  for (const name of CONSULTANTS) {
    const fields = frontmatter(read(agentPath(name)), name);
    assert.equal(fields.get('name'), name, `${name}: el campo name debe coincidir con el archivo`);
    assert.deepEqual(list(fields.get('tools')), TOOLS, `${name}: tools debe ser exactamente ${TOOLS.join(', ')}`);
    assert.deepEqual(list(fields.get('disallowedTools')), DISALLOWED, `${name}: disallowedTools incompleto`);
    for (const field of ['permissionMode', 'isolation', 'mcpServers', 'hooks', 'background']) {
      assert.ok(!fields.has(field), `${name}: el campo ${field} no está aprobado (ADR 0009)`);
    }
  }
});

test('la descripción limita el uso a cuando el paso lo pide', () => {
  for (const name of CONSULTANTS) {
    const description = frontmatter(read(agentPath(name)), name).get('description') ?? '';
    assert.match(description, /solo lectura/, `${name}: la descripción debe decir que es de solo lectura`);
    assert.match(
      description,
      /No delegar por iniciativa propia; usar solo cuando el prompt del paso lo pida por su nombre\.$/,
      `${name}: la descripción debe limitar el uso a cuando el paso lo pida`,
    );
    assert.doesNotMatch(description, /proactive/i, `${name}: no puede invitar a delegar por iniciativa propia`);
  }
});

test('las reglas comunes son idénticas en el documento y en los cuatro agentes', () => {
  const reference = commonBlock(read(DOC), 'docs/CONSULTANTS.md');
  for (const name of CONSULTANTS) {
    assert.equal(commonBlock(read(agentPath(name)), name), reference, `${name}: el bloque común difiere del documento`);
  }
});

test('las reglas comunes fijan solo lectura, sin comandos ni subagentes, evidencia, severidades y formato', () => {
  const block = commonBlock(read(DOC), 'docs/CONSULTANTS.md');
  for (const rule of ['Solo lectura.', 'No ejecutas comandos.', 'No lanzas otros agentes', 'Buscas fallos, no justificas el código.', 'Toda afirmación lleva evidencia:']) {
    assert.ok(block.includes(`**${rule}`), `falta la regla «${rule}»`);
  }
  for (const severity of SEVERITIES) {
    assert.match(block, new RegExp(`\\n\\| ${severity} \\| `), `falta la severidad ${severity} en la tabla`);
  }
  assert.ok(block.includes('[Critical|High|Medium|Low]'), 'el formato debe fijar las cuatro severidades');
  let last = -1;
  for (const heading of ['## Resumen', '## Hallazgos', '## Preguntas abiertas', '## Fuera de alcance', '## Límites de la revisión']) {
    const at = block.indexOf(`\n${heading}\n`, last + 1);
    assert.ok(at > last, `el formato debe tener «${heading}» en orden`);
    last = at;
  }
});

test('cada agente cita archivos que existen, y el documento y el ADR 0009 se enlazan', () => {
  for (const name of CONSULTANTS) {
    for (const match of read(agentPath(name)).matchAll(/`((?:\.claude|docs)\/[^`\s]+\.md)`/g)) {
      assert.ok(existsSync(join(ROOT, match[1] ?? '')), `${name}: no existe ${match[1]}`);
    }
  }
  const docText = read(DOC);
  const adrText = read(ADR);
  assert.ok(docText.includes('adr/0009-consultores-de-solo-lectura.md'), 'el documento debe enlazar el ADR 0009');
  assert.ok(adrText.includes('../CONSULTANTS.md'), 'el ADR 0009 debe enlazar el documento');
  for (const [file, text] of [[DOC, docText], [ADR, adrText]] as const) {
    for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] ?? '';
      if (/^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: enlace roto a ${target}`);
    }
  }
});
