# Criterios de promoción de estrategias

**CONGELADO** el 2026-10-15 en el paso 27 ([ADR 0030](adr/0030-criterios-congelados.md)), antes de ver ningún
resultado de investigación. Sustituye a los umbrales provisionales del [ADR 0002](adr/0002-protocolo-quant-research.md).
Desarrolla `quant-research` §9 y §11 y el [ADR 0019](adr/0019-periodo-del-test-final.md), y es más estricto que
ellos donde difieren.

**CAMBIADO POR LA PERSONA** el 2026-10-22, después de ver los resultados de la primera ronda y tras la auditoría quant
(ADR 0030, decisión 9): cómo se miden A.3.2, A.3.5, A.3.9, A.3.11 y A.3.14, y el mínimo de configuraciones de A.3.6. Los
umbrales no cambian. Es un cambio a la vista de resultados, con la contaminación declarada y la validación reiniciada.

- **Cambios.** Cambiar, quitar o relajar cualquier cosa de este documento es una parada obligatoria (`CLAUDE.md`
  §7). Exige un ADR justificado y aprobado por la persona, y **reinicia la validación**: toda estrategia por encima
  de RESEARCH vuelve a BACKTESTED y se evalúa de nuevo con los criterios nuevos, con `N` contando todas las pruebas
  anteriores. Nunca se cambia un criterio a la vista de un resultado; la única excepción, la del 2026-10-22, la decidió
  la persona y está declarada en el ADR 0030.
- **Huella.** El SHA-256 de este archivo (con finales de línea LF) está en el ADR 0030 y en `PROGRESS.md`, y
  `test/docs/frozen-criteria.test.ts` falla si el archivo cambia.

Este documento contiene la parte A (criterios de promoción) y la parte C (qué se hace si ninguna estrategia los
cumple). La parte B, el gate antes de operar con dinero real, está en [PRE_LIVE_GATE.md](PRE_LIVE_GATE.md).

## Reglas generales

1. **Todo se mide fuera de muestra y neto de costes**, sobre la concatenación de los tramos de validación del
   walk-forward con datos hasta el 2026-09-30T23:59:59Z. Las métricas dentro de muestra se informan, pero no
   deciden nada.
2. **Fallar un solo criterio basta para `RECHAZADA`.** Un criterio que no se puede medir da `NO CONCLUYENTE`, nunca
   un PASS. Ante la duda, se rechaza.
3. **La métrica primaria** es el Sharpe anualizado (365 días) neto de costes, salvo que el pre-registro fije otra
   más estricta.
4. **Todo se pre-registra.** Las variantes de sensibilidad, ablación y estrés se pre-registran con su experimento y
   cuentan en `N`, como cualquier ejecución sobre datos reales cuyas métricas se ven (`quant-research` §1).
5. **Los umbrales son mínimos.** Un pre-registro puede fijar otros más estrictos, nunca más laxos.
6. **Sin test final.** Nada de esta parte abre `config/holdout.lock`. Las etapas que lo usan (micro-live y más
   capital) tienen sus propios criterios al final de este documento.

## Parte A — Estados y criterios de promoción

### A.1 Estados

| Estado | Qué significa | Dónde consta |
|---|---|---|
| RESEARCH | Está en la biblioteca, con ficha y ejecutor, y tiene experimento pre-registrado | `docs/research/biblioteca/` y el Experiment Registry |
| BACKTESTED | Tiene un experimento `completado`, desde un commit limpio, con el informe completo de A.2 | Registro y `docs/research/experiments/EXP-NNNN.md` |
| VALIDATED | Pasa **todos** los criterios de A.3. Es el veredicto `CANDIDATA A TEST FINAL` de `quant-research` §11 | Registro e informe |
| PAPER | Pasa A.4 en la decisión provisional del paso 31 (etapa 1 del ADR 0019). Es el veredicto `CANDIDATA A PAPER` | Registro y documento de decisión del paso 31 |

- Se avanza de uno en uno y nunca hacia atrás sin dejar constancia. Una estrategia `RECHAZADA` no vuelve:
  cambiarla es una hipótesis nueva de su familia, y su prueba suma a `N`.
- PAPER solo permite paper trading. No es una aprobación de la ventaja: valida la ejecución.
- Hasta que exista el Strategy Registry (paso 34), el estado consta en el Experiment Registry y en el documento de
  decisión del paso 31.

### A.2 De RESEARCH a BACKTESTED

Todo esto existe y está en el informe. Si falta algo, la estrategia sigue en RESEARCH y el experimento es
`NO CONCLUYENTE`.

- Pre-registro anterior a cargar datos reales, con hipótesis, métrica primaria, criterios, familia, `N` y la
  rejilla completa.
- Ejecución por `npm run backtest` desde un commit limpio, con la huella de los datos.
- Costes del modelo de ejecución con al menos los mínimos de `quant-research` §5, más las ejecuciones con costes
  ×2 y ×3.
- Walk-forward con al menos 3 tramos de validación, parámetros elegidos solo en train, y purging y embargo con
  `e ≥ h`. Los episodios bajistas de 2018 y 2022 caen enteros dentro de tramos de validación, y el perfil por régimen
  de su familia (A.3.9) está en el pre-registro.
- Benchmark buy-and-hold (BTC y equiponderado), control aleatorio de al menos 1000 simulaciones con su semilla y
  las dos pruebas de humo de `quant-research` §6.
- DSR, PSR, MinTRL, bootstrap estacionario de al menos 10 000 remuestreos y desgloses por año, tramo, activo y
  régimen.
- Sensibilidad, ablación y universo alternativo (`quant-research` §7) y las pruebas de estrés de A.3.7.

### A.3 De BACKTESTED a VALIDATED

| # | Criterio | Umbral congelado |
|---|---|---|
| A.3.1 | Fuera de muestra y walk-forward | Al menos 3 tramos de validación. La métrica primaria es mayor que 0 en la serie concatenada **y en al menos la mitad de los tramos** |
| A.3.2 | Deflated Sharpe | `DSR ≥ 0,95` con la `N` de la familia. **Además**, `DSR ≥ 0,95` con la `N` global: todas las pruebas del Experiment Registry, de todas las familias, incluidas las previas, fallidas, abortadas e invalidadas, contadas al decidir en el paso 31 y la misma para todos los candidatos (ADR 0039). `V[SRₙ]` es la varianza del Sharpe estimado de una prueba sin habilidad con la misma longitud y dependencia, nunca por debajo de `1/(T − 1)` (ADR 0039). PSR y DSR usan la varianza a largo plazo del Sharpe (ADR 0038) |
| A.3.3 | Costes realistas y con margen | Costes del modelo del exchange, nunca por debajo de los mínimos de `quant-research` §5. **Con costes ×2, la métrica primaria y el P&L neto siguen siendo mayores que 0.** Con ×3 se informa |
| A.3.4 | Drawdown máximo | Caída máxima de la serie concatenada **≤ 10 %**, el breaker `DRAWDOWN_HALT` de `trading-risk` §5. El límite superior del IC al 95 % de la caída máxima (bootstrap) **≤ 20 %** |
| A.3.5 | Número mínimo de operaciones | **≥ 100 operaciones cerradas** fuera de muestra. La historia cumple `MinTRL` al 95 %, con la varianza a largo plazo del Sharpe (ADR 0038), e incluye al menos un mercado bajista completo (2018 o 2022) |
| A.3.6 | PBO máximo | **`PBO < 0,20`** por CSCV (`S = 16`). La matriz incluye todas las configuraciones con serie de rendimientos que compiten por la decisión: todas las de la ronda, de todas las familias, y todos los puntos de cada rejilla. Con `PBO ≥ 0,20`, `RECHAZADA`. Con menos de 3 configuraciones, `NO CONCLUYENTE`: el PBO se informa y no decide (ADR 0041). El de cada familia también se informa y no decide |
| A.3.7 | Stress testing | Las cuatro pruebas de la tabla A.3.7, todas en PASS |
| A.3.8 | Estabilidad de parámetros | Con ±25 % y ±50 % en cada parámetro, de uno en uno, la métrica primaria no cambia de signo ni cae a menos de la mitad. Ningún parámetro con más de 3 cifras significativas. En un barrido, el parámetro elegido en train se mueve como mucho un punto de la rejilla en al menos dos tercios de los cambios de tramo |
| A.3.9 | Regímenes | Cumple el perfil por régimen de su familia (tabla A.3.9), que sale de su hipótesis y se registra antes de mirar resultados. El desglose de volatilidad se informa |
| A.3.10 | Buy-and-hold ajustado por riesgo | El Sharpe **y** el Calmar netos superan a los del buy-and-hold de BTC y a los del equiponderado del universo, en el mismo periodo y con los mismos costes. Se informa el IC al 95 % del exceso de Sharpe |
| A.3.11 | Intervalo de confianza | El límite inferior del IC al 95 % de la métrica primaria es mayor que 0. Decide el menor de dos límites: el del bootstrap estacionario por bloques y el de la varianza a largo plazo del Sharpe (ADR 0038) |
| A.3.12 | Control aleatorio | La métrica primaria supera el percentil 95 de al menos 1000 simulaciones aleatorias con las mismas operaciones, duración, tamaño y costes |
| A.3.13 | Estabilidad temporal y por activo | Sin el mejor año y sin el mejor activo, la métrica primaria sigue siendo mayor que 0 |
| A.3.14 | Ablación y universo alternativo | Todos los componentes que quedan aportan: sin cada uno, el exceso de la métrica primaria sobre la mediana de su propio control aleatorio (sus mismas operaciones y duraciones) es menor que el de la estrategia completa sobre el suyo (ADR 0037). Con activos que no se usaron para diseñarla, la métrica primaria es mayor que 0 |
| A.3.15 | Pruebas de humo | Con la señal desplazada al azar y con un paseo aleatorio, el resultado es nulo (no supera el percentil 95 del control aleatorio) |

**Tabla A.3.9 — Perfil por régimen de cada familia.**

| Familia | Bajista: cada episodio por separado | Alcista | Lateral | Por qué, según su hipótesis |
|---|---|---|---|---|
| Trend following / momentum defensivo (`tendencia-donchian-atr`, `regimen-btc-sma200`) | Pierde ≤ 50 % de lo que pierde BTC | Captura ≥ 50 % de la subida de BTC | Pérdida anualizada ≤ 5 % | Sigue la tendencia y sale a liquidez cuando se rompe |
| Reversión a la media (`reversion-rsi2`) | Pierde ≤ 25 % de lo que pierde BTC | Captura ≥ 25 % de la subida de BTC | Rentabilidad anualizada ≥ 0 % | Su filtro de la SMA 200 la deja fuera en bajista; está poco tiempo en mercado; dice ganar en los rebotes de corto plazo |
| Breakout / expansión de volatilidad (incluye `ruptura-volatilidad-intradia`) | Pierde ≤ 50 % de lo que pierde BTC | Captura ≥ 50 % de la subida de BTC | Pérdida anualizada ≤ 5 % | El mismo mecanismo que la tendencia, con el riesgo de las rupturas falsas en lateral |
| Cross-Sectional Momentum | Pierde ≤ 50 % de lo que pierde BTC | Captura ≥ 100 % de la subida de BTC | Pérdida anualizada ≤ 5 % | Dice elegir a las ganadoras: en alcista tiene que igualar o superar a BTC. Medida contra BTC, no contra las altcoins que caen más |
| Price + Volume Momentum | Pierde ≤ 50 % de lo que pierde BTC | Captura ≥ 50 % de la subida de BTC | Rentabilidad anualizada ≥ 0 % | Dice que el volumen descarta las señales falsas: en lateral no puede perder |

Cómo se mide (ADR 0042):

- **Benchmark: BTC escalado por la exposición de la estrategia.**
  - En cada periodo gana e veces lo que gana el buy-and-hold de BTC con todo el capital, con su compra y su venta en
    cada tramo y los mismos costes.
  - e es la exposición de la estrategia: sus posiciones que no son polvo entre el patrimonio, en la marca que cierra
    cada periodo, con la media ponderada por la propia exposición.
  - En el bajista y en el alcista se compara dos veces, con la e de toda la serie y con la e de esos mismos periodos, y
    vale la más exigente. Si en esos periodos no hubo ninguna posición que no fuera polvo, decide la primera.
  - Sin ninguna posición en toda la serie, el bajista y el alcista son `NO CONCLUYENTE`.
  - En la tabla, «lo que pierde BTC» y «la subida de BTC» son las de este benchmark.
- **Bajista.** En cada episodio, 2018-01-01 a 2019-01-01 y 2022-01-01 a 2023-01-01 (UTC), se compara por separado el
  crecimiento logarítmico de la estrategia, ln(1 + r) con r su rentabilidad neta compuesta en el episodio, con el del
  benchmark. «Pierde ≤ X %» significa ln(1 + r de la estrategia) ≥ X · ln(1 + r del benchmark). Si el benchmark no cae
  en un episodio, la estrategia no puede perder en él.
- **Alcista y lateral.** Son los periodos de validación que `regimen-precio@1` etiqueta en BTC como `ALCISTA` o
  `LATERAL`, point-in-time.
  - «Captura ≥ X %» significa ln(1 + r de la estrategia) ≥ X · ln(1 + r del benchmark), con r la rentabilidad compuesta
    en los periodos alcistas. Si el benchmark no sube en ellos, la estrategia no puede perder.
  - La lateral es un umbral absoluto: la rentabilidad compuesta de la estrategia en esos periodos, anualizada con 365
    días.
  - Los periodos `SIN_DATO` no cuentan.
- **Todo neto de costes y en EUR.**
- **Lo que A.3.9 no mide.** El valor de entrar y salir entre regímenes lo miden A.3.10 y A.3.7, frente al buy-and-hold
  con todo el capital. A.3.9 mide cómo participa la estrategia en cada régimen, con su propio tamaño.
- **Pre-registro.** Cada experimento copia el perfil de su familia y solo puede endurecerlo. Una familia sin perfil en
  esta tabla no puede llegar a VALIDATED sin un ADR que lo añada, y añadirlo es cambiar este documento.
- **Fuera de muestra.** El diseño del walk-forward deja 2018 y 2022 enteros dentro de tramos de validación (A.2). Si
  un episodio no está fuera de muestra, el resultado es `NO CONCLUYENTE`.

**Tabla A.3.7 — Stress testing.**

| Prueba | PASS si |
|---|---|
| Costes ×2 y ×3 | Lo de A.3.3 |
| Retraso de una vela | Ejecutando en la apertura de la vela t+2 en lugar de la t+1, la métrica primaria sigue siendo mayor que 0 |
| Ventanas de crisis | En cada ventana que cae dentro de los tramos de validación, la caída máxima de la estrategia ≤ 10 % y su rentabilidad neta ≥ la del buy-and-hold de BTC. Ventanas fijas: 2018-01-01 a 2018-12-31, 2020-03-01 a 2020-04-30, 2021-05-01 a 2021-07-31 y 2022-01-01 a 2022-12-31 (fechas UTC, extremo final incluido) |
| Peor caso dentro de la vela | Si stop y objetivo caen en la misma vela, se asume lo peor (`quant-research` §5). Un backtest que no lo haga no es válido |

Notas:

- **Por qué dos `N` en A.3.2.** La decisión del paso 31 elige entre todas las familias: las pruebas de todas
  compiten por ella. La `N` global es la más exigente y no depende de cómo se agrupen las familias.
- **Por qué 10 % en A.3.4.** Es el breaker que en real para las entradas y solo rearma una persona. Una estrategia
  que en el backtest ya lo habría disparado no podría operar tal como se probó.
- **Régimen y ventanas.** Los parámetros del régimen los eligió Claude conociendo el periodo (ADR 0029). Aquí solo
  pueden rechazar, nunca elegir ni ajustar una estrategia. Las ventanas de crisis se fijan antes de ver ningún
  resultado de estrategia.
- **Por qué BTC escalado en A.3.9.** El riesgo por operación de A.4.5 limita el tamaño de las posiciones. Frente a BTC
  con todo el capital, ninguna estrategia dimensionada por Risk podía capturar el alcista (auditoría quant Q-02). A.3.10
  sigue comparando con todo el capital, porque el Sharpe y el Calmar no dependen del tamaño.

### A.4 De VALIDATED a PAPER (paso 31, etapa 1 del ADR 0019)

| # | Criterio | Umbral congelado |
|---|---|---|
| A.4.1 | Criterios de A.3 | Todos en PASS en el mismo experimento, sin que ninguno se haya medido en el test final |
| A.4.2 | Consultor quant | Su informe (`consultor-quant`) sobre el experimento no deja ningún hallazgo de severidad alta o crítica sin resolver. Resolverlo puede exigir repetir el experimento, y esa prueba suma a `N` |
| A.4.3 | Reproducción | El experimento se reproduce desde su commit (ADR 0024) con el mismo hash de salida |
| A.4.4 | Decisión | Documento de decisión del paso 31: qué estrategias pasan, cuáles no y por qué, con su evidencia, y la línea en el Experiment Registry. La decisión es provisional y solo permite paper |
| A.4.5 | Riesgo | La estrategia funciona con los límites de `src/risk/limits.ts` (0,75 % de riesgo por operación y 75 % de exposición máxima), y el backtest se hizo con ellos |

### A.5 Etapa 2: micro-live (unos 100 EUR)

Exige el PRE-LIVE GATE en PASS ([PRE_LIVE_GATE.md](PRE_LIVE_GATE.md)) y, además, que el comportamiento hacia delante
sea **coherente** con lo esperado. Esta etapa no aprueba la ventaja: solo puede refutarla. Fallar un criterio deja
la estrategia `RECHAZADA` (ADR 0019): no se reoptimiza.

- **Cuándo.** Nunca antes del 2027-01-01, con al menos 3 meses de datos hacia delante desde el 2026-10-01 o desde el
  inicio del paper, lo que sea posterior. Abrir el test final lo autoriza la persona (M-13).
- **Distribución de referencia.** Bootstrap estacionario de la serie concatenada fuera de muestra del experimento
  aprobado, con su semilla, 10 000 remuestreos de la misma longitud que el periodo hacia delante y la misma longitud
  media de bloque que su informe. De ahí salen los percentiles de esta tabla.

| # | Criterio | Coherente si |
|---|---|---|
| A.5.1 | Rentabilidad | La rentabilidad neta hacia delante ≥ el percentil 5 de la distribución de referencia |
| A.5.2 | Caída | La caída máxima hacia delante ≤ el percentil 95 de la referencia y ≤ 10 %. Ningún `DRAWDOWN_HALT` |
| A.5.3 | Frecuencia | El número de operaciones está en el intervalo central del 95 % de una Poisson con la tasa del backtest |
| A.5.4 | Costes | El coste realizado medio por operación (comisión, spread y slippage) ≤ 1,5 veces el del modelo. Ningún `SLIPPAGE_BREAKER` |
| A.5.5 | Decisiones | Una reproducción del código aprobado sobre los mismos datos hacia delante da las mismas señales, en la misma vela y con el mismo lado, en el 100 % de los casos |

### A.6 Etapa 3: capital por encima de micro-live

Exige el año completo hacia delante (2027-10-01), la etapa 2 en PASS y el PRE-LIVE GATE vigente. Son condiciones
necesarias, no suficientes: cuánto capital se añade lo decide la persona, con los límites de `trading-risk`.

- **Fallar la etapa 3 significa no subir capital.** Si falla A.6.1 (la coherencia de la etapa 2, medida sobre el
  año), la estrategia queda `RECHAZADA` y se retira. Si A.6.1 pasa y falla otro criterio, la estrategia sigue en
  micro-live con el mismo capital y la etapa 3 se repite con el año siguiente de datos hacia delante, con los mismos
  criterios.
- **Nunca se reoptimiza entre etapas** ni entre revisiones anuales: cambiar la estrategia es una hipótesis nueva sin
  test final limpio en su familia (ADR 0019).

| # | Criterio | PASS si |
|---|---|---|
| A.6.1 | Coherencia | A.5.1 a A.5.5, medidos sobre el año completo con una referencia de esa longitud |
| A.6.2 | Resultado | P&L neto del año > 0 y Sharpe neto del año > 0 |
| A.6.3 | Caída | Caída máxima del año ≤ 10 %, sin ningún `DRAWDOWN_HALT` |
| A.6.4 | Frente a buy-and-hold | Caída máxima del año menor que la del buy-and-hold de BTC del mismo periodo |
| A.6.5 | Operación | Ningún incidente crítico del PRE-LIVE GATE en el año: órdenes duplicadas, estado sin reconciliar más de 2 ciclos o kill switch activado por un fallo propio |

## Parte C — Si ninguna estrategia cumple A en el paso 31

### C.1 Segunda ronda

Si en el paso 31 ninguna estrategia llega a PAPER, se hace una segunda ronda y solo una.

- **Familias.** Solo las pendientes del ADR 0028: Breakout / Volatility Expansion, Cross-Sectional Momentum y
  Price + Volume Momentum. Las de la primera ronda no vuelven con otros parámetros en esta ronda.
- **Mismo contador de multiple testing.** Las pruebas de la segunda ronda se suman a la `N` global de A.3.2, que ya
  incluye la primera ronda y las previas. Cada familia nueva cuenta además sus pruebas previas: la ruptura de
  volatilidad intradía de `docs/research/02` (familia `ruptura-volatilidad-intradia`) cuenta para Breakout. El
  CSCV de A.3.6 incluye las configuraciones de las dos rondas.
- **Pre-registro conjunto y acotado.** Todas las estrategias de la ronda se pre-registran antes de cargar datos para
  ninguna: como mucho 2 estrategias por familia y como mucho 20 configuraciones por estrategia. Parámetros de la
  literatura, nunca del barrido de `docs/research/02`.
- **Mismos criterios.** Los de la parte A, sin relajar ninguno. Mismos datos (hasta el 2026-09-30), sin tocar el test
  final.
- **Contaminación declarada.** Quien propone las reglas (Claude) conoce el periodo (`quant-research` §12). Se
  declara en cada pre-registro.
- **Decisión.** Un documento de decisión de la segunda ronda, con el mismo formato que el del paso 31.

### C.2 Si tampoco hay evidencia

Si tras la segunda ronda ninguna estrategia llega a PAPER:

1. **Se para el desarrollo de trading activo.** No se empiezan los pasos de ejecución real del tramo 2 para
   estrategias activas. El código de research y los registros se conservan tal cual.
2. **Se documenta la alternativa pasiva** en un documento de decisión: buy-and-hold o DCA, con la evidencia que la
   sostiene (benchmarks de las dos rondas y las pruebas previas de las familias `dca-btc` y `regimen-btc-sma200`).
   Es la conclusión del proyecto, no un consejo de inversión personalizado: si se aplica y cómo lo decide la persona.
3. **No hay tercera ronda** ni nueva familia sin un ADR aprobado por la persona, que cuenta como cambio de este
   documento: reinicia la validación y su `N` incluye todo lo anterior.
