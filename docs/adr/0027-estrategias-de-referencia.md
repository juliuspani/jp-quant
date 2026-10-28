# ADR 0027 — Estrategias de referencia, control negativo y métricas de analytics

Fecha: 2026-10-14 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 24

## Contexto

El prompt del paso 24 pide:

- una estrategia baseline deliberadamente sencilla, solo para validar el pipeline y sin presentarla como rentable;
- RANDOM como control negativo y BUY_AND_HOLD como benchmark;
- comprobar el camino completo Data → Features → Strategy → Risk → Execution → Fill → Portfolio → Analytics;
- demostrar con pruebas que Strategy no puede evitar Risk;
- un control de cordura: RANDOM debe perder más o menos los costes, y si gana de forma consistente hay un fallo o
  leakage que se investiga antes de seguir.

Lo que había: el sistema compuesto y el backtester del paso 23 (ADR 0026), sin estrategias reales (`RESEARCH_RUNNERS`
vacío) y sin `analytics/`. Las métricas del backtest eran la rentabilidad neta, la caída máxima, las operaciones y las
comisiones. El contrato de estrategia exige funciones puras: sin E/S, sin reloj y sin azar. Las features no incluían el
cierre. El compromiso de la fila «24 a 27» de `PROGRESS.md` (barridos con elección en train, DSR, PBO, bootstrap y
control aleatorio de quant-research §6 y §8) cubre cuatro pasos. Este paso cubre el benchmark y el control negativo
básico, sobre los que se construye lo demás.

## Decisión

### 1. Tres estrategias en `src/strategy/baselines.ts`, construidas con sus features

Cada una es una función que recibe los parámetros y el timeframe y devuelve la estrategia, su conjunto de features y
los parámetros congelados (`StrategyKit`). Así el calentamiento declarado sale de las mismas features que usa. Ningún
parámetro tiene valor por defecto: un valor fuera de rango lanza al construirla (paso 25: los fija el pre-registro).

| Estrategia | Id | Regla |
|---|---|---|
| BASELINE | `baseline-cierre-ema` | Entra con el cierre sobre su EMA y sale con el cierre por debajo |
| RANDOM | `random` | Entra con probabilidad `entryProbability` por vela y sale con `exitProbability` |
| BUY_AND_HOLD | `buy-and-hold` | Entra en cuanto puede y mantiene; si salta el stop de protección, vuelve a entrar |

Las tres ponen el stop a `stopFraction` por debajo del cierre de la señal. Para eso se añade la feature `close` al
catálogo, que pasa la prueba anti look-ahead genérica.

### 2. RANDOM es pura: el azar sale de la semilla, el símbolo y el instante

`seededUnit(seed, key)` (`src/kernel/random.ts`) da un número en [0, 1) que solo depende de sus argumentos. RANDOM lo
llama con la semilla de sus parámetros y la clave `símbolo|cierre de la vela`. Ningún precio entra en la decisión, que
no puede saber nada del mercado. La misma entrada da siempre la misma decisión, y el diario sigue siendo determinista.

### 3. Las tres pasan por Risk como cualquier estrategia; BUY_AND_HOLD tiene la parte que Risk le deja

Ninguna tiene un camino propio: el Strategy Engine pide siempre tamaño por riesgo y Risk aplica sus límites. Por eso
BUY_AND_HOLD no está invertido al 100 %. Con un stop al 50 %, Risk le da menos del 2 % del patrimonio: el 0,75 % de
riesgo entre la distancia al stop más los costes. Como benchmark sirve para la métrica primaria, el Sharpe
(quant-research §2), que no depende de la parte invertida. No sirve para comparar rentabilidades sin escalarlas por la
exposición. El buy-and-hold puro de quant-research §6 (todo el capital en BTC) se calcula fuera del pipeline en los
pasos 25 a 27, junto con el resto de controles del informe.

### 4. `analytics/performance.ts`: el último eslabón del camino

Resume la curva marcada a mercado y los fills, en float, porque solo describe: rentabilidades por periodo, Sharpe por
periodo y anualizado con 365 días, tiempo en mercado, rotación, comisiones exactas y una estimación de los costes
implícitos. Esa estimación cuenta el medio spread y el slippage mínimo de cada fill, más la venta supuesta al final, y
es una cota inferior porque el impacto por profundidad puede añadir más. La rentabilidad bruta estimada es la neta más
esos costes. `BacktestResult.performance` la lleva, y el ejecutor de experimentos anota en el registro el Sharpe
anualizado y los costes de cada tramo. Es el primer archivo de `analytics/`; el régimen sigue siendo del paso 26.

### 5. El control de cordura, solo con datos sintéticos

Se hace en pruebas, sobre paseos aleatorios multiplicativos con media cero por vela. El precio es una martingala, así
que ninguna regla gana en esperanza antes de costes. Con 30 paseos de 600 velas horarias, RANDOM tiene que cumplir:

- la bruta media no es significativamente positiva (menos de 2 errores típicos);
- pierde entre 0,6 y 1,6 veces los costes estimados;
- gana en como mucho un quinto de los paseos.

El resultado en el commit del paso: pierde 1,02 veces los costes (neta media −4,09 %, costes 3,99 %, bruta
−0,10 % ± 0,24 %) y gana en 1 de 30. Para comprobar que el control tiene potencia, una estrategia que hace trampa a
propósito (conoce los cierres futuros del paseo) gana en todos.

No se ejecuta nada sobre datos reales en este paso. Un run con datos reales es una prueba del registro y suma a `N`
(quant-research §1 y §10), y el primero está asignado al paso 25. Las estrategias no se dan de alta en
`RESEARCH_RUNNERS` hasta entonces.

### 6. Strategy no puede evitar Risk: INV-06f

Se añade el control INV-06f (`test/invariants/strategy-risk.test.ts`) al invariante INV-06. Corre una estrategia de
verdad por el sistema compuesto y comprueba cuatro cosas:

- Toda orden y todo fill vuelven, por su client order ID, a una intención, a una decisión de Risk que aprobó y a su
  token, en ese orden, sin pasar de la cantidad aprobada. Quitar del diario las decisiones, los tokens o las
  intenciones rompe la cadena.
- Una decisión con campos forjados (cantidad, modo de tamaño, aprobación, origen o `reduceOnly`) deja el diario
  idéntico byte a byte.
- Un stop ausente, negativo, no finito o por encima del precio se rechaza en Risk (`STOP_INVALID`) y no llega al venue.
- La estrategia no puede escribir en las features que recibe: intentarlo detiene el backtest.

Es un control nuevo, no un cambio de invariante: no es una parada obligatoria (SECURITY_AND_TRADING_INVARIANTS.md §2).

## Alternativas

- **BUY_AND_HOLD fuera de Risk, con todo el capital.** Es el benchmark puro de quant-research §6, pero no es una
  estrategia del pipeline: no valida el camino y tendría un dimensionado distinto del de las demás. Se descarta como
  estrategia y queda como cálculo del informe (paso 25 en adelante).
- **Relajar los límites de Risk para el benchmark.** Prohibido: un límite no se relaja para que pase una operación
  (trading-risk §11).
- **RANDOM con un generador con estado.** Rompe la pureza del contrato y haría depender la decisión del orden de las
  llamadas. Se descarta.
- **El control negativo sobre datos reales.** Sobre activos con deriva, un largo aleatorio gana con el mercado, y la
  regla «pierde los costes» solo vale corrigiendo por la exposición. Además, sería una prueba del registro. Se hace sobre
  precios sin estructura; el control aleatorio sobre datos reales, con el mismo número de operaciones y la misma
  duración que la estrategia (quant-research §6), es de los pasos 25 a 27.
- **Las métricas de rendimiento en `app/backtest.ts`.** Es lo que había. Pasan a `analytics/`, que es su módulo
  (ARCHITECTURE.md §4.2) y que también podrán usar `research/` y `monitoring/`.

## Consecuencias

- El pipeline tiene tres estrategias de referencia probadas de punta a punta, y un control negativo que fallaría si
  apareciera un leakage que hiciera ganar a una regla aleatoria.
- El informe de cada tramo lleva Sharpe anualizado y costes estimados. El veredicto sigue en `null`: faltan DSR, PBO,
  bootstrap y el control aleatorio de 1000 simulaciones (pasos 25 a 27).
- BUY_AND_HOLD como estrategia está limitado por Risk. Comparar rentabilidades con él exige escalar por la exposición.
- El control de cordura se fija con semillas: es determinista, pero una tolerancia mal elegida podría esconder un sesgo
  pequeño, de menos de un 25 % de los costes. Lo que asegura es que no hay una ventaja del tamaño de los costes.
- Los costes implícitos de analytics son una estimación por debajo. Las cifras netas siguen siendo exactas, porque
  salen de los fills.
