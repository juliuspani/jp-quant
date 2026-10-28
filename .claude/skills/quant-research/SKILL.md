---
name: quant-research
description: Procedimiento obligatorio para cualquier investigación cuantitativa en Inversor JP. Cubre backtests, walk-forward, optimización o barrido de parámetros, evaluación de señales o features (incluidas las generadas por un LLM), comparación de estrategias e informes de resultados. Úsalo antes de escribir o ejecutar código de research, antes de mirar métricas sobre datos reales y antes de dar cualquier conclusión sobre el rendimiento de una estrategia.
---

# quant-research

Este procedimiento es obligatorio. Desarrolla las reglas de integridad de `CLAUDE.md` §2, pero no las
sustituye: si algo de aquí choca con `CLAUDE.md`, manda `CLAUDE.md`. Los umbrales numéricos están fijados en
[ADR 0002](../../../docs/adr/0002-protocolo-quant-research.md) y solo cambian con otro ADR.

**Umbrales congelados en el paso 27** ([ADR 0030](../../../docs/adr/0030-criterios-congelados.md)): los criterios
de promoción están en `docs/PROMOTION_CRITERIA.md` y el gate antes de operar en real en `docs/PRE_LIVE_GATE.md`.
Donde difieran de este skill, mandan esos documentos, que son más estrictos. Cambiarlos es una parada obligatoria y
reinicia la validación. El periodo del test final y sus etapas están en el ADR 0019 (§4).

Archivos de este skill:

- [checklist.md](checklist.md): lista de comprobación que se copia en cada experimento.
- [plantilla-informe.md](plantilla-informe.md): plantilla del informe de experimento.

## 1. Principios

1. **El P&L positivo no demuestra nada.** Ninguna estrategia se declara rentable, validada ni ganadora. Los
   únicos veredictos posibles son los de §11.
2. **Se cuenta todo lo que se ha mirado.** Cada ejecución sobre datos reales cuyas métricas se hayan visto
   es una prueba, salga bien o mal, se termine o se aborte. Va al Experiment Registry (§10).
3. **Primero se escribe y después se ejecuta.** Hipótesis, métrica primaria y criterios de aceptación se
   registran antes de tocar los datos. No se cambian a la vista del resultado.
4. **Ante la duda, se rechaza.** Si falta un control, la muestra no llega o un dato es dudoso, el veredicto
   es `NO CONCLUYENTE` o `RECHAZADA`, nunca uno mejor.
5. **A igualdad de evidencia, gana la opción más simple.**

## 2. Pre-registro

Antes de cargar datos reales, se añade al registro una entrada con `estado: "registrado"` que recoja:

- la hipótesis en una frase, con el mecanismo económico que la justificaría;
- la **métrica primaria**, que será una sola (por defecto, el Sharpe anualizado fuera de muestra y neto
  de costes);
- los criterios de aceptación, que son los de §9 salvo que se registren otros más estrictos;
- la **familia**, que agrupa las pruebas que compiten por la misma decisión, y el número de pruebas que la
  familia ya acumula;
- el espacio de parámetros completo que se va a explorar, con su rejilla.

## 3. Datos point-in-time

- **Sin look-ahead.** Cada decisión usa solo datos disponibles en ese instante. Se decide con la vela
  cerrada y se ejecuta en la apertura siguiente. En ccxt la marca de tiempo de una vela es la de su
  apertura, así que la vela solo se conoce al cerrar. La última vela de `fetchOHLCV` se descarta si sigue
  abierta. Los indicadores no incluyen la vela actual cuando la regla dice "previa".
- **Calentamiento.** Los indicadores recursivos (EMA, RSI, ATR) se calientan con al menos 3–5 veces su
  periodo, y el calentamiento es el mismo en backtest y en real. Calentar con datos anteriores a un tramo
  es legítimo porque es pasado. Ajustar parámetros con esos datos no lo es.
- **Universo point-in-time.** En cada fecha `t`, el universo lo forman los activos listados y negociables
  en `t`. Si hay filtros (volumen, capitalización, antigüedad), se calculan solo con datos anteriores a `t`.
  - **Listings:** ningún activo se usa antes de su primera vela. Además debe tener historia suficiente
    para el calentamiento.
  - **Delistings:** los activos deslistados siguen en el histórico hasta su fecha de baja. Una posición
    abierta en esa fecha se cierra al último precio negociable menos un descuento registrado. Si no había
    salida posible, la posición vale 0.
  - Un universo construido con `fetchMarkets()` de hoy tiene **sesgo de supervivencia por construcción**,
    porque solo devuelve lo que sigue listado. Hace falta una fuente con los activos deslistados, y el
    informe la nombra.
- **Sin leakage.** Ninguna normalización, escalado, selección de features ni selección de universo se
  ajusta con datos fuera del tramo de entrenamiento.
- **Huecos.** Los huecos de datos se detectan y se excluyen, nunca se rellenan con precios planos.
- **Calendario.** Cripto opera los 365 días del año: se anualiza con 365, no con 252.
- **Huella de datos.** Cada experimento registra la fuente, el rango, el timeframe y un hash de los datos
  usados.

## 4. Particiones temporales

- **Solo cortes temporales:** primero `train`, después `validation` y al final `test`. Nunca se baraja ni
  se usa k-fold aleatorio.
- **Walk-forward.** Los parámetros se eligen en `train` y se miden en el tramo siguiente, y luego se avanza.
  Un esquema típico ajusta con 3 años, mide 1 y avanza 1. El resultado que cuenta es la **concatenación de
  los tramos fuera de muestra**. Las métricas dentro de muestra se informan pero nunca deciden nada.
- **Purging.** Se elimina del entrenamiento toda observación cuya etiqueta u operación se resuelva dentro
  del tramo de evaluación. Con un horizonte de etiqueta de `h` velas, se purgan las últimas `h` velas de
  `train`. Una operación abierta al final de `train` no aporta su resultado al ajuste.
- **Embargo.** Tras cada tramo de evaluación se excluyen `e` velas antes de reutilizar datos para
  entrenar, con `e ≥ h`. Así no se cuela la correlación serial cuando un tramo posterior entrena sobre
  tramos ya evaluados.
- **Test final intocable, usado por etapas** ([ADR 0019](../../../docs/adr/0019-periodo-del-test-final.md)).
  - Su periodo está en `config/holdout.lock`: del 2026-10-01 al 2027-10-01, hacia delante, porque todo lo
    anterior hasta el 2026-09-29 está examinado. Ningún código de research lo carga sin un flag humano
    explícito. El hook de Claude bloquea cualquier comando de shell que nombre ese archivo o
    `data/holdout/`: no se intenta.
  - **Un periodo ya examinado no puede ser test final.** Las pruebas de
    `docs/research/02-estrategias-y-frecuencia.md` cuentan en `N` como pruebas previas de su familia.
  - **Etapa 1, paso 31:** decisión provisional que solo permite pasar a paper. No abre el test final: se basa en
    walk-forward y CSCV hasta el 2026-09-30, en el Deflated Sharpe y en el informe del consultor quant.
  - **Etapa 2, micro-live:** al menos 3 meses de datos hacia delante, nunca antes del 2027-01-01, con un
    comportamiento coherente con lo esperado según criterios congelados en el paso 27.
  - **Etapa 3, más capital:** el año completo hacia delante, cumpliendo los criterios de promoción del paso 27.
  - Cada apertura la autoriza un humano. Entre etapas no se reoptimiza. Si falla la etapa 2, o la coherencia en
    la etapa 3, queda rechazada. Si en la etapa 3 falla otro criterio, no se sube capital: sigue en micro-live con
    el mismo capital hasta la revisión del año siguiente (ADR 0030). Cambiarla después es una hipótesis nueva que
    ya no tiene test final limpio en esa familia.
  - Los resultados de paper durante el periodo se juzgan solo en las etapas 2 y 3, nunca para reajustar.

## 5. Costes de ejecución

En todo backtest se cobran, siempre, las tres partidas. Un resultado sin costes no es válido y no se
informa.

| Partida | Mínimo |
|---|---|
| Comisión | La tarifa taker real del exchange y del nivel de cuenta, por lado. Como mínimo, 0,10 % |
| Spread | Medio spread por lado si los precios son de cierre o de punto medio |
| Slippage | 0,05 % por lado en activos líquidos. En activos poco líquidos, se estima con el libro de órdenes o con el tamaño de la orden frente al volumen, y nunca baja de ese mínimo |

- **Estrés de costes.** El experimento se repite con costes ×2 y ×3. Se informan los resultados bruto y
  neto.
- Los precios de entrada y salida no pueden ser mejores que el rango de la vela. Si dentro de una vela no
  se sabe qué se tocó antes, el stop o el objetivo, se asume lo peor.

## 6. Benchmark y control negativo

Ambos se calculan con el mismo periodo, los mismos costes y el mismo universo point-in-time que la
estrategia.

- **Benchmark (buy-and-hold).** Comprar BTC al inicio y mantenerlo, pagando los costes de la compra. Con
  más de un activo, también el buy-and-hold equiponderado del universo point-in-time. En los regímenes
  (A.3.9) se compara con BTC escalado por la exposición de la estrategia, sin polvo (ADR 0042).
- **Control negativo (aleatorio).** Al menos 1000 simulaciones con entradas al azar. Cada una tiene el mismo
  número de operaciones, la misma distribución de duración, el mismo tamaño de posición y los mismos
  costes que la estrategia. La semilla se registra. El informe da el percentil que ocupa la estrategia en
  esa distribución.
- **Prueba de humo.** El código debe dar un resultado nulo en dos casos: con la señal desplazada al azar y
  con un camino de precios sin estructura, como un paseo aleatorio. Si "gana" con eso, hay un fallo.

## 7. Robustez

- **Estabilidad.** Los resultados se desglosan por año, por tramo walk-forward, por activo y por régimen
  de mercado (alcista, bajista y lateral). Se repite el cálculo quitando el mejor año y quitando el mejor
  activo.
- **Sensibilidad.** Cada parámetro se mueve ±25 % y ±50 %, de uno en uno. Se busca una meseta, no un pico.
  Un parámetro con más de 3 cifras significativas indica sobreajuste.
- **Ablación.** Se quita cada componente (filtros, stops, reglas de salida, features) y se mide su
  aportación a la métrica primaria fuera de muestra, como exceso sobre su propio control aleatorio con
  las mismas operaciones y duraciones (ADR 0037). Un componente que no aporta se elimina.
- **Universo alternativo.** La estrategia se prueba con activos que no se usaron para diseñarla.

## 8. Estadística

Los Sharpe de las fórmulas son por periodo, sin anualizar. `T` es el número de periodos; `γ₃` es la
asimetría y `γ₄` la curtosis no exceso, que vale 3 en una normal. `Φ` es la normal estándar acumulada.

- **Corrección por pruebas múltiples: Deflated Sharpe Ratio** (Bailey y López de Prado).
  - `PSR(SR*) = Φ( (SR − SR*)·√(T − 1) / √(1 − γ₃·SR + ((γ₄ − 1)/4)·SR²) )`
  - `SR₀ = √V[SRₙ] · ( (1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) )`, donde `γ ≈ 0,5772` es la constante
    de Euler–Mascheroni.
  - `DSR = PSR(SR₀)`.
  - `N` es el **número total de pruebas de la familia** según el registro, contando las fallidas y las
    abortadas; la `N` global, todas las del registro al decidir (ADR 0039). `V[SRₙ]` es la varianza del
    Sharpe estimado de una prueba sin habilidad con la misma longitud y dependencia, nunca por debajo de
    `1/(T − 1)` (ADR 0039).
  - Con autocorrelación, la varianza del Sharpe es la varianza a largo plazo de su función de influencia
    (ADR 0038), que nunca baja de la de la fórmula de arriba. La usan PSR, DSR y MinTRL.
  - Con `N = 1`, `SR₀ = 0`. El informe siempre da `N`.
- **Probability of Backtest Overfitting (CSCV)**, obligatoria cuando se comparan varias configuraciones.
  Con menos de 3 configuraciones se informa y no decide (A.3.6, ADR 0041).
  1. Se construye la matriz `T × N` de rendimientos por periodo de las `N` configuraciones y se parte en
     `S` bloques temporales contiguos, con `S` par (por defecto 16).
  2. Para cada una de las `C(S, S/2)` combinaciones, la mitad elegida de bloques es dentro de muestra y el
     resto es fuera de muestra.
  3. Se toma la mejor configuración dentro de muestra y se calcula su rango relativo fuera de muestra,
     `ω = rango/(N + 1)`, donde el rango 1 es la peor.
  4. Se calcula `λ = ln(ω/(1 − ω))`.
  5. `PBO` es la proporción de combinaciones con `λ ≤ 0`.
- **Intervalos de confianza por bootstrap por bloques.** Se usa el bootstrap estacionario de Politis y
  Romano con al menos 10 000 remuestreos.
  - La longitud media de bloque es al menos la mayor de dos cantidades: la duración media de una
    operación y `⌈T^(1/3)⌉`.
  - Se dan IC al 95 % de la métrica primaria, el CAGR y el drawdown máximo, y del exceso sobre el
    benchmark. Para la métrica primaria, también el de la varianza a largo plazo del Sharpe, y decide el
    menor de los dos límites inferiores (A.3.11, ADR 0038).
- **Tamaño de muestra mínimo.** No se saca ninguna conclusión por debajo de los mínimos de §9.
  - La longitud mínima de historial es `MinTRL = 1 + (1 − γ₃·SR + ((γ₄ − 1)/4)·SR²)·(z_α/(SR − SR*))²`
    periodos, con `z₀,₉₅ = 1,645` y `SR* = 0`.
  - Como referencia, el t de un Sharpe anual es aproximadamente `Sharpe × √años`: con un Sharpe de 1 hacen
    falta unos 4 años para distinguirlo de cero.

## 9. Criterios de aceptación

Estos son los mínimos obligatorios, fijados en el ADR 0002. Todos se miden fuera de muestra, netos de
costes. Fallar uno solo basta para `RECHAZADA`. Si un criterio no se puede medir, el resultado es
`NO CONCLUYENTE`.

Los criterios completos y congelados, más estrictos que esta tabla, están en `docs/PROMOTION_CRITERIA.md`
(A.3), incluido el perfil por régimen de cada familia.

| Criterio | Umbral |
|---|---|
| Muestra | ≥ 100 operaciones cerradas y ≥ 3 tramos walk-forward. La historia cumple `MinTRL` al 95 % e incluye al menos un mercado bajista completo (2018 o 2022) |
| Deflated Sharpe | `DSR ≥ 0,95` con `N` = todas las pruebas de la familia |
| PBO | `< 0,20` para aceptar. Con `≥ 0,50` se rechaza aunque lo demás pase |
| Bootstrap | El límite inferior del IC al 95 % de la métrica primaria es mayor que 0 (el menor de los dos de A.3.11) |
| Benchmark | Supera al buy-and-hold en la métrica primaria |
| Control aleatorio | La métrica primaria supera el percentil 95 de ≥ 1000 simulaciones aleatorias |
| Costes | Con costes ×2 la métrica primaria sigue siendo positiva. Con ×3 se informa |
| Sensibilidad | Con ±50 % en cada parámetro, la métrica primaria no cambia de signo ni cae a menos de la mitad |
| Estabilidad | Sin el mejor año y sin el mejor activo, la métrica primaria sigue siendo positiva |
| Ablación | Todos los componentes que quedan aportan, frente a su propio control aleatorio (ADR 0037) |

**Penalización de la complejidad.**

- Se cuentan como parámetros libres los parámetros numéricos, las elecciones discretas (indicador,
  timeframe, tipo de salida) y los filtros de universo.
- Entre dos variantes con evidencia comparable, cuyos IC se solapan, gana la que tiene menos parámetros.
- Cada parámetro añadido tiene que justificarse con la ablación, y su prueba suma a `N`.

## 10. Experiment Registry

- **Ubicación:** `docs/research/experiments/registry.jsonl`. Se crea con el primer experimento.
- **Formato:** una línea JSON por evento, solo de inserción. Nunca se edita ni se borra una línea: las
  correcciones se añaden como líneas nuevas que referencian la anterior.
- **Qué se registra:** todo, incluidas las pruebas fallidas, abortadas, con errores o descartadas, y los
  vistazos rápidos sobre datos reales. Lo único que no se registra son las ejecuciones con datos sintéticos
  para depurar código.
- **Ciclo de vida:** cada experimento tiene al menos dos líneas con el mismo `id`.
  1. La de pre-registro, con `estado: "registrado"`.
  2. La de cierre, con `estado` en `completado`, `fallido`, `abortado` o `invalidado`.

Campos ([ADR 0024](../../../docs/adr/0024-registro-de-experimentos.md)). Cada línea está en JSON canónico y lleva el
SHA-256 de la anterior, así que editar, borrar o reordenar una línea rompe la cadena y la lectura rechaza el registro
entero. Las reglas se comprueban al leer, no solo al escribir.

En todas las líneas:

| Campo | Contenido |
|---|---|
| `formato` | Versión del formato de línea (hoy, `1`) |
| `anterior` | SHA-256 de la línea anterior; en la primera, 64 ceros |
| `id` | `EXP-0001`, `EXP-0002`… (correlativo, asignado al registrar) |
| `fecha` | ISO 8601 en UTC, nunca anterior a la de la línea previa |
| `autor` | Persona o agente que lo ejecuta |
| `estado` | `registrado`, `completado`, `fallido`, `abortado` o `invalidado` |
| `familia` | Decisión a la que contribuye. Define el `N` del DSR. En el cierre es la del registro |
| `notas` | Motivo de fallo, aborto o invalidación (obligatorio en esos estados), o `null` |

Solo en la línea de pre-registro (`estado: "registrado"`):

| Campo | Contenido |
|---|---|
| `previa` | `true` si es una prueba anterior al registro, dada de alta solo para que cuente en `N` |
| `familia_nueva` | `true` si abre la familia. Se declara: una errata no puede abrir una familia con `N = 1` |
| `n_pruebas` | Pruebas que cuenta: las configuraciones (1 con valores, el producto de la rejilla con un barrido) más `variantes` |
| `variantes` | Ejecuciones de robustez sobre datos reales: costes ×2 y ×3, retraso de una vela, cada parámetro a ±25 % y ±50 %, sin el mejor activo, cada componente quitado (ablación) y el universo alternativo. Cuentan en N (ADR 0031). Los controles (aleatorio, señal desplazada y paseo aleatorio) no cuentan |
| `solo_eleccion` | `true` en un experimento que solo elige en train (ADR 0044): un barrido sin variantes, sin validaciones medidas y sin veredicto. Solo su último tramo puede validar fuera de los datos. Falta en los demás |
| `n_familia` | Pruebas de la familia contando esta (las anteriores más `n_pruebas`) |
| `hipotesis` | Una frase |
| `metrica_primaria` | Nombre y definición |
| `criterios` | Umbrales de aceptación, como mínimo los de §9 |
| `estrategia` | `nombre` y `version` de la estrategia; eligen su ejecutor (`nombre@version`) |
| `commit` | Hash del código ejecutado. No vale un árbol de trabajo con cambios sin confirmar, salvo el propio registro y sus informes. `null` solo en una prueba previa |
| `datos` | Fuente, dataset, versión, timeframe, rango `[desde, hasta)` y hash. Dataset, versión y hash son `null` solo en una prueba previa |
| `universo` | Regla y símbolos. Sin símbolos solo en una prueba previa que no los detalla. `alternativos`: activos que no se usaron para diseñarla, fijados antes de mirar datos y distintos de los símbolos (universo alternativo, §7) |
| `particiones` | Tramos `train`/`validation` en orden, purging y embargo (`e ≥ h`). `test` siempre es `null`: el test final no se abre desde aquí |
| `costes` | Comisión, spread, slippage (fracciones por lado, no por debajo de los mínimos de §5) y multiplicador |
| `parametros` | `valores`, o `rejilla` completa si es un barrido. `descripcion` solo en una prueba previa |
| `semilla` | Semilla entera del experimento (bootstrap y control aleatorio) |
| `informe` | Ruta del informe, `docs/research/experiments/EXP-NNNN.md` |

Solo en las líneas de cierre:

| Campo | Contenido |
|---|---|
| `referencia` | SHA-256 de la última línea de ese experimento, la que cierra o corrige |
| `resultado` | Solo en `completado`, y siempre: métricas fuera de muestra, hash de la salida y veredicto de §11 (`null` mientras el protocolo de §9 no lo calcule). Las métricas incluirán DSR, PBO, IC y percentil aleatorio |

Después de `completado`, `fallido` o `abortado` solo cabe una corrección `invalidado`, y después de `invalidado`,
nada. El `N` de cada familia se deriva solo de este archivo.

**Pruebas previas al registro.** Los barridos y pruebas de `docs/research/02-estrategias-y-frecuencia.md` se
hicieron sin este protocolo. Al crear el registro se dieron de alta como pruebas de su familia: una línea
`registrado` con `previa: true` y su cierre `invalidado`, para que cuenten en `N`.

## 11. Veredictos

Solo existen estos cuatro. Las palabras "rentable", "validada", "ganadora" o "funciona" no se usan para
describir una estrategia.

| Veredicto | Cuándo |
|---|---|
| `RECHAZADA` | Un criterio que se mide no llega a su umbral (también la muestra: menos de 100 operaciones cerradas o el MinTRL sin cumplir), o falla el test final. Basta uno (`docs/PROMOTION_CRITERIA.md`, regla 2) |
| `NO CONCLUYENTE` | Ningún criterio falla, pero alguno no se puede medir: falta un control o una prueba de robustez, el simulador del control aleatorio no es válido y no se repitió con el backtester, o no hay un bajista completo (2018 o 2022) fuera de muestra |
| `CANDIDATA A TEST FINAL` | Pasa todo en validación. Solo un humano decide si se abre el test final |
| `CANDIDATA A PAPER` | Pasa la decisión provisional del paso 31 (etapa 1 del ADR 0019). Lo siguiente es paper trading, que valida la ejecución y no la ventaja (`docs/research/02-estrategias-y-frecuencia.md` §4.3); micro-live y más capital exigen las etapas 2 y 3 |

## 12. Features generadas por un LLM

- La salida de un LLM solo cuenta como feature si se cumple una de estas dos condiciones:
  1. Se generó en tiempo real. Eso quiere decir que se guardó en un registro solo de inserción con marca
     de tiempo anterior al resultado que predice, junto con el modelo, la versión del prompt y la entrada
     exacta.
  2. Se generó después con un modelo cuyo corte de conocimiento documentado es **anterior al inicio del
     periodo evaluado**, y sin acceso a información posterior (ni búsqueda web ni entradas con fecha
     posterior).
- Si no se cumple ninguna, la feature no se usa y cualquier backtest que la use es inválido.
- El informe registra el identificador del modelo y su corte de conocimiento.
- **Las hipótesis también se contaminan.** Una idea o un parámetro propuesto por un LLM que conoce el
  periodo evaluado (también Claude en esta sesión) parte con look-ahead. Para esa idea solo es limpio el
  test final no examinado o los datos posteriores a la propuesta.
- En este proyecto la inteligencia de LLM solo puede frenar riesgo, nunca generar una señal de compra.
  Ningún LLM ejecuta órdenes.

## 13. Cómo trabajar

1. Copiar [checklist.md](checklist.md) en el informe del experimento y marcarla durante el trabajo.
2. Pre-registrar en el registry (§2) antes de cargar datos reales.
3. Ejecutar desde un commit limpio y registrar el cierre aunque el resultado sea malo.
4. Redactar el informe con [plantilla-informe.md](plantilla-informe.md) en
   `docs/research/experiments/EXP-NNNN.md`.
5. Dar el veredicto de §11 tal cual. Si hay que resumirlo en una frase, la frase lleva el veredicto, `N`,
   DSR y PBO, nunca solo el P&L.
