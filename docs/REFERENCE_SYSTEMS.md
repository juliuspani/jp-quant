# Sistemas de referencia (REFERENCE REPOSITORIES)

Documento de referencia del paso 10 (2026-10-02), ampliado en el 10B con NautilusTrader. Fija cómo se consultan proyectos open-source de trading y
qué se aprende de cada uno. Las decisiones están en
[ADR 0008](adr/0008-sistemas-de-referencia.md) (estado: *aceptado*, paso 10B).

**Los sistemas de referencia no forman parte del producto.** No son dependencias, no se instalan, no se
ejecutan y su código no entra en este repositorio. Son consultores arquitectónicos: muestran cómo otros han
resuelto un problema, y nosotros decidimos con nuestras reglas. Si algo de aquí choca con un skill
([exchange-execution](../.claude/skills/exchange-execution/SKILL.md),
[trading-risk](../.claude/skills/trading-risk/SKILL.md) o
[quant-research](../.claude/skills/quant-research/SKILL.md)), manda el skill.

Lo marcado [verificar] no se ha comprobado en la fuente primaria. No cambia `src/` ni `package.json`.

## 1. Metodología

### 1.1 Reglas

1. **Nunca dentro del repositorio.** Ningún sistema de referencia entra como dependencia, submódulo, copia
   (*vendoring*) ni carpeta. CCXT es la única excepción como dependencia (ADR 0007), y como referencia sigue
   las mismas reglas que los demás.
2. **No se copia código, sea cual sea la licencia.** Tampoco se traduce línea a línea a TypeScript. Se adopta
   el concepto y se escribe a partir de nuestra especificación (skill o ADR), no del código ajeno.
3. **Copyleft (GPL, AGPL, LGPL): ni copiar ni traducir.** Se prefiere la documentación al código fuente. Si
   se ha leído código, la implementación se escribe desde la especificación propia, sin el código ajeno
   delante. Una licencia permisiva (MIT, Apache-2.0) no cambia la regla 2: solo reduce el riesgo legal de un
   parecido accidental.
4. **Consulta de solo lectura.** Documentación oficial, código en GitHub (navegador o API) y notas de
   versión. Si hiciera falta clonar, se hace fuera del repositorio (carpeta temporal), sin instalar sus
   dependencias ni ejecutar su código.
5. **Toda afirmación lleva fuente y versión consultada** (§11). Lo que no se ha comprobado lleva [verificar].
6. **Este documento no decide.** Adoptar un concepto es una decisión del módulo que lo usa: va a su skill o
   a un ADR, que cita este documento. La tabla de §9 son candidatos, no compromisos.
7. **Lista cerrada.** Añadir o quitar un sistema de referencia exige aprobación. Los propuestos van a §8.
8. **Revisión.** La ficha de un sistema se revisa al empezar el paso que diseña el módulo correspondiente:
   la versión consultada puede haber cambiado.

### 1.2 Ficha de cada sistema

Cada sistema tiene una ficha con la versión consultada y estos seis apartados, siempre en este orden:

1. **Qué resuelve bien**
2. **Patrón arquitectónico interesante**
3. **Qué adoptar conceptualmente**
4. **Qué NO copiar**
5. **Licencia y dependencias**
6. **Diferencias con nuestra arquitectura**

### 1.3 Cuándo se consulta cada uno

| Tema | Referencias | Dónde se decide |
|---|---|---|
| ExchangeAdapter y conectores | CCXT, Hummingbot (conectores) | ADR 0007, exchange-execution, pasos 32 y 36 |
| Ciclo de vida de órdenes y reconciliación | Hummingbot, Freqtrade, NautilusTrader | exchange-execution §4, §5 y §14 |
| Risk Engine y estados de operación | NautilusTrader | trading-risk, paso 35 |
| Arranque, persistencia y recuperación tras caída | NautilusTrader, Freqtrade | exchange-execution §16 |
| Bucle de operación, simulación y avisos | Freqtrade | `ARCHITECTURE.md` (ADR 0012 y ADR 0013), refactor |
| Protecciones y circuit breakers | Freqtrade | trading-risk §5, paso 35 |
| Backtest y anti look-ahead | Freqtrade, NautilusTrader, Quants Lab (contraejemplo) | quant-research |

## 2. Resumen

Versiones y licencias consultadas el 2026-10-02 (API de GitHub y repositorios oficiales).

| Sistema | Licencia | Lenguaje | Versión consultada | Relevancia | ¿Se copia código? |
|---|---|---|---|---|---|
| CCXT | MIT | JS/TS, Python, PHP… | 4.5.84 (la instalada) | Alta | No |
| Hummingbot | Apache-2.0 | Python + Cython | v2.17.0 (2026-09-22) | Alta en conectores y órdenes | No |
| Hummingbot Quants Lab | Apache-2.0 | Python (notebooks) | Sin versiones; último cambio 2025-11-04 | Baja-media | No |
| Freqtrade | GPL-3.0 | Python | 2026.9 (2026-09-29) | Alta en operación y backtest | No |
| NautilusTrader | LGPL-3.0 | Rust + Python | v1.231.0 (2026-08-02) | Alta en Risk Engine, reconciliación y backtest | No |

## 3. CCXT

Versión consultada: 4.5.84, la fijada en `package.json`. El detalle de su uso está en [docs/CCXT.md](CCXT.md);
esta ficha solo lo mira como referencia de arquitectura.

**Qué resuelve bien**
- Una API unificada para más de cien exchanges: mercados, precisión, límites, órdenes, saldos e históricos.
- Firma de peticiones, jerarquía de errores y, con CCXT Pro, WebSockets con libro de órdenes.

**Patrón arquitectónico interesante**
- Una clase por exchange que hereda de una base común y se describe con datos: endpoints, límites de
  peticiones y un mapa de capacidades (`has`) que dice qué métodos admite ese exchange.
- Un único código fuente que se transpila a varios lenguajes, con pruebas comunes para todos.

**Qué adoptar conceptualmente**
- **Capacidades declaradas y comprobadas al arrancar.** El ExchangeAdapter puede exponer qué admite el
  exchange elegido (stops nativos, client order ID, canal privado) y negarse a arrancar si falta algo que
  el sistema necesita (*fail closed*).
- Metadatos de mercado como datos, no como código: precisión y límites se leen, no se escriben a mano.

**Qué NO copiar**
- Sus estructuras con `number`, `OrderRouter`, la API implícita y el client order ID aleatorio cuando no se
  pasa uno (docs/CCXT.md §1.1 y §2).
- Su limitador de peticiones como única capa: es la capa interior del nuestro (exchange-execution §11).

**Licencia y dependencias**
- MIT. Permisiva, pero la regla 2 se aplica igual: no se copia código suyo en el nuestro.
- Seis dependencias de runtime en 4.5.84: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/starknet`,
  `undici` y `ws`. El `postinstall` hace peticiones de red (paso 39).

**Diferencias con nuestra arquitectura**
- CCXT es una biblioteca sin estado de órdenes: no sabe qué se envió ni qué falta por reconciliar. Ese
  estado, el decimal y el modo UNKNOWN son nuestros (ADR 0007, decisión 4).

## 4. Hummingbot

Versión consultada: v2.17.0 (2026-09-22), rama `master`.

**Qué resuelve bien**
- Conectores normalizados con seguimiento de cada orden en vuelo, desde que se pide hasta que termina.
- Todo importe, precio y comisión en `Decimal`, serializado como cadena.
- Fills deduplicados por identificador de operación (*trade id*): la cantidad ejecutada solo crece.
- Libro de órdenes local a partir de *snapshot* más diferencias.
- Eventos de ciclo de vida con orden garantizado: «completada» llega siempre después de su último fill.

**Patrón arquitectónico interesante**
- **Conector** = clase del exchange + `OrderBookTracker` (libro) + `UserStreamTracker` (cuenta y órdenes) +
  `ClientOrderTracker`, que guarda un `InFlightOrder` por orden y emite los eventos.
- `ClientOrderTracker` separa órdenes activas, órdenes terminadas en caché (30 s, hasta 1000) para recibir
  actualizaciones tardías, y órdenes «perdidas».
- **Estrategias V2:** un *controller* decide y un *executor* gestiona el ciclo de órdenes de una posición
  (entrada, take profit, stop loss y límite de tiempo: la «triple barrera»).

**Qué adoptar conceptualmente**
- Un registro por orden con sus fills indexados por trade id. Confirma exchange-execution §4 y §5.3.
- **Caché de órdenes terminadas** para no perder un fill o un estado que llega tarde. Candidato para
  exchange-execution §4 y §14 cuando se implemente.
- Límites de peticiones declarados por endpoint, con su peso, en una tabla de datos [verificar si comparten
  cupo entre endpoints]. Candidato para el paso 32.
- La separación entre decidir (controller) y gestionar la orden (executor), **siempre que el executor pida
  aprobación a Risk** para cada orden.

**Qué NO copiar**
- **Órdenes «perdidas».** Si el exchange no encuentra la orden 3 veces, Hummingbot la marca como perdida,
  emite un fallo y deja de consultarla. Nosotros no damos nunca una orden por fallida sin pruebas: pasamos a
  UNKNOWN y reconciliamos (exchange-execution §3 y §9.2).
- Executors que envían órdenes directamente al conector, sin una puerta de riesgo central.
- Barreras gestionadas por software con órdenes a mercado por defecto. Nosotros usamos stops nativos
  (trading-risk §2.4).
- Su simulador de backtest de V2: sin slippage, entrada límite cuando el cierre toca el precio, take profit
  con el cierre y stop loss con máximo y mínimo. No cumple quant-research §5.
- Su generador de client order ID [verificar formato]: el nuestro deriva del `approval_id` (exchange-execution
  §5.1).

**Licencia y dependencias**
- Apache-2.0. Permisiva; aun así no se copia código (regla 2).
- Python ≥ 3.10.12, extensiones Cython compiladas y unas 51 dependencias directas, entre ellas SDK de
  blockchains (web3, Solana, XRPL…), TA-Lib y numba. En Windows exige WSL2 (`docs/research/05` §6).

**Diferencias con nuestra arquitectura**
- Hummingbot nace para creación de mercado y arbitraje, con muchas órdenes y muchos conectores. Nosotros
  hacemos tendencia en spot con pocas operaciones al año.
- No tiene token de aprobación, capguard ni kill switch con stops nativos.

## 5. Hummingbot Quants Lab

Versión consultada: rama `main`, sin versiones publicadas; último cambio el 2025-11-04. **Relevancia
baja-media:** se consulta solo para la organización de la investigación, y sobre todo como contraejemplo.

**Qué resuelve bien**
- Un circuito completo de investigación sobre Hummingbot: descarga de velas, operaciones, *funding* e
  interés abierto; caché local en parquet; tareas programadas; notebooks; optimización; despliegue.

**Patrón arquitectónico interesante**
- Un planificador de **tareas** con tipos separados: captura de datos, backtest, métodos cuantitativos y
  despliegue. Los notebooks también se ejecutan como tareas parametrizadas.
- La misma configuración de *controller* sirve para el backtest y para la operación real.

**Qué adoptar conceptualmente**
- La captura de datos como tarea independiente, programada y con su propio registro, separada del
  backtest.
- La configuración de una estrategia como artefacto único, el mismo en research y en operación. Encaja con
  el pre-registro de quant-research §2.

**Qué NO copiar**
- **Optimización sin protocolo:** barridos con optuna sin pre-registro, sin test final ni DSR o PBO. Choca con
  quant-research §2, §4 y §8.
- **Costes incompletos:** 6 puntos básicos por defecto, sin slippage y solo con velas (quant-research §5).
- **Despliegue automático** de una configuración desde research a operación. Aquí entre los dos hay
  aprobación humana y Risk.
- La base de datos MongoDB con credenciales de ejemplo en la documentación.

**Licencia y dependencias**
- Apache-2.0. Permisiva; aun así no se copia código (regla 2).
- Conda con Python 3.12; depende de `hummingbot`, optuna, pandas, statsmodels, scikit-learn, FastAPI,
  papermill y controladores de MongoDB y PostgreSQL. Funciona con Docker y MongoDB.

**Diferencias con nuestra arquitectura**
- Nosotros guardamos en SQLite y el Experiment Registry en JSONL (quant-research §10), sin servicios
  externos.
- Ninguna tarea nuestra puede pasar algo de research a operación por su cuenta.

## 6. Freqtrade

Versión consultada: 2026.9 (2026-09-29), rama `develop`.

**Qué resuelve bien**
- Operación 24/7 madura, con años de uso real.
- Simulación (*dry-run*) con el mismo código que la operación real.
- Stop en el exchange (`stoploss_on_exchange`) y protecciones globales: `StoplossGuard`, `MaxDrawdown`,
  `CooldownPeriod` y `LowProfitPairs`.
- Telegram con lista de usuarios autorizados.
- Herramientas contra el look-ahead: `lookahead-analysis` y `recursive-analysis`.
- Comprobación del reloj contra el exchange (desde 2026.9).

**Patrón arquitectónico interesante**
- **Bucle con orden fijo** en cada iteración: leer operaciones abiertas, actualizar órdenes desde el
  exchange, tiempos de espera, salidas, ajustes y por último entradas.
- **Estrategia como clase** con funciones vectorizadas sobre un dataframe (`populate_indicators`,
  `populate_entry_trend`, `populate_exit_trend`) y *callbacks* en los puntos de decisión.
- **Calentamiento explícito** (`startup_candle_count`) y pares informativos alineados por la hora de cierre.
- Persistencia con una operación (`Trade`) y sus órdenes (`Order`), y un envoltorio de ccxt con ajustes por
  exchange [verificar nombre del mecanismo].

**Qué adoptar conceptualmente**
- **Detección automática del look-ahead:** recalcular señales con datos recortados y comparar con el cálculo
  completo. Candidato para quant-research §3.
- **Estabilidad de indicadores:** comprobar que un indicador no cambia con más o menos historia previa
  (`recursive-analysis`). Candidato para quant-research §7.
- Calentamiento declarado por la estrategia, en lugar de suponerlo.
- Confirma lo ya recogido en `docs/research/05` §6: simulación por el mismo camino, salidas antes que entradas,
  stops en el exchange, protecciones y Telegram con autorizados y pausa de entradas separada de la parada.

**Qué NO copiar**
- **Cantidades, precios y comisiones en `Float`** en la base de datos (exchange-execution §17).
- **Sin client order ID ni idempotencia propia:** identifica las órdenes por el ID del exchange
  (exchange-execution §5).
- **Supuestos del backtest:** órdenes ejecutadas al precio pedido si está dentro de la vela y sin slippage
  (`docs/research/02`).
- Hyperopt y FreqAI como vía de optimización: sin el protocolo de quant-research.
- Entradas y salidas forzadas a mano desde Telegram que no pasan por una puerta de riesgo. Aquí toda orden
  pasa por Risk (trading-risk §2).
- Apalancamiento, futuros y cortos.

**Licencia y dependencias**
- **GPL-3.0: prohibido copiar o traducir su código** (regla 3). Se consulta sobre todo su documentación.
- Python ≥ 3.11 y unas 45 dependencias, casi todas fijadas a versión exacta, entre ellas `ccxt==4.5.85`, pandas, TA-Lib,
  SQLAlchemy, FastAPI y python-telegram-bot. También fija ccxt a una versión exacta, como nosotros.

**Diferencias con nuestra arquitectura**
- Sus estrategias calculan sobre todo el dataframe de una vez en el backtest y por incrementos en real:
  esa diferencia es la fuente de su look-ahead. La nuestra debe calcular igual en los dos modos.
- No tiene token de aprobación, capguard ni Risk Engine separado: las protecciones viven dentro del bot.

## 7. NautilusTrader

Versión consultada: v1.231.0 (2026-08-02), la última estable, rama `develop`. La 2.0 está en versiones
candidatas (v2.0.0rc5, 2026-09-15). Propuesto en el paso 10 e incorporado el 2026-10-02 (paso 10B). **Se usa
solo como consulta, sin copiar código** (reglas 2 y 3).

**Qué resuelve bien**
- Un mismo núcleo para backtest, sandbox y operación real: los mismos motores, caché, bus de mensajes y
  estrategias.
- Un `RiskEngine` en el núcleo que valida cada orden antes de la ejecución: precisión, límites del
  instrumento, nocional máximo por orden, saldo, reduce-only, ritmo de órdenes y estado de operación.
- Reconciliación al arrancar y durante la operación, con invariantes escritos.
- Tipos de dominio de punto fijo (`Price`, `Quantity`, `Money`) sobre enteros, nunca float.
- `ClientOrderId` y `VenueOrderId` separados, y una máquina de estados de orden con estados en vuelo
  (`SUBMITTED`, `PENDING_UPDATE`, `PENDING_CANCEL`).

**Patrón arquitectónico interesante**
- **Kernel** con `MessageBus`, `Cache`, `DataEngine`, `ExecutionEngine`, `RiskEngine` y `Portfolio`. Puertos y
  adaptadores: un `DataClient` y un `ExecutionClient` por venue traducen al modelo del dominio.
- **Flujo de una orden:** estrategia → `RiskEngine` (si la deniega, emite `OrderDenied`) → `ExecutionEngine`
  → `ExecutionClient` → venue. Los eventos del venue vuelven por el `ExecutionEngine` y actualizan la caché.
- **Un solo hilo** despacha mensajes, estrategia, riesgo y caché; red, logs y persistencia van aparte. Así el
  orden de los cambios de estado es determinista.
- **Estados de operación** del motor de riesgo: `ACTIVE`, `REDUCING` (solo órdenes que reducen) y `HALTED`
  (solo cancelar y consultar).
- **Crash-only:** si se rompe una invariante, el proceso aborta y un supervisor externo lo reinicia. Al
  arrancar restaura la caché persistida y reconcilia antes de conectar las estrategias.

**Qué adoptar conceptualmente**
- **Estados de operación** como modelo de nuestros bloqueos: el kill switch se parece a `HALTED`, y un estado
  «solo reducir» encaja con las salidas. Candidato para trading-risk §6 y §8 (paso 35).
- **Restaurar y reconciliar antes de decidir.** Confirma exchange-execution §16, donde el arranque empieza en
  UNKNOWN.
- **Invariantes de reconciliación escritos y probados**, con identificadores sintéticos deterministas que no
  se duplican tras un reinicio. Candidato para exchange-execution §14.
- **Abortar ante una invariante rota** y dejar el reinicio a un supervisor externo. Candidato para la
  operación en el VPS (paso 39).
- Tipos de punto fijo con precisión por instrumento, como contraste para el ADR del tipo decimal (paso 14).

**Qué NO copiar**
- **`INFLIGHT_TIMEOUT`:** una orden enviada que no se confirma a tiempo se resuelve como rechazada tras una
  sola consulta. Nosotros pasamos a UNKNOWN (exchange-execution §9.2).
- **`bypass` del motor de riesgo:** su configuración permite saltarse las comprobaciones de riesgo y los
  límites de ritmo. Aquí no existe un modo sin Risk (`CLAUDE.md` §2).
- **Riesgo en el mismo proceso que la estrategia**, que llama a `submit_order` sin token firmado ni capguard
  aparte (trading-risk §2 y §3).
- **Órdenes sintéticas para cuadrar posiciones** (`generate_missing_orders`). Nosotros no adoptamos lo que
  no reconocemos: avisamos y bloqueamos (exchange-execution §14.2).
- Margen, derivados, cuentas con cobertura (`HEDGING`) y mercados de apuestas.
- Su interfaz, en plena transición a la 2.0: no se toma como contrato estable.

**Licencia y dependencias**
- **LGPL-3.0**, verificada el 2026-10-02 en tres fuentes: el archivo `LICENSE` (GNU Lesser General Public
  License, versión 3), la API de GitHub (`LGPL-3.0`) y `python/pyproject.toml` (`LGPL-3.0-only`). Es copyleft:
  ni copiar ni traducir su código (regla 3). Se consulta sobre todo su documentación.
- Python 3.12 a 3.14 con paquetes precompilados para Linux, macOS y Windows Server. Núcleo en Rust; compilar
  desde el código fuente exige Rust, clang y Cap'n Proto. Redis o PostgreSQL, opcionales, como respaldo de la
  caché.

**Diferencias con nuestra arquitectura**
- Es una plataforma general: multi-activo, multi-venue, con nanosegundos y libro L3. Nosotros somos un bot de
  tendencia en spot, con velas y pocas operaciones al año.
- Su riesgo vive en el mismo proceso que la estrategia. El nuestro firma un token, y además el capguard, en
  otro proceso, es el único con la clave de trading.
- Persiste en Redis o PostgreSQL como respaldo de recuperación. Nosotros usamos `node:sqlite`, con decimales
  como `TEXT`.

## 8. Propuestos, no incorporados

Ninguno pendiente. NautilusTrader se propuso en el paso 10 y se incorporó en el 10B (§7).

### No propuestos

Jesse y OctoBot (`docs/research/05` §6) no se proponen: Jesse cobra la operación real y OctoBot no aporta
nada que no cubran los anteriores.

## 9. Candidatos a adoptar

Cada uno se decide en el módulo indicado, con su ADR o su skill. Los marcados «Adoptado» los decidió el ADR
citado; el resto siguen siendo candidatos.

| Concepto | De dónde | Dónde se decidiría | Estado |
|---|---|---|---|
| Capacidades del exchange comprobadas al arrancar | CCXT (`has`) | Paso 32, ExchangeAdapter | Nuevo |
| Caché de órdenes terminadas para actualizaciones tardías | Hummingbot | exchange-execution §4 y §14 | Nuevo |
| Límites de peticiones declarados por endpoint, con peso | Hummingbot | exchange-execution §11, paso 32 | Nuevo |
| Separar decisión (controller) y gestión de la orden (executor), con Risk en medio | Hummingbot V2 | `ARCHITECTURE.md` §8 (ADR 0012) | Adoptado |
| Detección automática del look-ahead con datos recortados | Freqtrade | quant-research §3 | Nuevo |
| Estabilidad de indicadores según la historia previa | Freqtrade | quant-research §7 | Nuevo |
| Calentamiento declarado por la estrategia | Freqtrade | `ARCHITECTURE.md` §16.5 (ADR 0012), quant-research §3 | Adoptado |
| Captura de datos como tarea independiente con registro | Quants Lab | `ARCHITECTURE.md` §3 y §10 (ADR 0012), quant-research §3 | Adoptado |
| Estados de operación: activo, solo reducir y detenido | NautilusTrader | trading-risk §6 y §8, paso 35 | Nuevo |
| Invariantes de reconciliación escritos y probados | NautilusTrader | exchange-execution §14 | Nuevo |
| Abortar ante una invariante rota, con supervisor externo | NautilusTrader | `ARCHITECTURE.md` §13 (ADR 0012); el supervisor, en el paso 39 | Adoptado |
| Fills deduplicados por trade id y cantidad que solo crece | Hummingbot | exchange-execution §4 y §5.3 | Ya recogido |
| `Decimal` en importes y cadenas en las fronteras | Hummingbot | exchange-execution §17 | Ya recogido |
| Simulación por el mismo camino que la operación real | Freqtrade, NautilusTrader | `docs/research/05` §6 | Ya recogido |
| Salidas antes que entradas en cada ciclo | Freqtrade | `docs/research/05` §6 | Ya recogido |
| Stop en el exchange y protecciones globales | Freqtrade | trading-risk §2.4 y §5 | Ya recogido |
| Restaurar estado y reconciliar antes de arrancar | NautilusTrader | exchange-execution §16 | Ya recogido |

## 10. Riesgos y límites de este documento

- **Fuentes resumidas.** Parte de lo anterior sale de la documentación oficial y parte de leer el código en
  GitHub, sin ejecutarlo. Lo dudoso lleva [verificar].
- **Las versiones cambian.** Hummingbot y Freqtrade publican cada mes, y NautilusTrader está pasando a la 2.0.
  Una ficha puede quedarse vieja; por eso se revisa al empezar el paso que la usa (regla 8).
- **Haber leído código copyleft.** De Freqtrade (GPL) se leyó `trade_model.py` para comprobar los tipos de
  columna. De NautilusTrader (LGPL) se buscaron en su configuración del motor de riesgo los nombres de los
  campos (`bypass` y los límites), sin leer la implementación. Lo que se implemente a partir de esas ideas se
  escribe desde nuestra especificación (regla 3).
- **El test comprueba el texto**, no que alguien haya copiado código. Que no se copia depende de la revisión.

## 11. Fuentes

Consultadas el 2026-10-02.

- API de GitHub (licencia, actividad y última versión): `ccxt/ccxt`, `hummingbot/hummingbot`,
  `hummingbot/quants-lab`, `freqtrade/freqtrade`, `nautechsystems/nautilus_trader`.
- CCXT: `node_modules/ccxt/package.json` (4.5.84) y [docs/CCXT.md](CCXT.md) §7.
- Hummingbot: https://hummingbot.org/connectors/connectors/architecture/ ·
  https://hummingbot.org/connectors/connectors/architecture/order_lifecycle/ ·
  https://hummingbot.org/strategies/v2-strategies/ ·
  https://hummingbot.org/strategies/v2-strategies/executors/positionexecutor/ · en el repositorio:
  `hummingbot/connector/client_order_tracker.py`, `hummingbot/core/data_type/in_flight_order.py`,
  `hummingbot/strategy_v2/backtesting/` y `setup.py`.
- Quants Lab: https://github.com/hummingbot/quants-lab (`README.md`, `environment.yml`,
  `core/backtesting/engine.py`).
- Freqtrade: https://www.freqtrade.io/en/stable/bot-basics/ ·
  https://www.freqtrade.io/en/stable/strategy-customization/ · https://www.freqtrade.io/en/stable/backtesting/ ·
  https://www.freqtrade.io/en/stable/lookahead-analysis/ · https://www.freqtrade.io/en/stable/plugins/ · en el
  repositorio: `requirements.txt` y `freqtrade/persistence/trade_model.py`.
- NautilusTrader: https://nautilustrader.io/docs/latest/concepts/overview/ ·
  https://nautilustrader.io/docs/latest/concepts/architecture/ ·
  https://nautilustrader.io/docs/latest/concepts/execution/ ·
  https://nautilustrader.io/docs/latest/concepts/execution/reconciliation ·
  https://nautilustrader.io/docs/latest/concepts/orders/ · https://nautilustrader.io/docs/latest/concepts/cache/ ·
  https://nautilustrader.io/docs/latest/concepts/backtesting/ ·
  https://nautilustrader.io/docs/latest/getting_started/installation/ · en el repositorio: `LICENSE`,
  `python/pyproject.toml` y los nombres de campo de `crates/risk/src/engine/config.rs`.
