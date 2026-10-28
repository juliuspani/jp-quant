// Archivos que acompañan a la salida de un experimento (paso 41C, ADR 0047): cada uno coincide con su huella en la salida,
// ninguno se sobrescribe y los diarios con datos reales solo van a una carpeta que git ignora.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { contextFromCard } from '../../../src/app/dashboard-command.ts';
import { ArtefactError, controlsText, journalCard, writeControls, writeJournals } from '../../../src/app/experiment-artefacts.ts';
import { parseLuckFile } from '../../../src/app/research-view.ts';
import type { Artefacts, ExperimentSpec } from '../../../src/research/experiment.ts';
import { canonicalJson, sha256Hex } from '../../../src/shared/canonical.ts';

const dir = mkdtempSync(join(tmpdir(), 'artefactos-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const curves = { simulaciones: 3, percentil: 66.67, estrategia: [100, 101, 103], p05: [100, 99, 98], p95: [100, 102, 104], muestras: [[100, 100.5, 99]] };
const journals = ['{"format":"inversor-replay/1"}\n', '{"format":"inversor-replay/1","x":2}\n'];
const artefacts: Artefacts = { controles: curves, diarios: journals.map((texto) => ({ texto, parametros: { entryPeriod: 20, stopAtr: 2 } })) };
const salida = { archivos: { controles: { sha256: sha256Hex(canonicalJson(curves)), motivo: null }, diarios_sha256: journals.map((j) => sha256Hex(j)) } };
const spec: Pick<ExperimentSpec, 'estrategia' | 'costes' | 'datos'> = {
  estrategia: { nombre: 'tendencia-donchian', version: '1.0.0' },
  costes: { comision: '0.0025', spread: '0.00075', slippage: '0.0005', multiplicador: 1 },
  datos: { fuente: 'prueba', dataset: 'prueba', version: '1', timeframe: '1d', rango: { desde: '2020-01-01T00:00:00Z', hasta: '2021-01-01T00:00:00Z' } },
};

test('las curvas del control van en EXP-NNNN.controles.json, en el formato que lee el dashboard, y no se sobrescriben', () => {
  const path = writeControls(dir, 'EXP-0099', salida, artefacts);
  assert.equal(path, join(dir, 'EXP-0099.controles.json'));
  const [entry] = parseLuckFile(readFileSync(join(dir, 'EXP-0099.controles.json'), 'utf8'));
  assert.equal(entry?.experimentId, 'EXP-0099');
  assert.deepEqual(entry?.strategy, curves.estrategia);
  assert.throws(() => writeControls(dir, 'EXP-0099', salida, artefacts), /EEXIST/, 'una salida no se reescribe');
  assert.throws(() => controlsText('EXP-0099', salida, { ...artefacts, controles: { ...curves, percentil: 99 } }), ArtefactError, 'curvas que no son las de su huella');
  assert.equal(writeControls(dir, 'EXP-0098', { archivos: { ...salida.archivos, controles: { sha256: null, motivo: 'simulador' } } }, { ...artefacts, controles: null }), null);
  assert.throws(() => controlsText('EXP-0097', salida, { ...artefacts, controles: null }), ArtefactError, 'la salida esperaba curvas');
  assert.throws(() => controlsText('EXP-0097', {}, artefacts), ArtefactError, 'sin huellas en la salida');
});

test('los diarios, con datos reales, solo en una carpeta que git ignora; con su ficha para el dashboard', () => {
  const ignored = join(dir, 'ignorada');
  const written = writeJournals(ignored, () => true, 'EXP-0099', spec, salida, artefacts);
  assert.deepEqual(written.map((p) => p.slice(ignored.length + 1)), ['EXP-0099.tramo-0.jsonl', 'EXP-0099.tramo-0.ficha.json', 'EXP-0099.tramo-1.jsonl', 'EXP-0099.tramo-1.ficha.json']);
  assert.equal(readFileSync(join(ignored, 'EXP-0099.tramo-1.jsonl'), 'utf8'), journals[1]);
  const context = contextFromCard(readFileSync(join(ignored, 'EXP-0099.tramo-0.ficha.json'), 'utf8'));
  assert.equal(context.synthetic, false, 'datos reales: sin marca de demostración');
  assert.deepEqual(context.strategy.params, { entryPeriod: 20, stopAtr: 2 });
  assert.match(context.label, /solo en local/);
  assert.throws(() => writeJournals(ignored, () => true, 'EXP-0099', spec, salida, artefacts), /EEXIST/, 'no se sobrescribe');
  const versioned = join(dir, 'versionada');
  assert.throws(() => writeJournals(versioned, () => false, 'EXP-0099', spec, salida, artefacts), ArtefactError);
  assert.ok(!existsSync(join(versioned, 'EXP-0099.tramo-0.jsonl')), 'en una carpeta versionada no se escribe nada');
  const tampered: Artefacts = { ...artefacts, diarios: [{ texto: 'otro', parametros: {} }, ...artefacts.diarios.slice(1)] };
  assert.throws(() => writeJournals(join(dir, 'x'), () => true, 'EXP-0100', spec, salida, tampered), ArtefactError, 'un diario que no es el de su huella');
  assert.throws(() => journalCard('EXP-0100', 0, spec, { lista: [1, 2] }), ArtefactError, 'la ficha solo admite texto o números');
});
