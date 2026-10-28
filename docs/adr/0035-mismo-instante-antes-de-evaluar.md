# ADR 0035 — Lo recibido en un mismo instante se ingiere antes de evaluar ninguna vela

Fecha: 2026-10-20 · Estado: aceptado (la persona aprobó corregir Q-01 el 2026-10-20; el cómo, en modo autónomo, ADR 0011)
· Auditoría quant, parte 1

## Contexto

- La auditoría quant del 2026-10-20 (`docs/audits/2026-10-20-quant-primera-ronda.md`, Q-01) encontró que el backtest
  rechazaba por `STALE_DATA` toda entrada de BTC/EUR mientras ETH/EUR estaba abierta.
- Las velas diarias de todos los pares se reciben en el mismo instante. El backtest entregaba cada vela por separado
  (instrumento, cotización y vela), y la composición evaluaba la vela al ingerirla. Al evaluar BTC/EUR, la cotización de
  ETH/EUR de ese instante aún no se había ingerido, y la marca más antigua de la cartera (`marksAsOf`) tenía un día, más
  que los 60 s de `trading-risk` §4.6.
- El orden contrario funcionaba, porque BTC va antes que ETH al ordenar por símbolo. En la salida de EXP-0025 hay 19
  entradas de ETH con BTC abierta y ninguna de BTC con ETH abierta.
- La regla de Risk es correcta: un precio con más de 60 s no sirve para valorar la cartera. Lo que fallaba era el orden,
  porque el dato ya se había recibido (quant-research §3: cada decisión usa lo disponible en ese instante).

## Decisión

1. **`TradingSystem.onMarketBatch(raws, receivedTime)`.** Lo recibido en un mismo instante se ingiere entero
   (instrumentos, cotizaciones y velas). Después se evalúan las velas cerradas, en el orden en que llegaron.
   `onMarketData` es un lote de uno: con un solo dato, el orden del diario no cambia.
2. **El backtest entrega juntas las velas de cada `receivedTime`,** con el primer registro de ese instante; los demás
   registros del instante ya no entregan nada. Los registros del replay no cambian.
3. **Risk no cambia:** ni el umbral de 60 s ni la regla de la marca más antigua.
4. **Paper y live (paso 32).** El código común es el mismo y ya lo trae. El fallo volvería si un adaptador entregara por
   separado los datos de un mismo instante con cotizaciones sacadas de las velas. Por eso el adaptador del paso 32
   entrega cada instante con `onMarketBatch`. Con cotizaciones del ticker o del libro, la marca depende de su antigüedad
   real, que es lo que pide `trading-risk` §4.6.

## Alternativas

- **Subir `maxPriceAgeMs` en el backtest a la duración de la vela.** Cambiaría un umbral de Risk solo en el backtest y
  dejaría de ser el mismo código en todos los modos (ADR 0013).
- **Valorar la cartera con la marca más reciente en lugar de la más antigua.** Dejaría pasar una cartera con un par sin
  precio al día (fail closed, `trading-risk` §8).
- **Un registro del replay por instante.** Cambiaría el formato de los registros y el diario de todos los backtests,
  también los de un solo par.

## Consecuencias

- Los backtests con varios pares cambian. Con un solo par, el diario es idéntico: el hash fijado de
  `test/src/app/backtest.test.ts` no cambia.
- Los experimentos con datos reales de BTC/EUR y ETH/EUR (EXP-0021 a EXP-0026) se hicieron con el fallo. A y B se repiten
  en la parte 10 del plan de la auditoría, como experimentos nuevos.
- Prueba: `test/src/app/same-instant.test.ts`, con dos pares y velas del mismo instante en los dos órdenes.
- Compromiso para el paso 32: el adaptador de paper y live entrega cada instante con `onMarketBatch`, con una prueba de
  dos pares.
