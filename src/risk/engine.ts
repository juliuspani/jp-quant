// Risk Engine mínimo del paso 20 (ADR 0023), con las interfaces definitivas de ARCHITECTURE.md §16.6: los pasos 23 y
// 35 añaden controles sin cambiar el contrato. Aplica, en el orden de trading-risk §9.3, el kill switch, la validez de
// la intención y del estado, los datos obsoletos, el mercado permitido, el stop, el tamaño por riesgo con costes (paso
// 23, ADR 0026), la exposición total, la posición por activo, la caja y el mínimo de la orden. Los stops de protección
// siguen el camino corto de las salidas y salen con su disparo firmado (paso 23). Fail closed: un control que lanza rechaza con INTERNAL_ERROR, y una decisión que no
// se puede persistir rechaza con DECISION_LOG_UNAVAILABLE y activa el kill switch. La decisión se guarda antes de
// responder, y solo una aprobación guardada sale firmada.
import type { KeyObject } from 'node:crypto';
import type { Clock } from '../kernel/clock.ts';
import { isSendingBlocked, type ExecutionRejected, type ExecutionView } from '../kernel/execution.ts';
import type { MarketView } from '../kernel/market-data.ts';
import type { DecisionDetail, OrderIntent, OrderType, RiskDecision, RiskView, SignedApproval, TradingState } from '../kernel/orders.ts';
import type { PortfolioView } from '../kernel/portfolio.ts';
import type { Ids } from '../kernel/random.ts';
import type { ReasonCode } from '../kernel/reason-codes.ts';
import type { DecisionRecord, RiskState, RiskStore } from '../kernel/stores.ts';
import { Decimal, type Notional, type Price, type Quantity } from '../shared/decimal.ts';
import { addMs, toUtcIso, type UtcMillis } from '../shared/time.ts';
import { UUID } from './approval.ts';
import { CASH_USAGE_FRACTION, checkRiskLimits, riskConfigHash, type RiskLimits } from './limits.ts';
import { createApprovalSigner, type ApprovalSigner } from './signer.ts';

export class RiskConfigError extends Error {
  override readonly name = 'RiskConfigError';
  readonly code = 'CONFIG_INVALID';
}

export interface RiskEngineDeps {
  readonly clock: Clock;
  readonly ids: Ids; // UUID: el approval_id da el client order ID (exchange-execution §5.1)
  readonly store: RiskStore;
  readonly market: MarketView;
  readonly portfolio: PortfolioView;
  readonly execution: ExecutionView;
  readonly limits: RiskLimits;
  readonly commit: string;
}

export interface RiskOutcome {
  readonly decision: RiskDecision;
  readonly approval: SignedApproval | null; // solo si se aprueba o se reduce, y la decisión quedó guardada
}

type Verdict =
  | { readonly decision: 'REJECTED'; readonly codes: readonly ReasonCode[]; readonly detail: DecisionDetail }
  | {
      readonly decision: 'APPROVED' | 'REDUCED';
      readonly codes: readonly ReasonCode[];
      readonly detail: DecisionDetail;
      readonly type: OrderType;
      readonly quantity: Quantity;
      readonly notional: Notional | null;
      readonly trigger: Price | null; // solo en los stops de protección
    };

const ZERO = Decimal.parse('0');
const ONE = Decimal.parse('1');
const DIV_SCALE = 18;
const SPOT_SIDE = { entry: 'buy', exit: 'sell', protective_stop: 'sell', stop_update: 'sell' } as const;
const INACTIVE: RiskState['killSwitch'] = Object.freeze({ active: false, reason: null, changedAt: null });

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function reject(codes: readonly ReasonCode[], detail: DecisionDetail): Verdict {
  return { decision: 'REJECTED', codes, detail };
}

function requestedQuantity(intent: OrderIntent): Quantity | null {
  return 'quantity' in intent.sizing ? intent.sizing.quantity : null;
}

export class RiskEngine implements RiskView {
  readonly #deps: RiskEngineDeps;
  readonly #signer: ApprovalSigner = createApprovalSigner();
  readonly #configHash: string;
  #killSwitch: RiskState['killSwitch'];

  constructor(deps: RiskEngineDeps) {
    const problems = checkRiskLimits(deps.limits);
    if (deps.commit === '') problems.push('falta el commit que decide');
    if (problems.length > 0) throw new RiskConfigError(`CONFIG_INVALID: ${problems.join('; ')}`);
    this.#deps = deps;
    this.#configHash = riskConfigHash(deps.limits);
    // Si no se puede leer el estado, no se arranca: lanza.
    this.#killSwitch = deps.store.loadState()?.killSwitch ?? INACTIVE;
  }

  /** Clave pública de las aprobaciones, para Execution (y el capguard). Cambia en cada arranque. */
  get approvalPublicKey(): KeyObject {
    return this.#signer.publicKey;
  }

  get configHash(): string {
    return this.#configHash;
  }

  tradingState(): TradingState {
    const blocked: ReasonCode[] = [];
    if (this.#killSwitch.active) blocked.push('KILL_SWITCH_ACTIVE');
    if (isSendingBlocked(this.#deps.execution.status())) blocked.push('STATE_UNRECONCILED');
    return Object.freeze({ killSwitch: this.#killSwitch.active, entriesBlockedBy: Object.freeze([...blocked]), exitsBlockedBy: Object.freeze([...blocked]) });
  }

  /** Activa el kill switch global (trading-risk §6). Queda activo en memoria aunque no se pueda guardar. */
  activateKillSwitch(reason: string): void {
    if (reason.trim() === '') throw new RangeError('el kill switch se activa con un motivo');
    if (!this.#killSwitch.active) {
      this.#killSwitch = Object.freeze({ active: true, reason, changedAt: this.#deps.clock.now() });
    }
    this.#deps.store.saveState({ killSwitch: this.#killSwitch });
  }

  /** Decide sobre una intención. Nunca agranda lo pedido y nunca aprueba por defecto. */
  evaluate(intent: OrderIntent): RiskOutcome {
    const now = this.#deps.clock.now();
    let verdict: Verdict;
    try {
      verdict = this.#decide(intent, now);
    } catch (error) {
      verdict = reject(['INTERNAL_ERROR'], { error: message(error) });
    }
    const decisionId = this.#deps.ids.next();
    let unsigned: Omit<SignedApproval, 'signature'> | null = null;
    if (verdict.decision !== 'REJECTED') {
      const approvalId = this.#deps.ids.next();
      if (UUID.test(approvalId)) {
        unsigned = {
          approval_id: approvalId,
          intent_id: intent.intentId,
          symbol: intent.symbol,
          side: intent.side,
          type: verdict.type,
          max_quantity: verdict.quantity.toString(),
          max_notional: verdict.notional === null ? null : verdict.notional.toString(),
          trigger_price: verdict.trigger === null ? null : verdict.trigger.toString(),
          reduce_only: intent.reduceOnly,
          issued_at: now,
          expires_at: addMs(now, this.#deps.limits.approvalTtlMs),
          config_hash: this.#configHash,
        };
      } else {
        verdict = reject(['INTERNAL_ERROR'], { error: `approval_id no es un UUID: ${approvalId}` });
      }
    }
    const decision = this.#decision(decisionId, intent.intentId, verdict);
    try {
      this.#deps.store.appendDecision(this.#record(now, decision, intent, unsigned?.approval_id ?? null));
    } catch (error) {
      const persisted = this.#tripQuietly(`no se pudo persistir la decisión ${decisionId}`);
      const failed = this.#decision(decisionId, intent.intentId, reject(['DECISION_LOG_UNAVAILABLE'], {
        error: message(error),
        killSwitchPersisted: persisted,
      }));
      return Object.freeze({ decision: failed, approval: null });
    }
    return Object.freeze({ decision, approval: unsigned === null ? null : this.#signer.sign(unsigned) });
  }

  /**
   * Persiste un rechazo de Execution, del capguard o del exchange (trading-risk §9.1). Un fallo de firma o un token
   * reutilizado activan antes el kill switch (§6), aunque luego no se pueda guardar el rechazo.
   */
  recordExecutionRejection(rejected: ExecutionRejected): void {
    const now = this.#deps.clock.now();
    // Un rechazo del capguard también: el Risk Engine dejó pasar algo que no debía (trading-risk §3, capa 2).
    if (rejected.reasonCode === 'APPROVAL_BAD_SIGNATURE' || rejected.reasonCode === 'APPROVAL_REPLAYED' || rejected.layer === 'capguard') {
      this.#tripQuietly(`${rejected.reasonCode} en ${rejected.layer} (aprobación ${rejected.approvalId ?? 'sin id'})`);
    }
    const record: DecisionRecord = {
      ts: now,
      layer: rejected.layer,
      decisionId: this.#deps.ids.next(),
      intentId: rejected.intentId,
      approvalId: rejected.approvalId,
      origin: null,
      symbol: rejected.symbol,
      side: rejected.side,
      quantity: rejected.quantity,
      notional: rejected.notional,
      decision: 'REJECTED',
      reasonCode: rejected.reasonCode,
      reasonCodes: [rejected.reasonCode],
      detail: rejected.detail,
      configHash: this.#configHash,
      commit: this.#deps.commit,
    };
    try {
      this.#deps.store.appendDecision(record);
    } catch (error) {
      this.#tripQuietly(`no se pudo persistir el rechazo ${rejected.reasonCode} de ${rejected.layer}`);
      throw error;
    }
  }

  /** Activa el kill switch y dice si quedó guardado. Si no, sigue activo en memoria. */
  #tripQuietly(reason: string): boolean {
    try {
      this.activateKillSwitch(reason);
      return true;
    } catch (error) {
      if (!this.#killSwitch.active) throw error;
      return false;
    }
  }

  #decision(decisionId: string, intentId: string, verdict: Verdict): RiskDecision {
    const approved = verdict.decision !== 'REJECTED';
    return Object.freeze({
      decisionId,
      intentId,
      decision: verdict.decision,
      reasonCode: verdict.codes[0] ?? null,
      reasonCodes: Object.freeze([...verdict.codes]),
      approvedQuantity: approved ? verdict.quantity : null,
      approvedNotional: approved ? verdict.notional : null,
      detail: Object.freeze({ ...verdict.detail }),
      configHash: this.#configHash,
      commit: this.#deps.commit,
    });
  }

  #record(now: UtcMillis, decision: RiskDecision, intent: OrderIntent, approvalId: string | null): DecisionRecord {
    return {
      ts: now,
      layer: 'risk',
      decisionId: decision.decisionId,
      intentId: intent.intentId,
      approvalId,
      origin: intent.origin,
      symbol: intent.symbol,
      side: intent.side,
      quantity: requestedQuantity(intent),
      notional: null,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      reasonCodes: decision.reasonCodes,
      detail: decision.detail,
      configHash: decision.configHash,
      commit: decision.commit,
    };
  }

  #decide(intent: OrderIntent, now: UtcMillis): Verdict {
    // 1. Kill switch: rechaza todo, también las salidas.
    if (this.#killSwitch.active) return reject(['KILL_SWITCH_ACTIVE'], { killSwitchReason: this.#killSwitch.reason });

    // 2. Intención, estado y persistencia.
    const invalid = this.#invalidIntent(intent, now);
    if (invalid !== null) return reject(['INTERNAL_ERROR'], { invalidIntent: invalid });
    if (isSendingBlocked(this.#deps.execution.status())) return reject(['STATE_UNRECONCILED'], { executionMode: 'UNKNOWN' });

    switch (intent.kind) {
      case 'entry':
        return this.#decideEntry(intent, now);
      case 'exit':
        return this.#decideExit(intent);
      case 'protective_stop':
      case 'stop_update':
        return this.#decideProtective(intent);
    }
    return reject(['INTERNAL_ERROR'], { invalidIntent: 'tipo de intención desconocido' });
  }

  #invalidIntent(intent: OrderIntent, now: UtcMillis): string | null {
    if (intent.intentId === '' || intent.symbol === '') return 'intención sin id o sin símbolo';
    if (!Object.hasOwn(SPOT_SIDE, intent.kind)) return `tipo de intención desconocido: ${String(intent.kind)}`;
    const entry = intent.kind === 'entry';
    if (intent.side !== SPOT_SIDE[intent.kind]) return `en spot una ${entry ? 'entrada compra' : 'salida o un stop venden'}`;
    if (intent.reduceOnly === entry) return 'reduceOnly es false en las entradas y true en todo lo demás';
    if (intent.kind === 'protective_stop' || intent.kind === 'stop_update') {
      if (intent.stopPrice === null || !intent.stopPrice.isPositive()) return 'un stop de protección sin precio de disparo';
    }
    toUtcIso(intent.signalTime); // lanza si no es un instante: INTERNAL_ERROR
    if (intent.signalTime > now) return 'señal posterior al instante de la decisión';
    switch (intent.sizing.mode) {
      case 'risk':
        return entry ? null : 'solo una entrada se dimensiona por riesgo';
      case 'all':
        return entry ? 'una entrada no puede pedir «todo»' : null;
      case 'quantity':
        return intent.sizing.quantity.isPositive() ? null : 'cantidad no positiva';
    }
    return 'modo de dimensionado desconocido'; // un objeto que no cumple el tipo, en tiempo de ejecución
  }

  // Salida reduce_only: tras los pasos 1 y 2, solo REDUCE_ONLY_VIOLATION (trading-risk §9.3).
  #decideExit(intent: OrderIntent): Verdict {
    const position = this.#deps.portfolio.snapshot().positions.find((p) => p.symbol === intent.symbol);
    const available = position?.available ?? ZERO;
    const quantity = requestedQuantity(intent) ?? available;
    const detail = { available: available.toString(), requested: quantity.toString() };
    if (!available.isPositive() || quantity.gt(available)) return reject(['REDUCE_ONLY_VIOLATION'], detail);
    return { decision: 'APPROVED', codes: [], detail, type: 'market', quantity, notional: null, trigger: null };
  }

  // Stop de protección (trading-risk §2.4): una orden reduce_only con su precio de disparo, que espera en el exchange. Como
  // una salida, tras los pasos 1 y 2 solo REDUCE_ONLY_VIOLATION. El disparo se redondea al alza al paso de precio: más
  // cerca del mercado, sale antes (exchange-execution §7).
  #decideProtective(intent: OrderIntent): Verdict {
    const position = this.#deps.portfolio.snapshot().positions.find((p) => p.symbol === intent.symbol);
    const available = position?.available ?? ZERO;
    const quantity = requestedQuantity(intent) ?? available;
    const detail: Record<string, string | null> = { available: available.toString(), requested: quantity.toString() };
    if (!available.isPositive() || quantity.gt(available)) return reject(['REDUCE_ONLY_VIOLATION'], detail);
    const instrument = this.#deps.market.instrument(intent.symbol);
    if (instrument === null || intent.stopPrice === null) return reject(['INTERNAL_ERROR'], { ...detail, error: 'sin paso de precio o sin stop' });
    const trigger = intent.stopPrice.roundToStep(instrument.priceStep, 'UP');
    detail.trigger = trigger.toString();
    return { decision: 'APPROVED', codes: [], detail, type: 'stop_market', quantity, notional: null, trigger };
  }

  #decideEntry(intent: OrderIntent, now: UtcMillis): Verdict {
    const { market, portfolio, limits } = this.#deps;
    const codes: ReasonCode[] = [];
    const detail: Record<string, string | number | boolean | null> = { now, signalTime: intent.signalTime };

    // 4. Datos obsoletos: precio, valoración de la cartera y señal.
    const quote = market.quote(intent.symbol);
    const snapshot = portfolio.snapshot();
    // La más antigua de las dos marcas: la edad del dato en origen o en el sistema, la mayor.
    const priceTime = quote === null ? null : quote.eventTime < quote.receivedTime ? quote.eventTime : quote.receivedTime;
    detail.quoteTime = priceTime;
    detail.marksAsOf = snapshot.marksAsOf;
    if (priceTime === null || priceTime > now || addMs(priceTime, limits.maxPriceAgeMs) < now) codes.push('STALE_DATA');
    const marks = snapshot.marksAsOf;
    if (snapshot.positions.length > 0 && (marks === null || marks > now || addMs(marks, limits.maxPriceAgeMs) < now)) {
      if (!codes.includes('STALE_DATA')) codes.push('STALE_DATA');
    }
    if (addMs(intent.signalTime, limits.maxSignalAgeMs) < now) codes.push('SIGNAL_TOO_OLD');

    // 6. Mercado permitido.
    const instrument = market.instrument(intent.symbol);
    if (instrument === null || !instrument.tradable || instrument.symbol !== intent.symbol) codes.push('MARKET_NOT_ALLOWED');

    // 8. Stop por debajo de la entrada.
    const ask = quote?.ask ?? null;
    const stop = intent.stopPrice;
    detail.ask = ask === null ? null : ask.toString();
    if (stop === null || !stop.isPositive() || (ask !== null && !stop.lt(ask))) codes.push('STOP_INVALID');
    if (codes.length > 0 || quote === null || instrument === null || ask === null || stop === null) return reject(codes, detail);
    if (!ask.isPositive() || !snapshot.equity.isPositive()) {
      return reject(['INTERNAL_ERROR'], { ...detail, error: 'precio o patrimonio no positivos' });
    }
    if (!quote.bid.isPositive() || quote.bid.gt(ask)) return reject(['INTERNAL_ERROR'], { ...detail, error: 'cotización cruzada o sin bid' });

    // 8. Tamaño por riesgo (trading-risk §4.1): la pérdida si salta el stop, con la comisión y el slippage de entrada y de
    // salida y el medio spread al vender, no pasa del riesgo por operación. Una cantidad pedida mayor se reduce.
    const step = instrument.quantityStep;
    const perSide = limits.estimatedCommission.plus(limits.estimatedSlippage);
    const halfSpread = ask.minus(quote.bid).div(ask.plus(quote.bid), DIV_SCALE, 'UP'); // fracción del punto medio
    const riskPerUnit = ask.minus(stop).plus(ask.times(perSide)).plus(stop.times(perSide.plus(halfSpread)));
    const riskBudget = snapshot.equity.times(limits.riskPerTradeFraction);
    const riskQuantity = riskBudget.div(riskPerUnit, DIV_SCALE, 'DOWN').roundToStep(step, 'DOWN');
    const explicit = requestedQuantity(intent);
    const base = explicit ?? riskQuantity;

    // 9. Exposición total y posición por activo, con la posición existente valorada al ask (lo más conservador), y el
    // 99 % de la caja libre con los costes de la compra.
    const existing = snapshot.positions.find((p) => p.symbol === intent.symbol);
    const existingValue = existing === undefined ? ZERO : existing.quantity.times(ask);
    const exposureRoom = snapshot.equity.times(limits.maxExposureFraction).minus(snapshot.exposure);
    const positionRoom = snapshot.equity.times(limits.maxPositionFraction).minus(existingValue);
    const cashRoom = snapshot.cash.times(CASH_USAGE_FRACTION);
    const fit = (room: Decimal, unitCost: Decimal): Quantity =>
      room.isPositive() ? room.div(unitCost, DIV_SCALE, 'DOWN').roundToStep(step, 'DOWN') : ZERO;
    Object.assign(detail, {
      equity: snapshot.equity.toString(),
      exposure: snapshot.exposure.toString(),
      cash: snapshot.cash.toString(),
      bid: quote.bid.toString(),
      stop: stop.toString(),
      riskBudget: riskBudget.toString(),
      riskPerUnit: riskPerUnit.toString(),
      riskQuantity: riskQuantity.toString(),
      existingPositionValue: existingValue.toString(),
      requestedNotional: base.times(ask).toString(),
      exposureRoom: exposureRoom.toString(),
      positionRoom: positionRoom.toString(),
      cashRoom: cashRoom.toString(),
    });
    const caps: (readonly [ReasonCode, Quantity])[] = [];
    if (explicit !== null) caps.push(['RISK_PER_TRADE', riskQuantity]);
    caps.push(
      ['MAX_EXPOSURE', fit(exposureRoom, ask)],
      ['CONCENTRATION_LIMIT', fit(positionRoom, ask)],
      ['INSUFFICIENT_CASH', fit(cashRoom, ask.times(ONE.plus(perSide)))],
    );
    const tight = caps.filter(([, cap]) => cap.lt(base));
    const binding = tight.map(([code]) => code);
    const quantity = Decimal.min(base, ...tight.map(([, cap]) => cap));
    if (!quantity.isPositive() && binding.length > 0) return reject(binding, detail);
    const notional = quantity.times(ask);
    detail.approvedQuantity = quantity.toString();

    // 10. Mínimo de la orden.
    if (!quantity.isPositive() || quantity.lt(instrument.minQuantity) || notional.lt(instrument.minNotional)) {
      return reject([...binding, 'BELOW_MIN_NOTIONAL'], detail);
    }
    return { decision: binding.length > 0 ? 'REDUCED' : 'APPROVED', codes: binding, detail, type: 'market', quantity, notional, trigger: null };
  }
}
