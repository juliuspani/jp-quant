// Reloj de tiempo real (ARCHITECTURE.md §5.3): el único archivo del dominio que lee el reloj del sistema y usa
// temporizadores de Node. La regla de ESLint del dominio lo exceptúa por nombre (ADR 0021).
import { setTimeout as delay } from 'node:timers/promises';
import type { UtcMillis } from '../shared/time.ts';
import { TimerTable, type Clock, type Sleeper, type TimerSink } from './clock.ts';

// setTimeout no admite esperas mayores (unos 24,8 días): una mayor vencería en 1 ms. Se encadenan tramos.
const MAX_TIMEOUT_MS = 2_147_483_647;

export class SystemClock implements Clock {
  readonly #timers = new TimerTable();
  readonly #handles = new Map<string, NodeJS.Timeout>();
  readonly #onTimer: TimerSink;

  constructor(onTimer: TimerSink) {
    this.#onTimer = onTimer;
  }

  now(): UtcMillis {
    return Date.now();
  }

  monotonic(): number {
    return performance.now();
  }

  schedule(at: UtcMillis, timerId: string): void {
    this.#timers.add(timerId, at, this.now());
    this.#arm(timerId, at);
  }

  cancel(timerId: string): void {
    this.#timers.remove(timerId);
    clearTimeout(this.#handles.get(timerId));
    this.#handles.delete(timerId);
  }

  #arm(timerId: string, at: UtcMillis): void {
    const wait = Math.max(0, at - this.now());
    const handle = setTimeout(() => {
      if (wait > MAX_TIMEOUT_MS) {
        this.#arm(timerId, at);
        return;
      }
      this.#handles.delete(timerId);
      if (this.#timers.remove(timerId)) this.#onTimer(timerId, at);
    }, Math.min(wait, MAX_TIMEOUT_MS));
    this.#handles.set(timerId, handle);
  }
}

export const systemSleeper: Sleeper = {
  sleep: (ms: number) => delay(ms),
};
