// Estado del dashboard (paso 41B, ADR 0045): una proyección de solo lectura del diario. No ejecuta nada ni cambia nada;
// solo cuenta lo que el diario dice que pasó. Los importes salen de los fills en Decimal; la curva y el benchmark, que
// solo se dibujan, en float. Las posiciones se valoran al último cierre del diario, sin los costes de venderlas.
// Las alertas se derivan de hechos con una tabla fija (ARCHITECTURE.md §12): ALERT_RULES.
import { buyAndHold } from '../analytics/benchmark.ts';
import { TERMINAL_STATES, type OrderState } from '../kernel/execution.ts';
import { Decimal } from '../shared/decimal.ts';
import type { UtcMillis } from '../shared/time.ts';
import { t } from './i18n.ts';
import { DashboardError, field, flag, integer, object, text, textOrNull, type JsonObject, type ReplayJournal } from './journal.ts';

const SCALE = 12;
const ZERO = Decimal.parse('0');
const ONE = Decimal.parse('1');
const MAX_ROWS = 50; // operaciones, rechazos y alertas: las más recientes
const MAX_ALERTS = 20;
const MAX_MARKS = 500; // marcas de la reproducción (paso 49): las más recientes, para acotar la página
// Estados de exchange-execution §4.1: el compilador comprueba que cada uno es un OrderState.
const ORDER_STATES: ReadonlySet<string> = new Set([
  'PENDING_SEND', 'SENT', 'OPEN', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'NOT_SENT', 'UNKNOWN',
] as const satisfies readonly OrderState[]);

function isOrderState(value: string): value is OrderState {
  return ORDER_STATES.has(value);
}

/** El modo lo decide app/ (ARCHITECTURE.md §14); el dashboard solo lo muestra. REPLAY es la versión local del paso 41B. */
export type DashboardMode = 'REPLAY' | 'PAPER' | 'SHADOW' | 'LIVE';
export type AlertLevel = 'CRITICAL' | 'WARNING' | 'INFO';

export interface DashboardContext {
  readonly mode: DashboardMode;
  readonly label: string; // qué se está viendo, p. ej. «Demostración con datos sintéticos»
  readonly synthetic: boolean; // datos de demostración: la página lleva su marca de agua (paso 41C)
  readonly strategy: { readonly id: string; readonly version: string; readonly params: Readonly<Record<string, string | number>> };
  readonly benchmark: { readonly symbol: string; readonly costRate: number; readonly maxStaleMs: number };
  readonly planB: { readonly target: Readonly<Record<string, string>> | null; readonly nextRebalanceAt: UtcMillis | null };
  readonly feedMaxAgeMs: number; // un feed cuyo último cierre es más antiguo, respecto al instante del estado, está retrasado
  readonly clientOrderIdOf: (approvalId: string) => string; // la de execution/, que monitoring/ no puede importar
}

export interface FeedHealth {
  readonly symbol: string;
  readonly candles: number;
  readonly lastCloseAt: UtcMillis | null;
  readonly lastReceivedAt: UtcMillis | null;
  readonly gaps: number;
  readonly discarded: number;
  readonly stale: boolean;
}

export interface PositionRow {
  readonly symbol: string;
  readonly quantity: string;
  readonly averageEntry: string;
  readonly lastClose: string;
  readonly value: string;
  readonly unrealizedPnl: string;
  readonly protectiveStop: string | null; // disparo del stop que espera en el exchange; null: posición sin proteger
}

export interface OrderRow {
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: string;
  readonly type: string;
  readonly kind: string;
  readonly state: OrderState;
  readonly quantity: string | null; // null: el diario no tiene la aprobación de esta orden (SEC-02)
  readonly filled: string;
  readonly triggerPrice: string | null;
  readonly updatedAt: UtcMillis;
}

export interface TradeRow {
  readonly at: UtcMillis;
  readonly symbol: string;
  readonly side: string;
  readonly kind: string;
  readonly quantity: string;
  readonly price: string;
  readonly notional: string;
  readonly fee: string;
  readonly reason: string;
}

export interface RejectionRow {
  readonly at: UtcMillis;
  readonly layer: string;
  readonly decision: string;
  readonly reasonCode: string;
  readonly reasonCodes: readonly string[];
  readonly symbol: string | null;
  readonly side: string | null;
  readonly kind: string | null;
}

/** Una marca de la curva para la reproducción (paso 49): una operación o una orden frenada por el control de riesgo. */
export interface CurveMark {
  readonly at: UtcMillis;
  readonly kind: 'buy' | 'sell' | 'risk';
  readonly symbol: string | null;
  readonly detail: string; // importe de la operación o reason_code del rechazo
}

export interface StrategyRow {
  readonly id: string;
  readonly version: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly state: 'activa' | 'detenida';
  readonly evaluations: number;
  readonly intents: number;
  readonly last: readonly { readonly symbol: string; readonly at: UtcMillis; readonly action: string | null; readonly reason: string | null }[];
}

export interface Alert {
  readonly at: UtcMillis;
  readonly level: AlertLevel;
  readonly message: string;
}

/** Lo que requiere atención, en lenguaje claro: CRITICAL si el sistema no opera como debe, WARNING si hay que mirarlo. */
export interface AttentionItem {
  readonly level: Exclude<AlertLevel, 'INFO'>;
  readonly message: string;
}

export interface AllocationRow {
  readonly asset: string;
  readonly value: string;
  readonly current: string; // fracción del patrimonio
  readonly target: string | null;
  readonly deviation: string | null; // actual menos objetivo
}

export interface DashboardSnapshot {
  readonly mode: DashboardMode;
  readonly label: string;
  readonly synthetic: boolean;
  readonly runId: string;
  readonly asOf: UtcMillis;
  readonly quoteCurrency: string;
  readonly health: {
    readonly trading: 'operando' | 'detenido' | 'sin empezar';
    readonly haltedReason: string | null;
    readonly killSwitch: boolean;
    readonly executionMode: string;
    readonly events: number;
    readonly feeds: readonly FeedHealth[];
    readonly reconciliation: { readonly count: number; readonly lastAt: UtcMillis | null; readonly lastResolved: boolean | null };
  };
  readonly account: {
    readonly startingCash: string;
    readonly equity: string;
    readonly cash: string;
    readonly exposure: string;
    readonly exposureFraction: string;
    readonly pnl: string;
    readonly pnlFraction: string;
    readonly realizedPnl: string;
    readonly fees: string;
    readonly maxDrawdown: string;
    readonly drawdown: string;
  };
  readonly positions: readonly PositionRow[];
  readonly orders: { readonly open: readonly OrderRow[]; readonly byState: Readonly<Record<string, number>> };
  readonly curve: {
    readonly at: readonly UtcMillis[];
    readonly equity: readonly number[];
    readonly benchmark: readonly number[] | null;
    readonly benchmarkSymbol: string;
    readonly benchmarkNote: string | null; // por qué no hay benchmark
    readonly marks: readonly CurveMark[]; // en orden de tiempo, como mucho MAX_MARKS (las más recientes)
  };
  readonly trades: readonly TradeRow[];
  readonly tradesTotal: number;
  readonly rejections: readonly RejectionRow[];
  readonly rejectionsTotal: number;
  readonly strategies: readonly StrategyRow[];
  readonly alerts: readonly Alert[];
  readonly attention: readonly AttentionItem[]; // vacío: todo en orden
  readonly alertCounts: Readonly<Record<AlertLevel, number>>;
  readonly planB: {
    readonly contributions: string;
    readonly contributionsNote: string;
    readonly allocation: readonly AllocationRow[];
    readonly hasTarget: boolean;
    readonly nextRebalanceAt: UtcMillis | null;
  };
}

/** Reglas fijas de alertas: tipo de evento → nivel y mensaje, o null si ese evento no alerta. */
const ALERT_RULES: Readonly<Record<string, (p: JsonObject, where: string) => { level: AlertLevel; message: string } | null>> = {
  TradingHalted: (p, w) => ({ level: 'CRITICAL', message: `${t('Trading detenido', 'Trading halted')}: ${text(p, 'reason', w)}` }),
  KillSwitchChanged: (p, w) => (flag(p, 'active', w) ? { level: 'CRITICAL', message: t('Kill switch activado', 'Kill switch on') } : { level: 'WARNING', message: t('Kill switch desactivado', 'Kill switch off') }),
  ReconciliationCompleted: (p, w) => (flag(p, 'resolved', w) ? null : { level: 'CRITICAL', message: `${t('Reconciliación sin resolver', 'Unresolved reconciliation')}: ${textOrNull(p, 'reason', w) ?? t('sin motivo', 'no reason')}` }),
  ExecutionModeChanged: (p, w) => ({ level: 'CRITICAL', message: `${t('Execution en', 'Execution in')} ${text(p, 'mode', w)}: ${textOrNull(p, 'reason', w) ?? t('sin motivo', 'no reason')}` }),
  ExecutionRejected: (p, w) => ({ level: 'WARNING', message: `${t('Rechazo de', 'Rejection by')} ${text(p, 'layer', w)}: ${text(p, 'reasonCode', w)}` }),
  VenueRequestFailed: (p, w) => ({ level: 'WARNING', message: `${t('Fallo del venue', 'Venue failure')} (${text(p, 'operation', w)}): ${text(p, 'errorClass', w)}` }),
  MarketDataGap: (p, w) => ({ level: 'WARNING', message: `${t('Hueco de datos en', 'Data gap in')} ${text(p, 'symbol', w)}` }),
  MarketDataDiscarded: (p, w) => ({ level: 'WARNING', message: `${t('Dato descartado', 'Data discarded')} (${text(p, 'kind', w)}): ${text(p, 'reason', w)}` }),
  RiskDecisionMade: (p, w) => (text(p, 'decision', w) === 'APPROVED' ? null : { level: 'INFO', message: `Risk: ${text(p, 'decision', w)} ${t('por', 'by')} ${textOrNull(p, 'reasonCode', w) ?? t('sin código', 'no code')}` }),
};

function decimal(object_: JsonObject, key: string, where: string): Decimal {
  const value = text(object_, key, where);
  try {
    return Decimal.parse(value);
  } catch (error) {
    throw new DashboardError(`${where}: «${key}» no es un decimal`, { cause: error });
  }
}

function fraction(part: Decimal, whole: Decimal): Decimal {
  return whole.isPositive() ? part.div(whole, SCALE, 'HALF_EVEN') : ZERO;
}

function baseOf(symbol: string): string {
  const slash = symbol.indexOf('/');
  if (slash <= 0) throw new DashboardError(`símbolo sin base: ${symbol}`);
  return symbol.slice(0, slash);
}

interface Held {
  quantity: Decimal;
  cost: Decimal; // coste de lo que queda, con comisiones (coste medio)
}

interface Approval {
  readonly intentId: string;
  readonly symbol: string;
  readonly side: string;
  readonly type: string;
  readonly quantity: string;
  readonly triggerPrice: string | null;
}

interface Intent {
  readonly symbol: string;
  readonly side: string;
  readonly kind: string;
  readonly reason: string;
}

/** Construye el estado del dashboard a partir del diario. Lanza DashboardError si el diario no se entiende. */
export function buildDashboard(journal: ReplayJournal, context: DashboardContext): DashboardSnapshot {
  const events = journal.events;
  const last = events.at(-1);
  if (last === undefined) throw new DashboardError('diario sin eventos');
  const asOf = last.receivedTime;

  let quoteCurrency: string | null = null;
  let startingCash: Decimal | null = null;
  let cash = ZERO;
  let fees = ZERO;
  let realized = ZERO;
  const held = new Map<string, Held>();
  const closes = new Map<string, { close: Decimal; points: { at: UtcMillis; close: number }[]; received: { at: UtcMillis; close: Decimal }[] }>();
  const feeds = new Map<string, { candles: number; lastCloseAt: UtcMillis | null; lastReceivedAt: UtcMillis | null; gaps: number; discarded: number }>();
  const feed = (symbol: string): { candles: number; lastCloseAt: UtcMillis | null; lastReceivedAt: UtcMillis | null; gaps: number; discarded: number } => {
    const existing = feeds.get(symbol);
    if (existing !== undefined) return existing;
    const created = { candles: 0, lastCloseAt: null, lastReceivedAt: null, gaps: 0, discarded: 0 };
    feeds.set(symbol, created);
    return created;
  };
  const intents = new Map<string, Intent>();
  const approvals = new Map<string, Approval>(); // por client order ID
  const orders = new Map<string, { state: OrderState; filled: string; updatedAt: UtcMillis }>();
  const trades: TradeRow[] = [];
  const rejections: RejectionRow[] = [];
  const alerts: Alert[] = [];
  const lastEvaluation = new Map<string, { at: UtcMillis; action: string | null; reason: string | null }>();
  let evaluations = 0;
  let intentCount = 0;
  let halted: string | null = null;
  let killSwitch = false;
  let executionMode = 'UNKNOWN'; // Execution arranca en UNKNOWN hasta la primera reconciliación (exchange-execution §16)
  const reconciliation = { count: 0, lastAt: null as UtcMillis | null, lastResolved: null as boolean | null };
  // Caja y cantidades en cada instante evaluado. Se valoran al final, con los cierres recibidos hasta ese instante: el
  // diario anota las velas que llegan a la vez después de evaluar la primera (auditoría quant Q-01).
  const samples: { at: UtcMillis; cash: Decimal; quantities: [string, Decimal][] }[] = [];

  for (const event of events) {
    const where = `${event.type} #${String(event.seq)}`;
    const p = event.payload;
    // Solo las reglas propias de la tabla: con «constructor» o «toString», un objeto literal devolvería las heredadas (SEC-01).
    const rule = Object.hasOwn(ALERT_RULES, event.type) ? ALERT_RULES[event.type] : undefined;
    if (rule !== undefined) {
      const alert = rule(p, where);
      if (alert !== null) alerts.push({ at: event.receivedTime, ...alert });
    }
    switch (event.type) {
      case 'RawMarketDataReceived': {
        const symbol = text(p, 'symbol', where);
        const close = decimal(p, 'close', where);
        const series = closes.get(symbol) ?? { close, points: [], received: [] };
        series.close = close;
        series.points.push({ at: integer(p, 'closeTime', where), close: close.toAnalysis() });
        series.received.push({ at: event.receivedTime, close });
        closes.set(symbol, series);
        const f = feed(symbol);
        f.candles += 1;
        f.lastCloseAt = integer(p, 'closeTime', where);
        f.lastReceivedAt = event.receivedTime;
        break;
      }
      case 'MarketDataGap':
        feed(text(p, 'symbol', where)).gaps += 1;
        break;
      case 'MarketDataDiscarded': {
        const symbol = textOrNull(p, 'symbol', where);
        if (symbol !== null) feed(symbol).discarded += 1;
        break;
      }
      case 'AccountSnapshotReceived':
        if (startingCash === null) {
          const balances = object(field(p, 'balances', where), `${where}: balances`);
          const funded = Object.keys(balances).map((currency) => ({ currency, amount: decimal(balances, currency, where) })).filter((b) => b.amount.isPositive());
          const [only] = funded;
          if (funded.length !== 1 || only === undefined) throw new DashboardError(`${where}: el dashboard necesita una sola moneda con saldo al empezar`);
          quoteCurrency = only.currency;
          startingCash = only.amount;
          cash = startingCash;
        }
        break;
      case 'ReconciliationCompleted':
        reconciliation.count += 1;
        reconciliation.lastAt = event.receivedTime;
        reconciliation.lastResolved = flag(p, 'resolved', where);
        executionMode = text(p, 'mode', where);
        break;
      case 'ExecutionModeChanged':
        executionMode = text(p, 'mode', where);
        break;
      case 'KillSwitchChanged':
        killSwitch = flag(p, 'active', where);
        break;
      case 'TradingHalted':
        halted ??= text(p, 'reason', where);
        break;
      case 'StrategyEvaluated': {
        evaluations += 1;
        lastEvaluation.set(text(p, 'symbol', where), { at: event.receivedTime, action: textOrNull(p, 'action', where), reason: textOrNull(p, 'reason', where) });
        // Una marca del patrimonio por instante evaluado, como la curva de la cartera (app/trading-system.ts).
        const sample = { at: event.receivedTime, cash, quantities: [...held].map(([symbol, h]): [string, Decimal] => [symbol, h.quantity]) };
        if (samples.at(-1)?.at === sample.at) samples.pop();
        samples.push(sample);
        break;
      }
      case 'OrderIntentCreated':
        intentCount += 1;
        intents.set(text(p, 'intentId', where), {
          symbol: text(p, 'symbol', where), side: text(p, 'side', where), kind: text(p, 'kind', where), reason: text(p, 'reason', where),
        });
        break;
      case 'RiskDecisionMade':
        if (text(p, 'decision', where) !== 'APPROVED') {
          const intent = intents.get(text(p, 'intentId', where)) ?? null;
          const codes = field(p, 'reasonCodes', where);
          if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string')) throw new DashboardError(`${where}: reasonCodes no es una lista de textos`);
          rejections.push({
            at: event.receivedTime, layer: 'risk', decision: text(p, 'decision', where), reasonCode: textOrNull(p, 'reasonCode', where) ?? 'sin código',
            reasonCodes: codes, symbol: intent?.symbol ?? null, side: intent?.side ?? null, kind: intent?.kind ?? null,
          });
        }
        break;
      case 'ExecutionRejected': {
        const intent = intents.get(textOrNull(p, 'intentId', where) ?? '') ?? null;
        const code = text(p, 'reasonCode', where);
        rejections.push({
          at: event.receivedTime, layer: text(p, 'layer', where), decision: 'REJECTED', reasonCode: code, reasonCodes: [code],
          symbol: textOrNull(p, 'symbol', where), side: textOrNull(p, 'side', where), kind: intent?.kind ?? null,
        });
        break;
      }
      case 'OrderApproved':
        approvals.set(context.clientOrderIdOf(text(p, 'approval_id', where)), {
          intentId: text(p, 'intent_id', where), symbol: text(p, 'symbol', where), side: text(p, 'side', where), type: text(p, 'type', where),
          quantity: text(p, 'max_quantity', where), triggerPrice: textOrNull(p, 'trigger_price', where),
        });
        break;
      case 'OrderStateChanged': {
        const state = text(p, 'state', where);
        if (!isOrderState(state)) throw new DashboardError(`${where}: estado de orden desconocido ${state}`);
        orders.set(text(p, 'clientOrderId', where), { state, filled: decimal(p, 'filled', where).toString(), updatedAt: event.receivedTime });
        break;
      }
      case 'FillRecorded': {
        if (quoteCurrency === null) throw new DashboardError(`${where}: fill antes de la foto inicial de la cuenta`);
        const feeCurrency = text(p, 'feeCurrency', where);
        if (feeCurrency !== quoteCurrency) throw new DashboardError(`${where}: comisión en ${feeCurrency}; el dashboard solo valora ${quoteCurrency}`);
        const symbol = text(p, 'symbol', where);
        const side = text(p, 'side', where);
        const quantity = decimal(p, 'quantity', where);
        const price = decimal(p, 'price', where);
        const fee = decimal(p, 'fee', where);
        const notional = quantity.times(price);
        const h = held.get(symbol) ?? { quantity: ZERO, cost: ZERO };
        if (side === 'buy') {
          h.quantity = h.quantity.plus(quantity);
          h.cost = h.cost.plus(notional).plus(fee);
          cash = cash.minus(notional).minus(fee);
        } else if (side === 'sell') {
          if (quantity.gt(h.quantity)) throw new DashboardError(`${where}: vende más ${symbol} del que hay (solo spot)`);
          const released = h.cost.times(quantity.div(h.quantity, SCALE, 'HALF_EVEN'));
          realized = realized.plus(notional).minus(fee).minus(released);
          h.cost = h.cost.minus(released);
          h.quantity = h.quantity.minus(quantity);
          cash = cash.plus(notional).minus(fee);
        } else throw new DashboardError(`${where}: lado desconocido ${side}`);
        fees = fees.plus(fee);
        if (h.quantity.isZero()) held.delete(symbol);
        else held.set(symbol, h);
        const approval = approvals.get(text(p, 'clientOrderId', where));
        const intent = approval === undefined ? undefined : intents.get(approval.intentId);
        trades.push({
          at: integer(p, 'exchangeTime', where), symbol, side, kind: intent?.kind ?? 'sin intención', quantity: quantity.toString(), price: price.toString(),
          notional: notional.toString(), fee: fee.toString(), reason: intent?.reason ?? 'sin motivo en el diario',
        });
        break;
      }
      default:
        break;
    }
  }

  if (startingCash === null || quoteCurrency === null) throw new DashboardError('el diario no tiene la foto inicial de la cuenta');
  const start = startingCash;
  const quote = quoteCurrency;

  const closeAt = (symbol: string, at: UtcMillis): Decimal => {
    let found = ZERO;
    for (const point of closes.get(symbol)?.received ?? []) {
      if (point.at > at) break;
      found = point.close;
    }
    return found;
  };
  const curve = samples.map((s) => ({ at: s.at, equity: s.quantities.reduce((total, [symbol, quantity]) => total.plus(quantity.times(closeAt(symbol, s.at))), s.cash) }));

  const byState: Record<string, number> = {};
  const open: OrderRow[] = [];
  for (const [clientOrderId, order] of orders) {
    byState[order.state] = (byState[order.state] ?? 0) + 1;
    if (TERMINAL_STATES.has(order.state)) continue;
    const approval = approvals.get(clientOrderId);
    open.push({
      clientOrderId, symbol: approval?.symbol ?? '?', side: approval?.side ?? '?', type: approval?.type ?? '?',
      kind: (approval === undefined ? undefined : intents.get(approval.intentId)?.kind) ?? '?', state: order.state,
      quantity: approval?.quantity ?? null, filled: order.filled, triggerPrice: approval?.triggerPrice ?? null, updatedAt: order.updatedAt,
    });
  }
  // Solo cuenta como protección un stop que el exchange ya tiene (OPEN): uno enviado sin confirmar no protege aún.
  const stops = new Map(open.filter((o) => o.state === 'OPEN' && o.triggerPrice !== null).map((o) => [o.symbol, o.triggerPrice]));

  const positions: PositionRow[] = [...held.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([symbol, h]) => {
    const close = closes.get(symbol)?.close ?? ZERO;
    const worth = h.quantity.times(close);
    return {
      symbol, quantity: h.quantity.toString(), averageEntry: h.cost.div(h.quantity, SCALE, 'HALF_EVEN').toString(), lastClose: close.toString(),
      value: worth.toString(), unrealizedPnl: worth.minus(h.cost).toString(), protectiveStop: stops.get(symbol) ?? null,
    };
  });
  const exposure = positions.reduce((total, row) => total.plus(Decimal.parse(row.value)), ZERO);
  const equity = cash.plus(exposure);

  let peak: Decimal | null = null;
  let maxDrawdown = ZERO;
  let drawdown = ZERO;
  for (const point of [start, ...curve.map((c) => c.equity), equity]) {
    if (peak === null || point.gt(peak)) peak = point;
    drawdown = peak.isPositive() ? peak.minus(point).div(peak, SCALE, 'HALF_EVEN') : ZERO;
    if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;
  }

  const sampleAt = curve.map((point) => point.at);
  let benchmark: readonly number[] | null = null;
  let benchmarkNote: string | null = null;
  const reference = closes.get(context.benchmark.symbol);
  const firstSample = sampleAt[0];
  if (reference === undefined) benchmarkNote = `${context.benchmark.symbol} ${t('no está en el diario', 'is not in the journal')}`;
  else if (firstSample === undefined) benchmarkNote = t('el sistema aún no ha evaluado ninguna vela', 'the system has not evaluated any candle yet');
  else {
    benchmark = buyAndHold({
      prices: new Map([[context.benchmark.symbol, reference.points]]), from: firstSample, samples: sampleAt, capital: start.toAnalysis(),
      costRate: context.benchmark.costRate, maxStaleMs: context.benchmark.maxStaleMs,
    }).equity;
  }

  const contributionsNote = t('Capital inicial del run (la foto inicial de la cuenta). El replay no tiene aportaciones periódicas.', 'Starting capital of the run (the first account snapshot). The replay has no periodic contributions.');
  const allocation: AllocationRow[] = [
    { asset: quote, worth: cash },
    ...positions.map((row) => ({ asset: baseOf(row.symbol), worth: Decimal.parse(row.value) })),
  ].map(({ asset, worth }) => {
    const current = fraction(worth, equity);
    const weights = context.planB.target;
    const targetText = weights !== null && Object.hasOwn(weights, asset) ? weights[asset] : undefined;
    const target = weights === null ? null : Decimal.parse(targetText ?? '0');
    return { asset, value: worth.toString(), current: current.toString(), target: target?.toString() ?? null, deviation: target === null ? null : current.minus(target).toString() };
  });
  if (context.planB.target !== null) {
    for (const [asset, target] of Object.entries(context.planB.target)) {
      if (!allocation.some((row) => row.asset === asset)) {
        allocation.push({ asset, value: '0', current: '0', target: Decimal.parse(target).toString(), deviation: ZERO.minus(Decimal.parse(target)).toString() });
      }
    }
  }

  const marks: CurveMark[] = [
    ...trades.map((t): CurveMark => ({ at: t.at, kind: t.side === 'sell' ? 'sell' : 'buy', symbol: t.symbol, detail: t.notional })),
    ...rejections.map((r): CurveMark => ({ at: r.at, kind: 'risk', symbol: r.symbol, detail: r.reasonCode })),
  ].sort((a, b) => a.at - b.at).slice(-MAX_MARKS);
  const newestFirst = <T extends { readonly at: UtcMillis }>(rows: readonly T[], max: number): T[] => [...rows].reverse().slice(0, max);
  const alertCounts: Record<AlertLevel, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const alert of alerts) alertCounts[alert.level] += 1;

  const trading: DashboardSnapshot['health']['trading'] = halted !== null ? 'detenido' : evaluations === 0 ? 'sin empezar' : 'operando';
  const feedRows = [...feeds.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([symbol, f]) => ({
    symbol, ...f, stale: f.lastCloseAt === null || asOf - f.lastCloseAt > context.feedMaxAgeMs,
  }));
  // Lo mismo que muestran salud, feeds y posiciones, dicho en una lista para el resumen de arriba.
  const attention: AttentionItem[] = [];
  const critical = (message: string): number => attention.push({ level: 'CRITICAL', message });
  const warning = (message: string): number => attention.push({ level: 'WARNING', message });
  if (halted !== null) critical(t(`el sistema se ha detenido (${halted})`, `the system has halted (${halted})`));
  if (killSwitch) critical(t('el freno de emergencia (kill switch) está activado', 'the emergency brake (kill switch) is on'));
  if (executionMode !== 'NORMAL') critical(t(`la ejecución de órdenes está en modo ${executionMode}`, `order execution is in ${executionMode} mode`));
  if (reconciliation.lastResolved === false) critical(t('las cuentas no cuadran con el exchange (reconciliación sin resolver)', 'the books do not match the exchange (unresolved reconciliation)'));
  else if (reconciliation.lastResolved === null) warning(t('aún no se ha comprobado que las cuentas cuadren con el exchange', 'the books have not been checked against the exchange yet'));
  for (const f of feedRows) {
    if (f.stale) warning(t(`los datos de ${f.symbol} llegan con retraso`, `${f.symbol} data is arriving late`));
    if (f.gaps > 0) warning(t(`${String(f.gaps)} ${f.gaps === 1 ? 'hueco' : 'huecos'} en los datos de ${f.symbol}`, `${String(f.gaps)} ${f.gaps === 1 ? 'gap' : 'gaps'} in the ${f.symbol} data`));
  }
  for (const row of positions) if (row.protectiveStop === null) warning(t(`la posición en ${row.symbol} no tiene stop de protección`, `the ${row.symbol} position has no protective stop`));
  const snapshot: DashboardSnapshot = {
    mode: context.mode,
    label: context.label,
    synthetic: context.synthetic,
    runId: journal.runId,
    asOf,
    quoteCurrency: quote,
    health: {
      trading,
      haltedReason: halted,
      killSwitch,
      executionMode,
      events: events.length,
      feeds: feedRows,
      reconciliation,
    },
    account: {
      startingCash: start.toString(),
      equity: equity.toString(),
      cash: cash.toString(),
      exposure: exposure.toString(),
      exposureFraction: fraction(exposure, equity).toString(),
      pnl: equity.minus(start).toString(),
      pnlFraction: fraction(equity, start).minus(ONE).toString(),
      realizedPnl: realized.toString(),
      fees: fees.toString(),
      maxDrawdown: maxDrawdown.toString(),
      drawdown: drawdown.toString(),
    },
    positions,
    orders: { open, byState },
    curve: { at: sampleAt, equity: curve.map((point) => point.equity.toAnalysis()), benchmark, benchmarkSymbol: context.benchmark.symbol, benchmarkNote, marks },
    trades: newestFirst(trades, MAX_ROWS),
    tradesTotal: trades.length,
    rejections: newestFirst(rejections, MAX_ROWS),
    rejectionsTotal: rejections.length,
    strategies: [{
      id: context.strategy.id, version: context.strategy.version, params: context.strategy.params, state: halted === null ? 'activa' : 'detenida',
      evaluations, intents: intentCount,
      last: [...lastEvaluation.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([symbol, e]) => ({ symbol, ...e })),
    }],
    alerts: newestFirst(alerts, MAX_ALERTS),
    attention,
    alertCounts,
    planB: {
      contributions: start.toString(),
      contributionsNote,
      allocation,
      hasTarget: context.planB.target !== null,
      nextRebalanceAt: context.planB.nextRebalanceAt,
    },
  };
  return Object.freeze(snapshot);
}
