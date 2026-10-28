# CCXT y CCXT Pro en Inversor JP

Documento de referencia del paso 9 (2026-10-02). Fija qué se usa de CCXT y qué hace el sistema por su
cuenta. Las decisiones están en [ADR 0007](adr/0007-ccxt-y-exchange-adapter.md) (estado: *aceptado*, paso 9B). Los
estándares de conexión con el exchange los fija [exchange-execution](../.claude/skills/exchange-execution/SKILL.md),
que manda si algo de aquí choca con él. **No integra nada en producción:** no cambia `src/`. En `package.json`
solo se fijó la versión de ccxt (paso 9B).

Los detalles marcados [verificar] no se han comprobado con el exchange elegido. Se comprueban en los pasos
17, 32 y 36, como en exchange-execution.

## 1. Arquitectura

```text
Trading System (Strategy → Risk → Execution, datos, reconciliación)
        │  tipos propios, valores decimales
        ▼
ExchangeAdapter (nuestro, src/exchange/)
        │  único punto que importa ccxt
        ▼
CCXT (REST) / CCXT Pro (WebSocket), cuando proceda
        ▼
Exchange
```

- **El ExchangeAdapter es nuestro y vive en `src/exchange/`** (exchange-execution §2). Es el único módulo que
  importa ccxt (regla `solo-exchange-importa-ccxt`).
- **Hacia dentro solo da tipos propios**, con valores decimales. Nunca devuelve estructuras de ccxt ni deja
  salir sus excepciones: las traduce a las clases de exchange-execution §10.1.
- **Quién lo usa.** Execution lo usa para órdenes (con token de Risk), la capa de datos para lecturas y la
  reconciliación para consultar el estado. **Strategy nunca**: recibe datos (velas, libro) y devuelve
  decisiones.
- **Superficie cerrada.** El adaptador solo llama a los métodos de ccxt de la lista de §1.1. Usar cualquier
  otro método exige un ADR.

### 1.1 Métodos de ccxt permitidos y prohibidos

| Uso | Métodos permitidos |
|---|---|
| Mercados y estado | `loadMarkets`, `fetchTime`, `fetchStatus` |
| Datos de mercado (REST) | `fetchOHLCV`, `fetchOrderBook`, `fetchTicker`, `fetchTickers`, `fetchTrades` |
| Cuenta y órdenes (REST) | `fetchBalance`, `fetchOrder`, `fetchOpenOrders`, `fetchClosedOrders`, `fetchMyTrades`, `createOrder`, `cancelOrder` |
| WebSocket (CCXT Pro) | `watchOrderBook`, `watchTrades`, `watchTicker`, `watchOHLCV`, `watchOrders`, `watchMyTrades`, `watchBalance` |

**Prohibidos**, aunque ccxt los ofrezca:

- Retiros y movimientos de fondos: `withdraw`, `transfer` y similares (`CLAUDE.md` §2). ESLint ya bloquea
  cualquier acceso a una propiedad llamada `withdraw`.
- Margen, apalancamiento, posiciones, derivados y opciones: `set*`, `fetchPositions`, `borrow*` y similares.
  El proyecto es solo spot.
- Órdenes por WebSocket (`createOrderWs`, `cancelOrderWs`, `editOrderWs` y similares). El skill oficial las
  recomienda por su latencia; aquí no aportan nada y añaden un camino de envío más que vigilar.
- `editOrder`: la sustitución la hace Execution como cancelación más orden nueva (exchange-execution §8).
- `cancelAllOrders`: cancelaría también los stops de protección, que el kill switch mantiene
  (trading-risk §6).
- `OrderRouter`, el `execute` de planes de ccxt y el espacio `ccxt.prediction`. `execute` envía órdenes por su
  cuenta, sin pasar por Risk.
- La API implícita (llamadas directas a endpoints del exchange), salvo con un ADR para un dato que la API
  unificada no dé.

### 1.2 Qué impide hoy que Strategy llame al proveedor

- `strategy-no-ccxt`: `src/strategy/` no puede importar ccxt.
- `strategy-no-execution-ni-exchange`: `src/strategy/` no puede importar `src/execution/` ni `src/exchange/`.
- `solo-exchange-importa-ccxt`: fuera de `src/exchange/`, nadie importa ccxt.
- `strategy-solo-importa-lo-permitido` (paso 14, ADR 0015): `src/strategy/` solo importa `shared/`, `kernel/`
  y `features/`. De forma transitoria también `src/config.ts`, `src/indicators.ts` y `src/types.ts`, que usa
  `trend.ts`.

**Hueco cerrado en el paso 14.** Con el `src/` plano, Strategy podía importar `src/broker.ts` o
`src/engine.ts` sin que saltara ninguna regla. La matriz de dependencias de
[ARCHITECTURE.md](../ARCHITECTURE.md) §15 ya lo impide.

Sigue sin verse un objeto inyectado en tiempo de ejecución, porque un análisis de imports no lo detecta. Por
eso el adaptador nunca se pasa a Strategy (ARCHITECTURE.md §15.2).

## 2. Qué aprovechamos de CCXT

| Capacidad | Qué da CCXT | Cómo lo usamos | Cuidado |
|---|---|---|---|
| **Normalización de mercados** | `loadMarkets`: símbolo unificado `BASE/QUOTE`, `id` del exchange, `spot`, `active`, `has` y `features` por exchange | Una carga al arrancar y otra periódica. Solo mercados `spot` activos. Se guarda también el `id` del exchange | `active` puede venir vacío: se trata como no operable. ccxt avisa de que puede cambiar alguna correspondencia de símbolos |
| **Precisión** | `precisionMode` (`TICK_SIZE` en casi todos; comprobado en Binance con 4.5.84) y `market.precision` con el paso de precio y cantidad. `amountToPrecision` trunca y `priceToPrecision` redondea; ambos devuelven cadenas | El paso del mercado se lee como decimal y nuestro tipo decimal redondea (cantidad siempre a la baja, exchange-execution §7). Se envían cadenas ya en el paso, así el formateo de ccxt no cambia nada | En `market.precision` el paso es un `number`. Se toma la cadena original de `info` y el valor de ccxt sirve de contraste [verificar en el paso 17] |
| **Límites** | `limits.amount`, `limits.price` y `limits.cost` con `min` y `max` | Validación previa en el adaptador, con `EXEC_MARKET_RULES` si no se cumple | El manual avisa de que pueden faltar. **Un límite que falta es un error** (fail closed), no un «sin límite» |
| **Históricos** | `fetchOHLCV(symbol, timeframe, since, limit)`: velas en orden cronológico, `since` en ms UTC | Descarga paginada propia con `since` y `limit`: se eliminan duplicados por timestamp, se descarta la vela en curso y se comprueba la continuidad | La última vela está incompleta hasta que cierra. Faltan velas si no hubo operaciones. Sin `since`, cada exchange devuelve un rango distinto. La profundidad histórica es limitada. La paginación automática (`paginate`) es experimental: no se usa |
| **WebSocket (CCXT Pro)** | Viene en el mismo paquete (`ccxt.pro.*`). Gestiona conexión, suscripción, autenticación y keep-alive. Reconecta en la siguiente llamada a `watch*`. Estructuras incrementales con caché (1000 elementos por defecto) | Datos de mercado y canal privado, por latencia. **REST sigue siendo la fuente de verdad** para reconciliar (exchange-execution §12.1) | `newUpdates` va a cambiar de valor por defecto: se fija de forma explícita. Si el bucle deja de llamar a `watch*`, no hay reconexión: los bucles se vigilan |
| **Libro de órdenes** | `watchOrderBook` sincroniza instantánea y diferencias. En Binance (código 4.5.84, `js/src/pro/binance.js`) comprueba los sequence numbers `U`/`u`. Si encuentra un hueco, lanza `ChecksumError`, borra el libro y la siguiente llamada lo vuelve a sincronizar | Se usa, pero con nuestra detección de gaps encima (§3) | El manual de CCXT Pro no documenta esta comprobación como garantía, y cada exchange la implementa a su manera |
| **Errores** | Jerarquía unificada: `BaseError` → `ExchangeError` (rechazos) y `OperationFailed` → `NetworkError` (temporales). Fuente: `ts/src/base/errorHierarchy.ts` | Base de la clasificación de exchange-execution §10.1 | El árbol del skill oficial está simplificado (no muestra `OperationFailed`). Manda el del manual |
| **Firma, nonce y hora** | Firma de peticiones, `fetchTime` y `adjustForTimeDifference` (en Binance viene desactivado) | La firma, tal cual. `adjustForTimeDifference` solo como red de seguridad; el desfase se mide por nuestra cuenta (exchange-execution §13) | Una instancia por clave: dos instancias con la misma clave dan `InvalidNonce` |
| **Testnet** | `setSandboxMode(true)` en los exchanges que tienen entorno de pruebas | Pruebas de humo del adaptador, sin dinero | Disponibilidad y fidelidad del testnet [verificar en el paso 17] |
| **Modo cadena** | `exchange.number = String`: las estructuras unificadas devuelven cadenas en lugar de `number` | Resuelve la marca [verificar] de exchange-execution §17 salvo en el libro por WebSocket | Comprobado en el paso 18 con Bitvavo y ccxt 4.5.84 (`test/docs/ccxt-number-mode.test.ts`): velas, trades, órdenes, ticker, saldos y mercados dan cadenas; el timestamp sigue en milisegundos enteros. **El libro de órdenes por WebSocket no**: `handleDelta` usa `safeFloat` y el libro se indexa en un `Float64Array`, así que `exchange/` convierte las cadenas del mensaje original (paso 32) |

## 3. Qué implementamos nosotros

CCXT es una capa de transporte y normalización. Las garantías que protegen el dinero no se delegan en ella.

| Responsabilidad | Qué hace CCXT | Qué hacemos nosotros | Dónde está la regla |
|---|---|---|---|
| **Idempotencia** | Pasa un `clientOrderId` en `params` si se le da. No persiste nada ni evita duplicados. En Binance, si no se le da, genera uno aleatorio (prefijo de broker más `uuid22`, `js/src/binance.js`): reintentar crearía otra orden | Client order ID derivado del `approval_id` y persistido antes de enviar. El adaptador **se niega a enviar una orden sin nuestro ID**. Nunca se reintenta una creación | exchange-execution §5 |
| **Máquina de estados** | Estado de orden grueso (`open`, `closed`, `canceled`, `expired`, `rejected`), que a veces viene vacío | 11 estados con transiciones cerradas; `filled` solo crece; un estado imposible lleva a UNKNOWN | exchange-execution §4 |
| **Estado UNKNOWN** | El propio manual lo admite: tras un `RequestTimeout` en `createOrder` no se sabe si la orden entró | Toda duda en una orden lleva a UNKNOWN y se reconcilia antes de continuar | exchange-execution §3 y §9 |
| **Reconciliación** | Solo ofrece las consultas (`fetchOpenOrders`, `fetchMyTrades`, `fetchBalance`…) | Comparación con SQLite al arrancar, periódica y tras cada duda, con huérfanas y tolerancias | exchange-execution §14 |
| **Rate limiting propio** | Limitador por instancia (*leaky bucket*), con un `rateLimit` conservador que no conoce otros procesos ni lee las cabeceras de peso. El manual lo llama experimental y deja la responsabilidad al usuario | `enableRateLimit` activo como capa interior. Encima, nuestro presupuesto (35 % bot, 15 % capguard) con las cabeceras de peso, prioridades y tratamiento de 429 y 418 | exchange-execution §11 |
| **Detección de gaps** | En algunos exchanges (Binance comprobado en el código) detecta huecos del libro y lo resincroniza. No cubre una conexión que sigue abierta sin traer datos, ni los huecos del canal privado | Un `ChecksumError` es un gap: el libro no existe para Risk hasta resincronizar. Vigilante propio de 60 s sin mensajes. Toda desconexión del canal privado es un gap y se reconcilia por REST. Prueba con un gap simulado | exchange-execution §12.3 y §12.4 |
| **Reintentos y backoff** | No reintenta (salvo dentro de la paginación automática, que no usamos) | Solo lecturas, con *full jitter* y un máximo de 4 reintentos | exchange-execution §10 |
| **Precisión decimal** | Usa `number` por defecto | Tipo decimal propio; cadenas en las fronteras; `TEXT` en SQLite | exchange-execution §17 |
| **Reloj, dead-man switch y recuperación** | Nada propio | Medición del desfase, `CLOCK_SKEW`, cancel-on-disconnect que respeta los stops, recuperación tras caída | exchange-execution §13, §15 y §16 |

## 4. Versión y política de actualización

**Estado actual** (comprobado el 2026-10-02):

- `package.json` declara `4.5.84` exacta (antes `^4.5.84`) y `package-lock.json` instala **4.5.84**. La
  última versión publicada en
  npm es 4.5.85 (2026-10-01).
- La rama 4.5 lleva 84 versiones de parche desde el 2025-08-13, 7 de ellas desde el 2026-09-01. CCXT no
  promete compatibilidad estricta entre versiones: su manual dice que la biblioteca está en desarrollo y que
  puede cambiar alguna correspondencia.
- `ccxt.version` devuelve 4.5.83 en el paquete 4.5.84. La versión instalada se lee de `package-lock.json`, no
  de esa constante.
- Licencia MIT, 6 dependencias directas (`@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/starknet`,
  `undici`, `ws`) y unos 59 MB instalados. Está en el registro [docs/DEPENDENCIES.md](DEPENDENCIES.md).
- **`postinstall`**: ejecuta `postinstall.js`, que consulta la API de GitHub para mostrar un mensaje con las
  estrellas y la última versión. No modifica nada, pero hace peticiones de red al instalar.

**Versión a fijar: exactamente `4.5.84`**, sin `^`. Aprobada y aplicada el 2026-10-02 (paso 9B). Es la
versión que había en el lockfile y con la que pasa `check:all`. La 4.5.85 tenía menos de 7 días.

**Política de actualización** (aprobada el 2026-10-02, paso 9B):

1. Versión exacta en `package.json`, lockfile versionado y `npm ci` en el VPS.
2. No se actualiza por inercia. Una actualización es un paso propio, con un commit que solo contiene la
   actualización.
3. La versión de destino tiene que llevar al menos 7 días publicada, para dar tiempo a que salgan las
   regresiones y los paquetes comprometidos.
4. Antes de actualizar se revisan:
   - el changelog entre las dos versiones (<https://docs.ccxt.com/docs/changelog>);
   - el diff del archivo del exchange elegido (`js/src/<exchange>.js` y `js/src/pro/<exchange>.js`) y de la
     base (`Exchange.js`, la jerarquía de errores y el redondeo).
5. Las pruebas de contrato del adaptador, con respuestas grabadas y sin red, pasan antes y después. Si hay
   testnet, también la prueba de humo.
6. **Única excepción:** un parche de seguridad crítico puede aplicarse antes de los 7 días. Se revisa
   igualmente el diff, y se sigue el resto del procedimiento. El motivo se documenta.
7. Se revisa al menos cada 3 meses, y siempre que el exchange anuncie un cambio de API, para no quedarse con
   una versión que ya no habla bien con el exchange.
8. Si la actualización cambia algo de este documento, se actualiza en el mismo commit.

## 5. Riesgos conocidos

- **Cambios de API del exchange.** Si el exchange cambia o retira un endpoint, una versión fijada puede dejar
  de funcionar de golpe. Se detecta por los errores, que llevan a UNKNOWN, y por la revisión de §4 punto 7.
- **Cambios de CCXT.** Pueden cambiar correspondencias, valores por defecto (`newUpdates`) y funciones
  experimentales (paginación automática, algoritmos del limitador). Por eso se fijan en la configuración los
  valores de los que dependemos, en lugar de aceptar los de por defecto.
- **Comportamiento distinto por exchange.** Varían:
  - los métodos que existen (`has`, `features`);
  - si faltan límites y cómo se cuenta la precisión;
  - el formato y la longitud del client order ID, y si se puede consultar una orden por él;
  - el canal privado, los valores de `limit` aceptados en el libro y cómo se detectan los gaps;
  - los estados de orden que devuelve.

  Mitigación: al arrancar, el adaptador comprueba que el exchange tiene todos los métodos que necesita y, si
  falta uno, no arranca (fail closed). Las pruebas de contrato se hacen con el exchange elegido en el paso 17.
- **Floats por defecto.** Un `number` de ccxt que se cuele en Execution, Risk o la contabilidad rompe la regla
  de precisión. El adaptador convierte en la frontera, y la regla de ESLint del paso 18 lo hará cumplir.
- **Client order ID automático.** Si una ruta de código llama a `createOrder` sin nuestro ID, ccxt pone uno
  aleatorio y se pierde la idempotencia. El adaptador lo rechaza antes de enviar.
- **Reconexión que depende del bucle.** CCXT Pro solo reconecta cuando se vuelve a llamar a `watch*`. Un bucle
  que se para en silencio deja los datos congelados: lo cubren el vigilante de 60 s y `STALE_DATA`.
- **Cadena de suministro.** Es un paquete grande, con versiones casi semanales y un `postinstall` con red. Lo
  mitigan la versión exacta, la espera de 7 días y la revisión del diff. Si se ejecuta `npm ci --ignore-scripts`
  en el VPS se decide en el paso 39.
- **Ejemplos del skill oficial.** Usan floats, reintentan con esperas fijas, recomiendan órdenes por WebSocket
  y muestran `OrderRouter.execute`. No se copian: aquí mandan exchange-execution y trading-risk.
- **Documentación que cambia.** El manual vive en la rama `master` de CCXT y puede no coincidir con la versión
  fijada. Ante la duda, manda el código de la versión instalada.

## 6. Pendiente de verificar

| Qué | Paso |
|---|---|
| Testnet del exchange elegido: si existe y qué fidelidad tiene | 16 |
| Cadena original del paso de precio y cantidad en `info` para el exchange elegido | 17 |
| Detección de gaps de `watchOrderBook` en el exchange elegido, probada con un gap simulado | 17 |
| Formato del client order ID, y consulta de órdenes por él, en el exchange elegido | 17 |
| Cabeceras de peso y de número de órdenes que expone ccxt (`last_response_headers`) | 17 |
| Canal privado vigente del exchange elegido en CCXT Pro | 31 |

## 7. Fuentes

Consultadas el 2026-10-02:

- Skill oficial `ccxt-typescript`: `.claude/skills/ccxt-typescript/SKILL.md` en la rama `master` de
  <https://github.com/ccxt/ccxt>. **No está instalado en el entorno**: se leyó como documento, sin
  instalarlo.
- Manual de CCXT (`wiki/Manual.md`) y manual de CCXT Pro (`wiki/ccxt.pro.manual.md`) en la rama `master`;
  versión publicada en <https://docs.ccxt.com/docs/manual> y <https://docs.ccxt.com/docs/pro-manual>.
- Código instalado de ccxt 4.5.84: `js/src/base/Exchange.js`, `js/src/binance.js`, `js/src/pro/binance.js`,
  `postinstall.js` y `package.json`.
- Registro de npm (`npm view ccxt`): versiones y fechas.
