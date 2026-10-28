// Comprobación hacia delante de A (ADR 0043), congelada en el paso 31. Estas pruebas fijan el SHA-256 (finales LF) del
// ADR y de la especificación de EXP-0027, comprueban que las salidas guardadas de EXP-0027 y EXP-0029 son las de su
// cierre, recalculan los umbrales que el ADR fija y fijan la configuración que EXP-0029 eligió en train. No comprueban que
// alguien ejecute la comprobación, solo que lo congelado no cambia sin dejar rastro.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { forwardReference, poissonCentralInterval } from '../../src/analytics/forward-reference.ts';
import { seededRng } from '../../src/kernel/random.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ADR = 'docs/adr/0043-comprobacion-hacia-delante-de-a.md';
const SPEC = 'docs/research/experiments/specs/tendencia-donchian-1.0.0-rejilla-repeticion.json';
const OUTPUT = 'docs/research/experiments/salidas/EXP-0027.json';
const SELECTION = 'docs/research/experiments/salidas/EXP-0029.json';

// Cambiar uno de estos valores es cambiar la comprobación congelada: parada obligatoria (CLAUDE.md §7).
const FROZEN: ReadonlyArray<readonly [string, string]> = [
  [ADR, '49e369f1699059ca684e41c81dcd29e83fb02fd6d713e6b71b563df83acc0f03'], // con la elección de EXP-0029 (aprobación del paso 31)
  [SPEC, 'c38555d167ddd3d4f29d2ea4f8524524531cde6109fcaeee549af927c5edc3fa'],
];
const OUTPUT_HASH = '35938e022e32db6d3027d61cca700671bebcfab924a795f129b7c3c45e2b6edc'; // hash_salida del cierre de EXP-0027
// La copia pública (paso 49, SEC-02; decisión de la persona) publica la salida de EXP-0027 reducida, sin las curvas, las
// operaciones ni las series de la rejilla, que dejaban despejar precios de Kraken. Lo que estas pruebas usan
// (serie_configuracion y seleccion) es idéntico al de la salida del cierre, cuyo hash se conserva arriba como dato del ADR.
const PUBLIC_OUTPUT_HASH = '0f8f78a6eef6d934f7bbe9125e4d9ee7fbd9fdcdb001933137050ee1a9e979cf';
const SELECTION_HASH = '3a0c4b8c6ee9a38b56e8d070bad74b00b2a0d88303d07c674850086172373994'; // hash_salida del cierre de EXP-0029
const RETURN_P5 = -0.040646985916777886;
const DRAWDOWN_P95 = 0.2048147691511416;
// Lo que eligió EXP-0029 en el train del tramo hacia delante (ADR 0043 §1): el punto 2 de la rejilla, 55/10.
const CHOSEN = { atrPeriod: 20, entryPeriod: 55, exitPeriod: 10, stopAtr: 2 };
const TRAIN_SHARPES = [0.7517057119240543, 0.6356193930225108, 0.9771816110020467, 0.7138779960989727];

interface SavedSelection {
  readonly configuraciones: readonly Record<string, unknown>[];
  readonly tramos: readonly { readonly train_desde: string; readonly train_hasta: string; readonly embargos: readonly unknown[]; readonly sharpe_train: readonly (number | null)[]; readonly elegida: number }[];
}

/** La salida guardada de un cierre, comprobada contra su hash_salida (el archivo es su JSON canónico con un salto final). */
function savedSelection(path: string, hash: string): SavedSelection {
  const text = read(path).replace(/\n$/, '');
  assert.equal(sha256(text), hash, `${path} no es la salida de su cierre`);
  return (JSON.parse(text) as { salida: { seleccion: SavedSelection } }).salida.seleccion;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Como lo escribe el ADR: coma decimal y signo menos tipográfico. */
function decimal(value: number): string {
  return String(value).replace('.', ',').replace('-', '−');
}

test('la comprobación hacia delante de A y la especificación de EXP-0027 no han cambiado', () => {
  for (const [file, hash] of FROZEN) {
    assert.equal(sha256(read(file)), hash, `${file} cambió: la comprobación hacia delante de A está congelada (ADR 0043) y cambiarla es una parada obligatoria`);
  }
});

test('F.1 y F.2: los umbrales salen de la salida guardada de EXP-0027 con el procedimiento del ADR', () => {
  const text = read(OUTPUT).replace(/\n$/, '');
  assert.equal(sha256(text), PUBLIC_OUTPUT_HASH, 'la salida pública de EXP-0027 no es la reducida de su cierre');
  const output = JSON.parse(text) as { salida: { serie_configuracion: { rendimientos: number[] } } };
  const returns = output.salida.serie_configuracion.rendimientos;
  assert.equal(returns.length, 3559);
  const reference = forwardReference(returns, { length: 365, meanBlock: 28, resamples: 10_000, rng: seededRng(28, 'referencia-hacia-delante') });
  assert.equal(reference.returnP5, RETURN_P5);
  assert.equal(reference.drawdownP95, DRAWDOWN_P95);
});

test('F.3: el intervalo sale de la tasa de EXP-0027, 79 operaciones cerradas en 3559 días', () => {
  assert.deepEqual(poissonCentralInterval((79 * 365) / 3559), { lower: 3, upper: 14 });
});

test('EXP-0029 repite la elección de los 10 tramos de EXP-0027 y elige 55/10 en el train del tramo hacia delante', () => {
  const base = savedSelection(OUTPUT, PUBLIC_OUTPUT_HASH);
  const selection = savedSelection(SELECTION, SELECTION_HASH);
  assert.deepEqual(selection.configuraciones, base.configuraciones);
  assert.deepEqual(selection.tramos.slice(0, 10), base.tramos, 'mismo código y mismos datos que EXP-0027');
  const forward = selection.tramos[10] ?? assert.fail('falta el tramo hacia delante');
  assert.equal(selection.tramos.length, 11);
  assert.deepEqual([forward.train_desde, forward.train_hasta], ['2023-10-01T00:00:00.000Z', '2026-08-07T00:00:00.000Z']);
  assert.equal(forward.embargos.length, 3, 'tras las validaciones de 2023, 2024 y 2025');
  assert.deepEqual(forward.sharpe_train, TRAIN_SHARPES);
  assert.deepEqual(selection.configuraciones[forward.elegida], CHOSEN);
});

test('la salida pública de EXP-0027 no lleva curvas, operaciones ni series de la rejilla', () => {
  const salida = (JSON.parse(read(OUTPUT)) as { salida: Record<string, unknown> & { tramos: readonly Record<string, unknown>[] } }).salida;
  assert.ok(!('series_rejilla' in salida));
  assert.ok(salida.tramos.every((t) => !('curva' in t) && !('operaciones' in t)));
});

test('el ADR recoge la base, los umbrales y la elección que estas pruebas comprueban', () => {
  const adr = read(ADR);
  for (const term of [
    decimal(RETURN_P5), decimal(DRAWDOWN_P95), 'entre 3 y 14', OUTPUT_HASH, SELECTION_HASH, FROZEN[1]?.[1] ?? '', '3ad406b966200e436184dd5b98f1952e06948940',
    '`referencia-hacia-delante`', '**Elegida: `entryPeriod` 55, `exitPeriod` 10, `atrPeriod` 20 y `stopAtr` 2**', ...TRAIN_SHARPES.map(decimal),
  ]) {
    assert.ok(term !== '' && adr.includes(term), `el ADR 0043 no recoge «${term}»`);
  }
});
