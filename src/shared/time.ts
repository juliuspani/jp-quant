// Tiempo de negocio en milisegundos UTC (ARCHITECTURE.md §5.1 y §16.1). Los módulos de dinero y precios no hacen
// aritmética con number (regla inversor/no-float): la del tiempo vive aquí, con entradas validadas.
export type UtcMillis = number; // milisegundos desde epoch, UTC, enteros
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const MINUTE = 60_000;
const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '1h': 60 * MINUTE,
  '4h': 240 * MINUTE,
  '1d': 1440 * MINUTE,
};
// Solo UTC explícito: fecha y hora con «Z» final, segundos y milisegundos opcionales. Sin desfases ni hora local.
const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/;
const UNSIGNED_INTEGER = /^\d{1,15}$/;
const UNIX_SECONDS_FRACTION = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

function checkMillis(value: number, what: string): UtcMillis {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what}: no es un instante UTC en ms: ${String(value)}`);
  return value;
}

export function isTimeframe(text: string): text is Timeframe {
  return Object.hasOwn(TIMEFRAME_MS, text);
}

export function timeframeMs(timeframe: Timeframe): number {
  const ms = TIMEFRAME_MS[timeframe];
  if (ms === undefined) throw new RangeError(`timeframe desconocido: ${String(timeframe)}`);
  return ms;
}

/** «2026-10-01T00:00:00Z» → ms. Rechaza lo que no lleve «Z» y las fechas imposibles (2026-02-30). */
export function parseUtcIso(text: string): UtcMillis {
  const m = ISO_UTC.exec(text);
  if (m === null) throw new SyntaxError(`no es una fecha ISO 8601 en UTC con «Z»: ${JSON.stringify(text)}`);
  const full = `${m[1] ?? ''}:${m[2] ?? '00'}.${(m[3] ?? '').padEnd(3, '0')}Z`;
  const ms = Date.parse(full);
  // Date.parse desplaza los días imposibles; comparar con la forma canónica los descubre.
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== full) throw new RangeError(`fecha imposible: ${text}`);
  return checkMillis(ms, text);
}

export function toUtcIso(ms: UtcMillis): string {
  return new Date(checkMillis(ms, 'toUtcIso')).toISOString();
}

/** Segundos Unix en texto («1609459200») → ms. Solo dígitos: sin decimales, signo ni exponente. */
export function parseUnixSeconds(text: string): UtcMillis {
  if (!UNSIGNED_INTEGER.test(text)) throw new SyntaxError(`no son segundos Unix enteros: ${JSON.stringify(text)}`);
  return checkMillis(Number(text) * 1000, text);
}

/** Segundos Unix con decimales en texto («1781481600.1256185») → ms, truncando lo que baja del milisegundo. */
export function parseUnixSecondsFraction(text: string): UtcMillis {
  const m = UNIX_SECONDS_FRACTION.exec(text);
  if (m === null) throw new SyntaxError(`no son segundos Unix: ${JSON.stringify(text)}`);
  return checkMillis(Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0').slice(0, 3)), text);
}

/** Milisegundos Unix en texto o bigint (lo que devuelve un BIGINT de DuckDB) → ms. */
export function parseEpochMillis(value: string | bigint): UtcMillis {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (!UNSIGNED_INTEGER.test(text)) throw new SyntaxError(`no son milisegundos Unix enteros: ${JSON.stringify(text)}`);
  return checkMillis(Number(text), text);
}

export function addMs(at: UtcMillis, ms: number): UtcMillis {
  return checkMillis(at + ms, 'addMs');
}

/** Cierre de una vela que abre en `openTime`. */
export function closeTimeOf(openTime: UtcMillis, timeframe: Timeframe): UtcMillis {
  return addMs(openTime, timeframeMs(timeframe));
}

/** La vela empieza en un múltiplo de su duración desde epoch (UTC): las de 1d, a medianoche UTC. */
export function isAligned(openTime: UtcMillis, timeframe: Timeframe): boolean {
  return openTime % timeframeMs(timeframe) === 0;
}

/** Apertura de la vela de `timeframe` que contiene `at`. */
export function floorToTimeframe(at: UtcMillis, timeframe: Timeframe): UtcMillis {
  return checkMillis(at - (at % timeframeMs(timeframe)), 'floorToTimeframe');
}

/** Velas completas que caben entre dos instantes alineados (`to` excluido). */
export function barsBetween(from: UtcMillis, to: UtcMillis, timeframe: Timeframe): number {
  if (to < from) throw new RangeError(`intervalo invertido: ${String(from)} > ${String(to)}`);
  return Math.floor((to - from) / timeframeMs(timeframe));
}

/** Espera en tiempo de pared para reproducir el tramo de `from` a `to` a `speed` veces la velocidad real. */
export function scaledDurationMs(from: UtcMillis, to: UtcMillis, speed: number): number {
  if (to < from) throw new RangeError(`intervalo invertido: ${String(from)} > ${String(to)}`);
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError(`velocidad inválida: ${String(speed)} (número finito > 0)`);
  return (to - from) / speed;
}
