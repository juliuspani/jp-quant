# ADR 0026 — Backtester event-driven con el sistema real y un modelo de ejecución conservador

Fecha: 2026-10-13 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 23

## Contexto

El prompt del paso 23 pide un backtester event-driven que use exactamente las interfaces de Strategy, Risk y Execution
del sistema real (las del paso 20, ADR 0023), en el que solo cambien el reloj, la fuente de datos y el simulador de
fills. Tiene que modelar bid/ask, comisiones, spread, slippage, profundidad, latencia, ejecuciones parciales, rechazos,
paso de precio, precisión de cantidad, importe mínimo, cancelación, datos obsoletos y liquidez del libro. Sin datos de
libro, el modelo tiene que ser conservador y declararlo en el informe. Ningún resultado se muestra sin costes y todo
run pasa por el Experiment Registry. Pide una prueba por cada hipótesis de ejecución.

Además, `PROGRESS.md` asignaba al paso compromisos de pasos anteriores:

- reescribir `src/backtest.ts` y `src/backtest/sim.ts`, quitando sus excepciones;
- componer el replay desde `app/`, decidir el calentamiento y llevar al diario la prueba de determinismo, sin las
  firmas Ed25519;
- unir las dos fuentes de Kraken, el universo desde 2023, los renombres y las bajas con las velas;
- el dimensionado por riesgo con costes e `INSUFFICIENT_CASH`;
- el `SimulatedVenue`;
- el `DatasetPort` real, los ejecutores por `nombre@versión` y el primer experimento por `runExperiment`;
- el normalizador de `marketdata/` y el coste del Feature Engine.

Lo que hay: solo velas OHLCVT de Kraken en 1h, 4h y 1d, sin libro ni cotizaciones (DATA.md §5). El exchange donde se
operará es Bitvavo (ADR 0018).

## Decisión

### 1. Un solo sistema compuesto; el replay es la cola de eventos

`src/app/trading-system.ts` compone el camino real: marketdata → features → strategy → risk → execution → venue, y de
vuelta venue → execution → portfolio → strategy. Es el mismo en todos los modos (ADR 0013). Los eventos entran por
sus métodos `on*` en orden de llegada y lo que provocan se resuelve de forma síncrona, como un handler de
ARCHITECTURE.md §5.2. Lo que cruza un módulo se anota en el diario en JSON canónico.

`src/app/backtest.ts` lo ejecuta sobre el motor de replay (ADR 0021), que ya ordena por `received_time` y entrega los
temporizadores en su instante. El bus del kernel no se construye: no lo necesita ningún consumidor hasta paper y live
(paso 32), y el replay ya es la cola. Strategy solo recibe vistas de solo lectura de mercado y cartera; una prueba de
la composición lo comprueba.

### 2. Lo único que cambia en el backtest

| Pieza | Backtest | Real |
|---|---|---|
| Reloj | El simulado del replay (`engine.clock`) | `SystemClock` |
| Datos | Velas de `historical/` en su `received_time`, con la cotización y las reglas del mercado del modelo | `exchange/` (paso 32) |
| Venue | `SimulatedVenue`, cuyas respuestas vuelven como temporizadores | `ShadowVenue` y `LiveVenue` (pasos 32 y 39) |

Strategy, Risk y Execution son los mismos módulos con los mismos contratos. Los añadidos a esos contratos completan lo
que ARCHITECTURE.md ya describía:

- Execution entrega cada fill nuevo por `onFill`, que es el `FillRecorded` de §6;
- el kernel gana `AccountSnapshot`, la respuesta de `requestAccountSnapshot`, y `RawMarketData` (§16.3);
- `StrategyInput` no lleva `regime` hasta que exista `analytics/` (paso 26);
- el token de aprobación lleva `trigger_price`, el disparo firmado de un stop de protección (`null` en el resto), y
  Execution gana `cancel`, que un stop de protección solo admite con la aprobación de una salida o de una sustitución
  (trading-risk §2.2). Ver la decisión 10.

### 3. Modelo de ejecución: una prueba por hipótesis

| Hipótesis | Modelo | Prueba |
|---|---|---|
| Bid/ask | Una compra paga el lado ask y una venta cobra el bid; nunca el precio de referencia | H01 |
| Comisiones | Taker en cada fill, sobre su importe, en EUR y redondeada al alza a 8 decimales | H02 |
| Spread | Sin libro, ± el medio spread alrededor de la referencia | H03 |
| Slippage | El mínimo (0,05 %) encima de cada fill, también contra un libro real | H04 |
| Profundidad | Una orden mayor que un nivel recorre los siguientes, a peor precio | H05 |
| Latencia | 1 s de ida y 1 s de vuelta; se ejecuta en la vela de su llegada; nada es síncrono | H06 |
| Ejecución parcial | Lo que no cabe en la liquidez caduca: PARTIALLY_FILLED y después EXPIRED | H07 |
| Rechazos | Símbolo desconocido o sin negociar, tipo no soportado, client order ID repetido y saldo insuficiente | H08 |
| Paso de precio | 5 cifras significativas; precios en la rejilla, redondeados contra quien opera | H09 |
| Precisión de cantidad | 8 decimales; fuera del paso, rechazo (`LOT_SIZE`); fills múltiplos del paso | H10 |
| Importe mínimo | 5 EUR al precio de referencia (`MIN_NOTIONAL`) | H11 |
| Cancelación | Sin órdenes en reposo, llega tarde (estado final), falla con una desconocida y puede adelantarse a la orden | H12 |
| Datos obsoletos | Un libro de más de 60 s no se usa; sin operaciones en el intervalo, la orden caduca sin ejecutarse | H13 |
| Liquidez del libro | Con un libro real al día se recorren sus niveles; uno cruzado o desordenado no vale | H14 |
| Caducidad | Una orden que llega después de su `expiresAt` caduca sin ejecutarse | H15 |
| Declaración sin libro | `report()` declara el modelo sintético, sus parámetros y cuántas órdenes lo usaron | H16 |
| Sin costes, no hay backtest | Por debajo de los mínimos el modelo no se construye; el estrés multiplica todas las partidas | H17 |
| Reconciliación | La foto de la cuenta trae saldos, órdenes y fills desde una marca | H18 |
| Stop por toque | Si el mínimo de la vela toca el stop, se vende desde el precio del stop | H19, `intrabar.test.ts` y backtest |
| Stop por hueco | Si la vela abre más allá del stop, se vende desde la apertura | H20, `intrabar.test.ts` y backtest |
| Stop y objetivo en la misma vela | Se asume lo peor: primero el stop | `intrabar.test.ts` |
| Stop que espera | Bloquea su saldo, sigue si no se toca y se cancela liberándolo | H21 |
| Stop rechazado | Si saltaría al llegar (`STOP_WOULD_TRIGGER`) o su disparo está fuera del paso | H22 |

**Precio de referencia:** la apertura de la vela que contiene la llegada de la orden, que es la «apertura siguiente»
de quant-research §3. La orden sale al cierre de la vela de la señal más la latencia de los datos y la de ida.

**Sin libro, conservador y declarado.** El libro sintético se construye con la vela de ejecución:

- toma el 2 % de su volumen por lado, repartido en 5 niveles, y cada nivel es un 0,05 % peor que el anterior;
- el slippage mínimo se cobra encima de cada fill;
- el medio spread no baja del 0,075 %, la mitad del spread más ancho que Risk acepta en el núcleo (0,15 %,
  trading-risk §4.5). Así cada operación simulada paga al menos lo que pagaría una real que pasara ese control.

Ninguno de esos números sale de datos ni se ajusta a la vista de un resultado.

**Mínimos de costes,** más estrictos que los del registro:

- comisión de al menos 0,25 %, la taker de Bitvavo (ADR 0018) [verificar en el paso 32];
- medio spread de al menos 0,075 %;
- slippage de al menos 0,05 %.

El multiplicador de estrés (×2, ×3) multiplica comisión, medio spread, slippage e impacto por nivel.

**Reglas del mercado** modeladas como Bitvavo [verificar en el paso 32]. No hay histórico de las reglas, y la lista de
pares de Kraken de hoy es del periodo del test final.

**Cuenta propia del venue.** Una orden sin saldo se rechaza por saldo insuficiente, que Execution trata como una duda
(exchange-execution §3.1).

### 4. Risk: dimensionado por riesgo con costes

El riesgo por unidad es:

`(ask − stop) + ask × (comisión + slippage) + stop × (comisión + slippage + medio spread de la cotización)`

- La pérdida a ese riesgo no pasa del 0,75 % del patrimonio.
- Los costes estimados tienen como mínimo el 0,25 % y el 0,05 %: más bajos darían tamaños mayores.
- Una cantidad pedida mayor se reduce con `RISK_PER_TRADE`.
- El 99 % de la caja libre, con los costes de la compra, recorta como los demás topes (`INSUFFICIENT_CASH`), y sin
  caja la entrada se rechaza.

### 5. Cartera, normalizador y Strategy Engine

- **`portfolio/`:** cartera en Decimal a partir de los fills, valorada al bid. Un fill repetido o imposible lanza, y
  una comisión en otra moneda también (paso 32).
- **`marketdata/`:** el normalizador de §4.3. Solo pasan velas cerradas y recibidas después de cerrar; las repetidas
  y desordenadas se ignoran y se anotan; un hueco se avisa y no se rellena.
- **`strategy/engine.ts`:** convierte decisiones puras en intenciones, con el stop al alza al paso de precio. Lleva
  una intención por símbolo cada vez, y el stop solo sube.

### 6. Determinismo, calentamiento y resultados

- **Diario sin firmas.** Los tokens van al diario sin su firma, que cambia en cada arranque (ADR 0023). El hash del
  diario es el mismo entre ejecuciones y entre procesos, y está fijado en la prueba.
- **Calentamiento:** los `warmupBars` de la estrategia antes del tramo calculan features sin evaluar la estrategia.
  En un experimento, salen de los datos registrados: si no caben en el rango, el ejecutor se niega.
- **Cifras netas.** Las posiciones abiertas al final se valoran al bid, menos la comisión y el slippage mínimo.
- **Una duda sin resolver detiene el sistema.** Si la primera reconciliación no la resuelve, el sistema se detiene
  (`halted`) y el resultado lo dice.

### 7. Todo run pasa por el Experiment Registry

- **`app/datasets.ts`:** el `DatasetPort` real.
  - Una referencia nombra una colección del almacén por prefijo, etiquetas y marco («kraken», «full2026q2+2026q3»,
    «1h»).
  - El hash cubre los manifiestos de todas las partes y la regla del universo, sin cargar velas.
  - Cada par se lee por la guarda del test final y se unen sus fuentes.
- **`app/research-runner.ts`:** el ejecutor por `nombre@versión`.
  - Hace un backtest por tramo de validación, con 1.000 EUR (el tope del ADR 0017).
  - Rechaza los barridos: elegir parámetros en train es de los pasos 24 a 27.
  - Deja en la línea de cierre del registro los costes, la declaración del modelo de ejecución y el sesgo de
    supervivencia.
  - Es el único que llama a `runBacktest`; una prueba lo comprueba.
- **`app/backtest-command.ts`:** sustituye a `src/backtest.ts`. Solo ejecuta por `runExperiment` y se niega a un
  barrido antes de registrar nada. `RESEARCH_RUNNERS` está vacío hasta que el paso 25 dé de alta una estrategia.
- **Código previo fuera.** `src/backtest.ts` y `src/backtest/sim.ts` salen, con sus excepciones de `no-float`, de
  límites y de la estructura.

### 8. Universo y fuentes (compromisos del 19B)

- `universeAt` no responde antes del 2023-01-01. Antes solo cabe un universo limitado con el sesgo declarado.
- Las bajas del final salen de las velas: un par sigue listado si tiene una vela que cierra después del
  2026-09-29T00:00Z.
- LUNA, LUNA2, REP y REPV2 no son renombres que unir. Se decidió con los rangos de los manifiestos (DATA.md §5).
- `joinParts` concatena el ZIP completo y el trimestral sin solapes.

### 9. El primer experimento con datos reales pasa al paso 25

No hay ninguna estrategia con parámetros de la literatura (compromiso del paso 25) ni pre-registrada. Ejecutar ahora la
de `trend.ts` sumaría una prueba a su familia sin un pre-registro válido y miraría datos reales sin hipótesis. Lo
reversible y prudente es no ejecutar nada. El camino completo está probado con datos sintéticos y un registro temporal,
incluida la reproducción exacta por id.

### 10. Stops de protección dentro de la vela (añadido antes de cerrar el paso, a petición de la persona)

Evaluar los stops solo al cierre de la vela y salir en la siguiente era optimista: ignoraba las caídas dentro de la
vela. Ahora el stop de cada posición es una orden que espera en el exchange, como el stop nativo de trading-risk §2.4:

- tras cada entrada, el Strategy Engine propone el stop como intención de sistema (`protective_stop`), Risk lo aprueba
  por el camino corto de las salidas, con el disparo al alza al paso de precio y firmado en el token, y Execution lo
  envía como stop a mercado sin TTL;
- el venue lo comprueba al cierre de cada vela con `sellTrigger` (`src/backtest/intrabar.ts`): si la vela abre más
  allá del stop y la orden ya esperaba, se vende desde la apertura; si el mínimo lo toca, desde el precio del stop;
  si se tocan stop y objetivo en la misma vela, primero el stop. Sobre esa referencia se cobran medio spread,
  slippage mínimo, profundidad y comisión, como en cualquier venta: algo más prudente que «stop menos slippage»;
- antes de una salida o de subir el stop (`stop_update`), la composición cancela el stop que espera y, confirmada la
  cancelación, envía la orden ya aprobada (exchange-execution §8). Si el stop se ejecutó antes, la salida sobra;
- el kill switch no cancela los stops de protección.

Lo que queda fuera: el objetivo existe en el modelo y en sus pruebas, pero ninguna estrategia puede fijarlo todavía,
porque haría falta una orden límite y otra de stop a la vez sobre el mismo saldo (OCO), que el venue y Execution no
tienen (paso 36). La hora del fill es el cierre de la vela, porque con velas no se sabe cuándo se tocó el stop.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Stops por software al cierre de la vela | Optimista: ignora las caídas dentro de la vela (decisión 10) |
| Simular el stop solo en el backtest, sin pasar por Risk ni Execution | Rompe Strategy → Risk → Execution y no es lo que hará el sistema real |
| Construir ya el bus de §5.2 | Infraestructura sin consumidor: el replay ya ordena por tiempo y con temporizadores. Llega con paper y live |
| Ejecutar al cierre de la vela de la señal | Optimista: ese precio ya pasó cuando llega la orden. quant-research §3 fija la apertura siguiente |
| Ejecutar al peor precio de la vela siguiente | Pesimista sin base, y usa el máximo y el mínimo, que ocurren después de la llegada |
| Slippage fijo sin profundidad | No modela el tamaño ni las ejecuciones parciales |
| Órdenes a mercado que esperan en el libro varias velas | Un exchange no deja en reposo una orden a mercado: lo que no se ejecuta caduca |
| Spread estimado con las velas (Corwin-Schultz) | Más parámetros y float en `backtest/`. Se usa un mínimo atado al control de Risk |
| Paso de precio de la lista de pares de Kraken de hoy | Es información del periodo del test final, y Kraken no es Bitvavo |
| Rechazos o timeouts al azar en el venue | No salen de ningún dato. Las pruebas inyectan esos fallos donde hace falta |
| Mantener `sim.ts` para comparar | Es otro motor, en float y vectorizado: justo lo que el ADR 0013 descarta |

## Consecuencias

- **Lo que el backtest no ejercita, declarado:** el libro real, los WebSockets, los límites de peticiones, la
  reconciliación periódica (una duda detiene el run) ni la ventana sin protección real al sustituir un stop. Por eso
  siguen paper y shadow.
- **Stops dentro de la vela, con lo peor primero:** el fill de un stop se fecha al cierre de su vela; sin OCO, ninguna
  estrategia puede fijar un objetivo (paso 36).
- **Precios de Kraken, ejecución modelada como Bitvavo:** el traslado se comprueba en el paso que compare los dos
  (DATA.md §2, punto 5).
- **La cotización del sistema sale del cierre de la vela.** El último trade pudo ser anterior, y eso no se ve con
  velas.
- **Una posición en un par que se da de baja no se liquida:** el venue rechaza sus órdenes. Queda como compromiso
  antes de un experimento con pares que se dan de baja (quant-research §3).
- **Coste:** unos 0,38 ms por vela con 29 features (0,30 ms son las features) y unos dos eventos de diario por vela,
  en memoria. Sin optimizar.
- **El hash fijado del diario** cambia si se cambia a propósito el modelo, el escenario o el formato; ese cambio se
  explica en su commit.
- Compromisos nuevos en `PROGRESS.md` para los pasos 24 a 27, 25, 26, 32, 35 y 36.
