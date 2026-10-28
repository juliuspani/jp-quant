// Criterios congelados del paso 27 (ADR 0030): docs/PROMOTION_CRITERIA.md (partes A y C) y docs/PRE_LIVE_GATE.md
// (parte B). Estas pruebas fijan su SHA-256 con finales de línea LF: cualquier cambio de texto las hace fallar. No
// comprueban que alguien aplique los criterios, solo que el texto congelado no cambia sin dejar rastro.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FROZEN_DOCUMENTS } from '../../src/analytics/criteria.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ADR = join(ROOT, 'docs', 'adr', '0030-criterios-congelados.md');

// Cambiar uno de estos valores es cambiar los criterios congelados: parada obligatoria (CLAUDE.md §7), ADR nuevo
// aprobado por la persona y validación reiniciada.
const FROZEN: ReadonlyArray<readonly [string, string]> = [
  ['docs/PROMOTION_CRITERIA.md', '7967cb763d0a773e6e6ccf055afeea332c15c4f6ca883ba17e3304da79db7893'], // cambio de la persona del 2026-10-22 (ADR 0030, decisión 9)
  ['docs/PRE_LIVE_GATE.md', '10d075607b3e051aabe2fe0c0012e09209ba203633623f388a78f4a71d75331c'],
];

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function sha256(path: string): string {
  return createHash('sha256').update(read(path), 'utf8').digest('hex');
}

test('los criterios congelados del paso 27 no han cambiado', () => {
  for (const [file, hash] of FROZEN) {
    assert.equal(
      sha256(join(ROOT, file)),
      hash,
      `${file} cambió: los criterios congelados del paso 27 solo cambian con un ADR aprobado por la persona, y el cambio reinicia la validación`,
    );
  }
});

test('paso 27B: el evaluador de criterios implementa exactamente estos documentos y pone su huella en cada informe', () => {
  assert.deepEqual(FROZEN_DOCUMENTS.map((d) => [d.path, d.sha256]), FROZEN);
});

// PROGRESS.md, que también las recoge, es un registro de trabajo privado: en la copia pública basta con el ADR.
test('el ADR 0030 recoge la huella de cada documento congelado', () => {
  const adr = read(ADR);
  for (const [file, hash] of FROZEN) {
    assert.ok(adr.includes(hash), `el ADR 0030 no recoge el SHA-256 de ${file}`);
  }
});

test('el gate marca cada criterio como crítico o no crítico, sin huecos en la numeración', () => {
  const rows = read(join(ROOT, 'docs', 'PRE_LIVE_GATE.md'))
    .split('\n')
    .filter((line) => line.startsWith('| G-'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.ok(rows.length > 0, 'el gate no tiene criterios');
  rows.forEach((cells, i) => {
    assert.equal(cells[0], `G-${String(i + 1).padStart(2, '0')}`);
    assert.ok(cells.at(-1) === 'C' || cells.at(-1) === 'N', `${cells[0]}: falta marcar si es crítico (C) o no (N)`);
  });
});

test('los criterios de promoción cubren los cuatro estados y las partes A y C', () => {
  const text = read(join(ROOT, 'docs', 'PROMOTION_CRITERIA.md'));
  for (const term of ['## Parte A', '## Parte C', '| RESEARCH |', '| BACKTESTED |', '| VALIDATED |', '| PAPER |']) {
    assert.ok(text.includes(term), `PROMOTION_CRITERIA.md no recoge «${term}»`);
  }
});
