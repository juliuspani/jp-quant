// Motor de replay determinista (ADR 0021). Con los mismos registros, la misma configuración y la misma semilla, el
// diario y su SHA-256 son idénticos byte a byte. El tiempo lo marcan los datos, no el reloj de pared: cada registro
// se entrega en su received_time (event_time más la latencia de su fuente, ARCHITECTURE.md §5.1), con el reloj
// simulado en ese instante, y en empate por fuente y orden original. Los temporizadores se intercalan; en empate con
// un dato, va primero el dato. La pausa, la reanudación y la velocidad solo cambian el ritmo, nunca el resultado.
import type { Clock, Sleeper } from '../kernel/clock.ts';
import { checkSeed, seededIds, seededRng, type Ids, type Rng } from '../kernel/random.ts';
import { addMs, scaledDurationMs, toUtcIso, type UtcMillis } from '../shared/time.ts';
import { canonicalJson, deepFreeze, sha256Hex } from '../shared/canonical.ts';
import { SimulatedClock } from './simulated-clock.ts';

export const REPLAY_FORMAT = 'inversor-replay/1';

/** Un dato del histórico, listo para el replay. */
export interface ReplayRecord {
  readonly type: string; // tipo de evento, p. ej. 'CandleClosed'
  readonly source: string; // fuente del dato; desempata a igual received_time
  readonly sourceSeq: number; // orden original dentro de su fuente, único
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
  readonly payload: unknown; // valor canónico (canonical.ts); se congela
}

/** Lo que reciben los handlers y queda en el diario. */
export interface ReplayEvent {
  readonly seq: number; // orden en el diario
  readonly id: string; // secuencia con semilla
  readonly runId: string;
  readonly type: string;
  readonly source: string; // la del registro, o 'internal' para temporizadores y salidas
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
  readonly causationId: string | null; // el evento que la provocó, en las salidas
  readonly payload: unknown;
}

export interface ReplayContext {
  readonly clock: Clock; // el contrato de live: el handler no puede mover el reloj
  readonly rng: Rng;
  readonly ids: Ids;
  /** Anota una salida en el diario, en el instante actual y causada por el evento en curso. */
  output(type: string, payload: unknown): void;
}

// Síncrono (ARCHITECTURE.md §5.2): devolver algo, también una promesa, es un error.
export type ReplayHandler = (event: ReplayEvent, context: ReplayContext) => undefined;

/** Tramo [from, to) por received_time. */
export interface ReplaySegment {
  readonly from: UtcMillis;
  readonly to: UtcMillis;
}

export type ReplaySpeed = number | 'max'; // veces la velocidad real, o sin esperas

export interface ReplayConfig {
  readonly runId: string;
  readonly seed: number;
  readonly segment?: ReplaySegment; // sin él, del primer registro al último, ambos incluidos
  readonly speed?: ReplaySpeed; // por defecto 'max'; no forma parte del resultado
}

export type ReplayState = 'ready' | 'running' | 'paused' | 'finished' | 'failed';

export interface ReplayResult {
  readonly sha256: string; // del diario en JSONL
  readonly jsonl: string; // cabecera, un evento por línea y cierre
  readonly journal: readonly ReplayEvent[];
}

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

type Next =
  | { readonly kind: 'record'; readonly at: UtcMillis; readonly record: ReplayRecord }
  | { readonly kind: 'timer'; readonly at: UtcMillis; readonly timerId: string };

function sameNext(a: Next | null, b: Next): boolean {
  if (a === null || a.kind !== b.kind || a.at !== b.at) return false;
  return a.kind === 'record' ? b.kind === 'record' && a.record === b.record : b.kind === 'timer' && a.timerId === b.timerId;
}

function byArrival(a: ReplayRecord, b: ReplayRecord): number {
  if (a.receivedTime !== b.receivedTime) return a.receivedTime < b.receivedTime ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.sourceSeq === b.sourceSeq ? 0 : a.sourceSeq < b.sourceSeq ? -1 : 1;
}

function checkSpeed(speed: ReplaySpeed): ReplaySpeed {
  if (speed !== 'max' && (!Number.isFinite(speed) || speed <= 0)) {
    throw new ReplayError(`velocidad inválida: ${String(speed)} ('max' o un número finito > 0)`);
  }
  return speed;
}

function checkRecord(record: ReplayRecord): string {
  const where = `registro ${JSON.stringify(record.source)}#${String(record.sourceSeq)}`;
  if (record.type === '' || record.source === '') throw new ReplayError(`${where}: tipo o fuente vacíos`);
  if (!Number.isSafeInteger(record.sourceSeq) || record.sourceSeq < 0) throw new ReplayError(`${where}: sourceSeq no es un entero ≥ 0`);
  toUtcIso(record.eventTime);
  toUtcIso(record.receivedTime);
  // Point-in-time: nada se recibe antes de ocurrir.
  if (record.receivedTime < record.eventTime) throw new ReplayError(`${where}: received_time anterior a event_time`);
  return canonicalJson({
    type: record.type,
    source: record.source,
    sourceSeq: record.sourceSeq,
    eventTime: record.eventTime,
    receivedTime: record.receivedTime,
    payload: record.payload,
  });
}

export class ReplayEngine {
  readonly #runId: string;
  readonly #seed: number;
  readonly #segment: ReplaySegment | null;
  readonly #handlers: readonly ReplayHandler[];
  readonly #sleeper: Sleeper;
  readonly #inputSha256: string;
  readonly #inputCount: number;
  readonly #pending: Iterator<ReplayRecord>;
  readonly #end: UtcMillis; // exclusivo
  readonly #clock: SimulatedClock;
  readonly #eventIds: Ids;
  readonly #context: ReplayContext;
  readonly #journal: ReplayEvent[] = [];
  readonly #lines: string[] = [];
  #peeked: ReplayRecord | null;
  #speed: ReplaySpeed;
  #state: ReplayState = 'ready';
  #playing = false;
  #current: ReplayEvent | null = null;
  #failure: unknown = null;
  #result: ReplayResult | null = null;
  #resume: (() => void) | null = null;

  constructor(records: readonly ReplayRecord[], handlers: readonly ReplayHandler[], config: ReplayConfig, sleeper: Sleeper) {
    if (config.runId === '') throw new ReplayError('runId vacío');
    this.#runId = config.runId;
    this.#seed = checkSeed(config.seed);
    this.#speed = checkSpeed(config.speed ?? 'max');
    this.#handlers = [...handlers];
    this.#sleeper = sleeper;

    const sorted = [...records].sort(byArrival);
    const seen = new Set<string>();
    const lines = sorted.map((record) => {
      const key = `${record.source}\u0000${String(record.sourceSeq)}`;
      if (seen.has(key)) throw new ReplayError(`registro duplicado: ${JSON.stringify(record.source)}#${String(record.sourceSeq)}`);
      seen.add(key);
      return checkRecord(record);
    });
    for (const record of sorted) deepFreeze(record);
    // Huella del dataset completo, en orden de llegada: el orden de entrada no cambia nada.
    this.#inputSha256 = sha256Hex(lines.join('\n'));
    this.#inputCount = sorted.length;

    const segment = config.segment ?? null;
    if (segment !== null) {
      toUtcIso(segment.from);
      toUtcIso(segment.to);
      if (segment.to <= segment.from) throw new ReplayError('segmento vacío o invertido: to debe ser mayor que from');
    }
    this.#segment = segment === null ? null : { from: segment.from, to: segment.to };
    const first = sorted[0];
    const last = sorted.at(-1);
    const start = segment?.from ?? first?.receivedTime ?? 0;
    this.#end = segment?.to ?? (last === undefined ? 0 : addMs(last.receivedTime, 1));
    const inWindow = sorted.filter((r) => r.receivedTime >= start && r.receivedTime < this.#end);
    this.#pending = inWindow[Symbol.iterator]();
    this.#peeked = this.#advance();

    this.#clock = new SimulatedClock(start);
    this.#eventIds = seededIds(this.#seed, 'ev');
    const clock = this.#clock;
    // Solo el contrato Clock: un handler no puede mover el reloj simulado.
    const facade: Clock = Object.freeze({
      now: () => clock.now(),
      monotonic: () => clock.monotonic(),
      schedule: (at: UtcMillis, timerId: string): void => {
        clock.schedule(at, timerId);
      },
      cancel: (timerId: string): void => {
        clock.cancel(timerId);
      },
    });
    this.#context = Object.freeze({
      clock: facade,
      rng: seededRng(this.#seed, 'handlers'),
      ids: seededIds(this.#seed, 'handlers'),
      output: (type: string, payload: unknown): void => {
        this.#output(type, payload);
      },
    });
  }

  get state(): ReplayState {
    return this.#state;
  }

  get speed(): ReplaySpeed {
    return this.#speed;
  }

  /** Instante simulado actual. */
  now(): UtcMillis {
    return this.#clock.now();
  }

  /**
   * El reloj del replay con el contrato Clock de live, para componer los módulos antes de empezar: es la misma fachada que
   * reciben los handlers, que no puede mover el reloj.
   */
  get clock(): Clock {
    return this.#context.clock;
  }

  setSpeed(speed: ReplaySpeed): void {
    this.#speed = checkSpeed(speed);
  }

  /** Detiene la entrega tras el evento en curso. Se puede llamar desde un handler. */
  pause(): void {
    this.#usable();
    if (this.#state === 'ready' || this.#state === 'running') this.#state = 'paused';
  }

  resume(): void {
    this.#usable();
    if (this.#state !== 'paused') return;
    this.#state = this.#playing ? 'running' : 'ready';
    const resume = this.#resume;
    this.#resume = null;
    resume?.();
  }

  /** Entrega el siguiente evento. Sirve para avanzar paso a paso en pausa. Devuelve false si ya no quedaba ninguno. */
  step(): boolean {
    this.#controllable();
    if (this.#state === 'running') throw new ReplayError('step() con el replay en marcha: páusalo antes');
    return this.#stepOnce();
  }

  /** Entrega todo sin esperas, hasta el final o hasta que un handler lo pause. */
  run(): ReplayState {
    this.#controllable();
    if (this.#playing) throw new ReplayError('run() con play() en marcha');
    if (this.#state === 'finished') return this.#state;
    this.#state = 'running';
    while (this.#state === 'running') this.#stepOnce();
    return this.#state;
  }

  /** Entrega todo al ritmo de la velocidad, respetando las pausas. Termina con el resultado. */
  async play(): Promise<ReplayResult> {
    this.#controllable();
    if (this.#playing) throw new ReplayError('play() ya está en marcha');
    this.#playing = true;
    if (this.#state === 'ready') this.#state = 'running';
    try {
      while (this.#state !== 'finished') {
        if (this.#state === 'paused') {
          await this.#untilResumed();
          continue;
        }
        const next = this.#next();
        if (next !== null && this.#speed !== 'max') {
          const wait = scaledDurationMs(this.#clock.now(), next.at, this.#speed);
          if (wait > 0) {
            await this.#sleeper.sleep(wait);
            // Durante la espera pudo pausarse o avanzar paso a paso: se vuelve a decidir.
            if (this.#state !== 'running' || !sameNext(this.#next(), next)) continue;
          }
        }
        this.#stepOnce();
      }
      return this.result();
    } finally {
      this.#playing = false;
    }
  }

  result(): ReplayResult {
    if (this.#result === null) throw new ReplayError(`el replay no ha terminado (estado: ${this.#state})`);
    return this.#result;
  }

  #usable(): void {
    if (this.#state === 'failed') throw new ReplayError('el replay falló; crea uno nuevo', { cause: this.#failure });
  }

  // Avanzar desde un handler entregaría un evento dentro de otro: el orden dejaría de ser el de llegada.
  #controllable(): void {
    this.#usable();
    if (this.#current !== null) throw new ReplayError('no se puede avanzar el replay desde un handler');
  }

  #untilResumed(): Promise<void> {
    return new Promise((resolve) => {
      this.#resume = resolve;
    });
  }

  #advance(): ReplayRecord | null {
    const step = this.#pending.next();
    return step.done === true ? null : step.value;
  }

  #next(): Next | null {
    const record = this.#peeked;
    const timer = this.#clock.nextTimer();
    const timerDue = timer !== null && timer.at < this.#end ? timer : null;
    // En empate, el dato antes que el temporizador: el temporizador de T ve todo lo recibido en T.
    if (record !== null && (timerDue === null || record.receivedTime <= timerDue.at)) {
      return { kind: 'record', at: record.receivedTime, record };
    }
    return timerDue === null ? null : { kind: 'timer', at: timerDue.at, timerId: timerDue.timerId };
  }

  #stepOnce(): boolean {
    if (this.#state === 'finished') return false;
    const next = this.#next();
    if (next === null) {
      this.#finish();
      return false;
    }
    try {
      this.#dispatch(next);
    } catch (error) {
      this.#state = 'failed';
      this.#failure = error;
      throw error;
    }
    return true;
  }

  #dispatch(next: Next): void {
    this.#clock.advanceTo(next.at);
    let event: ReplayEvent;
    if (next.kind === 'record') {
      this.#peeked = this.#advance();
      const r = next.record;
      event = this.#append(r.type, r.source, r.eventTime, r.receivedTime, null, r.payload);
    } else {
      this.#clock.takeTimer(next.timerId);
      event = this.#append('TimerFired', 'internal', next.at, next.at, null, { timerId: next.timerId });
    }
    this.#current = event;
    try {
      for (const handler of this.#handlers) {
        const returned: unknown = handler(event, this.#context);
        if (returned !== undefined) {
          throw new ReplayError(`un handler de ${event.type} devolvió un valor: los handlers son síncronos (ARCHITECTURE.md §5.2)`);
        }
      }
    } finally {
      this.#current = null;
    }
  }

  #output(type: string, payload: unknown): void {
    const cause = this.#current;
    if (cause === null) throw new ReplayError('output() solo se puede llamar mientras un handler procesa un evento');
    if (type === '') throw new ReplayError('output() con tipo vacío');
    const now = this.#clock.now();
    this.#append(type, 'internal', now, now, cause.id, payload);
  }

  #append(type: string, source: string, eventTime: UtcMillis, receivedTime: UtcMillis, causationId: string | null, payload: unknown): ReplayEvent {
    const event: ReplayEvent = deepFreeze({
      seq: this.#journal.length,
      id: this.#eventIds.next(),
      runId: this.#runId,
      type,
      source,
      eventTime,
      receivedTime,
      causationId,
      payload,
    });
    this.#lines.push(canonicalJson(event)); // rechaza lo que no sea canónico antes de entregarlo
    this.#journal.push(event);
    return event;
  }

  #finish(): void {
    const header = canonicalJson({
      format: REPLAY_FORMAT,
      runId: this.#runId,
      seed: this.#seed,
      segment: this.#segment,
      inputSha256: this.#inputSha256,
      inputRecords: this.#inputCount,
    });
    const footer = canonicalJson({
      events: this.#journal.length,
      clock: this.#clock.now(),
      pendingTimers: this.#clock.pendingTimers(),
    });
    const jsonl = `${[header, ...this.#lines, footer].join('\n')}\n`;
    this.#result = Object.freeze({ sha256: sha256Hex(jsonl), jsonl, journal: Object.freeze([...this.#journal]) });
    this.#state = 'finished';
  }
}
