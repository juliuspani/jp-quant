// Catálogo cerrado de reason_code (trading-risk §9.2), con la capa que lo emite según el catálogo. Es la misma lista y
// en el mismo orden que el skill: test/src/kernel/reason-codes.test.ts falla si se separan. Un código nuevo exige
// añadirlo en el skill, aquí y en las pruebas. El archivo empieza por un export: `node --check` trata como CommonJS
// un .ts cuya primera sentencia no es import ni export, y entonces no entiende `as const`.
export type DecisionLayer = 'risk' | 'execution' | 'capguard' | 'exchange';

const CATALOG = {
  KILL_SWITCH_ACTIVE: 'risk',
  CONFIG_INVALID: 'risk',
  INTERNAL_ERROR: 'risk',
  STATE_UNRECONCILED: 'risk',
  DECISION_LOG_UNAVAILABLE: 'risk',
  MANUAL_PAUSE: 'risk',
  DAILY_LOSS_LIMIT: 'risk',
  DRAWDOWN_HALT: 'risk',
  LOSS_STREAK_COOLDOWN: 'risk',
  SLIPPAGE_BREAKER: 'risk',
  STALE_DATA: 'risk',
  SIGNAL_TOO_OLD: 'risk',
  CLOCK_SKEW: 'risk',
  EXCHANGE_UNHEALTHY: 'risk',
  EVENT_RISK: 'risk',
  MARKET_NOT_ALLOWED: 'risk',
  SPREAD_TOO_WIDE: 'risk',
  LIQUIDITY_TOO_LOW: 'risk',
  SLIPPAGE_TOO_HIGH: 'risk',
  STOP_INVALID: 'risk',
  RISK_PER_TRADE: 'risk',
  MAX_EXPOSURE: 'risk',
  MAX_OPEN_POSITIONS: 'risk',
  CONCENTRATION_LIMIT: 'risk',
  CORRELATION_LIMIT: 'risk',
  INSUFFICIENT_CASH: 'risk',
  BELOW_MIN_NOTIONAL: 'risk',
  REDUCE_ONLY_VIOLATION: 'risk',
  PROTECTIVE_STOP_MISSING: 'risk',
  LIVE_TRADING_DISABLED: 'execution',
  APPROVAL_MISSING: 'execution',
  APPROVAL_BAD_SIGNATURE: 'execution',
  APPROVAL_EXPIRED: 'execution',
  APPROVAL_REPLAYED: 'execution',
  APPROVAL_MISMATCH: 'execution',
  EXEC_STATE_UNKNOWN: 'execution',
  EXEC_ORPHAN_ORDER: 'execution',
  EXEC_MARKET_RULES: 'execution',
  EXEC_RATE_LIMITED: 'execution',
  CAP_UNAVAILABLE: 'capguard',
  CAP_ORDER_NOTIONAL: 'capguard',
  CAP_EXPOSURE: 'capguard',
  CAP_LOSS_LOCK: 'capguard',
  CAP_MARKET_NOT_ALLOWED: 'capguard',
  CAP_BALANCE_MISMATCH: 'capguard',
  EXCHANGE_REJECTED: 'exchange',
} as const satisfies Readonly<Record<string, DecisionLayer>>;

export type ReasonCode = keyof typeof CATALOG;

export const REASON_CODES: readonly ReasonCode[] = Object.freeze(Object.keys(CATALOG) as ReasonCode[]);

export function isReasonCode(text: string): text is ReasonCode {
  return Object.hasOwn(CATALOG, text);
}

/** Capa que emite el código según el catálogo. */
export function catalogLayer(code: ReasonCode): DecisionLayer {
  return CATALOG[code];
}
