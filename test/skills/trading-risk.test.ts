// El skill trading-risk fija las reglas permanentes de riesgo y ejecución (paso 6, ADR 0003). Estas pruebas
// impiden que se rompa su carga, que desaparezca un control, que se desordenen las capas de capital o que
// diverjan el catálogo de reason_code y los umbrales.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKILL_DIR = join(ROOT, '.claude', 'skills', 'trading-risk');
const SKILL = join(SKILL_DIR, 'SKILL.md');
const CHECKLIST = join(SKILL_DIR, 'checklist.md');
const ADR = join(ROOT, 'docs', 'adr', '0003-trading-risk.md');

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

/** Códigos de la tabla de SKILL.md §9.2: filas que empiezan por | `CODIGO` | capa |. */
function catalog(): Map<string, string> {
  const codes = new Map<string, string>();
  for (const [, code, layer] of read(SKILL).matchAll(/^\| `([A-Za-z0-9_]+)` \| (\w+) \|/gm)) {
    assert.ok(code !== undefined && layer !== undefined);
    assert.ok(!codes.has(code), `reason_code duplicado en el catálogo: ${code}`);
    codes.set(code, layer);
  }
  return codes;
}

test('SKILL.md tiene un frontmatter válido para Claude Code', () => {
  const fields = frontmatter(read(SKILL));
  assert.equal(fields.get('name'), 'trading-risk');
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

test('SKILL.md cubre todos los controles y reglas pedidos', () => {
  const text = plain(SKILL);
  const required = [
    'strategy → risk engine → execution',
    'ningún módulo, usuario, llm ni estrategia se salta el risk engine',
    'token de aprobación',
    'firma ed25519',
    'position sizing',
    'risk per trade',
    'maximum exposure',
    'concentration',
    'correlation',
    'liquidity',
    'spread',
    'slippage',
    'daily loss',
    'drawdown',
    'consecutive losses',
    'stale data',
    'exchange health',
    'event risk',
    'circuit breakers',
    'kill switch global',
    'fail closed',
    'kill switch externo',
    'revocar la api key',
    'subcuenta',
    'api sin retiros',
    'whitelist de ip',
    'no comparte código con strategy',
    'reason_code',
    'solo de inserción',
    'stops de protección nativos',
    'la reconciliación conoce los stops nativos',
    'un stop-limit puede no ejecutarse en un gap',
    'mantiene los stops de protección',
    'no vende posiciones',
    'src/risk/signer.ts',
    'docs/incidents/',
  ];
  for (const term of required) assert.ok(text.includes(term), `SKILL.md no menciona «${term}»`);
});

test('el ADR 0003 está aceptado con los umbrales marcados como provisionales', () => {
  const adr = plain(ADR);
  assert.ok(adr.includes('estado: aceptado (umbrales provisionales)'), 'ADR 0003 no está aceptado con umbrales provisionales');
  for (const step of ['paso 35', 'paso 46', 'paso 36', 'paso 39']) {
    assert.ok(adr.includes(step), `ADR 0003 no cita el ${step}`);
  }
  assert.ok(plain(SKILL).includes('los umbrales numéricos son provisionales'), 'SKILL.md no avisa de que los umbrales son provisionales');
});

test('las tres capas de capital van de la más fuerte a la más débil', () => {
  const text = read(SKILL);
  const layers = ['### Capa 1 — Exchange', '### Capa 2 — Capguard', '### Capa 3 — Risk Engine'];
  const positions = layers.map((heading) => text.indexOf(heading));
  for (const [i, heading] of layers.entries()) assert.ok(positions[i]! >= 0, `falta el apartado «${heading}»`);
  assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!, 'las capas están desordenadas');
});

test('el catálogo de reason_code está bien formado y cubre cada control', () => {
  const codes = catalog();
  for (const [code, layer] of codes) {
    assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, `reason_code mal formado: ${code}`);
    assert.ok(['risk', 'execution', 'capguard', 'exchange'].includes(layer), `${code}: capa desconocida ${layer}`);
  }
  const required = [
    'KILL_SWITCH_ACTIVE',
    'CONFIG_INVALID',
    'INTERNAL_ERROR',
    'STATE_UNRECONCILED',
    'DECISION_LOG_UNAVAILABLE',
    'DAILY_LOSS_LIMIT',
    'DRAWDOWN_HALT',
    'LOSS_STREAK_COOLDOWN',
    'STALE_DATA',
    'EXCHANGE_UNHEALTHY',
    'EVENT_RISK',
    'SPREAD_TOO_WIDE',
    'LIQUIDITY_TOO_LOW',
    'SLIPPAGE_TOO_HIGH',
    'STOP_INVALID',
    'RISK_PER_TRADE',
    'MAX_EXPOSURE',
    'CONCENTRATION_LIMIT',
    'CORRELATION_LIMIT',
    'LIVE_TRADING_DISABLED',
    'APPROVAL_MISSING',
    'APPROVAL_BAD_SIGNATURE',
    'APPROVAL_EXPIRED',
    'APPROVAL_REPLAYED',
    'APPROVAL_MISMATCH',
    'CAP_UNAVAILABLE',
    'EXCHANGE_REJECTED',
    'PROTECTIVE_STOP_MISSING',
    'EXEC_STATE_UNKNOWN',
    'EXEC_ORPHAN_ORDER',
    'EXEC_MARKET_RULES',
    'EXEC_RATE_LIMITED',
  ];
  for (const code of required) assert.ok(codes.has(code), `falta el reason_code ${code} en SKILL.md §9.2`);
  // Los códigos propios de Execution llevan el prefijo EXEC_ para distinguirlos de los de Risk (ADR 0005).
  for (const [code, layer] of codes) {
    if (code.startsWith('EXEC_')) assert.equal(layer, 'execution', `${code}: el prefijo EXEC_ exige la capa execution`);
  }
});

test('todo reason_code citado en SKILL.md está en el catálogo', () => {
  const codes = catalog();
  for (const [, code] of read(SKILL).matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) {
    if (code === undefined || code === 'LIVE_TRADING') continue;
    assert.ok(codes.has(code), `SKILL.md cita ${code}, que no está en el catálogo`);
  }
});

test('los umbrales clave coinciden entre SKILL.md y el ADR 0003', () => {
  const skill = plain(SKILL);
  const adr = plain(ADR);
  const thresholds = [
    '≤ 10 s',
    '0,75 % del patrimonio',
    '≤ 75 % del patrimonio',
    '≤ 25 % del patrimonio',
    '≤ 50 % del patrimonio',
    '≤ 5 % del patrimonio',
    'ρ ≥ 0,80',
    '1 % del volumen de 24 h',
    '5 veces el importe',
    '0,15 % en el núcleo',
    '0,40 % en el explorador',
    '0,30 % estimado',
    '3 errores de api consecutivos',
    '5 min sin errores',
    '30 min antes hasta 60 min después',
    '−2 % desde el inicio del día utc',
    'caída del 10 % desde el máximo',
    '3 pérdidas seguidas',
    '≤ 30 % del capital asignado',
    '≤ 80 % del capital asignado',
    '3 % del capital asignado',
    '12 % del capital asignado',
    'menos de 5 min',
  ];
  for (const threshold of thresholds) {
    assert.ok(skill.includes(threshold), `SKILL.md no recoge el umbral «${threshold}»`);
    assert.ok(adr.includes(threshold), `ADR 0003 no recoge el umbral «${threshold}»`);
  }
});

test('el checklist de revisión cubre cada bloque del skill', () => {
  const text = read(CHECKLIST);
  for (const heading of [
    '## Flujo y token',
    '## Stops de protección nativos',
    '## Capas de capital',
    '## Controles del Risk Engine',
    '## Circuit breakers y kill switch',
    '## Kill switch externo',
    '## Fail closed',
    '## reason_code',
  ]) {
    assert.ok(text.includes(heading), `checklist.md no tiene el bloque «${heading}»`);
  }
  assert.ok((text.match(/^- \[ \] /gm) ?? []).length >= 40, 'checklist.md tiene menos casillas de las esperadas');
});
