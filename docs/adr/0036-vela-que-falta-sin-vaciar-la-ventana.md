# ADR 0036 — Una vela que falta se excluye sin vaciar la ventana

Fecha: 2026-10-20 · Estado: aceptado (la persona lo pidió el 2026-10-20; el cómo, en modo autónomo, ADR 0011) ·
Auditoría quant, parte 2. Sustituye el §5 del ADR 0025 y la regla de huecos del régimen del ADR 0029.

## Contexto

- `quant-research` §3: los huecos se detectan y se excluyen, nunca se rellenan con precios planos. El ADR 0025 §5 lo
  aplicó vaciando la ventana: tras un hueco, cada feature daba null hasta tener otra vez `warmupBars` velas contiguas.
  El régimen del ADR 0029 hacía lo mismo.
- Con features largas, una sola vela que falta dejaba meses sin decisiones: 101 velas con el ATR de 20 (5·20 + 1) y 200
  con la SMA 200. La auditoría quant (Q-07) lo encontró en BTC/EUR el 2018-01-12, al empezar el bajista: sin decisiones
  hasta julio, y 219 periodos sin régimen de tendencia.
- La persona pidió que una vela ausente no deje meses sin decisiones, aplicando la política de datos ausentes ya
  definida.

## Decisión

1. **Se excluye la vela que falta, no la ventana.** Cada cálculo usa sus últimas velas observadas. La que falta no se
   rellena ni se interpola: no existe en los datos. El normalizador sigue publicando `MarketDataGap`.
2. **Tope por principio.** Un cálculo cuya fórmula usa n velas da null si a sus velas les faltan más de ⌊√n / 2⌋
   (`src/features/gaps.ts`).
   - **Por qué ese tope.** Con m velas de menos, el sesgo de una estimación con n velas es del orden de m/n, y su error
     de muestreo, de 1/√n. Con m ≤ √n / 2, el sesgo no pasa de la mitad del error de muestreo, y el error cuadrático
     medio no pasa del 125 % de la varianza.
   - **Qué es n.** La ventana de la fórmula (`window`), no su calentamiento. En las recursivas es lo más estricto,
     porque las últimas velas pesan más. Las velas que faltan se cuentan en todas las que recibe el cálculo
     (`warmupBars`).
   - **Ventanas cortas.** Con n ≤ 3 no puede faltar ninguna: un retorno de una vela o un RSI de 2 nunca se calculan a
     través de un hueco.
   - **Ejemplos:**

     | Cálculo | Velas que admite |
     |---|---|
     | SMA 200 | 7 |
     | Donchian de 55 | 3 |
     | Donchian de 20 y ATR de 20 | 2 |
     | Donchian de 10 y media de 5 | 1 |
     | RSI de 2 | 0 |
3. **El régimen (`regimen-precio@1`), igual.** La tendencia admite ⌊√200 / 2⌋ = 7 velas de menos en sus 220 velas, y
   la volatilidad, ⌊√30 / 2⌋ = 2 en sus 395.
4. **Versiones.** Ninguna feature cambia de fórmula, ventana ni calentamiento, así que sus versiones no suben (ADR 0025).
   La regla es del motor, y el commit de cada experimento la fija.

## Alternativas

- **Mantener el vaciado de la ventana.** Es lo que deja meses sin decisiones.
- **Rellenar la vela** con el cierre anterior o interpolando. Prohibido por `quant-research` §3.
- **Excluir sin tope.** Tras una caída larga de la fuente, una ventana mezclaría velas de antes y de después como si
  fueran seguidas.
- **Un tope fijo de velas o un porcentaje de la ventana.** No sale de ningún principio. El de ⌊√n / 2⌋ sale del error
  de muestreo de la propia estimación.

## Consecuencias

- Tras una vela que falta, las features largas siguen. Las de ventana corta esperan mientras el hueco esté entre sus
  velas: como mucho, su calentamiento (11 velas el RSI de 2).
- Cambian los backtests con huecos. En los datos de la primera ronda, el de BTC/EUR de 2018. A y B se repiten en la
  parte 10 del plan de la auditoría.
- El régimen clasifica más periodos: cambian los desgloses y los periodos de A.3.9.
- **Pruebas:**
  - `test/src/features/gaps.test.ts`, `test/src/features/engine.test.ts` y `test/src/analytics/regime.test.ts`;
  - la prueba de look-ahead de las features sigue pasando con huecos.
