// Límites del Risk Engine (paso 20, ADR 0023; dimensionado por riesgo con costes en el paso 23, ADR 0026). Los valores
// por defecto son los de trading-risk y el ADR 0003, y hasta el paso 35 son también el máximo: un valor más arriesgado
// no arranca (CONFIG_INVALID). Los costes estimados van al revés: cuanto más bajos, mayor sale el tamaño, así que su
// valor por defecto es el mínimo. Las fracciones son del patrimonio o del importe, en Decimal; las duraciones, en
// milisegundos enteros.
import { createHash } from 'node:crypto';
import { Decimal } from '../shared/decimal.ts';

export interface RiskLimits {
  readonly maxExposureFraction: Decimal; // exposición total (MAX_EXPOSURE, §4.2)
  readonly maxPositionFraction: Decimal; // posición por activo, sumando la existente (CONCENTRATION_LIMIT, §4.3)
  readonly riskPerTradeFraction: Decimal; // pérdida si salta el stop, con costes (RISK_PER_TRADE, §4.1)
  readonly estimatedCommission: Decimal; // comisión taker por lado, para el riesgo por unidad y la caja (§4.1)
  readonly estimatedSlippage: Decimal; // slippage por lado, ídem
  readonly maxPriceAgeMs: number; // precio y valoración de la cartera (STALE_DATA, §4.6)
  readonly maxSignalAgeMs: number; // vela de la señal (SIGNAL_TOO_OLD, §4.6)
  readonly approvalTtlMs: number; // validez del token (§2.2)
}

/** Parte de la caja libre que puede usar una entrada, con sus costes (trading-risk §4.1). */
export const CASH_USAGE_FRACTION = Decimal.parse('0.99');

export const DEFAULT_RISK_LIMITS: RiskLimits = Object.freeze({
  maxExposureFraction: Decimal.parse('0.75'),
  maxPositionFraction: Decimal.parse('0.25'),
  riskPerTradeFraction: Decimal.parse('0.0075'),
  estimatedCommission: Decimal.parse('0.0025'), // taker de Bitvavo (ADR 0018) [verificar en el paso 32]
  estimatedSlippage: Decimal.parse('0.0005'), // mínimo de quant-research §5
  maxPriceAgeMs: 60_000,
  maxSignalAgeMs: 1_200_000,
  approvalTtlMs: 10_000,
});

function inRange(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

/** Problemas de la configuración; vacío si vale. */
export function checkRiskLimits(limits: RiskLimits): string[] {
  const problems: string[] = [];
  const zero = Decimal.parse('0');
  const one = Decimal.parse('1');
  const fraction = (name: string, value: Decimal, max: Decimal): void => {
    if (!(value instanceof Decimal) || !value.gt(zero) || value.gt(max)) problems.push(`${name} debe estar en (0, ${max.toString()}]`);
  };
  const cost = (name: string, value: Decimal, min: Decimal): void => {
    if (!(value instanceof Decimal) || value.lt(min) || !value.lt(one)) problems.push(`${name} debe estar en [${min.toString()}, 1)`);
  };
  fraction('maxExposureFraction', limits.maxExposureFraction, DEFAULT_RISK_LIMITS.maxExposureFraction);
  fraction('maxPositionFraction', limits.maxPositionFraction, DEFAULT_RISK_LIMITS.maxPositionFraction);
  fraction('riskPerTradeFraction', limits.riskPerTradeFraction, DEFAULT_RISK_LIMITS.riskPerTradeFraction);
  cost('estimatedCommission', limits.estimatedCommission, DEFAULT_RISK_LIMITS.estimatedCommission);
  cost('estimatedSlippage', limits.estimatedSlippage, DEFAULT_RISK_LIMITS.estimatedSlippage);
  const duration = (name: string, value: number, max: number): void => {
    if (!inRange(value, max)) problems.push(`${name} debe ser un entero de ms en (0, ${String(max)}]`);
  };
  duration('maxPriceAgeMs', limits.maxPriceAgeMs, DEFAULT_RISK_LIMITS.maxPriceAgeMs);
  duration('maxSignalAgeMs', limits.maxSignalAgeMs, DEFAULT_RISK_LIMITS.maxSignalAgeMs);
  duration('approvalTtlMs', limits.approvalTtlMs, DEFAULT_RISK_LIMITS.approvalTtlMs);
  return problems;
}

/** SHA-256 del JSON canónico de los límites: el config_hash de cada decisión y de cada token. */
export function riskConfigHash(limits: RiskLimits): string {
  const canonical = JSON.stringify({
    approvalTtlMs: limits.approvalTtlMs,
    estimatedCommission: limits.estimatedCommission.toString(),
    estimatedSlippage: limits.estimatedSlippage.toString(),
    maxExposureFraction: limits.maxExposureFraction.toString(),
    maxPositionFraction: limits.maxPositionFraction.toString(),
    maxPriceAgeMs: limits.maxPriceAgeMs,
    maxSignalAgeMs: limits.maxSignalAgeMs,
    riskPerTradeFraction: limits.riskPerTradeFraction.toString(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
