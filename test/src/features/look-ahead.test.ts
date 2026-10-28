// Prueba genérica anti look-ahead (ADR 0025): alterar los datos futuros no cambia ninguna feature pasada. Recorre
// todo el catálogo con varios periodos y dos símbolos intercalados, corta la serie en instantes al azar con semilla
// y altera todo lo recibido después del corte de cuatro formas: otros valores, velas quitadas (huecos), serie cortada
// y valores extremos. Las features calculadas hasta el corte tienen que ser idénticas.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEATURE_CATALOG } from '../../../src/features/definitions.ts';
import { FeatureEngine } from '../../../src/features/engine.ts';
import type { FeatureDefinition, FeatureSet, FeatureVector } from '../../../src/features/types.ts';
import { seededRng, type Rng } from '../../../src/kernel/random.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { T0, randomWalk, received, type Received } from './helpers.ts';

const PERIODS = [2, 3, 7, 14];
// 200 velas por símbolo dejan más de 120 tras el calentamiento más largo (71, rsi_14 y atr_14). Cada corte ejecuta el
// motor cuatro veces sobre 400 velas: 10 cortes mantienen la prueba en pocos segundos.
const COUNT = 200;
const TRIALS = 10;

function catalogSet(): FeatureSet {
  const byId = new Map<string, FeatureDefinition>();
  for (const build of Object.values(FEATURE_CATALOG)) {
    for (const period of PERIODS) {
      const f = build(period);
      byId.set(f.id, f);
    }
  }
  return { id: 'catalogo', version: 1, timeframe: '1h', features: [...byId.values()] };
}

const SET = catalogSet();

function byArrival(a: Received, b: Received): number {
  if (a.receivedTime !== b.receivedTime) return a.receivedTime - b.receivedTime;
  return a.candle.symbol < b.candle.symbol ? -1 : a.candle.symbol > b.candle.symbol ? 1 : 0;
}

function series(seed: number): Received[] {
  const rng = seededRng(seed, 'serie');
  // Un hueco en cada símbolo, para que el corte caiga a veces cerca de él.
  const a = randomWalk(rng, 'A/EUR', '1h', 0, COUNT, 100, new Set([150]));
  const b = randomWalk(rng, 'B/EUR', '1h', 0, COUNT, 3, new Set([90]));
  return [...a, ...b].sort(byArrival);
}

function run(events: readonly Received[]): FeatureVector[] {
  const engine = new FeatureEngine(SET);
  return events.map((r) => engine.onCandleClosed(r.candle, r.receivedTime));
}

const key = (r: Received): string => `${r.candle.symbol}@${String(r.candle.openTime)}`;

type Alteration = (future: readonly Received[], rng: Rng) => Received[];

const OTHER = new Map(series(999).map((r) => [key(r), r]));

const ALTERATIONS: Readonly<Record<string, Alteration>> = {
  'otros valores': (future) => future.map((r) => OTHER.get(key(r)) ?? r),
  'velas quitadas': (future, rng) => future.filter(() => rng.next() >= 0.3),
  'serie cortada': () => [],
  'valores extremos': (future) =>
    future.map((r) => {
      const scale = (d: Decimal): string => d.times(Decimal.parse('1000')).toString();
      const c = r.candle;
      return received(c.symbol, '1h', (c.openTime - T0) / 3_600_000, {
        open: scale(c.open), high: scale(c.high), low: scale(c.low), close: scale(c.close), volume: '0',
      });
    }),
};

test('el catálogo entero entra en la prueba', () => {
  assert.equal(SET.features.length, new Set(SET.features.map((f) => f.id)).size);
  for (const name of Object.keys(FEATURE_CATALOG)) {
    const id = FEATURE_CATALOG[name]?.(PERIODS[0] ?? 2).id ?? '';
    assert.ok(SET.features.some((f) => f.id === id), `${name} no está en el conjunto de la prueba`);
  }
});

test('alterar datos futuros no cambia ninguna feature pasada', () => {
  const base = series(2026);
  const original = run(base);
  const rng = seededRng(42, 'cortes');
  let changedAfterCut = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    // Corte: el received_time de un evento al azar. Pasado = todo lo recibido hasta ese instante, incluido.
    const cut = base[Math.floor(rng.next() * base.length)]?.receivedTime ?? 0;
    const pastLength = base.findIndex((r) => r.receivedTime > cut);
    const past = pastLength === -1 ? base : base.slice(0, pastLength);
    for (const [name, alter] of Object.entries(ALTERATIONS)) {
      const altered = run([...past, ...alter(base.slice(past.length), rng)]);
      assert.deepEqual(altered.slice(0, past.length), original.slice(0, past.length), `${name}, corte en ${new Date(cut).toISOString()}`);
      for (const v of altered.slice(0, past.length)) assert.ok(v.computedAt <= cut, 'un vector del pasado se calculó después del corte');
      if (name === 'otros valores' && altered.length > past.length && JSON.stringify(altered.slice(past.length)) !== JSON.stringify(original.slice(past.length))) {
        changedAfterCut++;
      }
    }
  }
  // La prueba no es vacía: alterar el futuro sí cambia las features futuras.
  assert.ok(changedAfterCut >= TRIALS - 1, `solo ${String(changedAfterCut)} de ${String(TRIALS)} cortes cambiaron el futuro`);
});
