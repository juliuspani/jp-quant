// Universo point-in-time (quant-research §3, DATA.md §2): qué pares existían en cada fecha, con sus altas y bajas.
// Prohibido reconstruir el pasado con las monedas que sobreviven hoy: una historia sin ningún par deslistado no responde,
// y tampoco antes de la fecha desde la que la fuente trae los pares dados de baja (en los ZIP de Kraken, el 2023-01-01:
// DATA.md §5). Antes de esa fecha solo cabe un universo limitado con el sesgo declarado (limitedUniverseAt).
//
// Las bajas salen de las velas y no de la lista de pares de hoy, que es del periodo del test final (paso 23): un par sigue
// listado al final de la historia si tiene alguna vela que cierra después de `activeSince`; si no, se da de baja al cerrar
// su última vela. Las altas y bajas también se pueden sacar de los rangos de los manifiestos, sin cargar las velas.
import { toUtcIso, type UtcMillis } from '../shared/time.ts';
import type { HistoricalCandle, SymbolId } from './types.ts';

export interface Listing {
  readonly symbol: SymbolId;
  readonly listedAt: UtcMillis; // apertura de la primera vela con trades
  readonly delistedAt: UtcMillis | null; // cierre de la última, si el par dejó de negociarse antes del final
}

export interface Coverage {
  readonly source: string;
  readonly start: UtcMillis;
  readonly end: UtcMillis; // excluido
  readonly delistingsFrom: UtcMillis; // desde aquí la fuente trae los pares dados de baja; antes, sesgo de supervivencia
  readonly activeSince: UtcMillis; // un par con una vela que cierra después sigue listado al final
}

export interface ListingHistory {
  readonly source: string;
  readonly coverageStart: UtcMillis;
  readonly coverageEnd: UtcMillis; // excluido
  readonly delistingsFrom: UtcMillis;
  readonly listings: readonly Listing[];
  readonly includesDelisted: boolean;
}

/** Primera apertura y último cierre de las velas de un par. */
export interface Span {
  readonly first: UtcMillis;
  readonly last: UtcMillis;
}

export class SurvivorshipBiasError extends Error {
  override readonly name = 'SurvivorshipBiasError';
}

function checkCoverage(coverage: Coverage): void {
  for (const at of [coverage.start, coverage.end, coverage.delistingsFrom, coverage.activeSince]) toUtcIso(at);
  if (coverage.end <= coverage.start) throw new RangeError('cobertura vacía o invertida');
  if (coverage.activeSince <= coverage.start || coverage.activeSince >= coverage.end) throw new RangeError('activeSince fuera de la cobertura');
}

/** Altas y bajas a partir de la primera apertura y el último cierre de cada par. */
export function listingsFromSpans(spans: ReadonlyMap<SymbolId, Span>, coverage: Coverage): ListingHistory {
  checkCoverage(coverage);
  const listings = [...spans.entries()]
    .map(([symbol, span]) => {
      if (span.first < coverage.start || span.last > coverage.end || span.last <= span.first) {
        throw new RangeError(`${symbol}: velas de ${toUtcIso(span.first)} a ${toUtcIso(span.last)}, fuera de la cobertura declarada`);
      }
      return Object.freeze({ symbol, listedAt: span.first, delistedAt: span.last > coverage.activeSince ? null : span.last });
    })
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return Object.freeze({
    source: coverage.source,
    coverageStart: coverage.start,
    coverageEnd: coverage.end,
    delistingsFrom: coverage.delistingsFrom,
    listings: Object.freeze(listings),
    includesDelisted: listings.some((l) => l.delistedAt !== null),
  });
}

/** Altas y bajas a partir de las velas limpias de una fuente. */
export function deriveListings(candles: readonly HistoricalCandle[], coverage: Coverage): ListingHistory {
  const spans = new Map<SymbolId, Span>();
  for (const c of candles) {
    const span = spans.get(c.symbol);
    spans.set(c.symbol, {
      first: span === undefined || c.openTime < span.first ? c.openTime : span.first,
      last: span === undefined || c.closeTime > span.last ? c.closeTime : span.last,
    });
  }
  return listingsFromSpans(spans, coverage);
}

function checkAt(history: ListingHistory, at: UtcMillis): void {
  if (at < history.coverageStart || at >= history.coverageEnd) {
    throw new RangeError(`${toUtcIso(at)} está fuera de la cobertura de ${history.source}`);
  }
}

function listedAt(history: ListingHistory, at: UtcMillis): SymbolId[] {
  return history.listings.filter((l) => l.listedAt <= at && (l.delistedAt === null || at < l.delistedAt)).map((l) => l.symbol);
}

/** Pares listados en `at`. No responde sin pares deslistados ni antes de que la fuente los traiga (SurvivorshipBiasError). */
export function universeAt(history: ListingHistory, at: UtcMillis): SymbolId[] {
  if (!history.includesDelisted) {
    throw new SurvivorshipBiasError(
      `${history.source} no tiene ningún par deslistado: el universo saldría solo de los supervivientes (DATA.md §2)`,
    );
  }
  checkAt(history, at);
  if (at < history.delistingsFrom) {
    throw new SurvivorshipBiasError(
      `${history.source} no trae los pares dados de baja antes del ${toUtcIso(history.delistingsFrom)}: en ${toUtcIso(at)} el universo ` +
        'tendría sesgo de supervivencia; usa un universo limitado con el sesgo declarado',
    );
  }
  return listedAt(history, at);
}

/**
 * Universo limitado a `symbols`, elegidos de antemano: los que estaban listados en `at`. Antes de que la fuente traiga
 * las bajas, la elección tiene sesgo de supervivencia, y se devuelve el texto que el informe tiene que declarar.
 */
export function limitedUniverseAt(
  history: ListingHistory,
  symbols: readonly SymbolId[],
  at: UtcMillis,
): { readonly symbols: SymbolId[]; readonly survivorshipBias: string | null } {
  checkAt(history, at);
  const unknown = symbols.filter((s) => !history.listings.some((l) => l.symbol === s));
  if (unknown.length > 0) throw new RangeError(`pares sin velas en ${history.source}: ${unknown.join(', ')}`);
  const listed = new Set(listedAt(history, at));
  return {
    symbols: symbols.filter((s) => listed.has(s)),
    survivorshipBias:
      at < history.delistingsFrom
        ? `Universo limitado (${symbols.join(', ')}) elegido a posteriori: ${history.source} no trae los pares dados de baja antes del ` +
          `${toUtcIso(history.delistingsFrom)}, así que antes de esa fecha hay sesgo de supervivencia.`
        : null,
  };
}
