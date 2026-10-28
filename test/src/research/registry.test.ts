// Registro de experimentos (ADR 0024): solo inserción con cadena de hashes, ciclo de vida, campos obligatorios y la
// cuenta de pruebas por familia que usará el Deflated Sharpe.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  close, GENESIS, gridPoints, gridSize, parseRegistry, readRegistry, register, RegistryError, trialsByFamily, trialsInFamily,
} from '../../../src/research/registry.ts';
import type { NewRegistration } from '../../../src/research/registry.ts';
import { canonicalJson, sha256Hex } from '../../../src/shared/canonical.ts';
import { registration, tempRegistry } from './helpers.ts';

const RESULT = { metricas: { media: 0.1 }, hash_salida: 'e'.repeat(64), veredicto: null };
const fecha = '2026-10-13T00:00:01.000Z';

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

test('pre-registro y cierre: id correlativo, cadena de hashes y JSON canónico', () => {
  const path = tempRegistry();
  const first = register(path, registration());
  assert.equal(first.id, 'EXP-0001');
  assert.equal(first.anterior, GENESIS);
  assert.equal(first.n_familia, 1);
  const closed = close(path, { id: 'EXP-0001', fecha, autor: 'prueba', estado: 'completado', resultado: RESULT, notas: null });
  const [l1 = '', l2 = ''] = lines(path);
  assert.equal(closed.anterior, sha256Hex(l1));
  assert.equal(closed.referencia, sha256Hex(l1));
  assert.equal(closed.familia, 'juguete', 'el cierre copia la familia del registro');
  assert.equal(canonicalJson(JSON.parse(l2)), l2);
  const second = register(path, registration({ familia_nueva: false, n_pruebas: 6, parametros: { tipo: 'rejilla', rejilla: { a: [1, 2, 3], b: ['x', 'y'] } } }));
  assert.equal(second.id, 'EXP-0002');
  assert.equal(second.n_familia, 7, 'n_familia cuenta las pruebas de la rejilla');
  assert.equal(readRegistry(path).experiments.size, 2);
  assert.ok(!existsSync(`${path}.lock`), 'el candado se suelta');
});

test('la cuenta por familia es la N del Deflated Sharpe: cuenta lo abierto, fallido, abortado e invalidado', () => {
  const path = tempRegistry();
  register(path, registration()); // EXP-0001, queda abierto
  register(path, registration({ familia_nueva: false })); // EXP-0002
  close(path, { id: 'EXP-0002', fecha, autor: 'p', estado: 'fallido', resultado: null, notas: 'lanzó' });
  register(path, registration({ familia_nueva: false, n_pruebas: 3, parametros: { tipo: 'rejilla', rejilla: { a: [1, 2, 3] } } })); // EXP-0003
  close(path, { id: 'EXP-0003', fecha, autor: 'p', estado: 'abortado', resultado: null, notas: 'descartado' });
  register(path, registration({ familia: 'otra', familia_nueva: true })); // EXP-0004
  close(path, { id: 'EXP-0004', fecha, autor: 'p', estado: 'completado', resultado: RESULT, notas: null });
  close(path, { id: 'EXP-0004', fecha, autor: 'p', estado: 'invalidado', resultado: null, notas: 'error en el código' });
  const registry = readRegistry(path);
  assert.deepEqual(Object.fromEntries(trialsByFamily(registry)), { juguete: 5, otra: 1 });
  assert.equal(trialsInFamily(registry, 'juguete'), 5);
  assert.equal(trialsInFamily(registry, 'no-existe'), 0);
});

test('solo inserción: editar, borrar, reordenar o cortar una línea invalida el registro entero', () => {
  const path = tempRegistry();
  register(path, registration());
  close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'completado', resultado: RESULT, notas: null });
  register(path, registration({ familia_nueva: false }));
  const original = readFileSync(path, 'utf8');
  const [a = '', b = '', c = ''] = lines(path);
  const edited = original.replace('"media":0.1', '"media":0.2');
  assert.notEqual(edited, original);
  assert.throws(() => parseRegistry(edited), /cadena de hashes|no cuadra/, 'una métrica cambiada');
  assert.throws(() => parseRegistry(`${a}\n${c}\n`), RegistryError, 'una línea borrada');
  assert.throws(() => parseRegistry(`${b}\n${a}\n${c}\n`), RegistryError, 'líneas reordenadas');
  assert.throws(() => parseRegistry(original.slice(0, -10)), /salto de línea|no es JSON/, 'escritura cortada');
  const spaced = JSON.stringify(JSON.parse(a), null, 1).replaceAll('\n', '');
  assert.throws(() => parseRegistry(`${spaced}\n`), /canónico/, 'misma información, otro texto');
  assert.doesNotThrow(() => parseRegistry(original));
});

test('una línea que no cumple las reglas no se escribe: el archivo queda igual', () => {
  const path = tempRegistry();
  register(path, registration());
  const before = readFileSync(path, 'utf8');
  const rejected: [string, () => unknown][] = [
    ['sin commit', () => register(path, registration({ familia_nueva: false, commit: null }))],
    ['sin hash de datos', () => register(path, registration({ familia_nueva: false, datos: { ...registration().datos, hash: null } }))],
    ['sin semilla', () => register(path, registration({ familia_nueva: false, semilla: null }))],
    ['universo vacío', () => register(path, registration({ familia_nueva: false, universo: { regla: 'ninguna', simbolos: [] } }))],
    ['semilla fuera de rango', () => register(path, registration({ familia_nueva: false, semilla: -1 }))],
    ['sin costes', () => register(path, registration({ familia_nueva: false, costes: null }))],
    ['comisión baja', () => register(path, registration({ familia_nueva: false, costes: { comision: '0.0009', spread: '0', slippage: '0.0005', multiplicador: 1 } }))],
    ['slippage bajo', () => register(path, registration({ familia_nueva: false, costes: { comision: '0.001', spread: '0', slippage: '0.0001', multiplicador: 1 } }))],
    ['n_pruebas ≠ rejilla', () => register(path, registration({ familia_nueva: false, n_pruebas: 2, parametros: { tipo: 'rejilla', rejilla: { a: [1, 2, 3] } } }))],
    ['familia nueva que ya existe', () => register(path, registration())],
    ['familia que no existe', () => register(path, registration({ familia: 'errata', familia_nueva: false }))],
    ['tramo desordenado', () => register(path, registration({
      familia_nueva: false,
      particiones: { ...registration().particiones!, tramos: [{ train: { desde: '2022-01-01T00:00:00Z', hasta: '2023-01-01T00:00:00Z' }, validation: { desde: '2021-01-01T00:00:00Z', hasta: '2022-01-01T00:00:00Z' } }] },
    }))],
    ['tramo fuera de los datos', () => register(path, registration({
      familia_nueva: false,
      particiones: { ...registration().particiones!, tramos: [{ train: { desde: '2019-01-01T00:00:00Z', hasta: '2022-01-01T00:00:00Z' }, validation: { desde: '2022-01-01T00:00:00Z', hasta: '2023-01-01T00:00:00Z' } }] },
    }))],
    ['embargo < purging', () => register(path, registration({ familia_nueva: false, particiones: { ...registration().particiones!, purging_velas: 6, embargo_velas: 5 } }))],
    ['test final abierto', () => register(path, registration({
      familia_nueva: false,
      particiones: { ...registration().particiones!, test: { desde: '2026-10-01T00:00:00Z', hasta: '2027-10-01T00:00:00Z' } } as unknown as NonNullable<ReturnType<typeof registration>['particiones']>,
    }))],
    ['fecha hacia atrás', () => register(path, registration({ familia_nueva: false, fecha: '2026-10-12T00:00:00.000Z' }))],
    ['cierre de un id inexistente', () => close(path, { id: 'EXP-0009', fecha, autor: 'p', estado: 'abortado', resultado: null, notas: 'x' })],
    ['completado sin resultado', () => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'completado', resultado: null, notas: null })],
    ['fallido con resultado', () => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'fallido', resultado: RESULT, notas: 'x' })],
    ['abortado sin motivo', () => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'abortado', resultado: null, notas: null })],
  ];
  for (const [what, write] of rejected) {
    assert.throws(write, RegistryError, what);
    assert.equal(readFileSync(path, 'utf8'), before, what);
    assert.ok(!existsSync(`${path}.lock`), `${what}: el candado se suelta`);
  }
});

test('ciclo de vida: tras cerrar solo cabe invalidar, y tras invalidar nada', () => {
  const path = tempRegistry();
  register(path, registration());
  close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'completado', resultado: RESULT, notas: null });
  assert.throws(() => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'completado', resultado: RESULT, notas: null }), RegistryError);
  assert.throws(() => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'abortado', resultado: null, notas: 'x' }), RegistryError);
  close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'invalidado', resultado: null, notas: 'error en el código' });
  assert.throws(() => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'invalidado', resultado: null, notas: 'otra vez' }), RegistryError);
  const experiment = readRegistry(path).experiments.get('EXP-0001');
  assert.deepEqual(experiment?.closings.map((c) => c.estado), ['completado', 'invalidado']);
});

test('prueba previa: sin commit ni datos reproducibles, y solo se cierra como invalidada', () => {
  const path = tempRegistry();
  const prior = registration({
    previa: true, commit: null, semilla: null, costes: null, particiones: null, n_pruebas: 12,
    parametros: { tipo: 'descripcion', texto: 'ruptura de 20 velas en 6 marcos, BTC y ETH' },
    datos: { fuente: 'Binance', dataset: null, version: null, timeframe: '1d', rango: { desde: '2017-08-17T00:00:00Z', hasta: '2026-09-30T00:00:00Z' }, hash: null },
  });
  register(path, prior);
  assert.throws(() => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'completado', resultado: RESULT, notas: null }), RegistryError);
  assert.throws(() => close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'abortado', resultado: null, notas: 'x' }), RegistryError);
  close(path, { id: 'EXP-0001', fecha, autor: 'p', estado: 'invalidado', resultado: null, notas: 'sin protocolo' });
  assert.equal(trialsInFamily(readRegistry(path), 'juguete'), 12);
});

test('candado: con otro escritor activo no se escribe nada', () => {
  const path = tempRegistry();
  register(path, registration());
  const before = readFileSync(path, 'utf8');
  writeFileSync(`${path}.lock`, '');
  assert.throws(() => register(path, registration({ familia_nueva: false })), /bloqueado/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(existsSync(`${path}.lock`), 'no borra el candado de otro');
});

test('un registro vacío o inexistente no tiene experimentos', () => {
  assert.equal(parseRegistry('').experiments.size, 0);
  assert.equal(readRegistry(tempRegistry()).lastHash, GENESIS);
});

test('paso 27B: las variantes de robustez cuentan en N; n_pruebas = configuraciones + variantes, y una prueba previa no las declara', () => {
  const path = tempRegistry();
  const first = register(path, registration({ variantes: 7, n_pruebas: 8 }));
  assert.equal(first.n_familia, 8);
  register(path, registration({ familia_nueva: false, variantes: 7, n_pruebas: 3 * 1 + 7, parametros: { tipo: 'rejilla', rejilla: { a: [1, 2, 3] } } }));
  assert.equal(trialsInFamily(readRegistry(path), 'juguete'), 18);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => register(path, registration({ familia_nueva: false, variantes: 7, n_pruebas: 1 })), RegistryError);
  assert.throws(
    () => register(path, registration({
      familia_nueva: false, previa: true, commit: null, semilla: null, costes: null, particiones: null, variantes: 0, n_pruebas: 1,
      datos: { fuente: 'x', dataset: null, version: null, timeframe: '1d', rango: { desde: '2017-01-01T00:00:00Z', hasta: '2018-01-01T00:00:00Z' }, hash: null },
    })),
    RegistryError,
  );
  assert.equal(readFileSync(path, 'utf8'), before, 'nada se escribe');
});

test('paso 28: las configuraciones de una rejilla, en orden fijo (claves ordenadas, valores en el orden registrado), tantas como n_pruebas cuenta', () => {
  const rejilla = { tipo: 'rejilla' as const, rejilla: { exitPeriod: [10, 20], entryPeriod: [55, 20], stopAtr: [2] } };
  assert.deepEqual(gridPoints(rejilla), [
    { entryPeriod: 55, exitPeriod: 10, stopAtr: 2 },
    { entryPeriod: 55, exitPeriod: 20, stopAtr: 2 },
    { entryPeriod: 20, exitPeriod: 10, stopAtr: 2 },
    { entryPeriod: 20, exitPeriod: 20, stopAtr: 2 },
  ]);
  assert.equal(gridPoints(rejilla).length, gridSize(rejilla));
  assert.deepEqual(gridPoints({ tipo: 'valores', valores: { a: 1 } }), [{ a: 1 }]);
  assert.throws(() => gridPoints({ tipo: 'descripcion', texto: 'previa' }), RegistryError);
});

test('paso 31 (ADR 0044): solo elegir en train es un barrido sin variantes ni veredicto; solo el último tramo valida fuera de los datos', () => {
  const path = tempRegistry();
  register(path, registration());
  const grid = { tipo: 'rejilla' as const, rejilla: { k: [1, 2] } };
  const base = registration().particiones ?? assert.fail('la línea de prueba tiene particiones');
  // Datos hasta el 2024-01-01 y purging de 5 velas diarias: lo que puntúa de este train acaba justo ahí.
  const forward = { train: { desde: '2021-01-01T00:00:00Z', hasta: '2024-01-06T00:00:00Z' }, validation: { desde: '2024-01-06T00:00:00Z', hasta: '2025-01-01T00:00:00Z' } };
  const late = { train: { desde: '2021-01-01T00:00:00Z', hasta: '2024-01-07T00:00:00Z' }, validation: { desde: '2024-01-07T00:00:00Z', hasta: '2025-01-01T00:00:00Z' } };
  const solo = (overrides: Partial<NewRegistration> = {}): NewRegistration => registration({
    familia_nueva: false, solo_eleccion: true, variantes: 0, n_pruebas: 2, parametros: grid, particiones: { ...base, tramos: [...base.tramos, forward] }, ...overrides,
  });
  const before = readFileSync(path, 'utf8');
  const rejected: [string, () => unknown][] = [
    ['sin rejilla', () => register(path, solo({ parametros: { tipo: 'valores', valores: { k: 1 } }, n_pruebas: 1 }))],
    ['con variantes', () => register(path, solo({ variantes: 2, n_pruebas: 4 }))],
    ['lo que puntúa del último train, fuera de los datos', () => register(path, solo({ particiones: { ...base, tramos: [...base.tramos, late] } }))],
    ['un tramo que no es el último, fuera de los datos', () => register(path, solo({ particiones: { ...base, tramos: [forward, ...base.tramos] } }))],
    ['el mismo tramo, sin solo elegir', () => register(path, registration({ familia_nueva: false, n_pruebas: 2, parametros: grid, particiones: { ...base, tramos: [...base.tramos, forward] } }))],
    ['una prueba previa que solo elige', () => register(path, registration({ familia_nueva: false, previa: true, commit: null, solo_eleccion: true }))],
  ];
  for (const [what, write] of rejected) {
    assert.throws(write, RegistryError, what);
    assert.equal(readFileSync(path, 'utf8'), before, what);
  }
  const line = register(path, solo());
  assert.equal(line.solo_eleccion, true);
  assert.equal(line.n_pruebas, 2, 'cada punto de la rejilla cuenta en N');
  assert.throws(() => close(path, { id: line.id, fecha, autor: 'p', estado: 'completado', resultado: { ...RESULT, veredicto: 'RECHAZADA' }, notas: null }), RegistryError, 'sin veredicto');
  close(path, { id: line.id, fecha, autor: 'p', estado: 'completado', resultado: RESULT, notas: null });
  assert.deepEqual(readRegistry(path).experiments.get(line.id)?.closings.map((c) => c.estado), ['completado']);
});
