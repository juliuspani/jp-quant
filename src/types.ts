export interface Candle {
  /** Apertura de la vela, ms desde epoch (UTC). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'buy' | 'sell';

/** `core` = estrategia principal sobre monedas grandes; `scout` = explorador de low-caps. */
export type Bucket = 'core' | 'scout';

export interface Quote {
  bid: number;
  ask: number;
  last: number;
}

export interface Ticker24h extends Quote {
  symbol: string;
  changePct: number;
  /** Volumen de las últimas 24 h expresado en la moneda de cotización. */
  quoteVolume: number;
}

export interface MarketInfo {
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  minAmount: number;
  minCost: number;
}

/**
 * Resultado económico de una orden ejecutada, ya neto de comisiones:
 * en una compra `quote` es todo lo que ha salido de caja y `amount` lo que de
 * verdad ha entrado en cartera; en una venta `quote` es lo que entra en caja.
 */
export interface Fill {
  clientOrderId: string;
  orderId: string;
  symbol: string;
  side: Side;
  amount: number;
  price: number;
  quote: number;
  /** Comisión valorada en la moneda de cotización (informativa; ya incluida arriba). */
  fee: number;
  ts: number;
}

export interface Position {
  id: number;
  symbol: string;
  bucket: Bucket;
  status: 'open' | 'closed';
  amount: number;
  /** Coste total en quote de la cantidad aún abierta, comisiones incluidas. */
  costBasis: number;
  entryPrice: number;
  entryTs: number;
  stopPrice: number;
  highestPrice: number;
  realizedPnl: number;
  exitTs: number | null;
  exitReason: string | null;
  meta: Record<string, unknown>;
}

export interface Notifier {
  send(text: string): Promise<void>;
}
