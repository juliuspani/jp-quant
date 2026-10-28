// Contratos de cartera (ARCHITECTURE.md §16.6). Viven en kernel/ porque los leen risk/ y execution/, que no pueden
// importar portfolio/ (matriz de §15.1). Importes en Decimal (ADR 0014).
import type { Notional, Price, Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';
import type { Bucket } from '../shared/trading.ts';

export interface PositionSnapshot {
  readonly symbol: SymbolId;
  readonly bucket: Bucket;
  readonly quantity: Quantity; // suma de fills menos las comisiones cobradas en el activo base
  readonly available: Quantity; // la que se puede vender ahora
  readonly costBasis: Notional;
  readonly averageEntry: Price;
  readonly realizedPnl: Notional;
  readonly dust: Quantity;
  readonly openedAt: UtcMillis;
}

export interface PortfolioSnapshot {
  readonly asOf: UtcMillis;
  readonly quoteCurrency: string;
  readonly cash: Notional;
  readonly equity: Notional;
  readonly exposure: Notional; // valor de lo que no es la moneda de cotización
  readonly exposureWithoutDust: Notional; // el mismo valor sin las posiciones que son polvo (ADR 0033); lo usa A.3.9 (ADR 0042)
  readonly positions: readonly PositionSnapshot[];
  readonly marksAsOf: UtcMillis | null; // antigüedad de los precios con que se valoró
}

export interface PortfolioView {
  snapshot(): PortfolioSnapshot;
}
