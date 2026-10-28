// Reloj del kernel (ARCHITECTURE.md §5.3 y §16.2). El mismo contrato en tiempo real (SystemClock, en
// system-clock.ts) y en replay (SimulatedClock, en src/backtest/): ningún módulo sabe cuál recibe. Fuera de
// system-clock.ts, el dominio no lee la hora ni programa temporizadores por su cuenta (regla de ESLint, ADR 0021).
import { toUtcIso, type UtcMillis } from '../shared/time.ts';

export interface Clock {
  now(): UtcMillis; // reloj de pared, UTC
  monotonic(): number; // milisegundos monótonos, solo para duraciones
  schedule(at: UtcMillis, timerId: string): void; // vence como TimerFired; ver TimerTable para lo que se rechaza
  cancel(timerId: string): void; // un id desconocido o ya vencido no hace nada
}

/** Recibe cada temporizador vencido. Con el bus, lo publicará como TimerFired. */
export type TimerSink = (timerId: string, at: UtcMillis) => void;

/** Espera en tiempo de pared. Solo marca el ritmo de un replay: nunca cambia su resultado. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export class TimerError extends Error {
  override readonly name = 'TimerError';
}

export interface PendingTimer {
  readonly timerId: string;
  readonly at: UtcMillis;
}

/**
 * Temporizadores pendientes, con las mismas reglas en los dos relojes: un instante pasado o un id que ya está
 * pendiente se rechazan (fail closed; nada se reprograma en silencio). Vencen por instante y, en empate, por orden
 * de programación.
 */
export class TimerTable {
  // Un Map recorre en orden de inserción: en empate gana el que se programó antes.
  readonly #pending = new Map<string, UtcMillis>();

  add(timerId: string, at: UtcMillis, now: UtcMillis): void {
    toUtcIso(at); // valida que sea un instante UTC en ms
    if (timerId === '') throw new TimerError('el id del temporizador está vacío');
    if (this.#pending.has(timerId)) throw new TimerError(`el temporizador ${timerId} ya está pendiente`);
    if (at < now) throw new TimerError(`el temporizador ${timerId} vence en el pasado: ${toUtcIso(at)} < ${toUtcIso(now)}`);
    this.#pending.set(timerId, at);
  }

  /** Lo quita y dice si estaba pendiente. */
  remove(timerId: string): boolean {
    return this.#pending.delete(timerId);
  }

  /** El siguiente en vencer, o null. */
  next(): PendingTimer | null {
    let first: PendingTimer | null = null;
    for (const [timerId, at] of this.#pending) {
      if (first === null || at < first.at) first = { timerId, at };
    }
    return first;
  }

  /** Todos los pendientes, en el orden en que vencerán (sort es estable: el empate respeta la programación). */
  list(): PendingTimer[] {
    return [...this.#pending].map(([timerId, at]) => ({ timerId, at })).sort((a, b) => a.at - b.at);
  }

  get size(): number {
    return this.#pending.size;
  }
}
