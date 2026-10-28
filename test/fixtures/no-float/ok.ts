// Lo que sí se permite en un módulo de dinero: Decimal, comparar números, bigint, literales negativos y texto.
import { Decimal } from '../../../src/shared/decimal.ts';

export function ok(price: Decimal, qty: Decimal, openTime: number, closeTime: number, values: readonly string[]): string {
  const notional = price.times(qty).roundToScale(2, 'DOWN');
  const later = closeTime > openTime && openTime !== closeTime;
  const counter = 10n + 5n * 2n;
  const last = values.at(-1) ?? '';
  const label = `${notional.toString()}-${String(counter)}-${last}`;
  let flag = false;
  flag ||= later;
  return flag ? label : `${label}!`;
}
