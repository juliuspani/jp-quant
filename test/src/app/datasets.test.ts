// DatasetPort real (app/datasets.ts, paso 23): una colección del almacén por prefijo, etiquetas y marco; hash de los
// manifiestos sin cargar velas; carga perezosa por la guarda del test final; fuentes unidas por par y altas y bajas.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatasetError, HistoricalDatasets, isMarketHistory } from '../../../src/app/datasets.ts';
import { TestFinalLockedError } from '../../../src/historical/guard.ts';
import { JoinError } from '../../../src/historical/join.ts';
import { SurvivorshipBiasError, universeAt } from '../../../src/historical/universe.ts';
import type { DatasetRef } from '../../../src/research/experiment.ts';
import { toUtcIso } from '../../../src/shared/time.ts';
import { candles, HOUR, T0 } from './scenario.ts';
import { CLOSES, storeFixture } from './store-fixture.ts';

const REF: DatasetRef = {
  fuente: 'sintético',
  dataset: 'prueba',
  version: 'full+q3',
  timeframe: '1h',
  rango: { desde: toUtcIso(T0), hasta: toUtcIso(T0 + 120 * HOUR) },
};

test('el hash cubre los manifiestos y la regla del universo; cambia con el rango o las etiquetas, no entre llamadas', async () => {
  const { datasets } = await storeFixture({ withScenario: true });
  const hash = datasets.hash(REF);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(datasets.hash(REF), hash);
  assert.notEqual(datasets.hash({ ...REF, rango: { ...REF.rango, hasta: toUtcIso(T0 + 100 * HOUR) } }), hash);
  assert.notEqual(datasets.hash({ ...REF, version: 'full' }), hash);
  assert.equal((await datasets.load(REF)).hash, hash);
});

test('la carga une las dos fuentes de cada par, recorta al rango y da las altas y bajas de los manifiestos', async () => {
  const { datasets } = await storeFixture({ withScenario: true });
  const { data } = await datasets.load(REF);
  assert.ok(isMarketHistory(data));
  const btc = await data.candles(['BTC/EUR']);
  // La última vela (la de la hora 119) se recibe a las 120 h y 1 min: fuera de [desde, hasta).
  assert.deepEqual([btc.length, btc[0]?.openTime, btc.at(-1)?.openTime], [119, T0, T0 + 118 * HOUR]);
  assert.ok(btc.every((c, i) => i === 0 || c.openTime === (btc[i - 1]?.openTime ?? 0) + HOUR), 'sin huecos en la costura');
  assert.deepEqual(data.listings.listings.map((l) => [l.symbol, l.delistedAt]), [['BTC/EUR', null], ['OLD/EUR', T0 + 30 * HOUR]]);
  assert.throws(() => universeAt(data.listings, T0 + 10 * HOUR), SurvivorshipBiasError, 'antes de que la fuente traiga las bajas');
  assert.deepEqual(universeAt(data.listings, T0 + 70 * HOUR), ['BTC/EUR']);
  await assert.rejects(data.candles(['ETH/EUR']), DatasetError);
});

test('fail closed: referencias inválidas, dos versiones de un dataset, rangos fuera de la historia y fuentes que se solapan', async () => {
  const { datasets, write } = await storeFixture({ withScenario: true });
  // Como llegarían de un JSON: el tipo no las admite, la validación en tiempo de ejecución tampoco.
  const twoHours = { ...REF, timeframe: '2h' } as unknown as DatasetRef;
  for (const ref of [{ ...REF, dataset: 'Prueba' }, { ...REF, version: 'full+full' }, twoHours, { ...REF, version: 'otra' }]) {
    assert.throws(() => datasets.hash(ref), DatasetError, JSON.stringify(ref));
  }
  assert.throws(() => datasets.hash({ ...REF, rango: { ...REF.rango, hasta: toUtcIso(T0 + 200 * HOUR) } }), DatasetError);
  await write('prueba-xbteur-1h-full', candles(CLOSES.slice(0, 10))); // otra versión del mismo dataset
  assert.throws(() => datasets.hash(REF), DatasetError);

  const overlap = await storeFixture({ withScenario: true });
  await overlap.write('prueba-xbteur-1h-solapa', candles(CLOSES).filter((c) => c.openTime >= T0 + 70 * HOUR && c.openTime < T0 + 90 * HOUR));
  const { data } = await overlap.datasets.load({ ...REF, version: 'full+solapa' });
  assert.ok(isMarketHistory(data));
  await assert.rejects(data.candles(['BTC/EUR']), JoinError);
});

test('cada par se lee por la guarda: un dataset que llega al test final no se carga, aunque la regla del universo lo dejara', async () => {
  const { guard, paths, write } = await storeFixture();
  const late = Date.UTC(2026, 8, 30, 20);
  await write('tarde-xbteur-1h-full', candles([100, 101, 102, 103, 104]).map((c, i) => ({
    ...c,
    openTime: late + i * HOUR,
    closeTime: late + (i + 1) * HOUR,
    receivedTime: late + (i + 1) * HOUR + 60_000,
  })));
  const ref: DatasetRef = { fuente: 'x', dataset: 'tarde', version: 'full', timeframe: '1h', rango: { desde: toUtcIso(late), hasta: '2026-10-01T00:00:00Z' } };
  // Una regla del universo mal configurada, que acaba después del inicio del test final: la guarda es la última barrera.
  const misconfigured = new HistoricalDatasets({ guard, researchRoot: paths.researchRoot, coverage: { delistingsFrom: late, activeSince: late + HOUR, end: Date.UTC(2026, 9, 2) } });
  const { data } = await misconfigured.load(ref);
  assert.ok(isMarketHistory(data));
  await assert.rejects(data.candles(['BTC/EUR']), TestFinalLockedError);
});
