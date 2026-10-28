# ADR 0032 — Barridos con elección en train y primera familia del paso 28

Fecha: 2026-10-16 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 28 (parte 1 de 2)

## Contexto

El prompt del paso 28 pide investigar una familia de estrategias del paso 25 por sesión: hipótesis antes de ejecutar,
train y validation temporales con purging y embargo, walk-forward, test final intacto, estabilidad, sensibilidad, costes,
regímenes, Deflated Sharpe y PBO; un presupuesto máximo de configuraciones por familia declarado al inicio, sin barridos
masivos y penalizando la complejidad; comparar siempre con RANDOM y BUY_AND_HOLD; todo por el Experiment Registry; y
decir si ninguna estrategia muestra evidencia robusta, sin fabricar una ganadora.

Compromisos de `PROGRESS.md` para este paso:
- (27B, regla de la persona) cada familia pre-registra, antes de mirar datos, un barrido pequeño (como mucho 20
  configuraciones por estrategia, `docs/PROMOTION_CRITERIA.md` C.1) para que el PBO (A.3.6) se pueda medir; todas las
  configuraciones cuentan en N; cada especificación declara sus `variantes` y un universo alternativo;
- («Antes del 31», de los pasos 23, 26 y 27B) barridos con elección en train sobre el ejecutor del backtester; con ellos,
  el PBO dentro del experimento y la estabilidad del elegido (`sweepStability`); ampliar `literatureParams`.

Hasta este paso el ejecutor rechazaba cualquier rejilla, porque elegir parámetros en train estaba pendiente. Sin barrido,
A.3.6 queda siempre en `NO CONCLUYENTE` (ADR 0031, decisión 6 bis).

## Decisión

### 1. Walk-forward con elección en train

Con `parametros.tipo = "rejilla"`, en cada tramo del walk-forward cada punto de la rejilla se ejecuta con el backtester
completo (Strategy, Risk, Execution y costes) sobre su ventana de train, y se puntúa con la métrica primaria: el Sharpe
anualizado con 365 días, neto de costes (`analytics/selection.ts`). El mejor se mide en la validación de ese tramo. La
serie fuera de muestra que deciden los criterios es la concatenación de lo elegido en cada tramo.

- **Sin Sharpe** (curva plana, sin operaciones) puntúa 0: no operar gana a perder. **Con empate**, gana el primero de la
  rejilla. La elección es determinista y se reproduce.
- **El orden de la rejilla** es fijo: claves ordenadas y valores en el orden registrado (`gridPoints`).
- Las puntuaciones de train van en la salida (`seleccion`) y las de lo elegido en el cierre (`tramo_N_sharpe_train`).
  Son dentro de muestra: se informan, eligen, pero no deciden el veredicto.

### 2. Purging y embargo (`quant-research` §4)

- **Purging, h velas:** la ventana de train termina h velas antes de su final. Lo que está abierto en ese punto se valora
  como si se vendiera, con costes, así que su resultado posterior no puntúa.
- **Embargo, e velas (e ≥ h):** tras cada tramo de evaluación que termina dentro de una ventana de train posterior, sus e
  velas siguientes no puntúan (el Sharpe de train se calcula sin esos periodos, por su punto medio). Es la lectura literal
  de §4: «tras cada tramo de evaluación se excluyen e velas antes de reutilizar datos para entrenar».
- Sin barrido no se elige nada en train, y purging y embargo no se usan.
- Una prueba de punta a punta comprueba que no hay fugas: cambiar las velas de validación, o las purgadas, no cambia lo
  elegido en los train anteriores; las que sí entran en un train posterior cambian su puntuación.

### 3. Cada punto de la rejilla se mide fuera de muestra

Además de lo elegido, cada punto se ejecuta en todos los tramos de validación. Esas series sirven para dos cosas:

- **PBO de la familia (A.3.6):** CSCV con S = 16 sobre todos los puntos de la rejilla (`pboAcross`).
- **V[SRₙ] del DSR (A.3.2):** los Sharpe por periodo de los puntos son pruebas con métricas, y entran en la varianza junto
  con los de las pruebas anteriores del registro. Con el suelo `1/(T − 1)` del ADR 0029, añadirlos solo puede subir el
  umbral, nunca bajarlo.

Las series de cada punto van en la salida (`series_rejilla`): con ellas se junta la matriz de la ronda antes del paso 31.

### 4. Variantes y controles, sobre lo elegido en cada tramo

Las variantes de robustez (costes ×2 y ×3, retraso de una vela, sensibilidad, sin el mejor activo, ablación y universo
alternativo) y los controles (aleatorio, señal desplazada y paseo aleatorio) se aplican a la regla elegida en cada tramo,
sin volver a elegir. La sensibilidad mueve cada parámetro de lo elegido en cada tramo (±25 % y ±50 %, de uno en uno). Así
cada variante mide la estrategia tal como se operó, y su número no depende de lo elegido: el plan sale de las claves de
la rejilla y el registro lo declara antes de cargar datos.

### 5. PBO entre familias: pendiente de la matriz de la ronda

A.3.6 pide la matriz de todas las configuraciones de la ronda, de todas las familias. Un experimento de una familia no la
tiene: el PBO entre familias queda `NO CONCLUYENTE` con ese motivo, y A.3.6 no puede pasar dentro del experimento. La
matriz de la ronda se junta con las salidas guardadas antes del paso 31 (compromiso del 27B). Medirlo solo con la propia
familia lo habría hecho pasar sin la competencia que el criterio exige.

### 6. Estabilidad del elegido (A.3.8)

Por cada parámetro con más de un valor en la rejilla, la fracción de cambios de tramo en que el elegido se mueve como
mucho un punto (`sweepStability`, con los valores en orden numérico). Con dos valores por parámetro se cumple siempre: el
informe lo dice y no cuenta como evidencia. Las cifras significativas de A.3.8 se comprueban en todos los valores de la
rejilla.

### 7. Rejillas de la literatura, declaradas en la biblioteca

Cada estrategia de la biblioteca puede declarar una rejilla (`LibraryEntry.rejilla`), con su fuente. El ejecutor solo
acepta esa rejilla, exacta (mismas claves, valores y orden): cualquier otra lanza, y el experimento queda `fallido`,
contando en N. Como mucho `MAX_GRID_CONFIGURATIONS` = 20 puntos por estrategia; el comando rechaza una rejilla mayor antes
de registrar. Una estrategia sin rejilla sigue aceptando solo sus valores de la literatura.

### 8. Primera familia: tendencia (`tendencia-donchian-atr`)

- **Rejilla:** las entradas y salidas de los sistemas 1 (20/10) y 2 (55/20) de los Turtle (Faith, 2007), que incluyen la
  regla de 4 semanas de Donchian (20/20): `entryPeriod` ∈ {20, 55} × `exitPeriod` ∈ {10, 20}, con N = ATR de 20 y stop
  a 2 N fijos. **Presupuesto de la familia: 4 configuraciones**, de las 20 permitidas.
- **Complejidad:** 8 grados de libertad de la regla (4 numéricos y 4 elecciones discretas, ficha §5), más la elección en
  train entre 4 puntos. Todos los puntos cuentan en N, igual que las 22 variantes: N de la familia 75, N global 91.
- **Purging y embargo:** 55 velas, el periodo más largo de la rejilla. Una señal depende de las 55 velas anteriores: así
  ninguna vela que puntúa en train entra en la ventana de las primeras decisiones de validación.
- **Datos:** desde el 2013-09-10, la primera vela de BTC/EUR, para que el primer train (desde 2014) tenga calentamiento.
- **Universo alternativo:** los pares en EUR con velas diarias antes del 2017-01-01 que siguen listados al final, salvo
  los de diseño: ETC/EUR, LTC/EUR y ZEC/EUR. REP/EUR queda fuera porque se da de baja dentro del periodo y liquidar al
  deslistar sigue pendiente. Se fija por fechas de alta y baja, sin mirar precios.
- **Contaminación declarada** (`quant-research` §12): quien elige la rejilla (Claude) conoce el periodo y el informe de
  EXP-0021 (48 operaciones con 55/20). La rejilla es la de 1983 y 2007, anterior a los datos de cripto, no la del
  barrido de `docs/research/02`.

### 9. RANDOM y BUY_AND_HOLD

Como fijó el ADR 0027, la comparación con RANDOM es el control aleatorio de A.3.12 (1000 simulaciones con las mismas
operaciones, duración, tamaño y costes), más exigente que la estrategia RANDOM; y con BUY_AND_HOLD, el buy-and-hold puro
de BTC y el equiponderado del universo (A.3.10), porque la estrategia BUY_AND_HOLD está limitada por Risk y no sirve para
comparar rentabilidades. El informe de cada experimento los presenta así.

### 10. INV-14c sustituido (parada obligatoria, aprobada por la persona el 2026-10-16)

El control INV-14c de `SECURITY_AND_TRADING_INVARIANTS.md` decía que el comando de backtest se niega a un barrido antes de
tocar el registro. Era la guarda mientras no había elección en train: un barrido no podía resolverse sin mirar
validación. Cambiar un control es una parada obligatoria (`CLAUDE.md` §7), y la persona aprobó sustituirlo por: **el
comando se niega, antes de tocar el registro, a una rejilla de más de 20 puntos; cada punto de una rejilla cuenta en N**.
El invariante INV-14 (todo backtest pasa por el registro, con costes) no cambia: un barrido entra en el registro como una
prueba por punto, más sus variantes. La prueba del control comprueba las dos partes.

### 11. Una familia por sesión

Por instrucción de la persona, el paso 28 se parte en dos: la parte 1 (esta) construye la elección en train e investiga la
tendencia; la parte 2 investiga la reversión a la media, con su rejilla pre-registrada en su sesión antes de cargar datos.
`STRATEGY_RESEARCH.md` recoge las dos.

## Alternativas

- **Volver a elegir en cada variante.** Mediría el procedimiento con otros costes o parámetros, no la estrategia operada,
  y multiplicaría el coste por el tamaño de la rejilla.
- **Embargo como hueco entre train y validación.** Con e ≥ h solo alargaría el purging; la lectura literal de §4 excluye
  las velas que siguen a cada tramo ya evaluado.
- **Purging y embargo de 0 o de 20 velas.** El periodo más largo de la rejilla es el más conservador de los que dependen
  solo de la regla, y deja más de 900 de las 1095 velas de cada train.
- **Una rejilla mayor** (entradas de 30 o 40, stops de 3 N): más N y valores sin fuente anterior a los datos.
- **PBO entre familias solo con la propia familia:** lo haría pasar sin la competencia que exige A.3.6.
- **Elegir por otra métrica (Calmar, rentabilidad):** la métrica primaria es el Sharpe; elegir por otra optimizaría algo
  que no se juzga.

## Consecuencias

- El ejecutor admite barridos de como mucho 20 puntos. Su coste crece con la rejilla: un backtest de train y otro de
  validación por punto y tramo, además de las variantes y los controles.
- A.3.6 queda en `NO CONCLUYENTE` dentro de cada experimento con barrido hasta la matriz de la ronda; un `FAIL` del PBO
  de la familia sí basta para `RECHAZADA`.
  (Sustituido el 2026-10-21 por decisión de la persona, auditoría quant Q-06: el PBO de la familia se informa y no
  decide, como dice el texto congelado de A.3.6; decide la matriz de toda la ronda.)
- Con dos valores por parámetro, la estabilidad del elegido no informa; lo dice el informe.
- `StrategyEntry` monta la regla con `configure(valores)` y la ablación recibe los parámetros del tramo.
- La reversión a la media aún no declara rejilla: su sesión la fija antes de cargar datos.
