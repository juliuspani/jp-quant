// Motor de replay determinista (ADR 0021). El determinismo se demuestra comparando el SHA-256 del diario entre
// ejecuciones: en el mismo proceso, en procesos aparte, con la entrada en otro orden, tras pasar por el almacén
// Parquet, con pausas, pasos y cambios de velocidad, y contra un hash fijado.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { NotCanonicalError } from '../../../src/shared/canonical.ts';
import { ReplayEngine, ReplayError, type ReplayEvent, type ReplayHandler, type ReplayRecord } from '../../../src/backtest/replay.ts';
import { SimulatedClock } from '../../../src/backtest/simulated-clock.ts';
import { TimerError, type Sleeper } from '../../../src/kernel/clock.ts';
import { Decimal } from '../../../src/shared/decimal.ts';
import { cleanCandles } from '../../../src/historical/quality.ts';
import { readDataset, writeDataset } from '../../../src/historical/store.ts';
import { HOUR, LATENCY_MS, T0 } from '../historical/helpers.ts';
import { CONFIG, noSleep, runScenario, scenarioCandles, scenarioRecords, strategyHandler, toRecords } from './scenario.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
// Hash del diario del escenario. Si cambia sin cambiar a propósito el formato, el escenario o el motor, el replay
// ha dejado de ser reproducible entre versiones. Un cambio a propósito actualiza este valor y lo explica en el commit.
const GOLDEN_SHA256 = 'a6662815a94f205ebfca9d7dac5b7d772d1013e9a22b68a32cca8787c6f090b1';

const STORE = mkdtempSync(join(tmpdir(), 'inversor-replay-'));
after(() => {
  rmSync(STORE, { recursive: true, force: true });
});

const inputs = (events: readonly ReplayEvent[]): string[] =>
  events.filter((e) => e.type === 'CandleClosed').map((e) => JSON.stringify([e.source, e.eventTime, e.receivedTime, e.payload]));

function record(source: string, sourceSeq: number, receivedTime: number, payload: unknown = {}): ReplayRecord {
  return { type: 'Dato', source, sourceSeq, eventTime: receivedTime, receivedTime, payload };
}

test('mismo dataset, configuración y semilla: el mismo diario byte a byte en cinco ejecuciones', () => {
  const runs = Array.from({ length: 5 }, () => runScenario().result());
  const first = runs[0];
  assert.ok(first);
  assert.ok(first.journal.length > 200, 'el escenario debería producir señales y temporizadores');
  for (const run of runs) {
    assert.equal(run.sha256, first.sha256);
    assert.equal(run.jsonl, first.jsonl);
  }
  assert.equal(first.sha256, GOLDEN_SHA256);
});

test('en procesos aparte da el mismo hash, el fijado', () => {
  const script = join(ROOT, 'test', 'fixtures', 'replay', 'run.ts');
  const hashes = [1, 2].map(() => execFileSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' }).trim());
  assert.deepEqual(hashes, [GOLDEN_SHA256, GOLDEN_SHA256]);
});

test('el orden en que llegan los registros al motor no cambia nada', () => {
  const records = scenarioRecords();
  const shuffled = [...records.filter((_, i) => i % 2 === 1).reverse(), ...records.filter((_, i) => i % 2 === 0)];
  assert.equal(runScenario(shuffled).result().sha256, GOLDEN_SHA256);
});

test('otra semilla, otro runId u otro dato dan otro hash', () => {
  assert.notEqual(runScenario(scenarioRecords(), { ...CONFIG, seed: CONFIG.seed + 1 }).result().sha256, GOLDEN_SHA256);
  assert.notEqual(runScenario(scenarioRecords(), { ...CONFIG, runId: 'otro' }).result().sha256, GOLDEN_SHA256);
  const records = scenarioRecords();
  const [head, ...rest] = records;
  assert.ok(head);
  const changed = { ...head, payload: { ...(head.payload as object), nota: 'cambiado' } };
  assert.notEqual(runScenario([changed, ...rest]).result().sha256, GOLDEN_SHA256);
});

test('el mismo dataset leído del almacén Parquet da el mismo hash', async () => {
  const { candles, report } = cleanCandles(scenarioCandles(), '1h');
  assert.equal(candles.length, scenarioCandles().length, 'el escenario debe pasar la limpieza entero');
  const manifest = await writeDataset(STORE, {
    dataset: 'replay',
    timeframe: '1h',
    receivedLatencyMs: LATENCY_MS,
    candles,
    quality: report,
    source: { provider: 'sintético', url: 'test://replay', retrievedAtUtc: '2026-10-08T00:00:00Z', originalSha256: '0'.repeat(64), terms: null },
  });
  const { candles: read } = await readDataset(STORE, 'replay', manifest.version);
  const split = (cs: typeof read): ReplayRecord[] => [
    ...toRecords(cs.filter((c) => c.symbol !== 'BTC/EUR'), 'kraken-zip'),
    ...toRecords(cs.filter((c) => c.symbol === 'BTC/EUR'), 'bitvavo-api'),
  ];
  assert.equal(runScenario(split(read)).result().sha256, GOLDEN_SHA256);
});

test('opera en tiempo de los datos: el reloj está en el received_time de cada dato y nunca retrocede', () => {
  let previous = -1;
  const check: ReplayHandler = (event, ctx) => {
    assert.equal(ctx.clock.now(), event.receivedTime);
    assert.ok(event.receivedTime >= previous);
    assert.ok(event.receivedTime >= event.eventTime);
    previous = event.receivedTime;
    return undefined;
  };
  const engine = new ReplayEngine(scenarioRecords(), [strategyHandler(), check], CONFIG, noSleep);
  assert.equal(engine.run(), 'finished');
  assert.ok(previous > T0);
});

test('orden: por received_time, luego fuente y orden original; un temporizador del mismo instante va después', () => {
  const seen: string[] = [];
  const handler: ReplayHandler = (event, ctx) => {
    seen.push(event.type === 'TimerFired' ? `timer@${String(event.receivedTime)}` : `${event.source}#${String((event.payload as { n: number }).n)}`);
    if (event.source === 'b' && (event.payload as { n: number }).n === 1) ctx.clock.schedule(ctx.clock.now(), 'ya');
    return undefined;
  };
  const records = [record('b', 1, T0 + 10, { n: 1 }), record('a', 2, T0 + 10, { n: 2 }), record('a', 1, T0 + 10, { n: 1 }), record('a', 3, T0 + 20, { n: 3 })];
  new ReplayEngine(records, [handler], CONFIG, noSleep).run();
  assert.deepEqual(seen, ['a#1', 'a#2', 'b#1', `timer@${String(T0 + 10)}`, 'a#3']);
});

test('pausa, reanudación, pasos y cambios de velocidad no cambian el resultado', async () => {
  const waits: number[] = [];
  let engine: ReplayEngine | null = null;
  const sleeper: Sleeper = {
    sleep: (ms) => {
      waits.push(ms);
      // Pausa durante la tercera espera, avanza un paso a mano y reanuda en la siguiente vuelta del bucle de eventos.
      if (waits.length === 3 && engine !== null) {
        const e = engine;
        e.pause();
        return new Promise((done) => {
          setImmediate(() => {
            assert.equal(e.step(), true);
            e.resume();
            done();
          });
        });
      }
      return Promise.resolve();
    },
  };
  let delivered = 0;
  const pauser: ReplayHandler = () => {
    delivered += 1;
    // Un handler también puede pausar: como un punto de parada.
    if (delivered === 100 && engine !== null) {
      const e = engine;
      e.pause();
      setImmediate(() => {
        e.setSpeed(7200);
        e.resume();
      });
    }
    return undefined;
  };
  engine = new ReplayEngine(scenarioRecords(), [strategyHandler(), pauser], { ...CONFIG, speed: 3600 }, sleeper);
  const result = await engine.play();
  assert.equal(result.sha256, GOLDEN_SHA256);
  assert.equal(engine.state, 'finished');
  // A 3600x, una hora simulada son 1000 ms; tras pasar a 7200x, 500 ms.
  assert.equal(waits[0], 1000);
  assert.ok(waits.includes(500), 'el cambio de velocidad debería notarse en las esperas');
  assert.ok(waits.every((w) => w > 0));
});

test('play a velocidad máxima no espera y da lo mismo que run', async () => {
  let slept = false;
  const engine = new ReplayEngine(scenarioRecords(), [strategyHandler()], CONFIG, {
    sleep: () => {
      slept = true;
      return Promise.resolve();
    },
  });
  assert.equal((await engine.play()).sha256, GOLDEN_SHA256);
  assert.equal(slept, false);
});

test('replay de un segmento: solo los datos de [from, to), determinista y con los mismos datos que el replay completo', () => {
  const segment = { from: T0 + 10 * HOUR, to: T0 + 20 * HOUR };
  const config = { ...CONFIG, segment };
  const a = runScenario(scenarioRecords(), config).result();
  const b = runScenario(scenarioRecords(), config).result();
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.sha256, GOLDEN_SHA256);
  for (const e of a.journal) assert.ok(e.receivedTime >= segment.from && e.receivedTime < segment.to, `fuera del segmento: ${String(e.receivedTime)}`);
  const full = runScenario().result().journal.filter((e) => e.receivedTime >= segment.from && e.receivedTime < segment.to);
  assert.deepEqual(inputs(a.journal), inputs(full));
  assert.ok(inputs(a.journal).length > 0);
  // Los temporizadores que vencerían al final o después quedan pendientes, a la vista en el cierre.
  const footer = JSON.parse(a.jsonl.trimEnd().split('\n').at(-1) ?? '{}') as { pendingTimers: { at: number }[] };
  for (const t of footer.pendingTimers) assert.ok(t.at >= segment.to);
  assert.match(a.jsonl.split('\n')[0] ?? '', /"segment":\{"from":\d+,"to":\d+\}/);
});

test('los eventos están congelados: un handler no puede cambiar lo que verán los demás', () => {
  const mutate: ReplayHandler = (event) => {
    assert.throws(() => {
      (event.payload as { n: number }).n = 99;
    }, TypeError);
    assert.throws(() => {
      (event as { type: string }).type = 'otro';
    }, TypeError);
    return undefined;
  };
  new ReplayEngine([record('a', 1, T0, { n: 1 })], [mutate], CONFIG, noSleep).run();
});

test('fail closed: datos imposibles, duplicados o no canónicos se rechazan al construir', () => {
  const make = (records: ReplayRecord[]): ReplayEngine => new ReplayEngine(records, [], CONFIG, noSleep);
  assert.throws(() => make([{ ...record('a', 1, T0), eventTime: T0 + 1 }]), ReplayError);
  assert.throws(() => make([record('a', 1, T0), record('a', 1, T0 + 5)]), /duplicado/);
  assert.throws(() => make([record('a', -1, T0)]), ReplayError);
  assert.throws(() => make([record('', 1, T0)]), ReplayError);
  for (const bad of [{ x: Number.NaN }, { x: undefined }, { x: new Map() }, { x: 1n }, { x: new Date(0) }, { x: Infinity }]) {
    assert.throws(() => make([record('a', 1, T0, bad)]), NotCanonicalError);
  }
  assert.doesNotThrow(() => make([record('a', 1, T0, { precio: Decimal.parse('1.50'), lista: [1, 'x', null, true] })]));
});

test('fail closed: configuración inválida', () => {
  const make = (config: object): ReplayEngine => new ReplayEngine([], [], { ...CONFIG, ...config }, noSleep);
  assert.throws(() => make({ seed: -1 }), RangeError);
  assert.throws(() => make({ seed: 1.5 }), RangeError);
  assert.throws(() => make({ runId: '' }), ReplayError);
  assert.throws(() => make({ speed: 0 }), ReplayError);
  assert.throws(() => make({ speed: Number.NaN }), ReplayError);
  assert.throws(() => make({ segment: { from: T0 + 10, to: T0 + 10 } }), ReplayError);
  assert.throws(() => make({ segment: { from: T0 + 10, to: T0 } }), ReplayError);
  assert.throws(() => make({}).setSpeed(-2), ReplayError);
});

test('fail closed: un handler asíncrono, que lanza o que avanza el replay deja el motor en failed', () => {
  const asyncHandler = (() => Promise.resolve()) as unknown as ReplayHandler;
  const engine = new ReplayEngine([record('a', 1, T0)], [asyncHandler], CONFIG, noSleep);
  assert.throws(() => engine.run(), /síncronos/);
  assert.equal(engine.state, 'failed');
  assert.throws(() => engine.step(), ReplayError);
  assert.throws(() => engine.result(), ReplayError);

  let engine2: ReplayEngine | null = null;
  const reentrant: ReplayHandler = () => {
    engine2?.step();
    return undefined;
  };
  engine2 = new ReplayEngine([record('a', 1, T0)], [reentrant], CONFIG, noSleep);
  assert.throws(() => engine2?.step(), /desde un handler/);

  const past: ReplayHandler = (_e, ctx) => {
    ctx.clock.schedule(ctx.clock.now() - 1, 'pasado');
    return undefined;
  };
  assert.throws(() => new ReplayEngine([record('a', 1, T0)], [past], CONFIG, noSleep).run(), TimerError);

  const engine3 = new ReplayEngine([record('a', 1, T0)], [], CONFIG, noSleep);
  assert.throws(() => engine3.result(), /no ha terminado/);
});

test('sin registros termina enseguida, con un diario solo de cabecera y cierre', () => {
  const result = runScenario([]).result();
  assert.equal(result.journal.length, 0);
  assert.equal(result.jsonl.trimEnd().split('\n').length, 2);
});

test('SimulatedClock: no retrocede y aplica las reglas de temporizadores de live', () => {
  const clock = new SimulatedClock(T0);
  assert.equal(clock.now(), T0);
  clock.advanceTo(T0 + 5);
  assert.throws(() => clock.advanceTo(T0 + 4), TimerError);
  assert.throws(() => clock.schedule(T0 + 4, 'x'), TimerError);
  clock.schedule(T0 + 9, 'b');
  clock.schedule(T0 + 7, 'a');
  assert.throws(() => clock.schedule(T0 + 8, 'a'), TimerError);
  assert.deepEqual(clock.pendingTimers(), [{ timerId: 'a', at: T0 + 7 }, { timerId: 'b', at: T0 + 9 }]);
  clock.cancel('a');
  assert.deepEqual(clock.nextTimer(), { timerId: 'b', at: T0 + 9 });
  assert.throws(() => clock.takeTimer('a'), TimerError);
});
