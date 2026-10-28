// Reloj simulado del replay (ARCHITECTURE.md §5.3, ADR 0021): el contrato Clock del kernel, el mismo que recibe
// el código en tiempo real, pero solo avanza cuando el motor de replay lo mueve al instante del siguiente evento o
// temporizador. Nunca retrocede. Los temporizadores siguen las reglas de TimerTable, como en SystemClock.
import { TimerError, TimerTable, type Clock, type PendingTimer } from '../kernel/clock.ts';
import { toUtcIso, type UtcMillis } from '../shared/time.ts';

export class SimulatedClock implements Clock {
  readonly #timers = new TimerTable();
  #now: UtcMillis;

  constructor(start: UtcMillis) {
    toUtcIso(start);
    this.#now = start;
  }

  now(): UtcMillis {
    return this.#now;
  }

  /** En el replay, el tiempo simulado también mide las duraciones. */
  monotonic(): number {
    return this.#now;
  }

  schedule(at: UtcMillis, timerId: string): void {
    this.#timers.add(timerId, at, this.#now);
  }

  cancel(timerId: string): void {
    this.#timers.remove(timerId);
  }

  /** Solo para el motor de replay. */
  advanceTo(at: UtcMillis): void {
    toUtcIso(at);
    if (at < this.#now) throw new TimerError(`el reloj simulado no retrocede: ${toUtcIso(at)} < ${toUtcIso(this.#now)}`);
    this.#now = at;
  }

  /** El siguiente temporizador pendiente, o null. Solo para el motor de replay. */
  nextTimer(): PendingTimer | null {
    return this.#timers.next();
  }

  /** Quita el temporizador que va a vencer. Solo para el motor de replay. */
  takeTimer(timerId: string): void {
    if (!this.#timers.remove(timerId)) throw new TimerError(`el temporizador ${timerId} no está pendiente`);
  }

  /** Los pendientes, en orden de vencimiento. */
  pendingTimers(): PendingTimer[] {
    return this.#timers.list();
  }
}
