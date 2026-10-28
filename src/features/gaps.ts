// Velas que faltan (ADR 0036). Un hueco se detecta y se excluye, nunca se rellena (quant-research §3), y no vacía la
// ventana: un cálculo usa las últimas velas observadas mientras le falten pocas; si le faltan más, da null. Lo usan el
// Feature Engine y el régimen de analytics/, para que las dos cosas traten igual una vela que falta.
import type { UtcMillis } from '../shared/time.ts';

/**
 * Velas que pueden faltar en los datos de un cálculo cuya fórmula usa n velas: ⌊√n / 2⌋. Con m velas de menos, el sesgo
 * de una estimación con n velas es del orden de m/n, y su error de muestreo, de 1/√n. Con m ≤ √n / 2, el sesgo no pasa
 * de la mitad del error de muestreo, y el error cuadrático medio no pasa del 125 % de la varianza. Con n ≤ 3 no puede
 * faltar ninguna: un retorno de una vela o un RSI de 2 nunca se calculan a través de un hueco.
 */
export function gapTolerance(n: number): number {
  return Math.floor(Math.sqrt(n) / 2);
}

/** Velas que faltan entre la primera y la última de `count` velas observadas en orden, con aperturas cada `step` ms. */
export function missingCandles(firstOpen: UtcMillis, lastOpen: UtcMillis, count: number, step: number): number {
  return (lastOpen - firstOpen) / step + 1 - count;
}
