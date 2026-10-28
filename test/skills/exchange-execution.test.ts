// El skill exchange-execution fija los estándares de ejecución con el exchange (paso 7, ADR 0005). Estas pruebas
// impiden que se rompa su carga, que desaparezca un estándar o la regla UNKNOWN, que se usen reason_code fuera
// del catálogo de trading-risk o que diverjan los estados y los umbrales con el ADR.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'exchange-execution');
const SKILL = join(SKILL_DIR, 'SKILL.md');
const CHECKLIST = join(SKILL_DIR, 'checklist.md');
const ADR = join(ROOT, 'docs', 'adr', '0005-exchange-execution.md');
const RISK_SKILL = join(ROOT, '.claude', 'skills', 'trading-risk', 'SKILL.md');
const ADR_0003 = join(ROOT, 'docs', 'adr', '0003-trading-risk.md');

const STATES = [
  'PENDING_SEND',
  'SENT',
  'OPEN',
  'PARTIALLY_FILLED',
  'CANCEL_PENDING',
  'FILLED',
  'CANCELED',
  'EXPIRED',
  'REJECTED',
  'NOT_SENT',
  'UNKNOWN',
];
const TERMINAL = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT'];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Texto sin negritas, sin saltos de línea y en minúsculas, para comparar frases sin depender del formato. */
function plain(path: string): string {
  return read(path).replaceAll('**', '').replace(/\s+/g, ' ').toLowerCase();
}

function frontmatter(text: string): Map<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const body = match?.[1];
  assert.ok(body !== undefined, 'SKILL.md debe empezar con un bloque de frontmatter entre ---');
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep > 0) fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  return fields;
}

/** Códigos del catálogo cerrado de trading-risk §9.2 con su capa: filas que empiezan por | `CODIGO` | capa |. */
function riskCatalog(): Map<string, string> {
  const codes = new Map<string, string>();
  for (const [, code, layer] of read(RISK_SKILL).matchAll(/^\| `([A-Za-z0-9_]+)` \| (\w+) \|/gm)) {
    if (code !== undefined && layer !== undefined) codes.set(code, layer);
  }
  return codes;
}

/** Estados de la tabla de SKILL.md §4.1: filas | `ESTADO` | significado | Sí o No |. */
function lifecycle(): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const [, state, terminal] of read(SKILL).matchAll(/^\| `([A-Z_]+)` \| [^|]+ \| (Sí|No) \|$/gm)) {
    assert.ok(state !== undefined && terminal !== undefined);
    assert.ok(!states.has(state), `estado duplicado en §4.1: ${state}`);
    states.set(state, terminal === 'Sí');
  }
  return states;
}

test('SKILL.md tiene un frontmatter válido para Claude Code', () => {
  const fields = frontmatter(read(SKILL));
  assert.equal(fields.get('name'), 'exchange-execution');
  const description = fields.get('description') ?? '';
  assert.ok(description.length > 0, 'falta description');
  assert.ok(description.length <= 1024, `description tiene ${description.length} caracteres; máximo 1024`);
});

test('los enlaces relativos de los archivos del skill apuntan a archivos que existen', () => {
  for (const file of [SKILL, CHECKLIST]) {
    for (const [, target] of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (target === undefined || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${file}: el enlace ${target} no existe`);
    }
  }
});

test('SKILL.md cubre todos los estándares pedidos', () => {
  const text = plain(SKILL);
  const required = [
    'websocket',
    'rest',
    'sequence numbers',
    'gap',
    'reconnection',
    'heartbeat',
    'backoff con jitter',
    'rate limits',
    'client order id',
    'idempotencia',
    'order lifecycle',
    'partial fills',
    'rejects',
    'cancel/replace',
    'timeouts',
    'modo unknown',
    'reconciliation',
    'clock synchronization',
    'dead-man switch',
    'cancel-on-disconnect',
    'crash recovery',
    'precisión decimal',
    'nunca float para precios, cantidades ni balances',
    'el exchange es la fuente de verdad',
    'nunca se reenvía a ciegas',
    'persistir antes de actuar',
    'el arranque empieza en modo unknown',
    'no cancela los stops de protección nativos',
    'salta el kill switch global',
    'el redondeo nunca aumenta el riesgo',
    'nunca `real`',
    'solo-exchange-importa-ccxt',
    'no salen ventas del bot',
    'alerta critical',
    'se bloquean las órdenes nuevas en ese símbolo',
    'decimal.js',
    'envuelta en un tipo propio',
    'paso 14',
    'paso 18',
    'paso 33',
    '`real`, `float` o `double`',
    'única excepción: el stop que falta',
    'bloqueo total',
    'canal autenticado, con un motivo escrito',
    'se decide en el paso 36',
  ];
  for (const term of required) assert.ok(text.includes(term), `SKILL.md no menciona «${term}»`);
});

test('los niveles de alerta son INFO, WARNING y CRITICAL, con los eventos CRITICAL decididos', () => {
  const text = read(SKILL);
  for (const level of ['INFO', 'WARNING', 'CRITICAL']) {
    assert.match(text, new RegExp(`^\\| ${level} \\|`, 'm'), `SKILL.md §20 no define el nivel ${level}`);
  }
  const skill = plain(SKILL);
  for (const event of [
    'entrar en modo unknown;',
    'el kill switch global;',
    'una orden huérfana con el prefijo del bot;',
    'una orden manual detectada',
    'un rechazo del capguard;',
    'un http 418.',
  ]) {
    assert.ok(skill.includes(event), `SKILL.md §20 no incluye «${event}» entre los CRITICAL`);
  }
  assert.ok(plain(ADR).includes('niveles de alerta info, warning y critical'), 'ADR 0005 no recoge los niveles de alerta');
});

test('la regla UNKNOWN está escrita literalmente en el skill y en el ADR', () => {
  const rule = 'ante duda sobre el estado de una orden, el sistema pasa a unknown, deja de enviar órdenes nuevas y reconcilia con el exchange antes de continuar';
  assert.ok(plain(SKILL).includes(rule), 'SKILL.md no recoge la regla UNKNOWN');
  assert.ok(plain(ADR).includes(rule), 'ADR 0005 no recoge la regla UNKNOWN');
});

test('el ciclo de vida tiene exactamente los estados del ADR, con sus terminales', () => {
  const states = lifecycle();
  assert.deepEqual([...states.keys()], STATES, 'los estados de §4.1 no son los esperados');
  for (const [state, terminal] of states) {
    assert.equal(terminal, TERMINAL.includes(state), `${state}: terminal mal marcado`);
  }
  const adr = read(ADR);
  for (const state of STATES) assert.ok(adr.includes(`\`${state}\``), `ADR 0005 no cita el estado ${state}`);
});

test('los códigos propios de Execution están en el catálogo de trading-risk, con prefijo EXEC_ y capa execution', () => {
  const catalog = riskCatalog();
  const adr = read(ADR);
  for (const code of ['EXEC_STATE_UNKNOWN', 'EXEC_ORPHAN_ORDER', 'EXEC_MARKET_RULES', 'EXEC_RATE_LIMITED']) {
    assert.equal(catalog.get(code), 'execution', `${code} no está en trading-risk §9.2 con capa execution`);
    assert.ok(read(SKILL).includes(`\`${code}\``), `SKILL.md no usa ${code}`);
    assert.ok(adr.includes(`\`${code}\``), `ADR 0005 no recoge ${code}`);
  }
});

test('el skill solo usa reason_code del catálogo cerrado de trading-risk', () => {
  const allowed = new Set([...riskCatalog().keys(), ...STATES, 'LIVE_TRADING']);
  for (const file of [SKILL, CHECKLIST]) {
    for (const [, code] of read(file).matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) {
      if (code === undefined) continue;
      assert.ok(allowed.has(code), `${file} cita ${code}, que no está en el catálogo de trading-risk §9.2`);
    }
  }
});

test('el ADR 0005 está aceptado con los parámetros de conectividad marcados como provisionales', () => {
  const adr = plain(ADR);
  const skill = plain(SKILL);
  assert.ok(
    adr.includes('estado: aceptado (parámetros de conectividad provisionales)'),
    'ADR 0005 no está aceptado con parámetros de conectividad provisionales',
  );
  for (const step of ['pasos 32 y 36', 'paso 17', 'paso 14', 'paso 33']) {
    assert.ok(adr.includes(step), `ADR 0005 no cita «${step}»`);
  }
  assert.ok(skill.includes('los parámetros de conectividad son provisionales'), 'SKILL.md no avisa de que los parámetros son provisionales');
  assert.ok(skill.includes('pasos 32 y 36') && skill.includes('paso 17'), 'SKILL.md no dice cuándo se fijan las cifras');
  // Los umbrales de mercado (ADR 0003) y los parámetros de conectividad (ADR 0005) no se confunden.
  for (const [name, text] of [['SKILL.md', skill], ['ADR 0005', adr], ['ADR 0003', plain(ADR_0003)]] as const) {
    assert.ok(text.includes('umbrales de mercado') && text.includes('parámetros de conectividad'), `${name} no distingue los dos términos`);
  }
});

test('los parámetros de conectividad coinciden entre SKILL.md y el ADR 0005', () => {
  const skill = plain(SKILL);
  const adr = plain(ADR);
  const thresholds = [
    'timeout de 10 s por petición',
    'ttl ≤ 5 min',
    'recvwindow + 5 s',
    '2 consultas seguidas',
    'base 1 s y tope 60 s',
    '4 reintentos',
    'estable durante 60 s',
    '≤ 50 % del límite de peso',
    'ningún mensaje en 60 s',
    'antes de 23 h',
    'tarda más de 1 s',
    'desfase de más de 1 s',
    'recvwindow ≤ 5000 ms',
    'al menos cada 10 min',
    '2 ciclos de reconciliación',
    '35 % para el bot y 15 % para el capguard',
  ];
  for (const threshold of thresholds) {
    assert.ok(skill.includes(threshold), `SKILL.md no recoge el parámetro «${threshold}»`);
    assert.ok(adr.includes(threshold), `ADR 0005 no recoge el parámetro «${threshold}»`);
  }
});

test('el checklist de aprobación cubre cada bloque del skill', () => {
  const text = read(CHECKLIST);
  for (const heading of [
    '## Estado UNKNOWN',
    '## Ciclo de vida de las órdenes',
    '## Client order IDs e idempotencia',
    '## Ejecuciones parciales y rechazos',
    '## Cancel/replace y timeouts',
    '## REST, backoff y rate limits',
    '## WebSockets',
    '## Reloj',
    '## Reconciliación',
    '## Dead-man switch y crash recovery',
    '## Precisión decimal',
    '## Niveles de alerta',
  ]) {
    assert.ok(text.includes(heading), `checklist.md no tiene el bloque «${heading}»`);
  }
  assert.ok((text.match(/^- \[ \] /gm) ?? []).length >= 50, 'checklist.md tiene menos casillas de las esperadas');
});
