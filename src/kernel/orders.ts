// Contratos del camino Strategy → Risk → Execution (ARCHITECTURE.md §16.5 a §16.7, trading-risk §2). Viven en kernel/
// porque cruzan módulos que no se importan entre sí (§15.1). El tipo marcado ApprovedOrder y la verificación del
// token no están aquí: solo los da src/risk/approval.ts (trading-risk §2.3).
import type { Notional, Price, Quantity } from '../shared/decimal.ts';
import type { SymbolId } from '../shared/symbol.ts';
import type { UtcMillis } from '../shared/time.ts';
import type { Bucket, Side } from '../shared/trading.ts';
import type { ReasonCode } from './reason-codes.ts';

export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit';
export type IntentOrigin = 'strategy' | 'manual' | 'system';

export interface OrderIntent {
  readonly intentId: string;
  readonly origin: IntentOrigin;
  readonly strategyId: string | null;
  readonly strategyVersion: string | null;
  readonly bucket: Bucket;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly kind: 'entry' | 'exit' | 'protective_stop' | 'stop_update';
  readonly reduceOnly: boolean; // true en todo lo que no es una entrada
  readonly sizing: { readonly mode: 'risk' } | { readonly mode: 'quantity'; readonly quantity: Quantity } | { readonly mode: 'all' };
  readonly stopPrice: Price | null; // obligatorio en entradas y stops (STOP_INVALID)
  readonly reason: string;
  readonly signalTime: UtcMillis; // cierre de la vela de la señal (SIGNAL_TOO_OLD)
}

/** Medidas, límites y marcas de tiempo de los datos usados (trading-risk §9.1). */
export type DecisionDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface RiskDecision {
  readonly decisionId: string;
  readonly intentId: string;
  readonly decision: 'APPROVED' | 'REDUCED' | 'REJECTED';
  readonly reasonCode: ReasonCode | null; // el principal, según el orden de trading-risk §9.3
  readonly reasonCodes: readonly ReasonCode[];
  readonly approvedQuantity: Quantity | null;
  readonly approvedNotional: Notional | null;
  readonly detail: DecisionDetail;
  readonly configHash: string;
  readonly commit: string;
}

export interface TradingState {
  readonly killSwitch: boolean;
  readonly entriesBlockedBy: readonly ReasonCode[];
  readonly exitsBlockedBy: readonly ReasonCode[];
}
export interface RiskView {
  tradingState(): TradingState;
}

// Token de trading-risk §2.2. Viaja en JSON canónico; los Decimal, como cadena. approval_id es un UUID: de él sale el
// client order ID (exchange-execution §5.1).
export interface SignedApproval {
  readonly approval_id: string;
  readonly intent_id: string;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly type: OrderType;
  readonly max_quantity: string;
  readonly max_notional: string | null; // solo en compras
  readonly trigger_price: string | null; // precio de disparo, solo en los stops de protección (paso 23); null en el resto
  readonly reduce_only: boolean;
  readonly issued_at: UtcMillis;
  readonly expires_at: UtcMillis;
  readonly config_hash: string;
  readonly signature: string; // Ed25519, base64url
}
