# ADR 0029 — Performance Analytics: métricas, DSR, PBO, bootstrap, benchmark, régimen y desgloses

Fecha: 2026-10-14 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 26

## Contexto

El prompt del paso 26 pide Performance Analytics con estas piezas:

- **Métricas:** net P&L, drawdown (máximo y duración), volatilidad, Sharpe, Sortino, Calmar, profit factor, expectancy,
  hit rate, win/loss, turnover, exposure, trades, fees, slippage, pérdidas de cola, y alfa y beta frente a buy-and-hold.
- **Validación:** Deflated Sharpe Ratio con el contador de pruebas del Experiment Registry, PBO cuando haya varias
  configuraciones e intervalos de confianza por bootstrap de bloques.
- **Desgloses:** por activo, tiempo, estrategia y régimen. El régimen son etiquetas point-in-time solo de precios (sin
  datos macro), con su test anti look-ahead.
- **Condiciones:** todas las métricas netas de costes y en EUR, y tests con series sintéticas de resultado conocido.

Compromisos de `PROGRESS.md` para este paso:
- (23) `StrategyInput.regime` cuando exista `analytics/`;
- (25) actualizar los textos «pasos 24 a 27» de `backtest-command.ts` y `research-runner.ts`;
- (23, 24 y 25, compartidos con el 27) DSR, PBO, bootstrap, benchmark buy-and-hold puro, control aleatorio, barridos con
  elección en train y las pruebas que faltan de EXP-0021 y EXP-0022.

`analytics/` ya tenía el resumen del paso 24 (ADR 0027): Sharpe, exposición, rotación y costes. Los costes implícitos
eran una estimación y una cota inferior.

## Decisión

### 1. Todo en `analytics/`, en funciones puras

| Archivo | Contenido |
|---|---|
| `statistics.ts` | Momentos, normal estándar, PSR, SR₀, DSR, suelo de V[SRₙ], MinTRL, PBO por CSCV y bootstrap estacionario |
| `performance.ts` | Resumen de un backtest: P&L, CAGR, volatilidad, Sharpe, Sortino, caída y duración, Calmar, cola, exposición, costes; alfa y beta |
| `trades.ts` | Acierto, profit factor, esperanza, ganancia y pérdida media, relación entre ambas, duración media |
| `benchmark.ts` | Buy-and-hold con todo el capital, de un símbolo o equiponderado |
| `regime.ts` | Clasificador `regimen-precio@1`, `RegimeTracker` en línea, serie de etiquetas y régimen vigente en t |
| `breakdown.ts` | Agrupación de periodos y operaciones por activo, año, estrategia o régimen |
| `report.ts` | Informe de un run: concatenación de tramos, DSR, bootstrap y desgloses |

Las funciones son puras, en float (análisis) y sin E/S. El azar llega con su semilla (`kernel/random.ts`). Los tipos del
régimen están en `src/kernel/regime.ts`, porque strategy/ y risk/ no pueden importar analytics/ (ARCHITECTURE.md §15).

### 2. La serie que se mide: los tramos concatenados, con la liquidación final

Cada tramo de validación empieza con su capital. Su último punto se sustituye por el valor de liquidación, que es lo que
se cobraría vendiendo lo abierto en ese instante. Así la serie concatenada lleva todos los costes y no tiene un periodo
de más. El benchmark se trata igual. Las rentabilidades se encadenan, como si el capital pasara de un tramo al
siguiente. El P&L neto en EUR es la suma de lo ganado en cada tramo.

### 3. Deflated Sharpe con la N del registro

- **N.** Es el `n_familia` de la línea registrada: todas las pruebas de la familia, también las fallidas, abortadas,
  invalidadas y previas.
- **V[SRₙ]** (sustituido por el ADR 0039, 2026-10-21: es la varianza del Sharpe estimado de una prueba sin habilidad con
  la misma longitud y dependencia, sin depender de otras pruebas). Antes: la varianza muestral de los Sharpe por periodo de la familia (los de las pruebas anteriores más el de
  esta), con un suelo de `1/(T − 1)`. Ese suelo es la varianza del Sharpe estimado de una prueba sin habilidad. Sin
  suelo, una familia con pocas pruebas con métricas daría una V casi nula y un SR₀ engañosamente bajo. Con menos de dos
  Sharpe se usa solo el suelo, en lugar de dejar el DSR sin calcular.
- **De dónde salen los Sharpe.** Del cierre `completado` de las pruebas de la misma familia y el mismo timeframe que
  se cerraron antes del pre-registro de esta, en la métrica `sharpe_periodo`. `research/experiment.ts` los pasa al
  ejecutor como `pruebas_familia`, construidos solo con las líneas anteriores al pre-registro: la reproducción recibe lo
  mismo. Las pruebas previas y EXP-0021 y EXP-0022 no tienen esa métrica: cuentan en N, pero no en V.
- **Además** se informan el PSR frente a 0 y el MinTRL al 95 %, y si la historia lo cumple.
- **Autocorrelación** (añadido el 2026-10-21): PSR, DSR y MinTRL usan la varianza a largo plazo del Sharpe estimado, que
  nunca baja de la de rentabilidades independientes (ADR 0038).

### 4. PBO por CSCV, sin valor con una sola configuración

`probabilityOfBacktestOverfitting` sigue quant-research §8:

- S bloques contiguos (16 por defecto, par y como mucho 20). Los primeros `T mod S` llevan una observación más.
- Rendimiento medido con el Sharpe.
- Los empates fuera de muestra van al rango medio. Entre varias mejores dentro de muestra empatadas, gana la primera.

Un experimento con valores fijos tiene una sola configuración, así que su PBO es `null` con el motivo. El PBO real
llega con los barridos con elección en train.

### 5. Bootstrap estacionario sobre la serie concatenada

- **Método.** Politis y Romano, con 10 000 remuestreos y la semilla del experimento (flujo `bootstrap`).
- **Bloque.** La longitud media de bloque es la mayor entre `⌈T^(1/3)⌉` y la duración media de una operación cerrada,
  en velas.
- **Intervalos.** Al 95 % por percentiles, para el Sharpe anualizado, el CAGR, la caída máxima y el exceso de Sharpe
  sobre BTC.
- **Remuestreos compartidos.** Los cuatro estadísticos usan los mismos remuestreos, y el exceso remuestrea los mismos
  periodos de la estrategia y del benchmark.

### 6. Benchmark: buy-and-hold de BTC con todo el capital

- **Compra y venta.** Se compra al último cierre igual o anterior al inicio del tramo, con todo el capital, pagando por
  lado la comisión, el medio spread y el slippage mínimo efectivos del run (con su multiplicador). Al final se paga la
  venta.
- **BTC/EUR.** Sale del mismo dataset registrado, cuyo hash ya cubre todos los pares.
- **Universo.** Si el universo tiene más de un par, se informa también el equiponderado de los pares que cotizan al
  empezar el tramo, sin rebalancear.
- **Fail closed.** Un par sin cierre en las 3 últimas velas en un instante de la curva lanza, porque aún no existe la
  regla de liquidación al deslistar.

No se usa la estrategia BUY_AND_HOLD del paso 24, porque Risk le limita la exposición (ADR 0027): no es un benchmark
con todo el capital.

### 7. Alfa y beta por mínimos cuadrados

Regresión, periodo a periodo, de las rentabilidades netas de la estrategia sobre las del buy-and-hold de BTC. El alfa
por periodo se anualiza multiplicando por los periodos de 365 días. También se informan la correlación y el exceso de
Sharpe anualizado.

### 8. Régimen `regimen-precio@1`: solo precios, ventana fija

- **Volatilidad.** Desviación típica de los últimos 30 log-retornos, situada entre sus 365 últimos valores (incluido el
  actual). Por debajo del percentil 25 es `BAJA`, hasta el 75 `NORMAL`, hasta el 95 `ALTA` y desde ahí `EXTREMA`.
- **Tendencia.** Cierre sobre la SMA de 200 y SMA subiendo en 20 velas es `ALCISTA`. Cierre bajo la SMA y SMA bajando
  es `BAJISTA`. En otro caso, `LATERAL`.
- **Calentamiento.** Hacen falta 395 velas para la volatilidad y 220 para la tendencia. Hasta entonces la etiqueta es
  `null`, que en los desgloses aparece como `SIN_DATO`. Un hueco reinicia la ventana y nada se rellena (sustituido por
  el ADR 0036, 2026-10-20: la vela que falta se excluye sin vaciar la ventana, con un tope que sale de cada fórmula).
- **Ventana fija, no creciente** (cambia ARCHITECTURE.md §4.4). Con una ventana que crece, la etiqueta dependería de
  dónde empieza la historia cargada, y backtest y real darían cosas distintas. Es el mismo criterio que las features
  (ADR 0025).
- **Point-in-time.** La etiqueta de una vela usa solo esa vela y las anteriores. Un periodo se etiqueta con el régimen
  conocido al empezar y una operación con el conocido al abrirse. La prueba anti look-ahead trunca la serie y altera
  todo lo posterior a t, y comprueba que ninguna etiqueta hasta t cambia. Su control altera una vela pasada y comprueba
  que sí cambian.
- **Qué se desglosa.** El régimen de BTC/EUR, en el timeframe del experimento.
- **Parámetros.** Son de investigación (§4.4). Cambiarlos es otra versión del clasificador, y si una estrategia lo usa,
  cuenta en N.

### 9. `StrategyInput.regime`: el del propio símbolo a la misma vela

- **Qué recibe la estrategia.** `TradingSystem` alimenta un `RegimeTracker` con cada vela cerrada y pasa a la
  estrategia el régimen del símbolo a esa misma vela. El Strategy Engine rechaza el de otro símbolo o de otra vela.
- **Qué no cambia.** Las estrategias actuales no lo leen, y no va al diario, así que el hash fijado del diario no
  cambia.
- **Régimen de mercado.** Exigiría que el sistema recibiera velas de BTC aunque no estén en el universo. Se deja para
  cuando una estrategia lo pre-registre.

### 10. Costes implícitos realizados, no estimados

`SimulatedVenue` anota el precio de referencia de cada orden ejecutada: la apertura de la vela de ejecución, el punto
medio del libro o el disparo del stop. Cada fill paga su diferencia con ese precio: medio spread, slippage e impacto
por profundidad. Ya no es una cota inferior. La rentabilidad bruta (la neta más los costes) del control de cordura del
paso 24 sigue cerca de cero con la cifra exacta.

### 11. Definiciones

- **Sortino.** La media entre la raíz de la media de `min(r, 0)²` sobre todos los periodos (objetivo 0).
- **Duración de la caída.** Los periodos desde un máximo hasta recuperarlo, o hasta el final si no se recupera; se da
  la más larga.
- **VaR y expected shortfall.** Al 95 %, históricos, con el cuantil de tipo 7.
- **Profit factor.** Es `null` sin pérdidas, porque infinito no cabe en el registro.
- **Rotación.** Importe negociado entre el capital inicial total, y su versión anual.
- **Exposición.** Tiempo en mercado y fracción media del patrimonio en posiciones.

### 12. Todo en EUR

El ejecutor rechaza un universo con un par que no cotice en EUR, y `analyzeRun` rechaza otra moneda.

## Alternativas consideradas

- **Régimen con ventana creciente** (ARCHITECTURE.md §4.4, versión anterior). Se descarta porque depende del inicio de
  la historia cargada.
- **DSR solo con V empírica, y sin valor con menos de dos Sharpe.** Dejaría el DSR sin calcular en todas las familias
  actuales, que no tienen Sharpe por periodo registrado. El suelo es más exigente y siempre calculable.
- **Un bootstrap independiente por métrica.** Gasta más y rompe el emparejamiento entre la estrategia y el benchmark.
- **Benchmark con la estrategia BUY_AND_HOLD.** Risk la limita (ADR 0027): no tiene todo el capital.
- **Mantener la estimación de costes implícitos.** La cifra exacta ya estaba en el venue; solo hacía falta exponerla.

## Consecuencias

- **Qué guarda el cierre.** Cada experimento completado lleva el informe entero en la salida, y sus cifras principales
  en las métricas del registro: DSR, PSR, SR₀, MinTRL, IC, alfa, beta, `pbo: null` y `sharpe_periodo`. Esta última
  alimenta la V de las pruebas siguientes de la familia.
- **Veredicto.** Sigue en `null`. Faltan el control aleatorio de al menos 1000 simulaciones, la robustez (§7), los
  barridos con elección en train (con ellos, el PBO real) y los criterios congelados. Esos compromisos pasan al paso 27,
  junto con las pruebas que faltan de EXP-0021 y EXP-0022 y la ampliación de `literatureParams`.
- **Reproducción de EXP-0021 y EXP-0022.** El código del ejecutor cambió, así que se reproducen solo en un worktree de
  su commit (ADR 0024).
- **Coste del bootstrap.** Con datos horarios de varios años, T es grande y 10 000 remuestreos tardan minutos.
- **Régimen sin dato.** Las primeras 395 velas de cada serie quedan en `SIN_DATO` en el desglose de volatilidad.
