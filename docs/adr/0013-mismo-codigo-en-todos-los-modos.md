# ADR 0013 — Mismo código en backtest, paper, shadow y live

Fecha: 2026-10-06 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) ·
Paso: 14

## Contexto

El prompt del paso 14 pide que el mismo código corra en backtest, paper, shadow y live cambiando solo los
adaptadores de reloj, datos y ejecución.

En el código previo, el backtest (`src/backtest/sim.ts`) tiene su propio bucle. Reutiliza `evaluateTrend` y
`sizeByRisk`, pero no el resto del camino de `engine.ts`. Así, lo que se mide en el backtest no es lo que
correría en real.

- **Freqtrade** calcula sobre todo el dataframe en el backtest y por incrementos en real, y esa diferencia es el
  origen de su look-ahead ([REFERENCE_SYSTEMS.md](../REFERENCE_SYSTEMS.md) §6).
- **NautilusTrader** usa el mismo núcleo en backtest, sandbox y live, y cambia solo los adaptadores (§7).

quant-research §3 exige datos point-in-time, y exchange-execution §19 pide un exchange simulado que pierda,
duplique y reordene respuestas.

## Decisión

1. **Cuatro modos** (ARCHITECTURE.md §14):
   - **backtest:** reloj simulado, datos de `historical/` y `SimulatedVenue`;
   - **paper:** reloj real, datos del exchange y `SimulatedVenue` con precios en vivo y cuenta simulada;
   - **shadow:** reloj real, datos del exchange y `ShadowVenue`, que lee la cuenta real con la clave de lectura
     y no transmite nada: cada orden termina en `NOT_SENT`;
   - **live:** reloj real, datos del exchange y `LiveVenue`, que envía por el capguard.
2. **Solo cambian tres adaptadores:** `Clock`, `MarketDataFeed` y `ExecutionVenue` (con su `VenueHealthView`).
   La cuenta forma parte del adaptador de ejecución.
3. **Solo `src/app/` conoce el modo.** Ningún módulo lo recibe ni lo consulta, y no hay `if (modo)` fuera de
   `app/`.
4. **El replay ordena por `received_time`.**
   - Una vela histórica se vuelve visible en su cierre más la latencia mínima registrada para su fuente.
   - Un dato externo con revisiones se vuelve visible en la hora de publicación de cada versión, nunca en la de
     descarga.
5. **Determinismo.**
   - Ids y aleatoriedad con semilla en backtest y replay.
   - Con los mismos datos, configuración, commit y semillas, dos ejecuciones dan el mismo diario. La prueba es
     obligatoria en cuanto exista el kernel.
   - El replay de un diario real reproduce sus decisiones.
6. **El mismo cálculo incremental de features**, vela a vela, en todos los modos. Si alguna vez se añade un
   cálculo vectorizado para investigar, una prueba lo compara con el incremental.
7. **Lo que el backtest no ejercita, declarado:**
   - el libro real: los controles de libro usan el spread y el slippage supuestos del modelo de costes, con su
     mínimo conservador;
   - los WebSockets, los límites de peticiones, el reloj y la reconciliación con el exchange.

   Por eso el camino es backtest, después paper y shadow, y por último micro-live.
8. **Shadow no usa el capguard.** El capguard se valida aparte, con sus propias pruebas.
9. **Live solo arranca con tres condiciones:** la confirmación de `LIVE_TRADING` (trading-risk §8), la
   estrategia aprobada para live en el registro y con el mismo hash de código, y el capguard disponible.
   `LiveVenue` vuelve a comprobar la confirmación (`LIVE_TRADING_DISABLED`).
10. **Una base de datos por modo** (`data/live.db`, `data/paper.db`, `data/shadow.db`) y una sola instancia del
    proceso principal por máquina. Shadow y live no corren a la vez.
11. **Tramo 1.**
    - `risk/` y `execution/` se construyen en versión de investigación (dimensionado con costes, límites y venue
      simulado), en sus carpetas definitivas y con las interfaces de ARCHITECTURE.md §16.
    - El tramo 2 los completa.
    - En el paso 35 se vuelve a ejecutar el backtest de la estrategia aprobada con los módulos completos, y se
      compara con el resultado del tramo 1.

## Alternativas descartadas

- **Un motor de backtest aparte, vectorizado,** como el `sim.ts` actual o el de Freqtrade. Es más rápido, pero
  diverge del camino real y es la fuente típica del look-ahead. Con velas de 4 h y pocos símbolos, ir evento a
  evento cuesta poco.
- **Ramas por modo dentro de los módulos.** Cada `if (modo)` es un camino que el backtest no prueba.
- **Paper solo contra el testnet del exchange.** No usa los datos reales del mercado, y la fidelidad del
  testnet está por comprobar (docs/CCXT.md §2). Queda como variante de configuración de live.
- **Shadow con fills virtuales.** Sería paper con lectura de la cuenta real, y mezclaría dos fuentes de verdad
  en la reconciliación. Shadow valida el camino real hasta el envío, y paper valida la ejecución simulada.
- **Shadow a la vez que live.** Duplicaría el consumo del límite de peticiones por IP y rompería la instancia
  única.
- **Un modo de validación en el capguard para shadow.** Añadiría un camino más al componente que tiene que ser
  más simple.

## Consecuencias

- **El backtest es más lento** que uno vectorizado. Se acepta: el volumen es pequeño, y los barridos pueden ir
  en procesos separados.
- **El simulador es una pieza crítica:** reproduce los costes de quant-research §5 y los fallos que exige
  exchange-execution §19.
- **Los resultados del tramo 1 son provisionales** frente a los módulos completos (paso 35).
- **Lo que convención y no herramienta hace cumplir:** ningún `if (modo)` fuera de `app/`, y nada de reloj ni
  azar propios en el dominio. Esta última tendrá una regla de ESLint al crear `src/kernel/`.
