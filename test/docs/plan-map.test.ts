// Regla de decisiones (modo autónomo, paso 12B, ADR 0011) y renumeración del plan (paso 12, ADR 0010).
// Comprueban el texto de CLAUDE.md §7 y de los ADRs, y que ningún documento vivo cite un paso que ya no existe. La tabla de
// la renumeración (docs/progress/PLAN_MAP.md) es un registro de trabajo privado: no se publica ni se comprueba aquí.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLAUDE = join(ROOT, 'CLAUDE.md');
const ADR_DIR = join(ROOT, 'docs', 'adr');

// Pasos que la persona añadió en el paso 31 (2026-10-22), sin correspondencia en la numeración anterior: los del plan B
// (el 41B y del 49 al 52) y el 53, el trabajo previo de la comprobación hacia delante de A (ADR 0043).
const LAST_PLANNED_STEP = 53;

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  assert.ok(start >= 0, `falta la sección «${heading}»`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

// §7 en modo autónomo (paso 12B, ADR 0011): sustituye la regla de preguntas del ADR 0010.
test('CLAUDE.md §7 fija el modo autónomo y sus paradas obligatorias', () => {
  const text = read(CLAUDE);
  const rule = section(text, '7. Qué decido yo y qué decide el humano');
  for (const term of [
    '**MODO AUTÓNOMO.**',
    'opción más segura, conservadora y',
    '«Decisiones tomadas por Claude»',
    'siempre el valor más restrictivo razonable',
    'licencia permisiva (MIT, Apache-2.0, BSD,',
    'al menos 7 días publicada, sin scripts de instalación',
    '**Paradas obligatorias**',
    'contratar o pagar cualquier servicio',
    'desbloquear el test final',
    'activar dinero real, transmitir órdenes reales o mover fondos',
    'criterios congelados del paso 27',
    'cualquier acción irreversible fuera del repositorio',
    'compromisos asignados a ese paso',
  ]) {
    assert.ok(rule.includes(term), `CLAUDE.md §7 no recoge «${term}»`);
  }
});

test('el ADR 0010 está aceptado y cada ADR renumerado lleva su corrección editorial', () => {
  const adr0010 = read(join(ADR_DIR, '0010-regla-de-decisiones-y-nuevo-plan.md'));
  assert.match(adr0010, /Estado: aceptado/);
  for (const file of [
    '0001-enforcement-automatico.md',
    '0002-protocolo-quant-research.md',
    '0003-trading-risk.md',
    '0005-exchange-execution.md',
    '0007-ccxt-y-exchange-adapter.md',
  ]) {
    const editorial = section(read(join(ADR_DIR, file)), 'Corrección editorial (2026-10-05)').replace(/\s+/g, ' ');
    assert.ok(editorial.includes('PLAN_MAP.md') && editorial.includes('no cambia ninguna decisión'), `${file}: corrección editorial incompleta`);
  }
});

test('ningún documento vivo cita un paso que no existe: después del 48, solo los que añadió la persona en el paso 31', () => {
  const files = [join(ROOT, 'CLAUDE.md')];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push(path);
    }
  };
  for (const dir of [join(ROOT, '.claude'), ADR_DIR, join(ROOT, 'docs', 'research')]) walk(dir);
  for (const entry of readdirSync(join(ROOT, 'docs'))) if (entry.endsWith('.md')) files.push(join(ROOT, 'docs', entry));
  for (const file of files) {
    for (const match of read(file).matchAll(/\bpasos?\s+((?:\d+[A-C]?(?:,\s*|\s+[ye]\s+)?)+)/gi)) {
      for (const step of (match[1] ?? '').match(/\d+/g) ?? []) {
        assert.ok(Number(step) <= LAST_PLANNED_STEP, `${relative(ROOT, file)} cita el paso ${step}, que no existe`);
      }
    }
  }
});
