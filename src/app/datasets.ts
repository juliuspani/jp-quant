// DatasetPort real (ADR 0024, paso 23): une research/ con historical/, que research/ no puede importar (ARCHITECTURE.md
// §15.1). Una referencia nombra una colección del almacén con la convención de la captura (`<dataset>-<par>-<marco>-
// <etiqueta>`, src/historical/capture.ts): `dataset` es el prefijo («kraken»), `version` las etiquetas unidas con «+»
// («full2026q2+2026q3») y `timeframe` el marco.
// - El hash cubre los manifiestos de todas las partes y la regla del universo, sin cargar velas.
// - La carga devuelve un acceso perezoso: cada par se lee por la guarda del test final (que se niega antes de leer nada
//   que lo toque), se unen sus fuentes (joinParts) y se recorta al rango del experimento. readDataset comprueba el
//   SHA-256 del archivo y del contenido contra el manifiesto, que es lo que cubre el hash.
// - Las altas y bajas salen de los rangos de los manifiestos (listingsFromSpans).
import { readdirSync } from 'node:fs';
import type { TestFinalGuard } from '../historical/guard.ts';
import { joinParts } from '../historical/join.ts';
import { listVersions, type DatasetManifest } from '../historical/store.ts';
import type { HistoricalCandle } from '../historical/types.ts';
import { listingsFromSpans, type ListingHistory, type Span } from '../historical/universe.ts';
import type { DatasetPort, DatasetRef } from '../research/experiment.ts';
import { canonicalJson, sha256Hex } from '../shared/canonical.ts';
import type { SymbolId } from '../shared/symbol.ts';
import { addMs, isTimeframe, parseUtcIso, toUtcIso, type Timeframe, type UtcMillis } from '../shared/time.ts';

const FORMAT = 'inversor-datasets/1';
const NAME = /^[a-z0-9]+$/;

/** Regla del universo de una fuente: desde cuándo trae las bajas y qué cuenta como «sigue listado» al final. */
export interface UniverseCoverage {
  readonly delistingsFrom: UtcMillis;
  readonly activeSince: UtcMillis;
  readonly end: UtcMillis; // excluido: el final de la historia de investigación
}

/** Lo que entrega load(): los datos del experimento, que se leen par a par cuando el ejecutor los pide. */
export interface MarketHistory {
  readonly kind: 'market-history';
  readonly timeframe: Timeframe;
  readonly from: UtcMillis;
  readonly to: UtcMillis; // excluido
  readonly listings: ListingHistory;
  candles(symbols: readonly SymbolId[]): Promise<HistoricalCandle[]>;
}

export class DatasetError extends Error {
  override readonly name = 'DatasetError';
}

export function isMarketHistory(value: unknown): value is MarketHistory {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'market-history';
}

interface Catalog {
  readonly timeframe: Timeframe;
  readonly bySymbol: ReadonlyMap<SymbolId, readonly DatasetManifest[]>;
  readonly hash: string;
}

export class HistoricalDatasets implements DatasetPort {
  readonly #guard: TestFinalGuard;
  readonly #researchRoot: string;
  readonly #coverage: UniverseCoverage;

  constructor(options: { readonly guard: TestFinalGuard; readonly researchRoot: string; readonly coverage: UniverseCoverage }) {
    this.#guard = options.guard;
    this.#researchRoot = options.researchRoot;
    this.#coverage = options.coverage;
  }

  hash(ref: DatasetRef): string {
    return this.#catalog(ref).hash;
  }

  // Async por contrato (DatasetPort), aunque solo lee manifiestos: las velas se leen al pedirlas.
  load(ref: DatasetRef): Promise<{ readonly hash: string; readonly data: MarketHistory }> {
    const catalog = this.#catalog(ref);
    const from = parseUtcIso(ref.rango.desde);
    const to = parseUtcIso(ref.rango.hasta);
    const guard = this.#guard;
    const spans = new Map<SymbolId, Span>();
    for (const [symbol, parts] of catalog.bySymbol) {
      const starts = parts.map((m) => parseUtcIso(m.rangeUtc.start));
      const ends = parts.map((m) => parseUtcIso(m.rangeUtc.endExclusive));
      spans.set(symbol, { first: Math.min(...starts), last: Math.max(...ends) });
    }
    const coverageStart = Math.min(...[...spans.values()].map((s) => s.first));
    const listings = listingsFromSpans(spans, {
      source: `${ref.fuente} (${ref.dataset} ${ref.version} ${ref.timeframe})`,
      start: coverageStart,
      end: this.#coverage.end,
      delistingsFrom: this.#coverage.delistingsFrom,
      activeSince: this.#coverage.activeSince,
    });
    const data: MarketHistory = Object.freeze({
      kind: 'market-history',
      timeframe: catalog.timeframe,
      from,
      to,
      listings,
      async candles(symbols: readonly SymbolId[]): Promise<HistoricalCandle[]> {
        const result: HistoricalCandle[] = [];
        for (const symbol of [...new Set(symbols)].sort()) {
          const manifests = catalog.bySymbol.get(symbol);
          if (manifests === undefined) throw new DatasetError(`${symbol} no está en ${ref.dataset} ${ref.version} ${ref.timeframe}`);
          const parts = [];
          for (const manifest of manifests) parts.push({ manifest, candles: await guard.loadResearch(manifest.dataset, manifest.version) });
          result.push(...joinParts(parts).filter((c) => c.openTime >= from && c.receivedTime < to));
        }
        return result;
      },
    });
    return Promise.resolve({ hash: catalog.hash, data });
  }

  #catalog(ref: DatasetRef): Catalog {
    const labels = ref.version.split('+');
    if (!NAME.test(ref.dataset) || labels.some((l) => !NAME.test(l)) || new Set(labels).size !== labels.length) {
      throw new DatasetError(`referencia inválida: dataset «${ref.dataset}», versión «${ref.version}» (etiquetas unidas con «+»)`);
    }
    const timeframe = ref.timeframe;
    if (!isTimeframe(timeframe)) throw new DatasetError(`timeframe desconocido: ${timeframe}`);
    const from = parseUtcIso(ref.rango.desde);
    const to = parseUtcIso(ref.rango.hasta);
    if (to <= from) throw new DatasetError('rango vacío o invertido');
    if (to > this.#coverage.end) throw new DatasetError(`el rango acaba el ${ref.rango.hasta}, después del final de la historia (${toUtcIso(this.#coverage.end)})`);
    const pattern = new RegExp(`^${ref.dataset}-([a-z0-9]+)-${ref.timeframe}-(${labels.join('|')})$`);
    const bySymbol = new Map<SymbolId, DatasetManifest[]>();
    const parts: unknown[] = [];
    for (const name of readdirSync(this.#researchRoot).filter((n) => pattern.test(n)).sort()) {
      const versions = listVersions(this.#researchRoot, name);
      const [manifest, extra] = versions;
      if (manifest === undefined || extra !== undefined) throw new DatasetError(`${name}: ${String(versions.length)} versiones; se espera una (los datasets no se reescriben)`);
      const [symbol, other] = manifest.symbols;
      if (symbol === undefined || other !== undefined) throw new DatasetError(`${name}: una parte es de un solo par`);
      bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), manifest]);
      parts.push({
        dataset: manifest.dataset,
        version: manifest.version,
        symbol,
        timeframe: manifest.timeframe,
        rangeUtc: manifest.rangeUtc,
        receivedLatencyMs: manifest.receivedLatencyMs,
        rows: manifest.rows,
        contentSha256: manifest.contentSha256,
      });
    }
    if (bySymbol.size === 0) throw new DatasetError(`no hay datasets ${ref.dataset}-*-${ref.timeframe}-(${labels.join('|')})`);
    const hash = sha256Hex(canonicalJson({
      format: FORMAT,
      fuente: ref.fuente,
      dataset: ref.dataset,
      version: ref.version,
      timeframe: ref.timeframe,
      rango: { desde: toUtcIso(from), hasta: toUtcIso(to) },
      coverage: { delistingsFrom: this.#coverage.delistingsFrom, activeSince: this.#coverage.activeSince, end: this.#coverage.end },
      parts,
    }));
    return { timeframe, bySymbol, hash };
  }
}

/** Regla del universo de los ZIP de Kraken (DATA.md §5): bajas desde el 2023-01-01; «sigue listado» si opera el último día. */
export function krakenCoverage(delistingsFromUtc: string, researchEndExclusiveUtc: string): UniverseCoverage {
  const end = parseUtcIso(researchEndExclusiveUtc);
  return { delistingsFrom: parseUtcIso(delistingsFromUtc), activeSince: addMs(end, -2 * 86_400_000), end };
}
