# Informe QUANT: auditoría adversarial de los barridos de la primera ronda (A = EXP-0025, B = EXP-0026) y coherencia de los criterios congelados

- Commit revisado: 967a861
- Alcance:
  - Informes A y B anonimizados.
  - `docs/research/experiments/registry.jsonl` y las salidas `salidas/EXP-0025.json` y `EXP-0026.json`.
  - Pre-registro: `specs/*-rejilla.json`.
  - Criterios: `docs/PROMOTION_CRITERIA.md` (A.3, A.3.9 y A.4).
  - Riesgo: `src/risk/limits.ts` y `src/risk/engine.ts`.
  - Código de research: `src/backtest/`, `src/analytics/`, `src/features/definitions.ts`, `src/strategy/` (trend-following, mean-reversion, engine, library), `src/portfolio/ledger.ts`, `src/historical/universe.ts` y `src/research/experiment.ts`.
  - De `src/app/`: research-runner, criteria-evidence, datasets, backtest y trading-system.
  - Manifiestos de `data/historical/` de los pares de diseño y alternativos. No he abierto `data/holdout/` ni `config/holdout.lock`.
- Reglas aplicadas:
  - `CLAUDE.md` §2 y §7.
  - `quant-research` (SKILL.md y checklist.md) y el ADR 0002.
  - `docs/PROMOTION_CRITERIA.md`.
  - `trading-risk` §4 y §5.
  - ADR 0019 (inventario), 0026, 0027, 0028, 0029, 0030, 0031, 0032 y 0033. De los ADR 0024 y 0025, solo las partes que afectan a N y a los huecos.
  - `docs/research/02-estrategias-y-frecuencia.md`, solo para contar las pruebas previas.

## Resumen

| Critical | High | Medium | Low |
|---|---|---|---|
| 0 | 4 | 2 | 2 |

## Hallazgos

### Q-01 [High] El backtester rechaza por STALE_DATA las entradas del primer par procesado mientras otro par está abierto

- Dónde: `src/risk/engine.ts:327-329`, `src/portfolio/ledger.ts:110-111`, `src/backtest/replay.ts:84-87`, `src/app/backtest.ts:112-115` y `:210-213`, `src/app/trading-system.ts:236-256` y `:375-376`.
- Evidencia:
  - **Risk.** Rechaza una entrada si la marca más antigua de la cartera tiene más de 60 s: `if (snapshot.positions.length > 0 && (marks === null || marks > now || addMs(marks, limits.maxPriceAgeMs) < now)) {` (`engine.ts:328`).
  - **Cartera.** La marca es la mínima entre las posiciones abiertas: `if (marksAsOf === null || markTime < marksAsOf) marksAsOf = markTime;` (`ledger.ts:111`).
  - **Orden de entrega.** Las velas diarias de todos los pares se reciben en el mismo instante (cierre + 60 s). El replay desempata por `sourceSeq` (`replay.ts:85-87`), que es el índice tras ordenar por símbolo (`backtest.ts:113`: `if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;`). Cada vela recorre features → estrategia → Risk en el acto (`trading-system.ts:236-256`).
  - **Consecuencia.** Al evaluar BTC/EUR, la cotización de ETH/EUR todavía es la de hace 24 h. Con ETH abierta, cualquier entrada de BTC sale STALE_DATA. Con BTC abierta, ETH sí entra, porque la cotización de BTC ya está actualizada.
  - **La composición conoce el caso.** Para la curva de patrimonio sí lo resuelve: «Varios símbolos con el mismo instante dan una sola marca: la última» (`trading-system.ts:375`). Risk, en cambio, no lo tiene en cuenta.
  - **Huella en la salida de A** (85 operaciones; comando C1):
    - 19 entradas de ETH con BTC ya abierta;
    - 0 entradas de BTC con ETH ya abierta;
    - 12 pares de entradas en el mismo instante.

    Ejemplo: ETH abre el 2017-01-04 (`"openedAt":1483488061000`) y cierra el 2017-06-26 con `"pnl":"1583.518676668858"`. BTC no vuelve a abrir hasta el 2017-07-21 (`"openedAt":1500595261000`).
  - **En B** las operaciones duran 2,6 velas: no hay ningún solape, solo 5 pares de entradas simultáneas.
  - **Límite de la evidencia.** El diario no se guarda en la salida (solo `diario_sha256`). La conclusión sale del código y de esa asimetría, no de los motivos de rechazo.
- Regla incumplida:
  - `quant-research` §3: cada decisión usa los datos disponibles en ese instante, y la vela de ETH ya está cerrada y recibida.
  - ADR 0026, decisiones 1 y 2: en el backtest solo cambian el reloj, los datos y el venue; este orden de entrega no existe en real.
  - `docs/PROMOTION_CRITERIA.md` A.4.5: el backtest se hace con los límites tal como operarían.
- Impacto:
  - **Qué se pierde en A.** Todas las entradas de BTC mientras ETH estaba abierta. En 2017, de enero a junio y del 15 de noviembre a fin de año.
  - **Sentido del sesgo:**
    - deprime la muestra de A.3.5 (77 operaciones cerradas) y la captura de A.3.9 (falso negativo);
    - probablemente subestima la caída de 2017 de A.3.4 (falso positivo de la cifra, aunque ya falla);
    - en Sharpe, DSR, intervalo de confianza, control aleatorio y PBO, el sentido no se puede saber sin repetir.
  - **Runs afectados:** todos los de más de un par. Eso incluye:
    - el run base y las ventanas de train, así que también la elección;
    - los puntos de la rejilla (PBO y V del DSR) y todas las variantes;
    - el control aleatorio y la señal desplazada con el backtester: las colocaciones de BTC pierden entradas y dejan de ser «las mismas operaciones» de A.3.12;
    - el paseo aleatorio;
    - el universo alternativo (ETC/EUR solo entra si LTC y ZEC están planas).

    Solo la variante «sin el mejor activo» (BTC solo, Sharpe 1,24) está limpia.
  - **Veredictos.** El de A no cambia: A.3.4 fallaría igual o peor, y A.3.5 necesitaría 23 operaciones cerradas más. En B el efecto es pequeño.
- Recomendación (no se aplica):
  - entregar todas las cotizaciones de un mismo `receivedTime` antes de evaluar ninguna estrategia, o marcar la cartera con la última vela recibida de cada par en ese instante;
  - añadir una prueba con dos pares y la misma hora de recepción;
  - repetir A y B como experimentos nuevos, que suman a N.

### Q-02 [High] La captura ≥ 50 % del alcista (A.3.9) es inalcanzable con los límites de A.4.5 e incompatible con la caída ≤ 10 % de A.3.4

- Dónde: `docs/PROMOTION_CRITERIA.md:93`, `:105-108`, `:76` y `:142`; `src/risk/limits.ts:24-26`; `src/analytics/windows.ts:109-113`; `src/analytics/criteria.ts:351`.
- Evidencia (razonada antes de abrir los informes, solo con el documento congelado y los límites):
  - **Límites del backtest.** A.4.5 lo exige con `maxExposureFraction: 0.75`, `maxPositionFraction: 0.25` y `riskPerTradeFraction: 0.0075` (`limits.ts:24-26`). Con el stop a una distancia s, una entrada usa 0,75 %/s del patrimonio (con 2 ATR, del orden del 10 %). El tope es el 25 % por par y el 75 % en total.
  - **Cómo se mide la captura.** Es el cociente de rentabilidades simples compuestas sobre todos los periodos `ALCISTA` de todos los tramos, frente a un buy-and-hold con todo el capital: `benchmarkReturn: compound(own.map((r) => r.benchmark))` (`windows.ts:113`) y `s >= (bullBtc > 0 ? profile.bullCapture * bullBtc : 0)` (`criteria.ts:351`).
  - **Techo de la captura.** Para una estrategia que mantiene la posición mientras dura la tendencia (el mecanismo de su hipótesis), con exposición E en K tramos alcistas que empiezan planos, la captura máxima es [Π(1+E·Rₖ) − 1]/[Π(1+Rₖ) − 1]. Ese valor es ≤ E y baja al crecer K y Rₖ. Con Rₖ = +100 % en cada tramo (comando C4):

    | E | K = 1 | K = 2 | K = 6 |
    |---|---|---|---|
    | 0,25 (tope por par) | 0,25 | 0,19 | 0,045 |
    | 0,5 | 0,50 | 0,42 | 0,16 |
    | 0,75 (tope total) | 0,75 | 0,69 | 0,44 |

    Con un solo par al tope, el 50 % es siempre imposible. Con dos pares tipo BTC, solo se llega si los dos están al tope durante todo el alcista y en un único tramo.
  - **Caída frente a captura.** Capturar el 50 % exige E ≥ 0,5 durante el alcista. Una corrección D de BTC con la posición dentro da una caída de al menos E·D. Como A.3.4 exige ≤ 10 %, hace falta D ≤ 20 % en cada corrección.
    - En esta muestra, BTC cae un 27,2 % en la ventana de mayo a julio de 2021, dentro del alcista de 2021 (`"crisis_2021-05-01/2021-07-31_btc":-0.27227731029363933`).
    - Dejar correr la posición ganadora, que es lo que da la captura, es lo que produce la caída del 20,7 % de A en 2017.
  - **El proyecto ya lo había fijado.** El ADR 0027 dice del buy-and-hold limitado por Risk: «No sirve para comparar rentabilidades sin escalarlas por la exposición» (`docs/adr/0027-estrategias-de-referencia.md:51-52`; también `:118`).
  - **Lo observado lo confirma.** BTC compone +3741 % en 1786 periodos alcistas (`"alcista_btc":37.40624980969129`). Llegar al 50 % exige multiplicar por 19,7, es decir, el 81,7 % de su crecimiento logarítmico. A obtiene el 42,1 % con una exposición media del 7,9 %, y eso da una captura del 9,8 % (comando C4).
  - **Otras combinaciones imposibles o vacías:**
    - **Reversión (25 %)** frente a su propia justificación, «está poco tiempo en mercado» (`:94`). Con E ≤ 0,25, el 25 % es el techo absoluto de un par, y con K ≥ 2 queda por debajo.
    - **Cross-Sectional (≥ 100 %)**, con exposición ≤ 75 % y caída ≤ 10 %. Exige altcoins que batan a BTC en más de un tercio en cada periodo y que caigan menos que él.
    - **Bajista de A.3.9.** Queda implícito en A.3.4 siempre que BTC caiga al menos un 20 % (un 40 % en reversión). No contradice nada, pero no añade nada.
    - **A.3.5 (≥ 100 operaciones).** Con un universo sin sesgo de supervivencia y con 2018 y 2022 fuera de muestra, no es factible con esta fuente para familias lentas: no hay bajas antes de 2023 (`DATA.md:102-106`).
- Regla incumplida: coherencia interna de `docs/PROMOTION_CRITERIA.md`. A.3.9 dice que el perfil «sale de su hipótesis» (`:81`), y A.4.5 y A.3.4 impiden que esa hipótesis lo cumpla. Contradice también el principio del ADR 0027 (decisión 3) sobre comparar rentabilidades con exposiciones distintas.
- Impacto:
  - **En A y B.** El FAIL de A.3.9 (9,8 % y 0,05 %) mide la restricción, no la hipótesis: es un falso negativo estructural.
  - **Veredictos.** No cambia ninguno: A falla también A.3.4 y A.3.5, y B falla otros nueve criterios.
  - **Hacia delante.** Toda estrategia de tendencia, breakout, Cross-Sectional o Price + Volume fallará A.3.9 por construcción, tenga o no ventaja. Ni el paso 31 ni la segunda ronda (C.1) pueden producir VALIDATED en esas familias.
- Recomendación. Corrección general, por principio y válida para todas las familias. No se aplica: es una parada obligatoria (`CLAUDE.md` §7) y reinicia la validación.
  1. **Benchmark factible.** Toda comparación de rentabilidad por régimen o por ventana (A.3.9 y A.3.7) se hace contra un buy-and-hold con las mismas restricciones que la estrategia: los límites de A.4.5, los mismos costes y los mismos reinicios por tramo. Puede ser el BUY_AND_HOLD del ADR 0027 pasado por Risk, o el buy-and-hold escalado a la exposición máxima admisible. A.3.10 puede seguir con todo el capital, porque el Sharpe no depende de la parte invertida.
  2. **Captura lineal.** El cociente de medias por periodo (upside capture) o de crecimiento logarítmico, nunca de rentabilidades simples compuestas a lo largo de años y tramos.
  3. **Simetría en cada ventana:** «si BTC no cae, no pierde», como ya dice A.3.9 (ver Q-05).
  4. **Factibilidad y potencia antes de congelar.** Cada combinación de umbrales se prueba con datos sintéticos de resultado conocido: caminos con la volatilidad de BTC y una ventaja fijada de antemano. Una estrategia sintética con ventaja tiene que poder pasar todos los criterios con una probabilidad razonable, y una sin ventaja no. Es lo que el paso 27B hizo con el evaluador, extendido a los umbrales.
  5. **PBO y DSR sobre conjuntos coherentes** (ver Q-03 y Q-06).
  6. **A y B no se reabren.** Esta corrección llega después de ver los resultados. A y B siguen `RECHAZADA` con los criterios congelados. Evaluarlos con criterios nuevos sería una prueba nueva de hipótesis ya contaminadas (`quant-research` §12), y sumaría a N.

### Q-03 [High] El DSR global de A.3.2 depende del orden de los experimentos: el PASS de A pasa a FAIL con el registro actual

- Dónde: `src/research/experiment.ts:209-223`; `src/app/research-runner.ts:441-442`; `src/analytics/report.ts:217-219`; salidas `EXP-0025.json` y `EXP-0026.json`.
- Evidencia:
  - **Orden.** `globalEvidence` solo toma los Sharpe de los cierres anteriores al pre-registro (`if (l.id === line.id) break;`, `experiment.ts:216`).
    - Cuando corrió A, el registro no tenía ningún `sharpe_periodo`. A usó V = suelo en los dos DSR (`"trialVariance":0.0002810567734682406`, `"familySharpes":5`, con N = 127 y N = 143) y obtuvo 0,9855 y 0,9837.
    - B corrió después y metió el Sharpe de A en su V global (`"trialVariance":0.0010288453371212535`, `"sr0":0.08741710893252198`, N = 177).
  - **Recálculo a mano.** Reproduce los valores guardados, y las fórmulas de `statistics.ts` coinciden con las de `quant-research` §8:

    | | A | B |
    |---|---|---|
    | SR por periodo (T = 3559) | 0,075793 | 0,018838 |
    | γ₃ / γ₄ | 4,595 / 79,16 | −6,136 / 263,56 |
    | Factor de varianza | 0,7639 | 1,1389 |
    | SR₀ familia (global) | 0,043816 (0,044493) | 0,037028 |
    | DSR familia (global) | 0,9855 (0,9837) | 0,1546 |
    | PSR frente a 0 | 1,0000 | 0,8538 |
    | MinTRL | 360,8 | 8683,9 |

  - **A recalculado con N = 177** (comando C2):
    - con V en el suelo: 0,980;
    - con la V que daría una reejecución hoy (7 Sharpe): ≈ 0,91;
    - con la V del cierre de B: ≈ 0,21;
    - con la V de los 9 Sharpe con métricas de la ronda: ≈ 0,18.
  - **N y V miden conjuntos distintos.** V usa 5 Sharpe por familia, y N cuenta 26 y 34 pruebas. Las variantes cuentan en N, pero su Sharpe nunca entra en V.
  - **Supuestos que mueven el resultado:**
    - la convención de V, que lo lleva de 0,98 a 0,18;
    - N pesa poco con el suelo: el DSR de familia de A solo baja de 0,95 con N ≈ 557 (comando C2);
    - los momentos: con los de una normal, 0,969;
    - quitar 2017 (ver Q-04).
  - **Umbral resultante.** Con la V del cierre de B, A.3.2 global exige un Sharpe anualizado de unos 2,1–2,2 durante 9,75 años.
- Regla incumplida:
  - `docs/PROMOTION_CRITERIA.md` A.3.2 y su nota: «La decisión del paso 31 elige entre todas las familias: las pruebas de todas compiten por ella» (`:126-127`).
  - `quant-research` §8: la V sale de las pruebas con métricas y la N de todas las pruebas, y deberían ser el mismo conjunto.
- Impacto:
  - **A.** El estado de A.3.2 global es un falso positivo: PASS en el informe, FAIL con el registro actual y con la misma regla que el código aplicó a B. El veredicto no cambia, porque A ya es `RECHAZADA`.
  - **B.** Falla con cualquier convención.
  - **Segunda ronda.** Con el contador de C.1 y una V entre familias, el umbral global será prácticamente inalcanzable.
- Recomendación. Fijar por ADR, antes de mirar nada más (no se aplica; es un cambio de criterio, `CLAUDE.md` §7):
  - A.3.2 global se calcula en el momento de la decisión, con la misma N y la misma V para todos los candidatos;
  - N y V salen del mismo conjunto de pruebas: si las variantes cuentan en N, su Sharpe entra en V, y si no, salen de N;
  - para pruebas heterogéneas, una N efectiva por clústeres de pruebas correlacionadas (López de Prado, 2019), en lugar de multiplicar la N total por la dispersión entre familias.

### Q-04 [High] El universo de diseño se eligió con una regla que los manifiestos desmienten, y el resultado de A cuelga de una sola operación de ETH en 2017

- Dónde: `docs/research/experiments/specs/tendencia-donchian-1.0.0-rejilla.json:23` (igual en `reversion-rsi2-1.0.0-rejilla.json:23`); `data/historical/kraken-ltceur-1d-full2026q2/e5737abc74c0691f/manifest.json:18-20`; `data/historical/kraken-etheur-1d-full2026q2/a0a601ffae568751/manifest.json:19`; salida `EXP-0025.json` (operaciones del tramo 0).
- Evidencia:
  - **La regla registrada:** «fija: BTC/EUR y ETH/EUR, los dos pares con más historia y los únicos que cubren los bajistas de 2018 y 2022 … elegidos hoy».
  - **Lo que dicen los manifiestos** (comando C6):
    - LTC/EUR empieza el 2013-09-14 (`"start": "2013-09-14T00:00:00.000Z"`) y ETH/EUR el 2015-08-07: LTC tiene más historia que ETH.
    - ETC/EUR (desde 2016-07-27) y ZEC/EUR (desde 2016-10-28) también cubren 2018 y 2022 y siguen listados: son precisamente el universo alternativo.

    Ninguna de las dos partes de la regla lleva a elegir ETH.
  - **Concentración.** Una sola operación, ETH del 2017-01-04 al 2017-06-26 (`"pnl":"1583.518676668858"`), aporta el 75 % de los 2108 EUR de P&L cerrado de A en 9,75 años. ETH en conjunto aporta 1763 EUR, el 84 %. Con el universo alternativo, que incluye LTC, el Sharpe baja de 1,45 a 0,87.
  - **DSR sin 2017.** Con momentos normales, el DSR de familia de A queda en torno a 0,8 (SR anual 1,19, T = 3194, SR₀ = 0,0463). El valor exacto, con los momentos de la serie guardada, sale del comando C3, que no he ejecutado.
- Regla incumplida: `CLAUDE.md` §2 (prohibido el survivorship bias); `quant-research` §3 (universo point-in-time, con filtros calculados solo con datos anteriores a t) y §12 (hipótesis contaminadas por quien conoce el periodo).
- Impacto:
  - **A.** Infla los PASS de A.3.2 (familia), A.3.10, A.3.11, A.3.12 y A.3.13 (falso positivo). Esa evidencia depende de un activo elegido a posteriori y de una operación.
  - **B.** ETH aporta 28 de los 33 EUR.
  - **Veredictos.** No cambia ninguno: los dos son `RECHAZADA`.
- Recomendación (no se aplica):
  - un universo de diseño con una regla calculable en cada fecha con datos pasados (por ejemplo, los k pares con más historia o más volumen antes de cada tramo), comprobada contra los manifiestos antes de registrar;
  - mientras el universo se elija hoy, no leer como evidencia ningún PASS de A.3.2 ni de A.3.10 a A.3.13;
  - informar del DSR sin la operación o el año dominantes.

### Q-05 [Medium] A.3.7 exige ganar a BTC en una ventana en la que BTC acaba subiendo, al revés que la regla simétrica de A.3.9

- Dónde: `docs/PROMOTION_CRITERIA.md:121` y `:104`; `src/analytics/criteria.ts:281`; `docs/adr/0031-evaluador-de-criterios.md:62-63`.
- Evidencia:
  - **Las dos reglas.** A.3.7 pide «su rentabilidad neta ≥ la del buy-and-hold de BTC», implementado como `return dd <= THRESHOLDS.crisisMaxDrawdown && s >= b ? 'PASS' : 'FAIL';`. A.3.9, en cambio, dice: «Si BTC no cae en un episodio, la estrategia no puede perder en él».
  - **Marzo y abril de 2020:**
    - BTC +2,1378 % (`"crisis_2020-03-01/2020-04-30_btc":0.02137807132055558`);
    - A +1,4161 %, con una caída del 0,96 %;
    - B 0 %, sin operaciones.
  - **Costes del benchmark.** En la ventana, el buy-and-hold no paga compra ni venta (ADR 0031: «sin cobrarle una compra al entrar en la ventana»). Con compra y venta al 0,375 % por lado, BTC queda en +1,3732 %, por debajo del +1,4161 % de A, y A pasaría (comando C5).
  - **Fechas.** Las fijó quien conocía el camino de BTC (`:130-132`). El final, el 30 de abril, decide si la ventana mide defensa (a 31 de marzo, BTC iba −25 %) o captura.
- Regla incumplida: incoherencia entre A.3.7 y A.3.9 de `docs/PROMOTION_CRITERIA.md`; `quant-research` §6 (benchmark con los mismos costes).
- Impacto:
  - **A.** El FAIL de A.3.7 depende de la convención de costes: 0,7 puntos en un sentido, 0,04 en el otro. Es propenso al falso negativo.
  - **B.** Se le penaliza por estar en liquidez durante un crash.
  - **En general.** En una ventana con BTC al alza, A.3.7 exige un 100 % de captura, más de lo que A.3.9 pide en los periodos alcistas.
  - **Veredictos.** No cambia ninguno.
- Recomendación: dentro de la corrección general de Q-02, exigir en cada ventana s ≥ min(b, 0), o s ≥ (fracción de pérdida de la familia) × b cuando b < 0, con el benchmark factible y los mismos costes. La caída ≤ 10 % por ventana ya la implica A.3.4. No se aplica (`CLAUDE.md` §7).

### Q-06 [Medium] El PBO de la familia decide RECHAZADA sin estar en el criterio congelado ni en el pre-registro, y con 3 configuraciones está sesgado al alza

- Dónde: `src/analytics/criteria.ts:265`; `docs/adr/0032-barridos-con-eleccion-en-train.md:145-146`; `src/analytics/statistics.ts:258-261`; `docs/PROMOTION_CRITERIA.md:78`; `docs/research/experiments/specs/reversion-rsi2-1.0.0-rejilla.json:7`.
- Evidencia:
  - **El criterio congelado.** A.3.6 dice: «La matriz incluye todas las configuraciones … todas las de la ronda, de todas las familias». El pre-registro de B dice «sin otros más estrictos». El evaluador exige además el PBO de la familia (`[pboStatus(family), pboStatus(global)]`), y el ADR 0032 lo confirma: «un `FAIL` del PBO de la familia sí basta para `RECHAZADA`».
  - **El sesgo.** `omega = (below + (equal + 1) / 2) / (configurations + 1)`, junto con `<= 0`, cuenta la mediana exacta como sobreajuste. Con configuraciones intercambiables, el PBO esperado es ⌊(N+1)/2⌋/N (comando C8):
    - 0,667 con N = 3 (B);
    - 0,5 con N = 4 (A);
    - 0,571 con N = 7 (la ronda).

    El 0,720 de B no se distingue del azar. La regla «con ≥ 0,50 se rechaza» de `quant-research` §9 rechaza en promedio cualquier rejilla de 3 puntos.
  - **Choque con A.3.8.** Una meseta perfecta, que es lo que pide A.3.8, lleva el PBO dentro de una familia hacia 0,5: los dos criterios tiran en sentidos opuestos.
- Regla incumplida: `docs/PROMOTION_CRITERIA.md` A.3.6 y regla 5 (umbrales más estrictos solo por pre-registro); `quant-research` §8 (el PBO es el de la comparación que decide).
- Impacto:
  - **B.** Uno de sus diez FAIL (A.3.6) no es informativo ni forma parte del criterio congelado (falso negativo).
  - **A.** Su 0,150 con 4 configuraciones es una evidencia débil.
  - **Veredictos.** No cambia ninguno.
- Recomendación: dentro de la corrección general de Q-02 (no se aplica; `CLAUDE.md` §7):
  - el PBO, solo con la matriz de la ronda;
  - un número mínimo de configuraciones para que decida;
  - sin contar la mediana exacta como sobreajuste;
  - como complemento, la probabilidad de pérdida fuera de muestra de la mejor dentro de muestra, que no castiga las mesetas.

### Q-07 [Low] Una vela que falta (2018-01-12) deja a BTC sin decisiones durante 101 o 200 velas y sin régimen durante 219, al empezar el bajista de 2018

- Dónde: `data/historical/kraken-xbteur-1d-full2026q2/6faca5debf9f3d51/manifest.json:51-54`; `src/features/engine.ts:111`; `src/features/definitions.ts:190` y `:215`; salida `EXP-0025.json` (régimen `SIN_DATO`).
- Evidencia:
  - **El hueco.** En BTC/EUR: `"from": 1515715200000, … "missingBars": 1`, es decir, el 2018-01-12.
  - **El reinicio.** El motor de features reinicia la ventana (`bars.length = 0; // hueco: la ventana vuelve a empezar`), y el calentamiento es de 101 velas en A (5·20+1, por el ATR de 20) y de 200 en B (SMA 200).
  - **El régimen.** Queda en `SIN_DATO` 219 periodos de tendencia, en los que BTC cae un 53,6 % (`"periods":219,"benchmarkReturn":-0.5361927104583164`), y 394 de volatilidad.
  - **Coherente con las operaciones.** A no opera BTC en 2018 hasta el 18 de julio.
- Regla incumplida: `quant-research` §3 se cumple, porque el hueco no se rellena. Lo que falla es la documentación del desglose de `quant-research` §7: el informe dice «1 vela» y no cuantifica que eso excluye 101 o 200 días de decisiones y 219 de régimen.
- Impacto:
  - **A.** Unas pocas operaciones menos para A.3.5 (falso negativo) y quizá un 2018 más favorable en A.3.9 y A.3.7 (falso positivo). Las dos cosas pasan con mucho margen (−2,5 % frente a un límite de −36,1 %).
  - **B.** No influye: BTC estuvo bajo su SMA 200.
  - **Estados.** Ninguno cambia.
- Recomendación: declarar en el informe, para cada hueco, cuántas velas quedan sin decisión y sin régimen, y estudiar en un ADR si un hueco de una sola vela debe reiniciar enteras las features recursivas. No se aplica.

### Q-08 [Low] Ni la ablación separa el componente de la exposición a la deriva, ni el ±25 % de los parámetros enteros pequeños es un ±25 % real

- Dónde: `src/analytics/criteria.ts:448`; `src/strategy/mean-reversion.ts:56`; `src/strategy/engine.ts:170-175`; `src/analytics/robustness.ts:42-43`.
- Evidencia:
  - **Ablación.** Un componente «aporta» si `check(v.sharpe.value, (s) => s < base)`, sin controlar la exposición. Sin `salida-media`, la posición solo sale por el stop fijo a 2 ATR de la entrada: el stop solo sube si la estrategia lo pide, y estas estrategias no lo piden. Así queda en mercado mucho más tiempo, en un periodo en que el buy-and-hold tiene un Sharpe de 0,99. B pasa de 0,36 a 0,85, lo que es compatible con esa deriva; la exposición de la variante no se guarda.
  - **Sensibilidad.** El redondeo hacia fuera (`step < 0 ? Math.floor(raw) : Math.ceil(raw)`) convierte el −25 % de `exitPeriod` = 5 en 3 (un −40 %), y el de `rsiPeriod` = 2 en 1, que ni siquiera se puede construir.
- Regla incumplida: `quant-research` §7 (la ablación mide la aportación del componente a la métrica primaria fuera de muestra; la sensibilidad mueve cada parámetro ±25 % y ±50 %).
- Impacto:
  - **B.** El FAIL de A.3.14 y parte del de A.3.8 pueden estar midiendo la deriva y el redondeo, no el componente (propenso al falso negativo).
  - **A.** El PASS de A.3.14 (1,10 frente a 1,45) tampoco controla la exposición.
  - **Veredictos.** No cambia ninguno.
- Recomendación (no se aplica):
  - comparar cada variante de ablación con un control aleatorio de la misma duración y exposición, o al menos informar de su exposición junto al Sharpe;
  - declarar el cambio efectivo de cada variante entera.

## Preguntas abiertas

- **Q-01, cuántas entradas.** ¿Cuántas entradas rechazó Risk por STALE_DATA en cada run: base, train, rejilla, variantes y controles? El diario no está en la salida (solo `diario_sha256`). Se resuelve repitiendo los runs con el diario guardado, o con una prueba de dos pares con la misma hora de recepción. Las dos cosas ejecutan `src/`, así que no las propongo como comando.
- **Q-01, muestra de A.** Una vez arreglado, ¿llegaría A a 100 operaciones cerradas? Le faltan 23, y no se puede estimar sin repetir.
- **Q-03, convención.** ¿Qué convención de N y de V aplicará el paso 31 en A.3.2 global, y en qué momento la calculará? El texto congelado no lo fija.
- **Registro, inventario previo.** Es un mínimo, por dos motivos:
  - `docs/research/02-estrategias-y-frecuencia.md:58` («Barrido de 21 combinaciones … sobre 6 pares») cuenta 21 pruebas, y serían 126 si se hizo par a par;
  - `:60` («elegí los valores por defecto después de ver los resultados») indica vistazos que no están en el inventario.

  Con V en el suelo, esto no cambia el DSR de familia de A (el umbral es N ≈ 557, comando C2). Con una V entre familias, sí pesa.
- **Q-02, la posición de ETH.** ¿Qué fracción del patrimonio llegó a ser la posición de ETH en 2017? La curva guardada no trae la exposición por punto, y esa posición es la que explica la caída del 20,7 %.
- **Q-06, matriz de la ronda.** ¿Con qué convención y en qué momento se calcula, siendo 7 configuraciones, un número impar?

## Fuera de alcance

- La regla de `marksAsOf` como mínimo entre posiciones también puede bloquear entradas en paper o en real si las cotizaciones de varios pares llegan a la vez con las velas. Es terreno del consultor EXECUTION/RISK.
- `src/app/round-matrix.ts`, `src/app/round-pbo-command.ts` y el ADR 0034 son posteriores a los experimentos y no los he revisado.
- En el backtest, el Risk Engine mínimo no aplica los breakers de `trading-risk` §5 ni los controles de liquidez y spread de §4.5, y la concentración de §4.3 solo se mira al entrar: la posición de ETH pudo crecer muy por encima del 25 %.

## Límites de la revisión

- Comandos para la sesión principal. Van en Bash, desde la raíz del repositorio; solo leen archivos y escriben en la consola.
  - **C1 (Q-01).** Salida esperada: en EXP-0025, `'ETH/EUR entra con BTC/EUR ya abierta': 19` y ninguna entrada de BTC con ETH abierta; en EXP-0026, solo las entradas simultáneas:
    `node -e 'const fs=require("fs");for(const id of ["EXP-0025","EXP-0026"]){const o=JSON.parse(fs.readFileSync("docs/research/experiments/salidas/"+id+".json","utf8"));const c={};for(const t of o.salida.tramos){const ops=t.operaciones;for(const x of ops)for(const y of ops){if(x.symbol===y.symbol)continue;const fin=y.closedAt===null?Infinity:y.closedAt;const k=y.openedAt<x.openedAt&&x.openedAt<fin?x.symbol+" entra con "+y.symbol+" ya abierta":y.openedAt===x.openedAt?"entradas simultaneas (x2)":null;if(k)c[k]=(c[k]||0)+1}}console.log(id,c)}'`
  - **C2 (Q-03).** Salida esperada: 0,9855; 0,9837; 0,9800; ≈ 0,91; ≈ 0,21; ≈ 0,18; ≈ 0,969; 0,1546; 0,0001; y N ≈ 557:
    `node -e 'const er=x=>{const s=Math.sign(x);x=Math.abs(x);const t=1/(1+0.3275911*x);return s*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x))};const P=z=>0.5*(1+er(z/Math.SQRT2));const Q=p=>{let a=-10,b=10;for(let i=0;i<200;i++){const m=(a+b)/2;if(P(m)<p)a=m;else b=m}return (a+b)/2};const G=0.5772156649015329,T=3559,F=1/(T-1),k=Math.sqrt(365);const sr0=(N,V)=>Math.sqrt(V)*((1-G)*Q(1-1/N)+G*Q(1-1/(N*Math.E)));const dsr=(s,g,N,V)=>P((s-sr0(N,V))*Math.sqrt(T-1)/Math.sqrt(1-g[0]*s+(g[1]-1)/4*s*s));const v=x=>{const m=x.reduce((p,c)=>p+c,0)/x.length;return Math.max(F,x.reduce((p,c)=>p+(c-m)**2,0)/(x.length-1))};const A=0.07579297219937274,B=0.018837739325999883,ga=[4.595423275718099,79.15962294967306],gb=[-6.13600904114248,263.5563209891513];const gA=[1.43,1.13,1.32,1.03].map(x=>x/k),gB=[0.09,0.21,-0.12].map(x=>x/k);const L=(n,x)=>console.log(n,x.toFixed(4));L("A familia N=127 suelo",dsr(A,ga,127,F));L("A global N=143 suelo",dsr(A,ga,143,F));L("A global N=177 suelo",dsr(A,ga,177,F));L("A global N=177 V como reejecucion",dsr(A,ga,177,v([A,B,...gA,A])));L("A global N=177 V del cierre de B",dsr(A,ga,177,0.0010288453371212535));L("A global N=177 V de los 9 Sharpe",dsr(A,ga,177,v([...gA,A,...gB,B])));L("A normal N=143 suelo",dsr(A,[0,3],143,F));L("B familia N=42",dsr(B,gb,42,F));L("B global N=177",dsr(B,gb,177,0.0010288453371212535));let n=127;while(dsr(A,ga,n,F)>=0.95)n++;console.log("N minima que baja el DSR de familia de A de 0,95 con el suelo:",n)'`
  - **C3 (Q-04, DSR sin 2017).** Salida esperada: 3194 periodos, un Sharpe anual de unos 1,19 y `dsr_familia_127` por debajo de 0,95:
    `node -e 'const er=x=>{const s=Math.sign(x);x=Math.abs(x);const t=1/(1+0.3275911*x);return s*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x))};const P=z=>0.5*(1+er(z/Math.SQRT2));const Q=p=>{let a=-10,b=10;for(let i=0;i<200;i++){const m=(a+b)/2;if(P(m)<p)a=m;else b=m}return (a+b)/2};const G=0.5772156649015329;const o=JSON.parse(require("fs").readFileSync("docs/research/experiments/salidas/EXP-0025.json","utf8"));const s=o.salida.serie_configuracion,cut=Date.UTC(2018,0,1,12);const r=s.rendimientos.filter((x,i)=>s.fines[i]>cut),n=r.length,m=r.reduce((p,c)=>p+c,0)/n;let m2=0,m3=0,m4=0;for(const x of r){const e=x-m;m2+=e*e;m3+=e**3;m4+=e**4}const sd=Math.sqrt(m2/(n-1));m2/=n;m3/=n;m4/=n;const sr=m/sd,g3=m3/m2**1.5,g4=m4/(m2*m2);const S0=N=>Math.sqrt(1/(n-1))*((1-G)*Q(1-1/N)+G*Q(1-1/(N*Math.E)));const D=N=>P((sr-S0(N))*Math.sqrt(n-1)/Math.sqrt(1-g3*sr+(g4-1)/4*sr*sr));console.log({periodos:n,sharpe_anual:sr*Math.sqrt(365),g3,g4,dsr_familia_127:D(127),dsr_global_177:D(177)})'`
  - **C4 (Q-02).** Salida esperada: la tabla de captura de Q-02, 0,817 de crecimiento logarítmico necesario y 0,421 obtenido por A:
    `node -e 'for(const E of [0.25,0.5,0.75])for(const K of [1,2,6]){const s=(1+E)**K-1,b=2**K-1;console.log("exposicion",E,"tramos alcistas de +100 %",K,"captura",(s/b).toFixed(3))}const f=37.40624980969129;console.log("parte del crecimiento logaritmico de BTC necesaria para el 50 %:",(Math.log(1+0.5*f)/Math.log(1+f)).toFixed(3),"; la de A:",(Math.log(1+3.6534956706636326)/Math.log(1+f)).toFixed(3))'`
  - **C5 (Q-05).** Salida esperada: 0,013732 para BTC frente a 0,014161 para A:
    `node -e 'const b=0.02137807132055558,a=0.01416101049790286,c=0.0025+0.00075+0.0005;console.log("BTC con compra y venta dentro de la ventana:",((1+b)*(1-c)**2-1).toFixed(6),"; A:",a.toFixed(6))'`
  - **C6 (Q-04).** Salida esperada: entre otras, BTC/EUR 2013-09-10, LTC/EUR 2013-09-14, ETH/EUR 2015-08-07, ETC/EUR 2016-07-27 y ZEC/EUR 2016-10-28:
    `node -e 'const fs=require("fs"),p=require("path"),d="data/historical";for(const n of fs.readdirSync(d).filter(x=>/^kraken-[a-z0-9]+eur-1d-full2026q2$/.test(x)))for(const v of fs.readdirSync(p.join(d,n))){const m=JSON.parse(fs.readFileSync(p.join(d,n,v,"manifest.json"),"utf8"));if(m.rangeUtc.start<"2017-01-01")console.log(m.symbols[0],m.rangeUtc.start,m.rangeUtc.endExclusive)}'`
  - **C7 (Q-03, autocorrelación; no comprobado):**
    `node -e 'const r=JSON.parse(require("fs").readFileSync("docs/research/experiments/salidas/EXP-0025.json","utf8")).salida.serie_configuracion.rendimientos;const n=r.length,m=r.reduce((p,c)=>p+c,0)/n,v=r.reduce((p,c)=>p+(c-m)**2,0);for(let k=1;k<=5;k++){let c=0;for(let i=k;i<n;i++)c+=(r[i]-m)*(r[i-k]-m);console.log("retardo",k,(c/v).toFixed(4))}'`
  - **C8 (Q-06).** Salida esperada: 0,667, 0,500 y 0,571:
    `node -e 'for(const N of [3,4,7])console.log(N,(Math.floor((N+1)/2)/N).toFixed(3))'`
  - **Q-07:**
    `rg -o '"SIN_DATO":\{[^}]*\}' docs/research/experiments/salidas/EXP-0025.json`
- No comprobado:
  - no he ejecutado nada, tampoco los tests de `test/`;
  - la guarda del test final en ejecución: solo he leído el filtro `c.receivedTime < to` de `datasets.ts:103`;
  - `smoke-data.ts`, `scheduled.ts`, `candle-tape.ts`, `instrument-model.ts`, `marketdata/normalizer.ts`, el resto de `features/engine.ts` y las fichas de la biblioteca;
  - los ADR 0024 y 0025, solo en parte;
  - el ajuste del Sharpe por autocorrelación (C7);
  - los motivos de rechazo de Risk, porque los diarios no están en las salidas.
- Comprobado sin hallazgo:
  - **Features sin look-ahead.** Donchian excluye la vela t (`definitions.ts:234` y `:248`), y ATR, RSI y SMA usan ventanas fijas sobre velas cerradas.
  - **Ejecución.** Se decide con la vela recibida y se ejecuta en la apertura siguiente; el stop usa el peor caso dentro de la vela (`intrabar.ts:25-31`).
  - **Elección en train.** Sin datos de validación, con purging y embargo (`selection.ts:31-44`).
  - **Test final.** Los datos acaban el 2026-09-30T00:00Z y las particiones tienen `test: null`.
  - **Costes.** Por encima de los mínimos y sin doble cobro: medio spread una vez, slippage y comisión en cada fill, y liquidación una sola vez (`book-model.ts:124-139`, `backtest.ts:292-302`). Son conservadores para BTC y ETH en EUR y no explican ningún resultado.
  - **Contador N.** La suma de `n_pruebas` da 127 y 42 por familia y 143 y 177 en total, igual que los informes; el inventario previo coincide con el del ADR 0019.
  - **Régimen.** Es point-in-time (`regime.ts:152-165`).
  - **Fórmulas.** PSR, SR₀, DSR, MinTRL y CSCV de `statistics.ts` coinciden con `quant-research` §8, y los valores de las salidas se reproducen a mano (Q-03).

---

# Verificación de la sesión principal

No forma parte del informe del consultor. La hizo la sesión principal el 2026-10-20, con `docs/CONSULTANTS.md` §4.3: leer
cada cita de los hallazgos High y ejecutar los comandos del informe que no escriben, no cambian git, no usan la red y no
ejecutan `src/`. Son C1 a C8, todos `node -e` de solo lectura, y el de Q-07 con `grep -o` en lugar de `rg`. No se ha
aplicado ninguna recomendación ni se ha tocado código.

## Encargo

- **Lanzamiento:** con la plantilla de `docs/CONSULTANTS.md` §4, sobre el commit `967a861`. Se cortó una vez por el
  límite de uso de la cuenta y se reanudó con su contexto.
- **Informes anonimizados:** EXP-0025 y EXP-0026 le llegaron como «Informe A» e «Informe B», sin nombre de estrategia ni
  de autor, y sin el resumen, «qué no demuestra» ni el siguiente paso propuesto. El ID se conservó para cruzarlo con el
  registro y las salidas. El encargo no dice qué estrategia se prefiere ni qué resultado se espera.
- **Revisión ciega:** se le pidió no leer `PROGRESS.md`, `docs/progress/`, `STRATEGY_RESEARCH.md` ni los informes
  originales, y razonar la coherencia de los criterios con el documento congelado y los límites de Risk antes de abrir
  los informes.
- **Preguntas:** las tres de la persona, literales.

## Estado de cada hallazgo

Ninguno se descarta.

| ID | Severidad | Estado | Qué se comprobó |
|---|---|---|---|
| Q-01 | High | Confirmado | El código citado y C1 |
| Q-02 | High | Confirmado, con dos matices | Las citas, C4 y las cifras guardadas |
| Q-03 | High | Confirmado | El código citado, las salidas y C2 |
| Q-04 | High | Confirmado | La regla registrada, C6, la operación de 2017 y C3 |
| Q-05 | Medium | Confirmado; es una discrepancia de criterio | Las citas y C5 |
| Q-06 | Medium | Confirmado | Las citas, la fórmula y C8 |
| Q-07 | Low | Confirmado | El manifiesto, el motor de features y la salida |
| Q-08 | Low | Confirmado | Las citas |

**Q-01.**
- El control de la valoración de la cartera (`src/risk/engine.ts:328`, con `maxPriceAgeMs: 60_000` en
  `src/risk/limits.ts:29`) está en `#decideEntry`: solo frena entradas. Las salidas y los stops (`#decideExit` y
  `#decideProtective`, `:289-312`) no pasan por él.
- La cinta se ordena por símbolo (`src/app/backtest.ts:201`, con `byOpen` en `:112-115` y `sourceSeq: i` en `:213`), y el
  replay desempata por `sourceSeq` (`src/backtest/replay.ts:87`). La cartera toma la marca mínima
  (`src/portfolio/ledger.ts:111`).
- **C1 en EXP-0025:** 19 entradas de ETH/EUR con BTC/EUR abierta, ninguna de BTC/EUR con ETH/EUR abierta y 24 entradas
  simultáneas contadas dos veces, es decir, 12 pares. **En EXP-0026:** 10, es decir, 5 pares.
- En la salida están la operación de ETH del 2017-01-04 al 2017-06-26 (`pnl` 1583,52) y la siguiente entrada de BTC, el
  2017-07-21.
- Queda sin medir cuántas entradas rechazó Risk: el diario no se guarda.

**Q-02.**
- Coinciden las citas de `docs/PROMOTION_CRITERIA.md` (`:76`, `:81`, `:93`, `:94`, `:96`, `:105-108` y `:142`),
  `src/risk/limits.ts:24-26`, `src/analytics/windows.ts:109-113`, `src/analytics/criteria.ts:351` y el ADR 0027
  (`:51-52` y `:118`).
- C4 reproduce la tabla y el 0,817 frente al 0,421. La salida guarda `alcista_btc` 37,406 y `alcista_estrategia` 3,653,
  una captura del 9,8 %.
- **Primer matiz:** el techo E vale para pares que se mueven como BTC. Con un par que sube mucho más que BTC, una posición
  pequeña puede capturar más, porque el benchmark es solo BTC.
- **Segundo matiz:** la incompatibilidad con A.3.4 supone que la posición sigue dentro durante la corrección; una salida
  antes la reduce.
- Ninguno de los dos cambia la conclusión de principio. Con el riesgo por operación de A.4.5 y una captura compuesta
  frente a BTC con todo el capital, el 50 % no está al alcance de la hipótesis de la familia.

**Q-03.**
- Coincide el código citado: `src/research/experiment.ts:213-221` toma N y los Sharpe de las líneas anteriores al
  pre-registro. `src/app/research-runner.ts:441-442` forma V con los Sharpe previos y los de la rejilla, sin las
  variantes. `src/analytics/report.ts:217-219` añade el de la propia serie.
- **Salidas:** A tiene `trialVariance` 0,000281 y `familySharpes` 5 en los dos DSR. B tiene 0,000281 en familia y
  0,0010288 en global, con `sr0` 0,0874.
- **C2** da 0,9855, 0,9837, 0,9800, 0,9125, 0,2138, 0,1793, 0,9689, 0,1546 y 0,0001.
- **Diferencia menor:** la N mínima que baja de 0,95 el DSR de familia de A con el suelo es 555; el informe dice ≈ 557.
- **Dato adicional (C7, que el consultor dejó sin comprobar):** la serie de A tiene una autocorrelación de 0,149 con un
  día de retardo y de 0,107 con dos.
  - En `src/analytics/` no hay ningún ajuste por autocorrelación (`grep` sin resultados): PSR, DSR, MinTRL y la
    anualización suponen rentabilidades independientes.
  - No es un hallazgo del consultor; se anota como dato para su recomendación.

**Q-04.**
- La regla de las dos especificaciones (`:23`) dice «los dos pares con más historia y los únicos que cubren los bajistas
  de 2018 y 2022».
- **C6:** LTC/EUR empieza el 2013-09-14, antes que ETH/EUR (2015-08-07). ETC/EUR (2016-07-27) y ZEC/EUR (2016-10-28)
  cubren los dos bajistas. Las dos afirmaciones de la regla son falsas según los manifiestos.
- **Concentración:** la operación de ETH de 2017 (1583,52 EUR) es el 75 % de los 2108 EUR de P&L cerrado.
- **C3, con los momentos de la serie y sin 2017:**
  - 3193 periodos (el informe dice 3194);
  - Sharpe anual de 1,185;
  - DSR de familia de 0,817 y global de 0,785, por debajo de 0,95.

**Q-05.**
- Coinciden `docs/PROMOTION_CRITERIA.md:104` y `:121` y `src/analytics/criteria.ts:281`.
- **C5:** con compra y venta, BTC queda en +1,3732 %, frente al +1,4161 % de A.
- El ADR 0031 (`:62-63`) eligió a propósito no cobrar la compra a BTC: «eso favorece a BTC, que es lo conservador». No es
  un error de código: el FAIL de A en 2020 sale de esa convención aprobada.

**Q-06.**
- Coinciden `src/analytics/criteria.ts:265`, que exige el PBO de la familia y el global, el ADR 0032 (`:145-146`) y
  `src/analytics/statistics.ts:260-261`, donde la mediana exacta da un logit de 0 y cuenta como sobreajuste.
- Coinciden también `docs/PROMOTION_CRITERIA.md:78` y el pre-registro de B (`:7`, «sin otros más estrictos»).
- **C8** da 0,667, 0,500 y 0,571. Con la fórmula de `statistics.ts:260` y un rango fuera de muestra uniforme salen
  exactamente esos valores.
- El PBO de la familia como causa de `RECHAZADA` lo decidió el ADR 0032, aprobado por la persona. El conflicto es entre
  ese ADR y el texto congelado de A.3.6.

**Q-07.**
- Coinciden el hueco del 2018-01-12 en el manifiesto de BTC/EUR (`:51-54`) y el reinicio de la ventana
  (`src/features/engine.ts:111`).
- La salida tiene 219 periodos `SIN_DATO` de tendencia, con BTC en −53,6 %, y 394 de volatilidad.

**Q-08.**
- Coinciden `src/analytics/criteria.ts:448`, `src/strategy/mean-reversion.ts:56`, `src/strategy/engine.ts:173-174` y
  `src/analytics/robustness.ts:43`.
- Ese redondeo hacia fuera convierte el −25 % de 5 en 3 y el de 2 en 1.

## Salida de los comandos

```text
C1   EXP-0025 { 'ETH/EUR entra con BTC/EUR ya abierta': 19, 'entradas simultaneas (x2)': 24 }
     EXP-0026 { 'entradas simultaneas (x2)': 10 }
C2   A familia N=127 suelo 0.9855 · A global N=143 suelo 0.9837 · A global N=177 suelo 0.9800
     A global N=177 V como reejecucion 0.9125 · V del cierre de B 0.2138 · V de los 9 Sharpe 0.1793
     A normal N=143 suelo 0.9689 · B familia N=42 0.1546 · B global N=177 0.0001 · N minima 555
C3   periodos 3193 · sharpe_anual 1.1853 · g3 0.7152 · g4 18.6858 · dsr_familia_127 0.8170 · dsr_global_177 0.7854
C4   E = 0,25: 0.250 · 0.188 · 0.045 | E = 0,5: 0.500 · 0.417 · 0.165 | E = 0,75: 0.750 · 0.688 · 0.440 (K = 1, 2, 6)
     crecimiento logarítmico necesario para el 50 %: 0.817; el de A: 0.421
C5   BTC con compra y venta dentro de la ventana: 0.013732; A: 0.014161
C6   BTC/EUR 2013-09-10 · LTC/EUR 2013-09-14 · ETH/EUR 2015-08-07 · ETC/EUR 2016-07-27 · REP/EUR 2016-10-04 · ZEC/EUR 2016-10-28
C7   retardos 1 a 5: 0.1494 · 0.1065 · 0.0360 · 0.0507 · 0.0679
C8   3 0.667 · 4 0.500 · 7 0.571
Q-07 SIN_DATO de tendencia: periods 219, benchmarkReturn -0.5362 · de volatilidad: periods 394, benchmarkReturn -0.7204
```

## Qué queda abierto

- **Veredictos:** no cambia ninguno. A y B siguen `RECHAZADA`.
- **Q-01:** es un error del backtester. Su arreglo es un cambio de código aparte, con su prueba. Repetir A o B serían
  experimentos nuevos, que suman a N.
- **Q-02, Q-03, Q-05 y Q-06:** cambian los criterios congelados o su cálculo. Es una parada obligatoria de la persona
  (`CLAUDE.md` §7), reinicia la validación y llega después de ver los resultados.
- **Fuera de alcance de este consultor:** la marca mínima de la cartera puede frenar entradas también en paper y en real.
  Es terreno del consultor EXECUTION/RISK.
