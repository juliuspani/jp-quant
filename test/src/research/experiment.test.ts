// Ejecución de experimentos (ADR 0024): qué se guarda de cada ejecución, que toda ejecución queda registrada (también
// las fallidas o descartadas), que un árbol sucio aborta, y que cualquier experimento se reproduce exactamente desde
// su id. Datos sintéticos y registro temporal: nada de esto va al registro real.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discardExperiment, DirtyWorkingTreeError, ExperimentError, FAMILY_SHARPE, familyEvidence, invalidateExperiment, OUTPUTS_DIR,
  readOutput, registryTrials, reproduceExperiment, ReproductionError, runExperiment, writeOutput, type Runner,
} from '../../../src/research/experiment.ts';
import { gitRepo } from '../../../src/research/git.ts';
import { close, EXPERIMENTS_DIR, readRegistry, register, REGISTRY_FILE, trialsInFamily } from '../../../src/research/registry.ts';
import { canonicalJson, sha256Hex } from '../../../src/shared/canonical.ts';
import { COMMIT, context, DATA_HASH, FakeDatasets, fakeGit, REF, registration, spec, tempRegistry, tempRepo, toyRunner } from './helpers.ts';

test('cada ejecución guarda versión, commit, datos y hash, universo, parámetros, semilla, costes, fechas, particiones, métricas y hash de la salida', async () => {
  const path = tempRegistry();
  const datasets = new FakeDatasets();
  const { registered, closed } = await runExperiment(context(path, fakeGit(), datasets), spec());
  assert.equal(registered.id, 'EXP-0001');
  assert.deepEqual(registered.estrategia, { nombre: 'juguete', version: '1.0.0' });
  assert.equal(registered.commit, COMMIT);
  assert.deepEqual(registered.datos, { ...REF, hash: DATA_HASH });
  assert.deepEqual(registered.universo, { regla: 'fija', simbolos: ['BTC/EUR'] });
  assert.deepEqual(registered.parametros, { tipo: 'valores', valores: { k: 2 } });
  assert.equal(registered.semilla, 42);
  assert.deepEqual(registered.costes, { comision: '0.001', spread: '0.0002', slippage: '0.0005', multiplicador: 1 });
  assert.deepEqual(registered.particiones?.tramos[0]?.train, { desde: '2020-01-01T00:00:00Z', hasta: '2022-01-01T00:00:00Z' });
  assert.equal(registered.particiones?.test, null, 'el test final no se abre');
  assert.equal(closed.estado, 'completado');
  assert.match(registered.fecha, /^2026-10-13T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(closed.fecha > registered.fecha, 'el cierre lleva su propia fecha, posterior');
  // El hash de la salida se puede recalcular de forma independiente con el mismo ejecutor.
  const input = { ...spec(), datos: registered.datos, particiones: spec().particiones, pruebas_familia: { n: 1 }, data: datasets.data };
  const output = await toyRunner(input);
  assert.deepEqual(closed.resultado?.metricas, output.metricas);
  assert.equal(closed.resultado?.hash_salida, sha256Hex(canonicalJson({ metricas: output.metricas, salida: output.salida })));
  assert.equal(closed.resultado?.veredicto, null);
});

test('árbol con cambios sin confirmar: se aborta sin escribir; los del propio registro sí se admiten', async () => {
  const path = tempRegistry();
  const git = fakeGit();
  const datasets = new FakeDatasets();
  git.dirty = ['src/research/experiment.ts'];
  await assert.rejects(runExperiment(context(path, git, datasets), spec()), DirtyWorkingTreeError);
  git.dirty = ['notas.txt'];
  await assert.rejects(runExperiment(context(path, git, datasets), spec()), DirtyWorkingTreeError, 'también un archivo nuevo');
  assert.ok(!existsSync(path), 'nada registrado');
  assert.equal(datasets.loads, 0, 'ni se cargaron los datos');
  git.dirty = [REGISTRY_FILE, 'docs/research/experiments/EXP-0001.md'];
  await runExperiment(context(path, git, datasets), spec());
  assert.equal(readRegistry(path).experiments.size, 1);
});

test('sin ejecutor, con un dataset que no existe o con campos inválidos no se mira nada: se aborta sin escribir', async () => {
  const path = tempRegistry();
  const datasets = new FakeDatasets();
  await assert.rejects(runExperiment(context(path, fakeGit(), datasets), spec({ estrategia: { nombre: 'otra', version: '1.0.0' } })), ExperimentError);
  datasets.hash = () => {
    throw new Error('dataset inexistente');
  };
  await assert.rejects(runExperiment(context(path, fakeGit(), datasets), spec()), /inexistente/);
  await assert.rejects(runExperiment(context(path, fakeGit(), new FakeDatasets()), spec({ costes: { comision: '0', spread: '0', slippage: '0', multiplicador: 1 } })), /comisión/);
  assert.ok(!existsSync(path));
});

test('toda ejecución queda registrada: si falla, se cierra como «fallido» y cuenta en N', async () => {
  const path = tempRegistry();
  const broken: Runner = () => Promise.reject(new Error('división por cero'));
  await assert.rejects(runExperiment(context(path, fakeGit(), new FakeDatasets(), broken), spec()), /división por cero/);
  const datasets = new FakeDatasets();
  datasets.loadHash = 'f'.repeat(64); // el contenido ya no es el del manifiesto
  await assert.rejects(runExperiment(context(path, fakeGit(), datasets), spec({ familia_nueva: false })), /no coinciden con el hash/);
  const registry = readRegistry(path);
  assert.deepEqual([...registry.experiments.values()].map((e) => e.closings.map((c) => c.estado)), [['fallido'], ['fallido']]);
  assert.match(registry.experiments.get('EXP-0001')?.closings[0]?.notas ?? '', /Error: división por cero/);
  assert.equal(trialsInFamily(registry, 'juguete'), 2);
});

test('descartar e invalidar añaden una línea y la prueba sigue contando', async () => {
  const path = tempRegistry();
  const ctx = context(path, fakeGit(), new FakeDatasets());
  await runExperiment(ctx, spec());
  invalidateExperiment(ctx, 'EXP-0001', 'prueba', 'error en el cálculo de costes');
  const registry = readRegistry(path);
  assert.deepEqual(registry.experiments.get('EXP-0001')?.closings.map((c) => c.estado), ['completado', 'invalidado']);
  assert.throws(() => discardExperiment(ctx, 'EXP-0001', 'prueba', 'tarde'), /no se pasa/);
  assert.equal(trialsInFamily(readRegistry(path), 'juguete'), 1);
});

test('reproducción exacta desde el id: mismas métricas y mismo hash de salida, sin escribir en el registro', async () => {
  const path = tempRegistry();
  const git = fakeGit();
  await runExperiment(context(path, git, new FakeDatasets()), spec());
  await runExperiment(context(path, git, new FakeDatasets()), spec({ familia_nueva: false, semilla: 7, parametros: { tipo: 'valores', valores: { k: 3 } } }));
  const before = readFileSync(path, 'utf8');
  const recorded = readRegistry(path);
  for (const id of ['EXP-0001', 'EXP-0002']) {
    // Contexto nuevo: solo el id, el registro, el mismo código y los mismos datos.
    const again = await reproduceExperiment(context(path, git, new FakeDatasets()), id);
    const closed = recorded.experiments.get(id)?.closings[0]?.resultado;
    assert.equal(again.hash_salida, closed?.hash_salida, id);
    assert.deepEqual(again.metricas, closed?.metricas, id);
  }
  const [a, b] = ['EXP-0001', 'EXP-0002'].map((id) => recorded.experiments.get(id)?.closings[0]?.resultado?.hash_salida);
  assert.notEqual(a, b, 'semilla y parámetros distintos dan otra salida');
  assert.equal(readFileSync(path, 'utf8'), before);
  git.changed = ['docs/research/experiments/registry.jsonl', 'PROGRESS.md'];
  await reproduceExperiment(context(path, git, new FakeDatasets()), 'EXP-0001'); // cambios de documentación: mismo código
});

test('la reproducción detecta cualquier diferencia: código, datos, árbol sucio o un ejecutor no determinista', async () => {
  const path = tempRegistry();
  const git = fakeGit();
  await runExperiment(context(path, git, new FakeDatasets()), spec());
  const reproduce = (ctx = context(path, git, new FakeDatasets())): Promise<unknown> => reproduceExperiment(ctx, 'EXP-0001');
  git.changed = ['src/strategy/trend.ts'];
  await assert.rejects(reproduce(), /el código cambió/);
  git.changed = ['package-lock.json'];
  await assert.rejects(reproduce(), /el código cambió/, 'las dependencias también son código');
  git.changed = [];
  git.dirty = ['src/a.ts'];
  await assert.rejects(reproduce(), DirtyWorkingTreeError);
  git.dirty = [];
  const otherManifest = new FakeDatasets();
  otherManifest.hashValue = 'c'.repeat(64);
  await assert.rejects(reproduce(context(path, git, otherManifest)), /el dataset cambió/);
  const otherContent = new FakeDatasets();
  otherContent.data = ['100', '200'];
  await assert.rejects(reproduce(context(path, git, otherContent)), /la salida no coincide/, 'mismo hash declarado, otros datos');
  let calls = 0;
  const unstable: Runner = async (input) => ({ ...(await toyRunner(input)), salida: { llamada: calls++ } });
  await assert.rejects(reproduce(context(path, git, new FakeDatasets(), unstable)), /la salida no coincide/);
  await assert.rejects(reproduceExperiment(context(path, git, new FakeDatasets()), 'EXP-0099'), ReproductionError);
  await assert.doesNotReject(reproduce());
});

test('solo se reproduce lo completado con este protocolo', async () => {
  const path = tempRegistry();
  const broken: Runner = () => Promise.reject(new Error('roto'));
  await assert.rejects(runExperiment(context(path, fakeGit(), new FakeDatasets(), broken), spec()));
  await assert.rejects(reproduceExperiment(context(path, fakeGit(), new FakeDatasets()), 'EXP-0001'), /solo se reproduce un experimento completado/);
});

test('con git real: el árbol sucio aborta, el registro se confirma y el experimento se reproduce hasta que cambia el código', async () => {
  const repo = tempRepo();
  mkdirSync(join(repo.dir, 'src'));
  writeFileSync(join(repo.dir, 'src', 'estrategia.ts'), 'export const v = 1;\n');
  writeFileSync(join(repo.dir, 'README.md'), 'r\n');
  repo.commit('código');
  const path = join(repo.dir, ...REGISTRY_FILE.split('/'));
  const ctx = context(path, gitRepo(repo.dir), new FakeDatasets());
  writeFileSync(join(repo.dir, 'src', 'sin-confirmar.ts'), 'x\n');
  await assert.rejects(runExperiment(ctx, spec()), DirtyWorkingTreeError);
  assert.ok(!existsSync(path));
  repo.git('clean', '-q', '-f');
  const { registered } = await runExperiment(ctx, spec());
  assert.equal(registered.commit, repo.git('rev-parse', 'HEAD'));
  await runExperiment(ctx, spec({ familia_nueva: false, semilla: 9 })); // con el registro aún sin confirmar
  repo.commit('registro');
  writeFileSync(join(repo.dir, 'README.md'), 'r2\n');
  repo.commit('documentación');
  for (const id of ['EXP-0001', 'EXP-0002']) await reproduceExperiment(context(path, gitRepo(repo.dir), new FakeDatasets()), id);
  writeFileSync(join(repo.dir, 'src', 'estrategia.ts'), 'export const v = 2;\n');
  repo.commit('cambio de código');
  await assert.rejects(reproduceExperiment(context(path, gitRepo(repo.dir), new FakeDatasets()), 'EXP-0001'), /el código cambió desde .*src\/estrategia\.ts/);
});

test('ADR 0039: la N de todo el registro cuenta todas las líneas de pre-registro, de todas las familias y sin orden', () => {
  const path = tempRegistry();
  const fecha = '2026-10-13T00:00:01.000Z'; // la de registration(): las fechas no retroceden
  const result = (sharpe: number) => ({ metricas: { [FAMILY_SHARPE]: sharpe }, hash_salida: 'e'.repeat(64), veredicto: null });
  register(path, registration({ familia: 'a', n_pruebas: 3, variantes: 2 })); // EXP-0001
  close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'completado', resultado: result(0.1), notas: null });
  register(path, registration({ familia: 'b', datos: { ...registration().datos, timeframe: '1h' } })); // EXP-0002, otro timeframe
  close(path, { id: 'EXP-0002', fecha, autor: 'p', estado: 'completado', resultado: result(0.5), notas: null });
  register(path, registration({ familia: 'c', n_pruebas: 4, variantes: 3 })); // EXP-0003, fallido: cuenta en N
  close(path, { id: 'EXP-0003', fecha, autor: 'p', estado: 'fallido', resultado: null, notas: 'x' });
  const line = register(path, registration({ familia: 'a', familia_nueva: false })); // EXP-0004
  register(path, registration({ familia: 'd' })); // EXP-0005, posterior: también cuenta al decidir
  close(path, { id: 'EXP-0005', fecha, autor: 'p', estado: 'completado', resultado: result(0.9), notas: null });
  const registry = readRegistry(path);
  assert.equal(registryTrials(registry), 3 + 1 + 4 + 1 + 1, 'también las fallidas y las posteriores');
  assert.deepEqual(familyEvidence(line), { n: 4 });
});

test('paso 27B: la salida completa se guarda solo si coincide con el hash del cierre, no se reescribe y se lee comprobándola', async () => {
  const path = tempRegistry();
  const { closed, salida } = await runExperiment(context(path, fakeGit(), new FakeDatasets()), spec());
  const resultado = closed.resultado;
  assert.ok(resultado !== null);
  const file = join(path, '..', OUTPUTS_DIR.replace(EXPERIMENTS_DIR, ''), `${closed.id}.json`);
  assert.throws(() => writeOutput(file, resultado, { otra: 'salida' }), ExperimentError);
  assert.equal(existsSync(file), false);
  writeOutput(file, resultado, salida);
  assert.deepEqual(readOutput(file, resultado), salida);
  assert.throws(() => writeOutput(file, resultado, salida), ExperimentError, 'una salida no se reescribe');
  writeFileSync(file, readFileSync(file, 'utf8').replace('rendimientos', 'rendimientoz'));
  assert.throws(() => readOutput(file, resultado), ExperimentError, 'editada a mano');
});
