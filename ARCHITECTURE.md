# Arquitectura de JP Quant

> **Copia pública (paso 49).** Las menciones a `PROGRESS.md` y `docs/progress/` se refieren al registro de trabajo
> privado del proyecto, que no se publica. Guía en inglés de la documentación: [docs/README.md](docs/README.md).

Fecha: 2026-10-06 · Paso: 14 · Decisiones:
[ADR 0012](docs/adr/0012-monolito-modular-por-eventos.md) (arquitectura),
[ADR 0013](docs/adr/0013-mismo-codigo-en-todos-los-modos.md) (modos),
[ADR 0014](docs/adr/0014-tipo-decimal-big-js.md) (tipo decimal) y
[ADR 0015](docs/adr/0015-limites-entre-modulos.md) (límites).

Este documento fija la arquitectura objetivo: procesos, módulos, eventos, propiedad del estado,
persistencia, recuperación, observabilidad, errores, concurrencia, límites e interfaces. **Todavía no está
implementada.** El `src/` actual es el código previo (mapa en `CLAUDE.md` §1). §18 dice adónde va cada archivo
actual y §19, en qué orden se construye cada parte.

Las reglas y los umbrales de riesgo, ejecución e investigación están en los skills
[trading-risk](.claude/skills/trading-risk/SKILL.md),
[exchange-execution](.claude/skills/exchange-execution/SKILL.md) y
[quant-research](.claude/skills/quant-research/SKILL.md). Aquí no se repiten ni se cambian. Si algo de este
documento choca con `CLAUDE.md` o con un skill, mandan ellos.

## 1. Decisiones principales

1. **Monolito modular orientado a eventos en un solo proceso**, más el **capguard** en un proceso aparte
   (ADR 0012). La investigación, la captura de datos y los informes son comandos del mismo código, no servicios.
2. **Pipeline:** Market Data → Normalization → Feature Engine → Strategy Engine → Portfolio/Risk Engine →
   Execution Engine → Exchange Adapter. Cada etapa vive en una carpeta de `src/` y se comunica con las demás
   por eventos.
3. **Kernel de un solo hilo:** un bus con una cola FIFO y handlers síncronos. La entrada y salida (E/S) solo la
   hacen los adaptadores, y sus resultados vuelven como eventos. El orden de los cambios de estado es
   determinista.
4. **Cada evento lleva `event_time` y `received_time`.** El backtest reproduce los eventos por `received_time`,
   y eso es lo que impide el look-ahead.
5. **Un solo dueño por dato y un solo productor por tipo de evento.** Los demás módulos leen vistas de solo
   lectura.
6. **Mismo código en backtest, paper, shadow y live.** Solo cambian los adaptadores de reloj, datos y
   ejecución, y solo `src/app/` los elige (ADR 0013).
7. **Un solo writer por cuenta:** una instancia del proceso principal, una cola de órdenes serializada y, en
   real, el capguard como único poseedor de la clave de trading.
8. **Tipo decimal propio sobre big.js** (ADR 0014), que se implementa en el paso 18.
9. **Límites comprobados por dependency-cruiser**, con una matriz de dependencias y una prueba de la estructura
   de `src/` (ADR 0015).

## 2. Diagrama

Modo live. En los demás modos solo cambian los extremos: la fuente de datos y el venue de ejecución (§14).

```text
 Fuentes de datos: exchange/ en paper, shadow y live · historical/ en backtest (replay)
        │ RawMarketDataReceived
 ══ PROCESO PRINCIPAL: un proceso Node, un hilo (src/) ═════════════════════════════════════
        ▼
   Market Data + Normalization   marketdata/          única entrada de datos de mercado
        │ CandleClosed, QuoteUpdated, OrderBookUpdated
        │      └──► Analytics (analytics/) ── RegimeChanged ──► Strategy Engine
        ▼
   Feature Engine                features/            float, sobre velas cerradas
        │ FeaturesComputed
        ▼
   Strategy Engine               strategy/            propone; nunca envía
        │ OrderIntentCreated
        ▼
   Portfolio/Risk Engine         portfolio/ + risk/   valora, decide y firma
        │ OrderApproved (token firmado)
        ▼
   Execution Engine              execution/           cola serializada, UNKNOWN, reconciliación
        │ SubmitOrder / CancelOrder (puerto ExecutionVenue)
        ▼
   Exchange Adapter              exchange/            único que importa ccxt
        │ lecturas (clave de lectura)    │ órdenes aprobadas, por IPC local
 ═══════│════════════════════════════════│══════════════════════════════════════════════════
        ▼                                ▼
     exchange ◄────────────────── CAPGUARD (proceso aparte, capguard/):
                órdenes (clave    clave de trading y topes propios,
                de trading)       sin código compartido con src/

 Dentro del proceso principal todo cruza por kernel/ (bus con cola FIFO, reloj, ids y vistas), y
 app/ elige reloj, datos y ejecución según el modo. En paralelo: historical/, backtest/,
 persistence/, monitoring/, registry/ y research/.
```

## 3. Procesos

| Proceso | Código | Qué hace | Claves |
|---|---|---|---|
| Principal | `src/`, arranca desde `src/app/` | Todo el pipeline, la persistencia y los avisos | Solo la de lectura (en shadow y live) |
| Capguard | `capguard/` | Envía una orden aprobada si cumple sus topes (trading-risk §3) | La única de trading |
| Comandos | `src/app/` (backtest, captura, investigación, informes) | Se ejecutan y terminan. Nunca corren dentro del proceso principal | Ninguna, o datos públicos en la captura |

**Por qué un monolito.**

- **Carga mínima.** La estrategia de tendencia usa velas de 4 h, unas 12 operaciones al año
  (`docs/research/02`) y pocos símbolos. No hay nada que repartir entre procesos.
- **Garantías más fáciles en un hilo.** Un solo writer por cuenta, la cola serializada, persistir antes de
  actuar y el orden determinista son triviales en un hilo. Entre procesos exigen bloqueos distribuidos, colas
  externas y gestionar fallos parciales.
- **`node:sqlite` encaja.** Es síncrono y de un solo escritor (`docs/research/05` §4.8 y §7.2).
- **Los sistemas de referencia hacen lo mismo** (§20). NautilusTrader procesa mensajes, estrategia, riesgo y
  caché en un solo hilo y deja fuera la red y la persistencia. Freqtrade y Hummingbot corren cada bot en un
  proceso.
- **La única separación es por seguridad.** El capguard no comparte código ni clave con el bot (ADR 0003).

**Qué no se hace:** microservicios, broker de mensajes (Redis, Kafka, NATS), hilos de trabajo dentro del
proceso principal, ni HTTP entre módulos. La investigación puede lanzar backtests en procesos hijos, cada uno
con su propio almacén y nunca con la base de datos real.

**Una instancia por máquina.** Hay una sola instancia del proceso principal por máquina, sea cual sea el modo:
el límite de peticiones es por IP y se reparte entre el bot y el capguard (exchange-execution §11). La captura
de datos no arranca si el proceso principal está activo en la misma máquina.

## 4. Módulos

### 4.1 Pipeline

| Etapa | Carpeta | Hace | No puede |
|---|---|---|---|
| Market Data | `src/marketdata/` | Suscripciones, calentamiento (warm-up), caché de mercado, instrumentos y libro de órdenes | Hablar con el exchange: lo hace `exchange/` a través de su puerto |
| Normalization | `src/marketdata/` (normalizador) | Convierte datos crudos en eventos canónicos (§4.3). Única puerta de entrada de datos de mercado | Inventar o rellenar datos |
| Feature Engine | `src/features/` | Features en float sobre ventanas de velas cerradas, con el mismo cálculo incremental en todos los modos | Importar `execution/` ni `risk/`; hacer E/S |
| Strategy Engine | `src/strategy/` | Aloja estrategias puras. Crea intenciones de estrategia, de sistema (stops de protección) y manuales (comandos) | Importar `risk/`, `execution/`, `exchange/` ni `persistence/`; hacer E/S |
| Portfolio | `src/portfolio/` | Posiciones, caja, patrimonio y PnL en `Decimal`, a partir de los fills | Enviar órdenes; corregir saldos para que cuadren |
| Risk Engine | `src/risk/` | Controles, breakers, kill switch, decisiones y firma (`src/risk/signer.ts`) | Enviar órdenes; agrandar una intención |
| Execution Engine | `src/execution/` | Verifica el token, cola de órdenes, máquina de estados, UNKNOWN, reconciliación, stops nativos y TTL | Importar ccxt ni `exchange/`; enviar sin token válido |
| Exchange Adapter | `src/exchange/` | Único que importa ccxt: REST y WebSocket, límite de peticiones, reloj del exchange, clasificación de errores, conversión a `Decimal`, pasarela al capguard y venue de shadow | Decidir si una orden sale |

### 4.2 Módulos paralelos y transversales

| Módulo | Carpeta | Hace | No puede |
|---|---|---|---|
| Historical Data | `src/historical/` | Captura, almacén point-in-time (formato en el paso 18) y lector que alimenta el replay | Abrir el test final sin el flag humano; escribirse desde el proceso principal |
| Backtesting/Replay | `src/backtest/` | Reloj simulado, venue simulado con los costes de quant-research §5, replay del diario | Usar `exchange/` o la base de datos real |
| Persistence | `src/persistence/` | Única conexión SQLite, migraciones, repositorios de cada dueño, diario de eventos y copias | Escribir una tabla para un módulo que no es su dueño |
| Analytics | `src/analytics/` | Régimen de mercado (§4.4), métricas de rendimiento y de calidad de ejecución | Crear intenciones; hacer E/S |
| Monitoring | `src/monitoring/` | Alertas por nivel, Telegram, latido externo, centinela del kill switch, estado de solo lectura y resumen diario | Importar `execution/` ni crear órdenes: un comando manual es un evento que decide Risk |
| Strategy Registry | `src/registry/` | Catálogo de estrategias, versiones, veredictos y aprobaciones por modo | Aprobar nada por su cuenta |
| Experiment Registry | `src/research/` | Registro de experimentos (quant-research §10), protocolo y estadística | Saltarse el pre-registro ni el test final |
| Capital Cap Guard | `capguard/` | Último filtro antes del exchange, en su propio proceso (trading-risk §3) | Compartir código con `src/` |
| Kernel | `src/kernel/` | Bus, sobre y catálogo de eventos, contratos de las vistas y puertos, reloj, ids, temporizadores y vigilante | Conocer el modo; importar algo que no sea `shared/` |
| Shared | `src/shared/` | `Decimal`, tiempo, errores, JSON canónico y log | Importar otros módulos; hacer E/S, salvo el log |
| Config | `src/config/` | Carga y valida la configuración y los secretos, y calcula su hash | Ser importado fuera de `app/` |
| App | `src/app/` | Composición de cada modo, bloqueo de instancia, arranque y comandos | Contener lógica de negocio |

Futuros, de los que solo se fija la interfaz (§17): `src/intel/` (`onchain/`, `news/` y `macro/`) y
`src/features/microstructure/`.

### 4.3 Normalization

- **Única puerta.** Solo el normalizador publica eventos de mercado. Los adaptadores (`exchange/`,
  `historical/`) entregan `RawMarketDataReceived` con los valores ya en `Decimal`, convertidos desde la cadena
  original (exchange-execution §17).
- **Velas.** Una vela se publica cuando cierra: `event_time` es su cierre (ccxt da la apertura), y la vela en
  curso se descarta. Las repetidas se ignoran, igual que las desordenadas, que además se registran. Un hueco
  publica `MarketDataGap`: se detecta y nunca se rellena (quant-research §3). La vela que falta se excluye sin vaciar
  la ventana, y una feature da null si le faltan más velas de las que admite su fórmula (ADR 0036).
- **Mismo instante.** Lo que llega con el mismo `received_time` (velas o cotizaciones de varios pares) se ingiere
  entero antes de evaluar ninguna vela, para que Risk valore la cartera con todo lo ya recibido (ADR 0035).
- **Libro.** Se aplican los sequence numbers. Un gap invalida el libro hasta resincronizar
  (exchange-execution §12.3), y mientras tanto la vista devuelve `null`.
- **Valores.** Un dato no válido (precio no positivo, volumen negativo, `high` por debajo de `low`) se descarta
  y se registra. Se valida igual en la captura, en el replay y en real, porque es el mismo código.

### 4.4 Régimen de mercado (Analytics)

- **Volatilidad.** Se mide la volatilidad realizada de cada símbolo y del mercado en velas cerradas, y se
  clasifica en `BAJA`, `NORMAL`, `ALTA` o `EXTREMA` según percentiles de su propia historia. Los umbrales se
  calculan solo con el pasado, en una ventana fija (desde el paso 26, ADR 0029: como las features, da lo mismo en
  backtest y en real empiece donde empiece la historia). El clasificador `regimen-precio@1` está en
  `src/analytics/regime.ts`; los tipos, en `src/kernel/regime.ts`, porque strategy/ y risk/ no importan analytics/.
- **Tendencia.** Se clasifica también en alcista, bajista o lateral, para los desgloses de quant-research §7.
- **Sin dato, `null`.** Mientras no hay historia suficiente, el régimen es `null`. Quien lo use lo trata como
  desconocido, y si su regla lo necesita, no opera.
- **Parámetros de investigación.** La medida, la ventana y los percentiles se pre-registran y cuentan en el `N`
  del DSR (quant-research §2 y §8). Cada clasificador lleva un id de versión.
- **Usos.**
  1. Desglose por régimen en la investigación.
  2. Contexto de una estrategia, solo si su pre-registro lo incluye.
  3. Riesgo, solo para apretar. Un control nuevo exige su `reason_code` y un ADR (paso 35).
  4. Informes.

## 5. Kernel: eventos, bus y reloj

### 5.1 Sobre de cada evento

Todo evento lleva: `id`, `seq` (orden de despacho en el run), `runId`, `type`, `producer`, `event_time`,
`received_time`, `source`, `correlationId`, `causationId` y `payload` (interfaz en §16.2).

| Dato | `event_time` | `received_time` en tiempo real | `received_time` en replay |
|---|---|---|---|
| Vela | Cierre de la vela | Hora local al aceptar el mensaje | `event_time` + la latencia mínima registrada para esa fuente |
| Cotización, libro | Hora del exchange | Hora local | La del diario o del histórico |
| Estado de orden, fill | Hora del exchange | Hora local | La del simulador |
| Decisión interna | Igual que `received_time` | Reloj del kernel | Reloj simulado |
| Dato externo (macro, on-chain, noticias) | Instante al que se refiere | Hora local | Hora de publicación de esa versión del dato, nunca la de descarga |

- **Invariante point-in-time.** Un handler que procesa un evento en el instante `T` solo ve datos con
  `received_time ≤ T`. Se cumple sola si las vistas solo cambian al procesar eventos y los eventos llegan en
  orden de `received_time`, que es lo que garantiza el replay.
- **Orden.** En tiempo real, el de llegada a la cola. En replay, por `received_time`; en caso de empate, por
  fuente y por el `seq` original.
- **Dos relojes.** Las marcas de negocio van en milisegundos UTC. Las duraciones se miden con el reloj monótono
  (exchange-execution §9.1).

### 5.2 Bus

1. **Una cola FIFO.** El kernel saca un evento, lo apunta en el diario y llama a sus handlers uno a uno, en el
   orden en que se registraron (lo fija `app/`). Solo después pasa al siguiente.
2. **Handlers síncronos.** El tipo `Handler` devuelve `undefined`, así que una función async no encaja, y el
   kernel lo comprueba también al ejecutar. Publicar dentro de un handler encola el evento: no lo despacha en
   ese momento.
3. **Un productor por tipo de evento** en cada run. Cada módulo recibe un `Publisher` con su identidad, y el
   kernel rechaza que publique un tipo que no le corresponde (invariante, §13).
4. **Eventos inmutables.** Se congelan al publicarse. El `ApprovedOrder` llega a Execution exactamente como lo
   firmó Risk.
5. **E/S en los adaptadores.** Un handler llama a un puerto de salida que no bloquea (`ExecutionVenue.submit`,
   `MarketDataFeed.start`…), y el resultado vuelve más tarde como evento, con su `causationId`. **Ningún
   callback asíncrono toca estado**: solo publica.
6. **Lecturas en memoria** a través de vistas de solo lectura del dueño (`MarketView`, `PortfolioView`,
   `ExecutionView`, `VenueHealthView` y `RiskView`), que devuelven instantáneas inmutables.
7. **Temporizadores.** El reloj los dispara como `TimerFired`. El kernel publica cada cierto tiempo un
   `CycleTick` con las tareas periódicas: frescura de datos, TTL, reconciliación pendiente y métricas. Cuando se
   han despachado sus handlers, publica `CycleCompleted`.
8. **Vigilante.** Mide el retraso del bucle de eventos y la duración de cada despacho. Si se pasa, Execution
   entra en UNKNOWN y se avisa (exchange-execution §15).

### 5.3 Reloj, ids y azar

- **`Clock`.** `SystemClock` en tiempo real y `SimulatedClock` en backtest y replay. El simulado avanza hasta el
  `received_time` del siguiente evento o temporizador.
- **`Ids`.** UUID aleatorio en tiempo real: el `approval_id` es el nonce del token. Secuencia con semilla en
  backtest y replay.
- **`Rng`.** Con semilla registrada (quant-research §6). Solo en backtest e investigación.
- **Sin atajos.** Ningún módulo llama a `Date.now()`, `new Date()` sin argumentos, `setTimeout`, `setInterval`
  ni `Math.random`: los recibe del kernel. Lo hace cumplir una regla de ESLint desde el paso 19, que creó
  `src/kernel/` (ADR 0021). Solo `kernel/system-clock.ts` lee el reloj del sistema.

## 6. Catálogo de eventos

El catálogo es cerrado: un evento nuevo exige añadirlo aquí, en `src/kernel/` y en sus pruebas.

- **Actúa:** el módulo que cambia su estado por el evento. Los demás solo observan. `persistence/` escribe el
  diario y `monitoring/` deriva alertas de todos los eventos.
- **Productor «adaptador»:** según el modo, `exchange/` (shadow y live), `backtest/` (backtest y paper) o
  `historical/` (replay). Siempre hay uno solo por run.

| Evento | Productor | Actúa | `event_time` | Diario |
|---|---|---|---|---|
| `RawMarketDataReceived` | adaptador | marketdata | origen | velas sí; cotizaciones muestreadas; libro no |
| `CandleClosed` | marketdata | features, analytics | cierre de la vela | sí |
| `QuoteUpdated` | marketdata | (vista de mercado) | exchange | muestreado |
| `OrderBookUpdated` | marketdata | (vista de mercado) | exchange | no |
| `OrderBookStateChanged` | marketdata | — | local | sí |
| `InstrumentsUpdated` | marketdata | — | exchange | sí |
| `MarketDataGap` | marketdata | features | local | sí |
| `FeaturesComputed` | features | strategy | cierre de la vela | sí |
| `RegimeChanged` | analytics | strategy | cierre de la vela | sí |
| `StrategyEvaluated` | strategy | — | cierre de la vela | sí |
| `OrderIntentCreated` | strategy | risk | creación | sí |
| `RiskDecisionMade` | risk | — | decisión | sí, y `risk_decisions` |
| `OrderApproved` | risk | execution | decisión | sí |
| `BreakerChanged` | risk | — | local | sí |
| `KillSwitchChanged` | risk | execution (cancela las pendientes) | local | sí |
| `TradingStateChanged` | risk | — | local | sí |
| `ExecutionRejected` | execution | risk (lo registra; un rechazo del capguard activa el kill switch) | local | sí |
| `OrderStateChanged` | execution | — | exchange o local | sí, y `order_transitions` |
| `FillRecorded` | execution | portfolio | exchange | sí, y `fills` |
| `ExecutionModeChanged` | execution | risk | local | sí |
| `ReconciliationCompleted` | execution | risk | local | sí |
| `ProtectiveStopStatus` | execution | strategy (stop que falta), risk | local | sí |
| `ForeignOrderDetected` | execution | risk | local | sí |
| `PortfolioUpdated` | portfolio | — | local | sí |
| `VenueOrderUpdate` | adaptador | execution | exchange | sí |
| `VenueRequestFailed` | adaptador | execution | local | sí |
| `AccountSnapshotReceived` | adaptador | execution | exchange | sí |
| `ExchangeHealthChanged` | adaptador | risk | local | sí |
| `ClockSkewMeasured` | adaptador | risk | local | sí |
| `StreamStatusChanged` | `exchange/` | execution (canal privado), marketdata (público) | local | sí |
| `CapguardStatusChanged` | `exchange/` | risk, execution | local | sí |
| `OperatorCommandReceived` | monitoring | risk (pausa, rearme, kill switch), strategy (orden manual) | local | sí |
| `AlertRaised` | monitoring | — | local | sí |
| `TimerFired`, `CycleTick`, `CycleCompleted` | kernel | quien programó el temporizador; todos (tick); monitoring (latido) | programada | no |
| `HealthSnapshot` | kernel | — | local | sí |
| `SystemStarted`, `SystemStopping` | app | — | local | sí |
| `ExternalObservationReceived`, `RiskBrakeUpdated` | `intel/` (futuro) | features, risk | origen | sí |
| `MicrostructureUpdated` | `features/` (futuro) | strategy, risk | exchange | sí |

- `ForeignOrderDetected` cubre las órdenes huérfanas con el prefijo del bot y las manuales sin él
  (exchange-execution §14.2).
- Los rechazos de cualquier capa se guardan en `risk_decisions`, cuyo único dueño es Risk. Execution publica
  `ExecutionRejected` y Risk lo registra. Si el proceso cae entre las dos cosas, el rechazo sigue en el diario.

## 7. Propiedad del estado

Cada dato tiene un único dueño, que es el único que lo escribe. Los demás lo leen por su vista o lo reciben
por eventos.

| Dato | Dueño | Lo leen | Dónde se guarda |
|---|---|---|---|
| Velas recientes, cotizaciones, libros, volumen de 24 h e instrumentos | marketdata | features, risk, execution, portfolio (`MarketView`) | Memoria; instrumentos, también en el diario |
| Features | features | strategy | Diario |
| Régimen | analytics | strategy, risk (solo para apretar) | Diario |
| Estado de cada estrategia (máximo desde la entrada, stop vigente) | strategy | — | `strategy_state` |
| Intenciones | strategy (inmutables) | risk | Diario y `risk_decisions` |
| Decisiones, breakers, kill switch, máximo de patrimonio y patrimonio al inicio del día | risk | todos (`RiskView`) | `risk_decisions` (solo inserción), `risk_state` |
| Órdenes, transiciones, fills, tokens usados, stops nativos, modo UNKNOWN, reconciliaciones y símbolos bloqueados | execution | risk, portfolio, strategy (`ExecutionView`) | `orders`, `order_transitions`, `fills`, `approvals_used`, `protective_stops`, `reconciliations` |
| Posiciones, caja, patrimonio, PnL y polvo | portfolio | risk, strategy, monitoring (`PortfolioView`) | `positions`, `portfolio_snapshots` |
| Salud del exchange, desfase de reloj, conexiones y pausa por 429/418 | exchange (o el simulador) | risk, execution (`VenueHealthView`) | Diario |
| Configuración y su hash | config (inmutable tras arrancar) | cada módulo recibe su sección | `runs` |
| Diario de eventos | persistence | replay, informes | `events` |
| Alertas enviadas | monitoring | — | `alerts` |
| Histórico de mercado | historical (comando de captura) | backtest, research | `data/historical/` |
| Registro de experimentos | research | registry, informes | `docs/research/experiments/registry.jsonl` |
| Registro de estrategias | registry (aprobaciones humanas) | app | `docs/research/strategies/registry.jsonl` |
| Topes y estado del capguard | capguard | nadie del proceso principal | Su propio archivo, de otro usuario del sistema (paso 39) |

## 8. Flujo de una orden

La orquestación que trading-risk §2.1 llama `engine` es aquí el kernel más la composición de `app/`. Nadie toca
el `ApprovedOrder` por el camino, porque viaja congelado dentro de `OrderApproved`.

1. `CandleClosed` → Feature Engine → `FeaturesComputed`.
2. **Strategy Engine.** Arma la entrada de la estrategia: features, régimen, y la posición vista por portfolio
   más el estado de la estrategia. Llama a `evaluate` y publica `StrategyEvaluated`. Si la estrategia quiere
   entrar, convierte su stop de float a `Decimal` con redondeo explícito y publica `OrderIntentCreated`
   (entrada, dimensionada por riesgo).
3. **Risk.** Aplica los controles en el orden de trading-risk §9.3 con las vistas. Guarda la decisión antes de
   responder y publica `RiskDecisionMade`. Si aprueba o reduce, publica también `OrderApproved` con el token
   firmado.
4. **Execution, al recibir el token.** Verifica el token en el orden de trading-risk §2.2. Comprueba el modo
   UNKNOWN, las órdenes huérfanas y la pausa por límite de peticiones, redondea con las reglas del mercado
   (exchange-execution §7) y pone la orden en la cola.
5. **Execution, al sacarla de la cola.** En una transacción, marca el token como usado y crea la orden en
   `PENDING_SEND` (exchange-execution §5.2). La pasa a `SENT` y llama a `venue.submit`. En live, `exchange/`
   la entrega por IPC al capguard, que aplica sus topes y la envía con su clave.
6. `VenueOrderUpdate` o `VenueRequestFailed` → transiciones de la máquina de estados. Cualquier duda lleva a
   UNKNOWN (exchange-execution §3).
7. `FillRecorded` → Portfolio → `PortfolioUpdated`.
8. **Stop de protección.** Si una posición no tiene su stop nativo confirmado, `ProtectiveStopStatus` lo
   indica. El Strategy Engine propone entonces el stop como intención de sistema, `reduce_only`, que hace el
   mismo camino (trading-risk §2.4).
9. **Salida.** Es una intención `reduce_only` con el camino corto de Risk (trading-risk §9.3). Execution ejecuta
   el plan aprobado: cancela el stop nativo, espera la confirmación y vende lo que queda (exchange-execution
   §8).
10. **Kill switch.** Lo activa Risk ante `OperatorCommandReceived`, un rechazo del capguard, errores de
    credenciales repetidos o un fallo al persistir una decisión. Publica `KillSwitchChanged`, y Execution
    cancela las órdenes propias pendientes salvo los stops de protección (trading-risk §6).

## 9. Concurrencia

- **Un hilo, un handler cada vez.** No hay estado mutable compartido entre módulos ni locks. La E/S asíncrona
  vive en los adaptadores.
- **Un solo writer por cuenta.**
  1. **Instancia única.** Hay un bloqueo de instancia única por máquina para el proceso principal. Si no se
     puede comprobar que la instancia anterior terminó, no arranca. Eso corrige el fallo de `EPERM` del
     `main.ts` actual (paso 32).
  2. **Cola de órdenes serializada en Execution.** Hay una sola operación con el venue en vuelo cada vez, y la
     siguiente empieza cuando la anterior tiene un resultado definitivo o el sistema entra en UNKNOWN.
     - **Prioridades:** cancelaciones del kill switch y de UNKNOWN, después stops de protección, después
       salidas y por último entradas. Dentro de cada prioridad, orden de llegada.
     - **En UNKNOWN** la cola se para, salvo las excepciones de exchange-execution §3.2.
     - **Una aprobación que caduca en la cola** se rechaza con `APPROVAL_EXPIRED`.
     - **La cola no se persiste:** los tokens no sobreviven a un reinicio.
  3. **En real,** el capguard es el único con la clave de trading y serializa sus envíos.
  4. **Paper, shadow y backtest no transmiten** al exchange.
  5. **La subcuenta es exclusiva del bot.** Una orden ajena se detecta al reconciliar (trading-risk §2.1).
- **Un solo escritor por base de datos.** Hay una conexión, en `persistence/`, y cada tabla tiene su dueño.
  Otros procesos solo leen (WAL).
- **Backtests en paralelo** en procesos distintos, cada uno con su propio almacén.

## 10. Persistencia

| Qué | Dónde | Formato | Dueño |
|---|---|---|---|
| Estado operativo y auditoría | `data/live.db`, `data/paper.db`, `data/shadow.db`: una base por modo | SQLite en WAL con `synchronous=FULL`. Migraciones con `user_version`, solo hacia delante | persistence (conexión); cada tabla, su módulo (§7) |
| Diario de eventos | Tabla `events` de la base del modo | Solo inserción: `seq`, run, tipo, productor, `event_time`, `received_time`, correlación y payload en JSON | persistence |
| Backtest y replay | Almacén en memoria o temporal de cada run | Los mismos puertos | backtest |
| Histórico de mercado | `data/historical/` (Parquet con DuckDB, ADR 0020) | Sin float para precios ni cantidades. Manifiesto con fuente, rango, captura y hash. Nunca se reescribe: se añaden versiones | historical |
| Test final | `data/holdout/` y `config/holdout.lock` | Solo con flag humano (`CLAUDE.md` §2): token `HOLDOUT_UNLOCK` firmado por la persona (ADR 0020) | historical (lector con guarda) |
| Registro de experimentos | `docs/research/experiments/registry.jsonl` | JSONL solo de inserción en JSON canónico, encadenado por SHA-256 y versionado en git (quant-research §10; ADR 0024, paso 21: no migra a una base de datos) | research |
| Registro de estrategias | `docs/research/strategies/registry.jsonl` | JSONL solo de inserción, versionado en git | registry |
| Capguard | Su propio archivo | Lo decide su paso | capguard |
| Logs técnicos | Salida estándar y tabla `logs` | Retención limitada (paso 39) | persistence |

- **Decimales** como `TEXT` en forma canónica (ADR 0014); marcas de tiempo como `INTEGER` en milisegundos UTC;
  nunca `REAL` para dinero (prueba del paso 33).
- **Persistir antes de actuar.** La decisión de riesgo se guarda antes de responder, y la orden, antes de
  enviarla. Cada cambio de estado va en una transacción.
- **Solo inserción**, con triggers que abortan `UPDATE` y `DELETE`: `events`, `risk_decisions`,
  `order_transitions`, `fills`, `approvals_used` y `alerts`. Las tablas de auditoría no se borran nunca.
- **Copias.** `backup()` diario y antes de cada actualización, guardadas fuera de la máquina, con
  `integrity_check` y un ensayo de restauración (`docs/research/05` §4.8; paso 39).

## 11. Arranque y recuperación

Cada paso del arranque es *fail closed*: si falla, el proceso no sigue.

1. Toma el bloqueo de instancia.
2. Carga la configuración y los secretos, con su hash y el commit. Si algo es inválido: `CONFIG_INVALID`, y no
   arranca.
3. Abre la base del modo, migra y ejecuta `quick_check`. Si la base viene de una copia restaurada, hace falta la
   revisión de una persona antes de operar (exchange-execution §16). Publica `SystemStarted`.
4. Restaura el estado de cada dueño: kill switch y breakers (risk); órdenes no terminales, tokens usados y stops
   nativos (execution); posiciones (portfolio); estado de las estrategias (strategy).
5. Execution arranca **siempre en UNKNOWN**.
6. Risk genera un par de claves Ed25519 nuevo y entrega la pública a Execution. En live, saludo con el
   capguard: versión del protocolo y clave pública. Si no responde, `CAP_UNAVAILABLE`.
7. `exchange/` carga los mercados y mide la salud y el desfase del reloj. En shadow y live comprueba los
   permisos de la clave: si permite retiros, margen o futuros, o no tiene restricción de IP, `CONFIG_INVALID`
   (trading-risk §3).
8. Reconciliación completa (exchange-execution §14.2 y §16). Si cuadra, sale de UNKNOWN.
9. Suscripciones, sincronización de libros y calentamiento con velas cerradas, igual que en el backtest.
10. Comprueba las estrategias en el registro, por hash de código y aprobación para el modo, y solo entonces las
    activa.

**Después de una caída.**

- Nada depende de un cierre limpio. Se repite la misma secuencia, y la tabla `runs` registra que la salida
  anterior no fue limpia.
- **Bucle de caídas.** Con 3 salidas no limpias en 60 min (valor provisional; el supervisor y su política de
  reinicios son del paso 39), el arranque activa el kill switch.
- **Capguard caído.** Ninguna orden sale (`CAP_UNAVAILABLE`). Cuando vuelve, se repite el saludo.
- **Diagnóstico.** `backtest/` puede reproducir los eventos de entrada de un diario y comprobar que salen las
  mismas decisiones.

## 12. Observabilidad

- **Tres niveles: INFO, WARNING y CRITICAL** (exchange-execution §20), los mismos para las alertas y para el log.
  DEBUG solo en desarrollo, y no se persiste. Al pasar `log.ts` a `shared/`, sus niveles `info`, `warn` y
  `error` cambian a estos (exchange-execution §18).
- **Las alertas se derivan de hechos.** `monitoring/` traduce eventos en alertas con una tabla fija, que incluye
  como mínimo los CRITICAL de exchange-execution §20. Ningún otro módulo elige canal. Un CRITICAL nunca se
  rebaja; los WARNING se agrupan; los INFO van al resumen.
- **Canales.** El Telegram del bot, el Telegram propio del capguard y un vigilante externo. El latido al
  vigilante se envía con `CycleCompleted`, al final de cada ciclo completo (exchange-execution §15).
- **Trazabilidad.**
  - `correlationId` es el `intent_id` y une decisión, token, orden, fills y posición.
  - Cada línea de log lleva módulo, evento y correlación, con los secretos tachados.
  - Cada decisión de riesgo guarda los valores y las marcas de tiempo de los datos que usó (trading-risk §9.1).
- **Métricas como eventos `HealthSnapshot`.** Retraso del bucle, duración del ciclo, eventos y órdenes en cola,
  edad de la orden en vuelo, edad de cada dato y de la última reconciliación, estado de los WebSockets, peso
  usado del límite de peticiones, desfase del reloj y latencia del capguard. No hay un sistema de métricas
  externo.
- **Consultas.** El diario y las tablas, en SQLite. El estado de solo lectura y el resumen diario llegan por
  Telegram (paso 41).

## 13. Errores y fail closed

| Situación | Efecto |
|---|---|
| Dato de mercado no válido | Se descarta y se registra. Un hueco se excluye sin rellenar: la feature a la que faltan más velas de las que admite su fórmula da null, y sin ella no hay señal (ADR 0036) |
| Dato de cuenta u orden que no se entiende | UNKNOWN (exchange-execution §3.1) |
| Lectura que falla por la red o el exchange | Reintento con backoff (exchange-execution §10). Si se agota, cuenta para la salud del exchange |
| Duda al enviar, cancelar o sustituir | UNKNOWN |
| Control que lanza o no se puede evaluar | Rechazo con `INTERNAL_ERROR` o control suspendido (trading-risk §8) |
| 429 o 418 | Pausa y `EXCHANGE_UNHEALTHY`. El 418 lleva además a UNKNOWN y CRITICAL (exchange-execution §11) |
| Credenciales rechazadas repetidamente, firma inválida, token reutilizado o rechazo del capguard | Kill switch (trading-risk §6) |
| No se puede persistir una decisión | Rechazo con `DECISION_LOG_UNAVAILABLE` y kill switch |
| No se puede escribir el diario, o el kernel detecta un uso indebido (handler async, productor ajeno) | Invariante rota (fila siguiente) |
| Excepción que escapa de un handler del camino de la orden (kernel, persistence, portfolio, risk, execution) | **Invariante rota:** se persiste el kill switch si se puede, CRITICAL, y el proceso sale con código distinto de 0. El supervisor lo reinicia (§11) |
| Excepción en una estrategia | Esa estrategia queda desactivada hasta reiniciar, con CRITICAL. Sus posiciones siguen protegidas por los stops nativos |
| Excepción en analytics, monitoring o intel | WARNING y módulo degradado. Si un control necesitaba su dato, cuenta como suspendido |
| Bucle colgado | UNKNOWN y alerta (exchange-execution §15) |
| Configuración incompleta o inválida | No arranca (`CONFIG_INVALID`) |

Lo que ya resuelven los skills (`INTERNAL_ERROR`, UNKNOWN) se trata como dicen ellos. Solo lo que escapa de
esos caminos es una invariante rota. Nada de `catch` vacíos: cada error se clasifica, se registra y, si es un
rechazo, lleva su `reason_code`.

## 14. Mismo código en backtest, paper, shadow y live

| Modo | Reloj | Datos | Ejecución | Cuenta | Capguard | Base de datos | Para qué |
|---|---|---|---|---|---|---|---|
| backtest | `SimulatedClock` | `historical/`, en orden de `received_time` | `SimulatedVenue` (`backtest/`) con los costes de quant-research §5 y el peor caso dentro de la vela | Simulada | No | Del run | Investigación |
| paper | `SystemClock` | `exchange/` (solo lectura) | `SimulatedVenue` con precios en vivo | Simulada, con el capital inicial de la configuración | No | `data/paper.db` | Validar la ejecución, no la ventaja (quant-research §11) |
| shadow | `SystemClock` | `exchange/` (solo lectura) | `ShadowVenue` (`exchange/`): lee la cuenta real con la clave de lectura y no transmite; cada orden termina en `NOT_SENT` | Real, solo lectura | No | `data/shadow.db` | Validar todo el camino real salvo el envío: cuenta, permisos, reconciliación, reloj, límites y datos |
| live | `SystemClock` | `exchange/` (solo lectura) | `LiveVenue` (`exchange/`): envío por IPC al capguard y lecturas con la clave de lectura | Real | Sí | `data/live.db` | Operar. Activarlo es una parada obligatoria (`CLAUDE.md` §7) |

- **Solo `src/app/` sabe el modo.** Los módulos no lo reciben, no lo consultan y no tienen `if (modo)`. Cambian
  solo los adaptadores de reloj (`Clock`), datos (`MarketDataFeed`) y ejecución (`ExecutionVenue` y
  `VenueHealthView`); la cuenta forma parte del adaptador de ejecución.
- **Mismo cálculo de features en todos los modos**, incremental y vela a vela. No hay un cálculo vectorizado
  propio del backtest: esa diferencia es el origen del look-ahead de Freqtrade (REFERENCE_SYSTEMS.md §6).
- **Determinismo.** Con los mismos datos, configuración, commit y semillas, dos ejecuciones dan el mismo diario.
  La prueba es obligatoria en cuanto exista el kernel. Desde el paso 19, la del motor de replay
  (`src/backtest/replay.ts`, ADR 0021) compara el SHA-256 del diario entre ejecuciones y procesos, y contra un hash
  fijado; cuando exista el bus, se extiende a su diario.
- **Lo que el backtest no puede ejercitar,** y por eso existen shadow y paper:
  - el libro real: los controles de libro usan el spread y el slippage supuestos del modelo de costes, con su
    mínimo conservador;
  - los WebSockets, los límites de peticiones, el reloj y la reconciliación con el exchange: el simulador
    responde siempre sano.
- **`LIVE_TRADING`.** Solo `app/` construye `LiveVenue`, y solo con la confirmación de trading-risk §8; sin
  ella, el modo live no arranca. `LiveVenue` la comprueba otra vez y, si falta, rechaza con
  `LIVE_TRADING_DISABLED`.
- **Registro de estrategias.** En paper, shadow y live solo se carga una estrategia aprobada para ese modo y con
  el mismo hash de código que se aprobó.
- **Testnet.** Es una variante de live con el entorno de pruebas del exchange: se configura en el adaptador, no
  es un modo.

## 15. Límites

### 15.1 Matriz de dependencias

La comprueba dependency-cruiser (`npm run boundaries`, ADR 0015). Cada módulo solo puede importar, dentro de
`src/`, los de su fila. Los `import type` cuentan igual.

| Módulo | Puede importar de `src/` |
|---|---|
| `shared/` | — |
| `kernel/` | `shared/` |
| `marketdata/`, `features/`, `portfolio/`, `risk/` | `shared/`, `kernel/` |
| `exchange/`, `historical/`, `backtest/`, `persistence/`, `registry/`, `intel/` | `shared/`, `kernel/` |
| `analytics/` | `shared/`, `kernel/`, `features/` |
| `strategy/` | `shared/`, `kernel/`, `features/` |
| `execution/` | `shared/`, `kernel/` y solo `src/risk/approval.ts` de `risk/` (tipo y verificación del token) |
| `monitoring/` | `shared/`, `kernel/`, `analytics/` |
| `research/` | `shared/`, `kernel/`, `analytics/`, `registry/` |
| `config/` | todo menos `app/` (los tipos de la sección de cada módulo) |
| `app/` | todo |

Además:

- `shared/`, `kernel/`, `marketdata/`, `features/`, `analytics/`, `strategy/`, `portfolio/`, `risk/` y
  `execution/` son el **dominio**: no importan módulos de E/S de Node (`fs`, `net`, `http`, `child_process`,
  `sqlite`…) ni paquetes de npm. La única excepción será `src/shared/decimal.ts`, que envuelve big.js.
- Solo `exchange/` importa ccxt; solo `risk/` importa el firmante; el capguard y `src/` no se importan entre sí
  (reglas anteriores, ADR 0001 y ADR 0003).
- Solo `persistence/` importa `node:sqlite`.
- En el paso 18: solo `src/shared/decimal.ts` y `capguard/decimal.ts` importan big.js (ADR 0014).
- **Excepciones transitorias del código previo** (ADR 0015), que se quitan al reescribir esos archivos:
  - `src/strategy/trend.ts` puede importar `src/config.ts`, `src/indicators.ts` y `src/types.ts`;
  - `src/store.ts` puede importar `node:sqlite` hasta el paso 33.

  La de `src/backtest/sim.ts` desapareció con ese archivo en el paso 23.
- `test/enforcement/layout.test.ts` comprueba que cada carpeta de primer nivel de `src/` es un módulo de esta
  tabla, que la raíz de `src/` solo tiene archivos del código previo y que cada módulo tiene su regla.

### 15.2 En tiempo de ejecución

- **Eventos.** Un productor por tipo, eventos congelados y vistas que devuelven instantáneas inmutables.
- **Token.** `ApprovedOrder` es un tipo marcado que solo da `src/risk/approval.ts` al verificar la firma
  (trading-risk §2.3). Un `as ApprovedOrder` fuera de `risk/` se rechaza en revisión.
- **Composición.** `app/` nunca entrega a Strategy, Analytics ni Monitoring un objeto con el que se pueda enviar
  una orden. El análisis de imports no lo ve, y por eso lo comprueba una prueba de la composición cuando exista
  `app/`.

### 15.3 Procesos, secretos y LLM

- **Claves.** La de trading solo la tiene el capguard; el proceso principal tiene la de lectura. Solo
  `config/` lee los secretos, y `app/` entrega cada uno al adaptador que lo usa: la clave de lectura a
  `exchange/`, y el token de Telegram y la URL del latido a `monitoring/`.
- **LLM y noticias.** Solo producen un `RiskBrake`, que reduce o bloquea y nunca relaja; jamás una intención
  (trading-risk §1.6). Toda salida de LLM se registra según quant-research §12. La regla
  `llm-y-news-no-execution-ni-exchange` sigue activa.

## 16. Interfaces TypeScript

Son el contrato de partida: cada paso las pasa a `src/` y las ajusta con sus pruebas. Un cambio que rompa un
contrato entre módulos va a un ADR. Siguen las limitaciones del TypeScript nativo de Node: nada de `enum`, uniones
de literales en su lugar, e `import type` para los tipos (`docs/research/05` §7.3).

**Desde el paso 20** ([ADR 0023](docs/adr/0023-risk-y-execution-minimos.md)), los contratos de §16.5 a §16.8 que
cruzan módulos están en código:

- **Dónde.** En `src/kernel/`: `orders.ts`, `portfolio.ts`, `execution.ts`, `stores.ts` y `reason-codes.ts`. `Side` y
  `Bucket` van en `src/shared/trading.ts`.
- **Ajustes** respecto a lo escrito aquí:
  - `ReasonCode` es la unión cerrada del catálogo;
  - `RiskStore.appendDecision` recibe un `DecisionRecord` con los campos de trading-risk §9.1;
  - `ExecutionStore` tiene `isApprovalUsed`;
  - `ExecutionRejected`, `OrderTransition` y `VenueOrderUpdate` llevan algunos campos más.

  Desde el paso 23, `AccountSnapshot` es la respuesta de `requestAccountSnapshot` (saldos, órdenes y fills),
  `RawMarketData` está en `src/kernel/market-data.ts`. Desde el paso 26, `StrategyInput.regime` es el del propio
  símbolo a la misma vela (ADR 0029). El token lleva `trigger_price`, el disparo firmado de un stop de protección (`null` en el
  resto). El código manda sobre los extractos de abajo.

### 16.1 Tipos base (`src/shared/`)

```ts
export type UtcMillis = number; // milisegundos desde epoch, UTC, enteros
export type SymbolId = string; // símbolo unificado: 'BTC/USDT'
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type Side = 'buy' | 'sell';
export type Bucket = 'core' | 'scout';
// Decimal y Rounding: ADR 0014. Precio, cantidad e importe son alias que solo documentan.
export type Price = Decimal;
export type Quantity = Decimal;
export type Notional = Decimal;
```

### 16.2 Kernel (`src/kernel/`)

```ts
export type ModuleId =
  | 'kernel' | 'marketdata' | 'features' | 'analytics' | 'strategy' | 'portfolio' | 'risk' | 'execution'
  | 'exchange' | 'historical' | 'backtest' | 'persistence' | 'monitoring' | 'registry' | 'research'
  | 'intel' | 'app';

export type EventSource = 'exchange-rest' | 'exchange-ws' | 'replay' | 'simulator' | 'internal' | 'operator';

export interface EventEnvelope<T extends EventType = EventType> {
  readonly id: string; // UUID en real; secuencia con semilla en backtest y replay
  readonly seq: number; // orden de despacho dentro del run
  readonly runId: string;
  readonly type: T;
  readonly producer: ModuleId; // el único productor de T en este run
  readonly eventTime: UtcMillis; // event_time: cuándo ocurrió en origen
  readonly receivedTime: UtcMillis; // received_time: cuándo lo tuvo el sistema (§5.1)
  readonly source: EventSource;
  readonly correlationId: string | null; // intent_id a lo largo de decisión, orden y fills
  readonly causationId: string | null; // evento que lo provocó
  readonly payload: EventPayloads[T];
}

// Catálogo cerrado (§6). Extracto: cada evento de §6 tiene aquí su payload.
export interface EventPayloads {
  RawMarketDataReceived: RawMarketData;
  CandleClosed: { readonly candle: Candle };
  FeaturesComputed: FeatureVector;
  RegimeChanged: RegimeView;
  StrategyEvaluated: { readonly strategyId: string; readonly symbol: SymbolId; readonly decision: StrategyDecision };
  OrderIntentCreated: OrderIntent;
  RiskDecisionMade: RiskDecision;
  OrderApproved: { readonly approval: SignedApproval };
  ExecutionRejected: { readonly approvalId: string | null; readonly intentId: string | null; readonly layer: 'execution' | 'capguard' | 'exchange'; readonly reasonCode: ReasonCode; readonly detail: string };
  OrderStateChanged: OrderTransition;
  FillRecorded: Fill;
  ExecutionModeChanged: { readonly mode: ExecutionMode; readonly reason: string };
  VenueOrderUpdate: VenueOrderUpdate;
  VenueRequestFailed: VenueRequestFailed;
  OperatorCommandReceived: OperatorCommand;
  // … el resto de §6
}
export type EventType = keyof EventPayloads;

export type Handler<T extends EventType> = (event: EventEnvelope<T>) => undefined; // síncrono

export interface PublishMeta {
  readonly eventTime: UtcMillis;
  readonly source: EventSource;
  readonly correlationId?: string;
  readonly causationId?: string;
}
export interface Publisher {
  publish<T extends EventType>(type: T, payload: EventPayloads[T], meta: PublishMeta): EventEnvelope<T>;
}
export interface Bus {
  publisherFor(module: ModuleId): Publisher; // rechaza tipos que ese módulo no produce
  subscribe<T extends EventType>(module: ModuleId, type: T, handler: Handler<T>): void; // orden de registro = orden de llamada
}

export interface Clock {
  now(): UtcMillis; // reloj de pared, UTC
  monotonic(): number; // milisegundos monótonos, solo para duraciones
  schedule(at: UtcMillis, timerId: string): void; // vence como TimerFired
  cancel(timerId: string): void;
}
export interface Ids { next(): string }
export interface Rng { next(): number } // [0, 1), con semilla
```

### 16.3 Datos de mercado (`src/marketdata/`, contratos en `src/kernel/`)

```ts
export interface Candle {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  readonly openTime: UtcMillis;
  readonly closeTime: UtcMillis;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume: Quantity;
}
export interface QuoteSnapshot {
  readonly symbol: SymbolId;
  readonly bid: Price;
  readonly ask: Price;
  readonly bidSize: Quantity;
  readonly askSize: Quantity;
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
}
export interface BookLevel { readonly price: Price; readonly quantity: Quantity }
export interface BookSnapshot {
  readonly symbol: SymbolId;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly eventTime: UtcMillis;
  readonly receivedTime: UtcMillis;
}
export interface Instrument {
  readonly symbol: SymbolId;
  readonly base: string;
  readonly quote: string;
  readonly tradable: boolean; // spot, activo y sin anuncio de deslistado ni suspensión
  readonly priceStep: Price;
  readonly quantityStep: Quantity;
  readonly minQuantity: Quantity; // un límite que falta es un error (docs/CCXT.md §2)
  readonly minNotional: Notional;
  readonly asOf: UtcMillis;
}

// Del adaptador al normalizador: valores ya en Decimal, todavía sin validar.
export type RawMarketData =
  | { readonly kind: 'candle'; readonly candle: Candle; readonly closed: boolean }
  | { readonly kind: 'quote'; readonly quote: QuoteSnapshot }
  | { readonly kind: 'book'; readonly book: BookSnapshot; readonly sequence: string | null; readonly isSnapshot: boolean }
  | { readonly kind: 'volume24h'; readonly symbol: SymbolId; readonly quoteVolume: Notional; readonly eventTime: UtcMillis }
  | { readonly kind: 'instruments'; readonly instruments: readonly Instrument[] };

// Puerto de datos: lo implementan exchange/ (tiempo real) y historical/ (replay). Publica RawMarketDataReceived.
export interface Subscription {
  readonly symbol: SymbolId;
  readonly channel: 'candles' | 'quote' | 'book' | 'volume24h';
  readonly timeframe?: Timeframe;
  readonly warmupBars?: number; // velas cerradas previas que hay que entregar antes de las nuevas
}
export interface MarketDataFeed {
  start(subscriptions: readonly Subscription[]): void;
  stop(): void;
}

// Vista de solo lectura del dueño (marketdata).
export interface MarketView {
  instrument(symbol: SymbolId): Instrument | null;
  quote(symbol: SymbolId): QuoteSnapshot | null;
  book(symbol: SymbolId): BookSnapshot | null; // null mientras el libro no esté sincronizado
  volume24h(symbol: SymbolId): { readonly quoteVolume: Notional; readonly eventTime: UtcMillis } | null;
}
```

### 16.4 Features y Analytics (`src/features/`, `src/analytics/`)

```ts
// Velas cerradas hasta asOf inclusive, en float: solo para análisis (exchange-execution §17).
export interface CandleWindow {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  readonly asOf: UtcMillis;
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
  readonly volume: readonly number[];
}
// Paso 22 (ADR 0025): ventana fija de warmupBars velas contiguas, el timeframe en el conjunto y computedAt.
export interface FeatureDefinition {
  readonly id: string;
  readonly version: number;
  readonly formula: string;
  readonly window: number; // velas que lee la fórmula
  readonly warmupBars: number; // las mismas velas de calentamiento en todos los modos
  readonly missingData: string;
  compute(window: CandleWindow): number | null; // recibe exactamente warmupBars velas
}
export interface FeatureSet {
  readonly id: string;
  readonly version: number;
  readonly timeframe: Timeframe;
  readonly features: readonly FeatureDefinition[];
}
export interface FeatureVector {
  readonly symbol: SymbolId;
  readonly timeframe: Timeframe;
  readonly asOf: UtcMillis; // cierre de la última vela usada
  readonly computedAt: UtcMillis; // solo se usan velas con received_time ≤ computedAt
  readonly featureSetId: string;
  readonly featureSetVersion: number;
  readonly values: Readonly<Record<string, number | null>>;
}

export type VolatilityRegime = 'BAJA' | 'NORMAL' | 'ALTA' | 'EXTREMA';
export type TrendRegime = 'ALCISTA' | 'BAJISTA' | 'LATERAL';
export interface RegimeView {
  readonly scope: SymbolId | 'mercado';
  readonly timeframe: Timeframe;
  readonly asOf: UtcMillis;
  readonly volatility: VolatilityRegime | null; // null: sin historia suficiente
  readonly trend: TrendRegime | null;
  readonly classifierId: string; // versión del clasificador: cuenta como parámetro (§4.4)
}
export interface RegimeClassifier {
  readonly id: string;
  readonly warmupBars: number;
  classify(window: CandleWindow): Pick<RegimeView, 'volatility' | 'trend'>; // umbrales solo con el pasado
}
```

### 16.5 Strategy (`src/strategy/`)

```ts
export interface PositionView { // vista de análisis, en float
  readonly quantity: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly highestPrice: number;
}
export interface StrategyInput<P> {
  readonly asOf: UtcMillis;
  readonly symbol: SymbolId;
  readonly features: FeatureVector;
  readonly regime: RegimeView | null;
  readonly position: PositionView | null;
  readonly params: Readonly<P>;
}
export type StrategyDecision =
  | { readonly action: 'hold'; readonly reason: string; readonly stopPrice?: number } // stopPrice: trailing
  | { readonly action: 'enter'; readonly stopPrice: number; readonly reason: string }
  | { readonly action: 'exit'; readonly reason: string };

export interface Strategy<P> {
  readonly id: string;
  readonly version: string;
  readonly featureSet: { readonly id: string; readonly version: number };
  readonly warmupBars: number; // calentamiento declarado (quant-research §3)
  evaluate(input: StrategyInput<P>): StrategyDecision; // pura: sin E/S, sin reloj y sin azar
}

export interface OrderIntent {
  readonly intentId: string;
  readonly origin: 'strategy' | 'manual' | 'system';
  readonly strategyId: string | null;
  readonly strategyVersion: string | null;
  readonly bucket: Bucket;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly kind: 'entry' | 'exit' | 'protective_stop' | 'stop_update';
  readonly reduceOnly: boolean; // true en todo lo que no es una entrada
  readonly sizing: { readonly mode: 'risk' } | { readonly mode: 'quantity'; readonly quantity: Quantity } | { readonly mode: 'all' };
  readonly stopPrice: Price | null; // obligatorio en entradas y stops (STOP_INVALID)
  readonly reason: string;
  readonly signalTime: UtcMillis; // cierre de la vela de la señal (SIGNAL_TOO_OLD)
}
```

### 16.6 Portfolio y Risk (`src/portfolio/`, `src/risk/`)

```ts
export interface PositionSnapshot {
  readonly symbol: SymbolId;
  readonly bucket: Bucket;
  readonly quantity: Quantity; // suma de fills menos las comisiones cobradas en el activo base
  readonly available: Quantity; // la que se puede vender ahora
  readonly costBasis: Notional;
  readonly averageEntry: Price;
  readonly realizedPnl: Notional;
  readonly dust: Quantity;
  readonly openedAt: UtcMillis;
}
export interface PortfolioSnapshot {
  readonly asOf: UtcMillis;
  readonly quoteCurrency: string;
  readonly cash: Notional;
  readonly equity: Notional;
  readonly exposure: Notional;
  readonly exposureWithoutDust: Notional; // sin las posiciones que son polvo (ADR 0033); la usa A.3.9 (ADR 0042)
  readonly positions: readonly PositionSnapshot[];
  readonly marksAsOf: UtcMillis | null; // antigüedad de los precios con que se valoró
}
export interface PortfolioView { snapshot(): PortfolioSnapshot }

export type ReasonCode = 'KILL_SWITCH_ACTIVE' | 'CONFIG_INVALID' | /* … */ 'EXCHANGE_REJECTED'; // catálogo cerrado de trading-risk §9.2 (src/kernel/reason-codes.ts)
export interface RiskDecision {
  readonly decisionId: string;
  readonly intentId: string;
  readonly decision: 'APPROVED' | 'REDUCED' | 'REJECTED';
  readonly reasonCode: ReasonCode | null; // el principal, según el orden de trading-risk §9.3
  readonly reasonCodes: readonly ReasonCode[];
  readonly approvedQuantity: Quantity | null;
  readonly approvedNotional: Notional | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>; // medidas, límites y edad de los datos
  readonly configHash: string;
  readonly commit: string;
}
export interface TradingState {
  readonly killSwitch: boolean;
  readonly entriesBlockedBy: readonly ReasonCode[];
  readonly exitsBlockedBy: readonly ReasonCode[];
}
export interface RiskView { tradingState(): TradingState }

// Token de trading-risk §2.2. Viaja en JSON canónico; los Decimal, como cadena.
export interface SignedApproval {
  readonly approval_id: string;
  readonly intent_id: string;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly type: OrderType;
  readonly max_quantity: string;
  readonly max_notional: string | null;
  readonly reduce_only: boolean;
  readonly issued_at: UtcMillis;
  readonly expires_at: UtcMillis;
  readonly config_hash: string;
  readonly signature: string; // Ed25519, base64url
}
// src/risk/approval.ts: el tipo marcado solo existe tras verificar la firma (trading-risk §2.3).
declare const verified: unique symbol; // no se exporta
export type ApprovedOrder = SignedApproval & { readonly [verified]: true };
export type ApprovalCheck =
  | { readonly ok: true; readonly order: ApprovedOrder }
  | { readonly ok: false; readonly reasonCode: 'APPROVAL_MISSING' | 'APPROVAL_BAD_SIGNATURE' | 'APPROVAL_EXPIRED' };
// verifyApproval(approval, publicKey, now): ApprovalCheck. La reutilización y la coincidencia las comprueba Execution.
```

### 16.7 Execution y venues (`src/execution/`, contratos en `src/kernel/`)

```ts
export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit';
export type OrderState =
  | 'PENDING_SEND' | 'SENT' | 'OPEN' | 'PARTIALLY_FILLED' | 'CANCEL_PENDING'
  | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'NOT_SENT' | 'UNKNOWN'; // exchange-execution §4.1
export type ExecutionMode = 'NORMAL' | 'UNKNOWN';

export interface SubmitOrder {
  readonly clientOrderId: string; // 'ijp-' + approval_id en base64url (exchange-execution §5.1)
  readonly approval: SignedApproval; // el capguard la vuelve a verificar
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly type: OrderType;
  readonly quantity: Quantity; // ya redondeada al paso, a la baja
  readonly limitPrice: Price | null;
  readonly triggerPrice: Price | null;
  readonly expiresAt: UtcMillis | null; // TTL; null solo en los stops de protección
}
export interface CancelOrder {
  readonly clientOrderId: string;
  readonly reason: string;
  readonly approvalId: string | null; // obligatorio si cancela un stop de protección (trading-risk §2.2)
}
// Puerto de ejecución: SimulatedVenue (backtest/), ShadowVenue y LiveVenue (exchange/).
// No bloquea: cada resultado vuelve como VenueOrderUpdate, VenueRequestFailed o AccountSnapshotReceived.
export interface ExecutionVenue {
  submit(order: SubmitOrder): void;
  cancel(order: CancelOrder): void;
  queryOrder(clientOrderId: string): void;
  requestAccountSnapshot(fillsSince: UtcMillis | null): void; // saldos, órdenes abiertas y fills, para reconciliar
}

export interface Fill {
  readonly tradeId: string;
  readonly clientOrderId: string;
  readonly symbol: SymbolId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
  readonly fee: Decimal;
  readonly feeCurrency: string;
  readonly feeEstimated: boolean; // true solo si el dato faltaba (exchange-execution §6)
  readonly exchangeTime: UtcMillis;
}
export interface VenueOrderUpdate {
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly status: 'open' | 'partially_filled' | 'filled' | 'canceled' | 'expired' | 'rejected' | 'not_found' | 'not_transmitted';
  readonly filled: Quantity;
  readonly averagePrice: Price | null;
  readonly fills: readonly Fill[];
  readonly exchangeRejectCode: string | null; // va al detail de EXCHANGE_REJECTED
  readonly origin: 'rest' | 'ws' | 'reconciliation';
}
export interface VenueRequestFailed {
  readonly operation: 'submit' | 'cancel' | 'query' | 'snapshot';
  readonly clientOrderId: string | null;
  readonly errorClass:
    | 'transient' | 'timeout' | 'rate_limited' | 'ip_banned' | 'clock' | 'rejected' | 'order_not_found'
    | 'insufficient_funds' | 'credentials' | 'capguard_rejected' | 'capguard_unavailable' | 'live_disabled'
    | 'unknown'; // clases de exchange-execution §10.1, más las del capguard y de LIVE_TRADING
  readonly reasonCode: ReasonCode | null; // CAP_* o LIVE_TRADING_DISABLED cuando aplica
  readonly retryAfter: UtcMillis | null;
  readonly detail: string;
}
export interface OrderTransition {
  readonly clientOrderId: string;
  readonly from: OrderState;
  readonly to: OrderState;
  readonly filled: Quantity;
  readonly origin: 'rest' | 'ws' | 'reconciliation' | 'internal';
  readonly exchangeTime: UtcMillis | null;
}
export interface ExecutionStatus {
  readonly mode: ExecutionMode;
  readonly lastReconciledAt: UtcMillis | null;
  readonly blockedSymbols: readonly SymbolId[]; // órdenes huérfanas (EXEC_ORPHAN_ORDER)
  readonly rateLimitedUntil: UtcMillis | null; // EXEC_RATE_LIMITED
  readonly unprotectedPositions: readonly SymbolId[]; // sin stop nativo confirmado (PROTECTIVE_STOP_MISSING)
}
export interface ExecutionView { status(): ExecutionStatus }
export interface VenueHealth {
  readonly healthy: boolean;
  readonly reason: string | null;
  readonly clockSkewMs: number | null;
  readonly capguardAvailable: boolean | null; // null fuera de live
}
export interface VenueHealthView { health(): VenueHealth }
```

### 16.8 Persistencia (puertos en `src/kernel/`, adaptador SQLite en `src/persistence/`)

```ts
export interface Journal { append(event: EventEnvelope): void } // síncrono; lanza si no puede escribir
export interface RiskStore {
  appendDecision(record: DecisionRecord): void; // fila de risk_decisions con los campos de trading-risk §9.1
  loadState(): RiskState | null; // kill switch, breakers, máximo de patrimonio
  saveState(state: RiskState): void;
}
export interface ExecutionStore {
  isApprovalUsed(approvalId: string): boolean; // paso 4 de trading-risk §2.2, antes de la coincidencia
  reserveAndInsert(approvalId: string, order: OrderRecord): void; // una transacción: token usado + PENDING_SEND
  appendTransition(transition: OrderTransition): void;
  insertFill(fill: Fill): boolean; // false si ya existía: idempotente por exchange, símbolo y trade_id
  loadNonTerminal(): readonly OrderRecord[];
}
export interface PortfolioStore {
  saveSnapshot(snapshot: PortfolioSnapshot): void;
  loadLatest(): PortfolioSnapshot | null;
}
export interface StrategyStateStore {
  save(strategyId: string, symbol: SymbolId, stateJson: string): void;
  load(strategyId: string, symbol: SymbolId): string | null;
}
```

### 16.9 Registros, histórico y comandos del operador

```ts
export type Verdict = 'RECHAZADA' | 'NO CONCLUYENTE' | 'CANDIDATA A TEST FINAL' | 'CANDIDATA A PAPER'; // quant-research §11

export interface StrategyRegistryEntry {
  readonly strategyId: string;
  readonly version: string;
  readonly codeHash: string; // hash de los archivos de la estrategia y de su feature set
  readonly paramsHash: string;
  readonly experiments: readonly string[]; // EXP-NNNN
  readonly verdict: Verdict | null;
  readonly approvals: readonly {
    readonly mode: 'paper' | 'shadow' | 'live';
    readonly by: string;
    readonly at: UtcMillis;
    readonly note: string;
  }[];
}
export interface StrategyRegistry { resolve(strategyId: string, version: string): StrategyRegistryEntry | null }

// Solo inserción; los campos de cada línea son los de quant-research §10.
export interface ExperimentRegistry {
  preRegister(entry: PreRegistration): string; // EXP-NNNN, antes de cargar datos reales
  close(id: string, outcome: ExperimentOutcome): void;
  family(name: string): readonly ExperimentLine[]; // da el N del DSR
}

export interface HistoricalReader {
  // Lanza si experimentId no está pre-registrado (quant-research §2) o si el rango toca el test final sin el
  // flag humano (CLAUDE.md §2). Los datos sintéticos no pasan por aquí.
  open(request: {
    readonly experimentId: string;
    readonly symbols: readonly SymbolId[];
    readonly timeframe: Timeframe;
    readonly from: UtcMillis;
    readonly to: UtcMillis;
  }): MarketDataFeed;
  manifest(): DatasetManifest; // fuente, rango, captura y hash (quant-research §3)
}

export type OperatorCommand =
  | { readonly command: 'pause' | 'kill'; readonly actor: string; readonly reason: string }
  | { readonly command: 'rearm'; readonly target: string; readonly actor: string; readonly reason: string } // breaker o símbolo bloqueado
  | { readonly command: 'manual-order'; readonly symbol: SymbolId; readonly side: Side; readonly sizing: OrderIntent['sizing']; readonly stopPrice: Price | null; readonly actor: string; readonly reason: string };
// actor: el chat autorizado de Telegram, o 'centinela' cuando aparece el archivo data/KILL.
```

### 16.10 Protocolo con el capguard

El proceso principal y el capguard no comparten archivos. Cada lado escribe su código a partir de este
contrato, y una prueba de contrato en `test/` comprueba que el JSON canónico y la verificación de la firma dan
lo mismo en los dos.

```ts
// IPC local (socket de dominio Unix en el VPS, tubería con nombre en Windows). Un mensaje JSON por línea.
// Si no hay respuesta en su plazo: CAP_UNAVAILABLE.
type ToCapguard =
  | { readonly kind: 'hello'; readonly protocol: 1; readonly publicKey: string } // clave pública Ed25519 del run
  | { readonly kind: 'submit'; readonly requestId: string; readonly order: SubmitOrderWire } // SubmitOrder con decimales en cadena
  | { readonly kind: 'cancel'; readonly requestId: string; readonly clientOrderId: string; readonly approvalId: string | null }
  | { readonly kind: 'status'; readonly requestId: string };
type FromCapguard =
  | { readonly kind: 'ready'; readonly protocol: 1 }
  | { readonly kind: 'sent'; readonly requestId: string; readonly exchangeOrderId: string | null }
  | { readonly kind: 'rejected'; readonly requestId: string; readonly code: string } // un CAP_* de trading-risk §9.2
  | { readonly kind: 'exchange-error'; readonly requestId: string; readonly errorClass: string; readonly detail: string }
  | { readonly kind: 'status'; readonly requestId: string; readonly available: boolean };
```

## 17. Módulos futuros

Solo se fija su interfaz; no se diseñan ni se construyen hasta que la investigación lo justifique
(`docs/progress/PLAN_MAP.md`, «Pospuestos»).

| Módulo | Carpeta | Qué puede producir | Qué no puede |
|---|---|---|---|
| On-chain | `src/intel/onchain/` | Observaciones que el Feature Engine convierte en features, si la investigación las valida | Crear intenciones; llegar a `execution/` o `exchange/` |
| News | `src/intel/news/` | Solo un `RiskBrake`, que reduce o bloquea entradas | Dar señales de compra; relajar un límite |
| Macro | `src/intel/macro/` | Observaciones (features) y ventanas del calendario de eventos (`EVENT_RISK`) | Lo mismo que on-chain |
| Microestructura avanzada | `src/features/microstructure/` | Métricas del libro y de las operaciones, como features y como datos de los controles de liquidez | Hacer E/S propia: recibe el libro por eventos |

```ts
export interface ExternalSource { // publica ExternalObservationReceived
  readonly id: string;
  readonly kind: 'onchain' | 'news' | 'macro';
  start(): void;
  stop(): void;
}
export interface ExternalObservation<P> {
  readonly sourceId: string;
  readonly kind: 'onchain' | 'news' | 'macro';
  readonly eventTime: UtcMillis; // instante al que se refiere el dato
  readonly publishedTime: UtcMillis; // cuándo se publicó esta versión: es su received_time en el replay
  readonly vintage: string | null; // versión del dato, si la fuente lo revisa
  readonly provenance: {
    readonly provider: string;
    readonly reference: string | null;
    readonly model: string | null; // LLM: modelo, versión del prompt y hash de la entrada (quant-research §12)
    readonly promptVersion: string | null;
    readonly inputHash: string | null;
  };
  readonly payload: P;
}
export interface RiskBrake { // única salida de las noticias y de cualquier LLM (trading-risk §1.6)
  readonly sourceId: string;
  readonly asOf: UtcMillis;
  readonly validUntil: UtcMillis;
  readonly sizeMultiplier: Decimal; // entre 0 y 1: solo reduce
  readonly blockEntries: boolean;
  readonly reasons: readonly string[];
}
export interface RiskBrakeProvider { current(asOf: UtcMillis): RiskBrake | null } // configurado y sin dato vigente: control suspendido
export interface EventCalendar { // ventanas de EVENT_RISK (trading-risk §4.8)
  windows(asOf: UtcMillis): readonly { readonly name: string; readonly from: UtcMillis; readonly to: UtcMillis }[];
}
export interface MicrostructureEngine {
  readonly id: string;
  readonly version: number;
  metrics(symbol: SymbolId, asOf: UtcMillis): Readonly<Record<string, number | null>> | null;
}
```

Reglas comunes:

- **Point-in-time con versiones.** Un dato que se revisa (macro, on-chain) se guarda con cada versión y su hora
  de publicación. El replay usa la versión que existía en ese momento.
- **Pre-registro.** Ninguna feature externa entra en una estrategia sin pre-registro y sin contar en el `N` de
  su familia (quant-research §2 y §8).
- **Límites.** La regla `intel-solo-importa-lo-permitido` y la de LLM y noticias ya están activas.

## 18. Ubicación del código actual

**Módulos que se conservan** (clasificación del paso 13):

| Actual | Destino | Cambios al moverlo |
|---|---|---|
| `src/log.ts` | `src/shared/log.ts` | Niveles INFO, WARNING y CRITICAL (§12). El sumidero escribe en el diario a través de `persistence/` |
| `src/util.ts` | Se reparte | `sleep`, `tfToMs`, `utcDay` y `errMsg` → `shared/`. `withRetry` → `exchange/`, reescrito con *full jitter* (exchange-execution §10.3, paso 32). `newClientOrderId` desaparece: Execution deriva el ID `ijp-` del `approval_id`. `fmt`, `fmtPrice` y `fmtPct` → `monitoring/`, con `Decimal` |
| `src/types.ts` | Se reparte | `Side` y `Bucket` → `shared/`. `Candle` en float → `features/` como `CandleWindow`. `Quote`, `Ticker24h`, `MarketInfo`, `Fill` y `Position` → contratos de `kernel/` en `Decimal` (§16). `Notifier` → `monitoring/` |
| `src/indicators.ts` | Se archiva cuando `strategy/trend.ts` lea el `FeatureVector` | No se mueve: `features/` tiene sus propias definiciones con ventana fija, que no dependen del inicio de la serie (paso 22, ADR 0025) |
| `src/strategy/trend.ts` | Se queda en `src/strategy/` | Se conserva la regla de decisión. EMA, ATR, máximos y el filtro de régimen de BTC pasan a ser un *feature set* de `features/`, y la estrategia lee el `FeatureVector`. `TrendParams` se muda a la estrategia |
| `src/config.ts` | `src/config/` | Hecho en el paso 16 (ADR 0017): `src/config.ts` solo reexporta para el código previo y desaparece con él. Pendiente: solo lo importa `app/`, el tipo de la sección de cada módulo se muda a ese módulo y `LIVE_CONFIRMATION` lo comprueba `app/` al componer live |
| `src/telegram.ts` | `src/monitoring/telegram.ts` | Mensajes con nivel. Las órdenes recibidas se publican como `OperatorCommandReceived` |

**Módulos que se reescriben o se archivan:**

| Actual | Destino | Paso |
|---|---|---|
| `src/market.ts` | `exchange/` (lectura con ccxt) y `marketdata/` (normalizador) | 32 |
| `src/broker.ts` | `execution/` (máquina de estados), `exchange/` (`LiveVenue`, `ShadowVenue`) y `backtest/` (`SimulatedVenue`, que también usa paper) | 32 y 36 |
| `src/engine.ts` | `kernel/` (bus), `strategy/` (Strategy Engine) y `risk/` | 35 |
| `src/risk.ts` | `risk/` | 35 |
| `src/portfolio.ts` | `portfolio/`, en `Decimal` | 18 |
| `src/store.ts` | `persistence/` | 33 |
| `src/backtest.ts`, `src/backtest/sim.ts` | `app/` (comando) y `backtest/`: hecho en el paso 23 (ADR 0026) | 23 |
| `src/main.ts` | `app/` (live, paper y shadow) | 32 |
| `src/report.ts` | `analytics/` (métricas) y `monitoring/` (resumen diario) | 41 |
| `src/intel.ts`, `src/dashboard.ts`, `src/scout.ts` | `legacy/`, fuera del build | 35 |

## 19. Orden de construcción

Un módulo no se construye antes que los módulos que importa. Lo que no tiene paso conocido se asigna al
detallar cada paso, siguiendo este orden.

**Tramo 1 (investigación, pasos 12 a 31).**

1. `shared/` con `Decimal` (paso 18), y `portfolio/` en `Decimal` (paso 18).
2. `historical/`: almacén y captura (desde el paso 18), con la guarda del test final.
3. `kernel/` y `marketdata/` con el normalizador, antes de reescribir el backtest.
4. `features/` (paso 22, ADR 0025), `analytics/` (métricas de rendimiento en el paso 24, ADR 0027; régimen, para
   quant-research §7, en el paso 26) y `strategy/`. El normalizador de `marketdata/` llega con el replay del paso 23. Las
   estrategias de referencia (BASELINE, RANDOM y BUY_AND_HOLD) son del paso 24. La Strategy Library, con tendencia y
   reversión a la media en estado RESEARCH, es del paso 25 (ADR 0028).
5. `risk/` y `execution/` en versión de investigación: dimensionado con costes, límites y venue simulado, en
   sus carpetas definitivas y con estas interfaces. La versión mínima es del paso 20 (ADR 0023). El dimensionado
   con costes y `SimulatedVenue` son del paso 23.
6. `backtest/` y el comando de backtest (paso 23).
7. `research/` con el registro de experimentos: JSONL en git, decidido en el paso 21 (ADR 0024). El puerto de
   datos real y el primer experimento llegan con el backtest (paso 23).
8. Sin `registry/`: la decisión del paso 31 se registra en el Experiment Registry y en un documento de decisión (qué
   estrategias pasan, cuáles no y por qué, con su evidencia). `registry/` se construye completo en el paso 34 e importa
   de ahí esas estrategias.

**Tramo 2 (solo si el paso 31 aprueba alguna estrategia, pasos 32 a 48).**

1. `exchange/` y la composición de paper, shadow y live en `app/` (paso 32).
2. `persistence/` (paso 33).
3. `risk/` completo (paso 35). En ese paso se vuelve a ejecutar el backtest de la estrategia aprobada con `risk/`
   y `execution/` completos, y se compara con el del tramo 1.
4. `execution/` completo y stops nativos (paso 36).
5. El capguard antes del micro-live. Su separación de usuarios es del paso 39.
6. `monitoring/` (paso 41).
7. Micro-live (paso 46).

## 20. Contraste con los sistemas de referencia

Solo se contrastaron decisiones, sin copiar código (fichas de [REFERENCE_SYSTEMS.md](docs/REFERENCE_SYSTEMS.md),
2026-10-02, y la página de arquitectura de NautilusTrader, consultada el 2026-10-06).

| Decisión | Coincide con | Diferencia nuestra |
|---|---|---|
| Núcleo de un hilo con bus de mensajes | NautilusTrader: kernel con `MessageBus` en un hilo; la red y la persistencia, fuera | Sin forma de saltarse el riesgo (su `bypass`), con token firmado y con capguard aparte |
| Mismo código en todos los modos, con puertos y adaptadores | NautilusTrader (backtest, sandbox y live); Freqtrade (dry-run) | Sin cálculo vectorizado propio del backtest, que Freqtrade sí tiene |
| Separar la decisión (Strategy) de la gestión de la orden (Execution), con Risk en medio | Hummingbot V2 (controller y executor) | El executor nunca envía sin token |
| Captura de datos como tarea independiente con registro | Hummingbot Quants Lab | Nada pasa de la investigación a la operación sin aprobación humana |
| Abortar ante una invariante rota | NautilusTrader (crash-only) | Antes se persiste el kill switch. El supervisor es del paso 39 |
| Restaurar y reconciliar antes de decidir | NautilusTrader | Se arranca en UNKNOWN (exchange-execution §16) |

## 21. Riesgos y límites de este documento

- **Sin implementar.** Las reglas de límites muerden según aparecen las carpetas. Hasta entonces, el código
  previo sigue con sus brechas (trading-risk §10, exchange-execution §18).
- **Indirección.** Un sistema por eventos es más difícil de seguir que llamadas directas. Lo compensan el
  catálogo cerrado, un productor por tipo, el diario y la correlación.
- **Un hilo.** Un cálculo síncrono largo, como features de muchos símbolos o una consulta pesada a SQLite,
  bloquea todo. El vigilante lo detecta, y lo pesado va a los comandos, fuera del proceso principal.
- **`node:sqlite`** es candidata a estable (`docs/research/05` §7.2). Queda encapsulada en `persistence/`; el
  plan B es `better-sqlite3`.
- **Lo que no valida cada modo.** Paper y shadow no validan la ventaja, y el backtest no ejercita el libro real,
  los WebSockets ni los límites de peticiones.
- **Tramo 1 simplificado.** `risk/` y `execution/` del tramo 1 son versiones reducidas, y sus resultados se
  vuelven a comprobar en el paso 35.
- **Convenciones sin check automático todavía:** ningún `if (modo)` fuera de `app/` y la composición segura de §15.2.
- **La matriz puede estar mal.** Cambiarla exige un ADR (ADR 0015).
- **Saludo del capguard.** Solo lo protegen los permisos del sistema operativo: un proceso local podría
  presentar otra clave pública. Lo que decide son los topes del capguard (ADR 0003, paso 39).
