---
name: exchange-execution
description: Estándares obligatorios de Inversor JP para hablar con el exchange y gestionar órdenes. Cubre WebSockets, REST, sequence numbers y gaps, reconexión, heartbeat, backoff con jitter, rate limits, client order IDs, idempotencia, order lifecycle, partial fills, rejects, cancel/replace, timeouts, el estado UNKNOWN, reconciliation, clock synchronization, dead-man switch y cancel-on-disconnect, crash recovery y precisión decimal (nunca float para precios, cantidades ni balances). Úsalo antes de escribir, revisar o cambiar código de exchange/ o execution/, de conexiones REST o WebSocket, de envío, cancelación o seguimiento de órdenes, de saldos o fills, de reconciliación o de arranque tras una caída.
---

# exchange-execution

Estos estándares son permanentes. Desarrollan `CLAUDE.md` §2 y complementan
[trading-risk](../trading-risk/SKILL.md): trading-risk decide **qué** orden puede salir; este skill fija
**cómo** se habla con el exchange y cómo se sigue cada orden hasta su estado final. Si algo de aquí choca con
`CLAUDE.md` o con trading-risk, mandan ellos, y se para a preguntar. Las decisiones y los parámetros de
conectividad están en [ADR 0005](../../../docs/adr/0005-exchange-execution.md) y solo cambian con otro ADR.

**Los parámetros de conectividad son provisionales.** Son las cifras de este skill: timeouts, TTL, backoff,
rate limits, WebSocket, reloj y reconciliación. Las reglas son firmes; las cifras se fijan en los pasos 32 y
36 con la documentación oficial del exchange elegido en el paso 17. Ninguna se relaja sin ese dato y sin un
ADR. No hay que confundirlos con los umbrales de mercado del ADR 0003 (spread, slippage y liquidez), que son
del Risk Engine y se fijan en el paso 46.

**Marcas [verificar].** Los ejemplos usan Binance, el exchange por defecto del código actual; el exchange
definitivo se elige en el paso 17. Los detalles de Binance y de ccxt que llevan esta marca se comprobaron solo
en la investigación previa (`docs/research/05` §4) o no se han comprobado. Se verifican contra la
documentación oficial del exchange elegido en los pasos 32 y 36, antes de escribir el código que depende de
ellos.

Archivos de este skill:

- [checklist.md](checklist.md): checklist que se completa antes de aprobar cualquier código de ejecución.

## 1. Principios

1. **El exchange es la fuente de verdad.** SQLite guarda intenciones, órdenes y una caché del estado. Si no
   cuadran, gana el exchange, y la diferencia se investiga; no se «corrige» a ciegas.
2. **Regla UNKNOWN.** Ante duda sobre el estado de una orden, el sistema pasa a UNKNOWN, deja de enviar
   órdenes nuevas y reconcilia con el exchange antes de continuar (§3).
3. **Un timeout no es un fallo: es una duda.** Una orden enviada sin respuesta pudo entrar. Se trata como
   UNKNOWN, nunca como «no enviada».
4. **Nunca se reenvía a ciegas.** Una orden solo se vuelve a intentar cuando se ha confirmado que la anterior
   no existe, y con una aprobación nueva del Risk Engine.
5. **Persistir antes de actuar.** Toda orden queda escrita en SQLite, en una transacción confirmada, antes de
   salir hacia el exchange. Toda respuesta se escribe antes de actuar sobre ella.
6. **Precisión decimal, nunca float** para precios, cantidades, balances, comisiones ni importes (§17).
7. **Con el bot caído, en el exchange solo quedan stops de protección.** Ninguna otra orden puede seguir viva
   indefinidamente sin nadie que la vigile (§15).
8. **Fail closed.** Una respuesta que no se entiende, un dato que falta o un estado imposible llevan a
   UNKNOWN, no a suponer lo más probable.

## 2. Dónde vive cada cosa

| Módulo | Responsabilidad | No puede |
|---|---|---|
| `src/exchange/` | Único que importa ccxt. Clientes REST y WebSocket, rate limiter, reloj, conversión a decimal, clasificación de errores | Decidir si una orden se envía |
| `src/execution/` | Ciclo de vida de las órdenes, client order IDs, modo UNKNOWN, reconciliación, cancel/replace, verificación del token (trading-risk §2.2) | Importar ccxt directamente; enviar sin token válido |
| `capguard/` | Envío real con la clave de trading (trading-risk §3) | Saltarse estas reglas: el envío del capguard las cumple igual |

- La regla `solo-exchange-importa-ccxt` de dependency-cruiser ya obliga a que ccxt solo entre por
  `src/exchange/`.
- `src/exchange/` devuelve tipos propios con valores decimales, nunca las estructuras de ccxt. Así ningún
  `number` de ccxt se cuela en execution, risk ni en la contabilidad.
- Los códigos de rechazo propios de Execution llevan el prefijo `EXEC_`, para distinguirlos de los de Risk, y
  están en el catálogo cerrado de trading-risk §9.2. Un código nuevo exige añadirlo allí y en sus pruebas.
- La reconciliación usa la clave de lectura del proceso principal. Las órdenes las envía el capguard
  (trading-risk §3). Hasta que exista, las envía `LiveBroker`, con las mismas reglas.

## 3. Estado UNKNOWN

### 3.1 Cuándo se entra

El sistema pasa a modo UNKNOWN en cuanto se da cualquiera de estas situaciones:

- una petición que crea, cancela o sustituye una orden agota su timeout o pierde la conexión antes de la
  respuesta;
- una respuesta de orden no se puede interpretar: estado desconocido, campo que falta, valor no decimal;
- una transición imposible (§4.2): un `filled` que baja, que supera la cantidad pedida o que llega a una orden
  terminal;
- un fill o una actualización de una orden que no consta en SQLite;
- el exchange responde «orden desconocida» al cancelar o consultar una orden que el bot cree viva;
- un rechazo por saldo insuficiente (`InsufficientFunds`): el bot creía tener un saldo que no tiene;
- el canal privado de WebSocket (órdenes, fills, saldos) se desconecta o detecta un gap (§12);
- la reconciliación periódica encuentra diferencias de saldo por encima de la tolerancia (§14);
- aparece en la subcuenta una orden sin el prefijo del bot (orden manual, §14.2);
- el exchange veta la IP con un HTTP 418 (§11);
- el vigilante interno detecta el bucle colgado (§15);
- el arranque, siempre: el bot arranca en modo UNKNOWN (§16).

### 3.2 Qué hace

- **Deja de enviar órdenes nuevas**, de cualquier tipo: entradas, salidas por software y stops nuevos. El
  Risk Engine rechaza toda intención con `STATE_UNRECONCILED` (trading-risk §8) y Execution se niega a enviar
  aunque reciba un token válido, con `EXEC_STATE_UNKNOWN` (defensa en profundidad).
- **No salen ventas del bot.** Mientras dura, las posiciones solo las protegen los stops ya puestos en el
  exchange.
- **No cancela los stops de protección nativos.** Siguen protegiendo las posiciones (trading-risk §2.4).
- **Única excepción: el stop que falta.** Si una posición abierta no tiene su stop nativo, y la
  reconciliación ya ha dejado cuadradas las órdenes y los saldos (§14.2, pasos 1 a 6), se coloca ese stop
  como orden `reduce_only` aprobada por el Risk Engine. Es la única orden que sale en modo UNKNOWN. Si su
  envío es dudoso, sigue en UNKNOWN como cualquier otra orden.
- Puede cancelar sus propias órdenes de entrada pendientes, porque cancelar no crea exposición. La respuesta
  de cada cancelación se trata con las mismas reglas: si es dudosa, la orden sigue en UNKNOWN.
- **Lanza una alerta CRITICAL** (§20) por Telegram con el motivo y las órdenes afectadas.
- **Reconcilia con el exchange** (§14) de inmediato.
- Registra la entrada en UNKNOWN, su motivo y las órdenes afectadas en SQLite.

El modo UNKNOWN es global y no por símbolo: en spot todas las órdenes comparten el saldo de la moneda de
cotización, así que una duda sobre una orden es una duda sobre la caja de todas.

### 3.3 Cómo se sale

Solo con una reconciliación completa en verde:

1. cada orden local no terminal tiene un estado confirmado por el exchange;
2. cada fill del exchange consta en SQLite, sin duplicados;
3. los saldos calculados cuadran con los del exchange dentro de la tolerancia (§14.3);
4. no hay ninguna orden sin el prefijo del bot en la subcuenta (§14.2);
5. cada posición abierta tiene su stop nativo confirmado (trading-risk §2.4), si hace falta colocado con la
   excepción de §3.2;
6. el reloj está dentro de margen (§13) y los canales WebSocket están sincronizados (§12).

La salida de UNKNOWN también se registra, con el resultado de la reconciliación.

### 3.4 Si no se resuelve

Si la reconciliación no resuelve la duda en **2 ciclos de reconciliación**, salta el kill switch global
(trading-risk §6: discrepancia que no se resuelve en 2 ciclos) con alerta CRITICAL. Una persona revisa el caso; el bot
no sale solo de ahí.

## 4. Ciclo de vida de una orden (order lifecycle)

### 4.1 Estados

| Estado | Significado | Terminal |
|---|---|---|
| `PENDING_SEND` | Escrita en SQLite, aún no ha salido | No |
| `SENT` | La petición ha salido y no hay respuesta | No |
| `OPEN` | El exchange la aceptó y no tiene ejecuciones | No |
| `PARTIALLY_FILLED` | Ejecutada en parte y aún viva | No |
| `CANCEL_PENDING` | Cancelación pedida y no confirmada | No |
| `FILLED` | Ejecutada por completo | Sí |
| `CANCELED` | Cancelada; puede tener una parte ejecutada | Sí |
| `EXPIRED` | Caducada por el exchange (TTL, IOC o mercado sin liquidez); puede tener una parte ejecutada | Sí |
| `REJECTED` | Rechazada por el exchange; nada ejecutado | Sí |
| `NOT_SENT` | Confirmado que nunca llegó al exchange (§9.2) | Sí |
| `UNKNOWN` | No se sabe; bloquea el sistema (§3) | No |

### 4.2 Transiciones permitidas

- `PENDING_SEND` → `SENT` → `OPEN`, `PARTIALLY_FILLED`, `FILLED`, `EXPIRED` o `REJECTED`.
- `OPEN` → `PARTIALLY_FILLED`, `FILLED`, `CANCEL_PENDING`, `CANCELED` o `EXPIRED`.
- `PARTIALLY_FILLED` → `PARTIALLY_FILLED` (más ejecución), `FILLED`, `CANCEL_PENDING`, `CANCELED` o `EXPIRED`.
- `CANCEL_PENDING` → `CANCELED`, `FILLED` o `EXPIRED` (la orden pudo ejecutarse antes de cancelarse).
- `PENDING_SEND`, `SENT` y `CANCEL_PENDING` → `UNKNOWN` ante cualquier duda (§3.1).
- `UNKNOWN` → cualquier estado, pero **solo desde la reconciliación** y con el estado confirmado por el
  exchange. `UNKNOWN` → `NOT_SENT` solo con las condiciones de §9.2.

Cualquier otra transición es imposible: la orden pasa a `UNKNOWN` y el sistema entra en modo UNKNOWN.

### 4.3 Reglas

- **Una orden terminal no cambia nunca.** Un evento que intente cambiarla es una duda (§3.1).
- **`filled` solo crece** y nunca supera la cantidad de la orden. La posición es la suma de los fills, no la
  cantidad pedida.
- **Los eventos se aplican de forma idempotente** (§5.3): el mismo evento por WebSocket y por REST, o
  repetido tras una reconexión, no cuenta dos veces.
- Cada cambio de estado se guarda con su origen (`rest`, `ws`, `reconciliation`), la marca de tiempo del
  exchange y la local.
- El estado de la orden en el bot se deriva de los datos del exchange (estado, `filled`, fills), no de lo que
  el bot esperaba que pasara.

## 5. Client order IDs e idempotencia

### 5.1 Client order ID

- **Cada orden lleva un client order ID propio**, generado por Execution antes de enviarla.
- **Se deriva del `approval_id`** del token de trading-risk §2.2: prefijo `ijp-` y el UUID en base64url
  (22 caracteres). Una aprobación es de un solo uso, así que una aprobación da como mucho una orden.
- Debe cumplir el formato del exchange. En Binance, hasta 36 caracteres de `[.A-Za-z0-9:/_-]` [verificar].
  Si no cabe, el arranque falla (`CONFIG_INVALID`); no se recorta.
- **Nunca se reutiliza**, ni para un reintento ni para otra intención. Reintentar exige una aprobación nueva
  y, por tanto, un client order ID nuevo.
- El prefijo `ijp-` identifica las órdenes del bot al reconciliar. Una orden sin el prefijo en la subcuenta
  del bot es una operación manual prohibida (trading-risk §2.1).

### 5.2 Persistencia previa

En **una sola transacción confirmada** antes de llamar al exchange:

1. se marca el `approval_id` como usado (trading-risk §2.2);
2. se inserta la orden en estado `PENDING_SEND` con su client order ID, símbolo, lado, tipo, cantidad, precio
   y TTL, todos en decimal.

Si la transacción falla, no se envía nada. Inmediatamente antes de la llamada, la orden pasa a `SENT` con la
marca de tiempo de envío.

### 5.3 Idempotencia de los eventos

- Los fills tienen clave única `(exchange, symbol, trade_id)` en SQLite. Insertar uno repetido no hace nada.
- Una actualización de orden se aplica solo si hace avanzar el estado o el `filled`. Si llega una más
  antigua, se ignora y se registra.
- Una cancelación es idempotente desde el lado del bot: si el exchange responde que la orden no existe o ya
  está cerrada, se consulta su estado; nunca se supone que se canceló.
- Ninguna operación que cree una orden se repite automáticamente (§10.2).

## 6. Ejecuciones parciales (partial fills)

- Toda orden puede ejecutarse en parte, también las de mercado: en spot, una orden a mercado sin liquidez
  suficiente puede acabar `EXPIRED` con una parte ejecutada [verificar en Binance].
- `filled`, `remaining`, el precio medio y las comisiones se recalculan a partir de los fills, en decimal.
- **Comisión en el activo base.** Si la comisión de una compra se cobra en la moneda comprada, la cantidad
  disponible es `filled − comisión`. El stop y las ventas usan la cantidad realmente disponible, redondeada a
  la baja al paso del mercado.
- Una comisión cobrada en otra moneda (por ejemplo, BNB) se registra en esa moneda, con su precio en la
  moneda de cotización en ese momento. No se estima con una tarifa supuesta salvo que el dato falte, y
  entonces se marca como estimada.
- **Cada parte ejecutada de una entrada queda protegida** por el stop nativo (trading-risk §2.4). Cuándo se
  ajusta el stop a la cantidad disponible (con cada parte ejecutada, o al terminar la entrada o vencer su
  TTL) se decide en el paso 36. Se elige la opción que minimice el tiempo sin protección, y se documenta,
  porque sustituir un stop deja una ventana sin protección (§8).
- Los restos por debajo del mínimo del mercado (polvo) se registran como tales y quedan fuera de la lógica de
  posición.

## 7. Rechazos (rejects)

- **Validación previa.** Antes de enviar, Execution comprueba las reglas del mercado: paso de cantidad, paso
  de precio, cantidad mínima, importe mínimo y filtros de precio del exchange. Lo que no las cumple no sale
  (`EXEC_MARKET_RULES`). Si tras redondear la orden ya no coincide con lo aprobado, `APPROVAL_MISMATCH`.
- **El redondeo nunca aumenta el riesgo.** La cantidad se redondea siempre a la baja. El precio límite de
  compra, a la baja; el de venta, al alza; el precio de disparo de un stop de venta, al alza (más cerca del
  mercado, sale antes). Una cantidad redondeada no puede superar la aprobada.
- **Un rechazo definitivo** del exchange deja la orden en `REJECTED`, con `EXCHANGE_REJECTED` y el código del
  exchange en `detail` (trading-risk §9). No se reintenta con otros parámetros: hace falta una intención y una
  aprobación nuevas.
- Rechazos con significado propio:
  - saldo insuficiente: modo UNKNOWN (§3.1);
  - error de timestamp o de `recvWindow`: rechazo, y medición inmediata del reloj (§13);
  - autenticación o permisos: trading-risk §4.7 (repetidos, kill switch global);
  - 429 o 418: §11.
- Rechazos repetidos cuentan como errores de API para la salud del exchange (trading-risk §4.7).

## 8. Cancelación y sustitución (cancel/replace)

- **Primero cancelar, después confirmar, y solo entonces colocar la nueva.** La nueva orden usa la cantidad
  que queda según el `filled` final confirmado de la cancelada, nunca la cantidad original.
- Una orden que se ejecuta mientras se cancela es normal: pasa de `CANCEL_PENDING` a `FILLED` o a `CANCELED`
  con parte ejecutada. La sustitución se recalcula con lo que de verdad quedó.
- Una cancelación sin respuesta o con respuesta dudosa deja la orden en `UNKNOWN` (§3.1). No se coloca la
  sustituta hasta resolverlo.
- **Endpoints atómicos.** Si el exchange ofrece cancelar y colocar en una sola llamada (en Binance,
  cancel-replace [verificar]), solo se usa interpretando por separado el resultado de las dos partes. Si una
  parte falla o es dudosa, modo UNKNOWN.
- **Stops de protección.** Sustituir un stop deja una ventana sin protección, porque en spot el saldo no da
  para dos órdenes de venta (trading-risk §2.4). Esa ventana se mide, se registra y se mantiene lo más corta
  posible. Un stop de protección nunca se cancela sin que la sustitución o la salida estén aprobadas por el
  Risk Engine.
- Cada sustitución es una orden nueva, con su aprobación y su client order ID.

## 9. Timeouts

### 9.1 Timeouts de red

- **Toda petición tiene un timeout explícito**: timeout de 10 s por petición, también en ccxt. Ninguna
  llamada puede colgar el bucle.
- Las duraciones se miden con el reloj monótono (`performance.now()` o `process.hrtime`), no con
  `Date.now()`, que puede saltar al sincronizar.
- **Timeout al crear, cancelar o sustituir una orden: modo UNKNOWN.** No es un error recuperable.
- Timeout en una lectura: se reintenta con backoff (§10).

### 9.2 Cuándo una orden dudosa se da por no enviada

Una orden en `SENT` o `UNKNOWN` sin rastro en el exchange solo pasa a `NOT_SENT` cuando se cumplen las dos
condiciones:

1. han pasado recvWindow + 5 s desde la marca de tiempo con la que se firmó la petición. Pasado ese plazo, el
   exchange ya no puede aceptarla [verificar en Binance];
2. **2 consultas seguidas** por su client order ID, separadas al menos 1 s, responden que no existe. La
   consulta busca también entre las órdenes cerradas.

`NOT_SENT` **no se reenvía automáticamente**. Si la estrategia sigue queriendo operar, lo propone de nuevo en
el siguiente ciclo y pasa otra vez por el Risk Engine.

### 9.3 Tiempo de vida de las órdenes

- Toda orden que no es un stop de protección tiene un TTL explícito, guardado con la orden. Las entradas son
  a mercado, IOC o límite con TTL ≤ 5 min.
- Se usa el TTL del exchange si existe (GTD). Si no, Execution cancela la orden al vencer.
- Al vencer, se cancela y se registra la parte ejecutada.

## 10. REST: errores, reintentos y backoff con jitter

### 10.1 Clasificación de errores

`src/exchange/` traduce cada error a una de estas clases, y nadie fuera de ese módulo mira las excepciones de
ccxt:

| Clase | Ejemplos (ccxt) | Tratamiento |
|---|---|---|
| Transitorio | `RequestTimeout`, `NetworkError`, `ExchangeNotAvailable`, HTTP 5xx | Lectura: reintento con backoff. Orden: modo UNKNOWN |
| Límite de peticiones | `RateLimitExceeded`, `DDoSProtection`, HTTP 429 y 418 | §11 |
| Reloj | `InvalidNonce`, error de timestamp | Medir el reloj (§13) antes de reintentar una lectura |
| Rechazo definitivo | `InvalidOrder`, `BadSymbol` | §7, sin reintento |
| Orden desconocida | `OrderNotFound` al consultar o cancelar una orden que el bot cree viva | Modo UNKNOWN (§3.1) |
| Saldo | `InsufficientFunds` | Modo UNKNOWN (§3.1) |
| Credenciales | `AuthenticationError`, `PermissionDenied` | Sin reintento; repetido, kill switch global |
| Desconocido | Cualquier otro | Como transitorio en lecturas; modo UNKNOWN en órdenes |

### 10.2 Qué se reintenta

- **Solo lecturas y consultas**, que son idempotentes: saldos, órdenes, fills, libro, velas, hora del
  servidor.
- **Nunca** una petición que crea una orden. Tampoco una sustitución.
- Una cancelación no se reintenta a ciegas: primero se consulta el estado de la orden.

### 10.3 Backoff con jitter

- Espera = valor aleatorio entre 0 y `min(tope, base × 2^intento)` (*full jitter*), con base 1 s y tope 60 s.
- Si el exchange envía `Retry-After`, se espera al menos ese tiempo.
- Como mucho 4 reintentos por lectura. Después, la lectura falla y cuenta para la salud del exchange
  (trading-risk §4.7: 3 errores de API consecutivos lo marcan como no sano).
- El mismo backoff se usa para reconectar WebSockets (§12.4). El contador vuelve a 0 cuando la conexión se
  mantiene estable durante 60 s.
- Sin jitter, todos los reintentos llegan a la vez tras un corte, y el exchange los limita.

## 11. Rate limits

- `enableRateLimit` de ccxt siempre activo, y **una sola instancia del cliente por proceso y exchange**, para
  que un único limitador vea todas las peticiones.
- Los límites de Binance son por IP, no por clave [verificar]. El bot y el capguard comparten la IP del VPS,
  así que se reparten el presupuesto: 35 % para el bot y 15 % para el capguard, cada uno con su parte fija
  en su configuración (provisional hasta el paso 32).
- **Presupuesto propio ≤ 50 % del límite de peso** del exchange, sumando las dos partes, medido con las cabeceras de peso usado
  (`X-MBX-USED-WEIGHT-*` en Binance). Al acercarse, se recortan primero los datos de mercado, después las
  lecturas no urgentes. La reconciliación, las cancelaciones y los stops tienen prioridad.
- Los límites de número de órdenes se vigilan aparte de los de peso (`X-MBX-ORDER-COUNT-*` en Binance)
  [verificar].
- **HTTP 429**: se dejan de enviar peticiones a ese exchange hasta que pase `Retry-After`, y el exchange queda
  como no sano (`EXCHANGE_UNHEALTHY`). Execution rechaza las órdenes de mientras con `EXEC_RATE_LIMITED`.
- **HTTP 418** (IP vetada): lo mismo, más una alerta CRITICAL. Con la IP vetada no se puede reconciliar, así que
  el sistema entra en modo UNKNOWN y espera. Los stops nativos siguen protegiendo.
- Se prefiere WebSocket a sondear por REST para todo lo que se consulta a menudo (§12).

## 12. WebSockets

### 12.1 Canales

- **Datos de mercado** (público): libro de órdenes, operaciones, tickers. Alimenta decisiones; si se
  pierde, los datos quedan obsoletos (`STALE_DATA`, trading-risk §4.6) tras 60 s.
- **Canal privado** (órdenes, fills y saldos de la cuenta). Da latencia, pero **REST sigue siendo la fuente
  de verdad para reconciliar**. Si se desconecta, modo UNKNOWN (§3.1).
- El mecanismo del canal privado de Binance spot ha cambiado en los últimos años (listenKey frente a la API
  WebSocket) [verificar]. Se usa el que documente el exchange como vigente al implementar.

### 12.2 Validación de mensajes

- Cada mensaje se valida contra su esquema antes de usarlo. Los precios y cantidades se convierten a decimal
  desde la cadena original (§17).
- Un mensaje de mercado que no se entiende se descarta y se registra. Uno del canal privado que no se
  entiende lleva a modo UNKNOWN.

### 12.3 Sequence numbers y gaps

- **Libro de órdenes**: instantánea por REST más diferencias por WebSocket, con sus sequence numbers. En
  Binance [verificar]:
  1. se abre el WebSocket y se guardan los eventos en un búfer;
  2. se pide la instantánea y se descartan los eventos con `u` ≤ `lastUpdateId`;
  3. el primer evento aplicado debe cumplir `U` ≤ `lastUpdateId + 1` ≤ `u`;
  4. a partir de ahí, cada evento empieza justo después del anterior (`U` = `u` anterior + 1).
- **Un gap invalida el libro.** Se descarta y se vuelve a sincronizar desde una instantánea nueva. Mientras
  tanto el libro no existe para el Risk Engine: los controles de liquidez y slippage no se pueden evaluar y
  cuentan como suspendidos (trading-risk §8).
- Si el exchange publica checksums del libro, se comprueban; un checksum que no cuadra es un gap.
- Si se usa `watchOrderBook` de ccxt, hay que comprobar en el paso del adaptador que aplica este
  procedimiento, y probarlo con un gap simulado [verificar].
- **Canal privado.** Si el exchange da sequence numbers, se comprueban igual. Si no los da, **toda
  desconexión se trata como un gap**: los eventos de mientras se han podido perder, y se reconcilia por REST
  antes de volver a confiar en el canal.

### 12.4 Heartbeat y reconexión (reconnection)

- **Heartbeat.** Se responde a cada ping del servidor con su pong, a tiempo [verificar el intervalo en
  Binance]. Además, un vigilante propio da la conexión por muerta si no llega ningún mensaje en 60 s, ni
  datos ni ping. Una conexión que no se cierra pero ya no trae datos es el fallo más silencioso.
- **Reconexión** con el backoff con jitter de §10.3. Tras reconectar, en este orden:
  1. volver a suscribir los canales;
  2. resincronizar cada libro desde una instantánea;
  3. reconciliar por REST si el canal privado estuvo caído;
  4. solo entonces, volver a usar los datos.
- **Reconexión planificada.** Si el exchange cierra las conexiones a las 24 h [verificar], el bot reconecta
  por su cuenta antes de 23 h, con una conexión nueva abierta antes de cerrar la vieja.
- Todo corte y toda reconexión se registran con su duración.

## 13. Sincronización de reloj (clock synchronization)

- **NTP obligatorio** en la máquina: chrony o `systemd-timesyncd` en el VPS, el servicio de hora de Windows en
  el portátil. Hoy el portátil está sin sincronizar (`docs/research/05` §4.5).
- **Medición contra el exchange** al arrancar, cada hora y tras cualquier error de timestamp:
  `desfase = hora_servidor − (t_envío + t_respuesta) / 2`. Si la ida y vuelta tarda más de 1 s, la medición
  no vale y se repite.
- **Desfase de más de 1 s**: no se envían órdenes (`CLOCK_SKEW`, trading-risk §4.6) y se avisa.
- recvWindow ≤ 5000 ms. **Nunca se sube para tapar un reloj desfasado**: se arregla el reloj.
- La opción `adjustForTimeDifference` de ccxt es una red de seguridad. El desfase se mide igualmente contra el
  reloj local sin corregir, porque es el que hay que arreglar.
- Las marcas de tiempo de negocio se guardan en UTC, en milisegundos, con la hora del exchange cuando la hay
  y la local al lado.

## 14. Reconciliación (reconciliation)

### 14.1 Cuándo

- Al arrancar, siempre (§16).
- Al entrar en modo UNKNOWN.
- Tras reconectar el canal privado.
- De forma periódica, al menos cada 10 min, aunque todo vaya bien (trading-risk §4.6).

### 14.2 Cómo

1. Cargar de SQLite las órdenes no terminales, los stops nativos y las posiciones abiertas.
2. Pedir al exchange los saldos, las órdenes abiertas y los fills desde la última marca guardada.
3. Para cada orden local no terminal, consultarla por su client order ID y fijar su estado, `filled`,
   precio medio y comisiones.
4. Registrar los fills que falten, de forma idempotente (§5.3).
5. Para cada orden abierta en el exchange que no consta en SQLite:
   - con el prefijo `ijp-` (orden huérfana): no debería existir, porque toda orden se escribe antes de
     enviarse. Indica una base de datos perdida o restaurada. **No se adopta ni se toca: se lanza una alerta
     CRITICAL y se bloquean las órdenes nuevas en ese símbolo** (`EXEC_ORPHAN_ORDER`) hasta que lo resuelva
     una persona. La huérfana por sí sola no mantiene el modo UNKNOWN global; si sus fills o el saldo que
     bloquea descuadran los saldos, se aplica §14.3.
     **Resolución:** una persona da la orden de desbloqueo desde un canal autenticado, con un motivo
     escrito, y queda registrada, igual que el rearme de los breakers manuales (trading-risk §5);
   - sin el prefijo (orden manual): operación prohibida (trading-risk §2.1). La subcuenta es exclusiva del
     bot, así que indica otro operador o una clave comprometida. **Bloqueo total:** no se toca, se lanza una
     alerta CRITICAL y el sistema sigue en modo UNKNOWN mientras exista. A los 2 ciclos salta el kill switch
     global (§3.4), y es uno de los casos del kill switch externo (trading-risk §7).
6. Comparar las posiciones calculadas con los saldos del exchange (§14.3).
7. Comprobar que cada posición abierta tiene su stop nativo y que coincide con lo guardado (trading-risk
   §2.4). Si falta y los pasos 1 a 6 han cuadrado, se coloca con la única excepción de §3.2.
8. Si todo cuadra, salir de modo UNKNOWN (§3.3), aunque queden símbolos bloqueados por órdenes huérfanas. Si
   no, seguir en él (§3.4).

### 14.3 Tolerancia

- Se compara en decimal, nunca en float.
- Tolerancia: diferencia ≤ 1 paso de cantidad del mercado, o polvo ya registrado. Cualquier otra diferencia
  deja el estado sin reconciliar.
- La reconciliación **no corrige** los saldos para que cuadren. Si no cuadran, avisa y deja el caso a una
  persona.

## 15. Dead-man switch y cancel-on-disconnect

El objetivo es que un bot caído no deje en el exchange nada que pueda ejecutarse sin vigilancia, salvo los
stops de protección.

- **Cancel-on-disconnect o dead-man switch del exchange** (cancelar todo si el cliente deja de renovar un
  temporizador, como `CancelAllOrdersAfter` de Kraken). Solo se activa si **no cancela los stops de
  protección**. El de Kraken los cancela (`docs/research/05` §4.6), y dejaría las posiciones sin stop justo
  cuando el bot está caído. Si el exchange no ofrece uno que respete los stops, no se usa.
- Si no hay uno utilizable, el mismo efecto se consigue con los TTL (§9.3): ninguna orden que no sea un stop
  de protección vive más que su TTL, aunque el bot muera.
- **Dead-man switch externo.** Latido a un vigilante externo (healthchecks.io, `docs/research/05` §4.6) al
  final de cada ciclo completo del bucle de trading, no desde un temporizador aparte. Si deja de llegar,
  avisa por dos canales.
- **Vigilante interno.** Si el bucle de eventos se bloquea o un ciclo dura más de lo previsto, el bot entra
  en modo UNKNOWN y avisa. Un bot vivo pero colgado es tan peligroso como uno caído.

## 16. Recuperación tras caída (crash recovery)

- **El bot puede morir en cualquier instante**: Windows no avisa al proceso antes de matarlo
  (`docs/research/05` §1), y un VPS puede reiniciarse. Ningún paso depende de un cierre limpio.
- **El arranque empieza en modo UNKNOWN.** No se envía ninguna orden hasta reconciliar (§14).
- SQLite en modo WAL. Cada cambio de estado de una orden va en una transacción; nunca hay una orden a medio
  escribir.
- Las órdenes en `PENDING_SEND` al arrancar se resuelven como `SENT`: pudieron salir justo antes de la caída.
  Se buscan por su client order ID y, si no existen, pasan a `NOT_SENT` con las condiciones de §9.2.
- Los tokens de aprobación anteriores a la caída ya no valen: el par de claves cambia al reiniciar
  (trading-risk §2.2).
- El kill switch y los circuit breakers se leen de SQLite al arrancar (trading-risk §5 y §6).
- **Restaurar una copia de SQLite** es un caso especial: la copia es más antigua que el exchange. Se arranca
  en modo UNKNOWN y una persona revisa la reconciliación antes de volver a operar.

## 17. Precisión decimal

- **Nunca float para precios, cantidades ni balances**, y tampoco para comisiones, importes, PnL ni ningún
  valor que vaya a una orden, a un fill o a la contabilidad. `0.1 + 0.2` no es `0.3` en float.
- **Tipo decimal propio.** Todo el código de exchange, execution, risk y contabilidad usa un tipo decimal
  exacto con modo de redondeo explícito. Por dentro usa una biblioteca madura (por ejemplo decimal.js),
  envuelta en un tipo propio para poder sustituirla sin tocar el resto del código. La decisión definitiva
  va en un ADR en el paso 14, y la implementación, al inicio del paso 18.
- **Se hace cumplir de forma automática.** Una regla de ESLint en los módulos de dinero (paso 18) prohíbe
  `number` en esos valores, y un test (paso 33) falla si el esquema de SQLite tiene columnas `REAL`, `FLOAT`
  o `DOUBLE`.
- **En las fronteras, cadenas.**
  - Entrada: los valores del exchange se convierten a decimal desde su cadena original, no desde un `number`.
    ccxt devuelve `number` en sus estructuras unificadas; la cadena original suele estar en `info`
    ccxt ofrece un modo cadena (`exchange.number = String`, [docs/CCXT.md](../../../docs/CCXT.md) §2)
    [verificar en el paso 18 qué estructuras cubre, incluidas las de WebSocket].
  - Salida: las cantidades y los precios se envían como cadenas ya redondeadas al paso del mercado.
  - SQLite: columnas `TEXT` con el decimal en forma canónica, nunca `REAL`.
  - JSON y logs: cadenas.
- **Redondeo explícito** en cada conversión, con el sentido de §7: la cantidad, siempre a la baja.
- Las comparaciones (igualdad, mayor que, tolerancias) se hacen en decimal.
- **El float solo se permite en análisis**: indicadores, estadísticas y features. Cuando un resultado de
  análisis se convierte en un precio o una cantidad de orden, pasa a decimal con redondeo explícito en ese
  punto, y desde ahí no vuelve a float.
- Un valor que no es un decimal válido (vacío, `NaN`, infinito, notación que no se espera) es un error: en una
  orden, modo UNKNOWN; en datos de mercado, dato descartado.

## 18. Estado actual del código

El código previo (`PRE-REFACTOR-RECOVERY`) **no cumple** estos estándares. Las brechas se corrigen en el
refactor, no a escondidas en otro paso:

- **Riesgo de orden duplicada.** Si `LiveBroker` pierde la respuesta de `createOrder`, busca la orden durante
  unos 15 s y, si no la encuentra, lanza un error. `engine.ts` lo da por fallo y reintenta en el siguiente
  ciclo con un client order ID nuevo. Si la orden sí entró, se envía dos veces.
- El client order ID (`newClientOrderId`, prefijo `jp-` en lugar del estándar `ijp-`) se genera en
  `engine.ts` por cada intento, no se deriva de una aprobación y no se guarda antes de enviar: solo aparece
  en la tabla `fills` después.
- No hay niveles de alerta: `log.ts` usa `info`, `warn` y `error`, y los avisos de Telegram no distinguen
  INFO, WARNING y CRITICAL (§20).
- No hay tabla de órdenes, ni máquina de estados, ni estado UNKNOWN, ni reconciliación al arrancar.
- `waitFilled` espera 10 s: si la orden sigue abierta con una parte ejecutada, devuelve esa parte y deja el
  resto vivo en el exchange, sin seguimiento ni TTL.
- **Todo es float**: `Number(...)` sobre los valores de ccxt, y columnas `REAL` en SQLite para cantidades,
  precios, comisiones y saldos.
- La comisión cobrada en otra moneda se estima con la tarifa taker.
- Sin WebSockets: todo se consulta por REST.
- Timeout de 20 s, sin medición del desfase de reloj (solo `adjustForTimeDifference`), sin tratamiento propio
  de 429 y 418, sin cancelación ni sustitución de órdenes, sin dead-man switch y sin stops nativos.
- Lo que sí existe: `enableRateLimit`, reintentos con backoff exponencial y jitter solo en lecturas
  (`withRetry`), búsqueda por client order ID tras un error de red, y velas filtradas para usar solo las ya
  cerradas.

Hasta que se corrijan, **no se opera en real**.

## 19. Cómo trabajar

1. Antes de tocar código de exchange o de ejecución, leer este skill y trading-risk, y copiar
   [checklist.md](checklist.md) en la descripción del cambio.
2. Cada regla de este skill que implemente el código lleva una prueba que la demuestre, incluidos los casos
   de fallo: timeout al enviar, respuesta perdida, fill duplicado, gap, desconexión y caída a mitad de envío.
3. Las pruebas no hablan con el exchange real. Usan un exchange simulado que puede perder respuestas,
   duplicar eventos, reordenarlos y cortar la conexión.
4. Un detalle marcado [verificar] se comprueba en la documentación oficial antes de escribir el código que
   depende de él, y se cita la fuente en el código o en el ADR.
5. Cambiar un parámetro de conectividad o una regla exige un ADR nuevo.

## 20. Niveles de alerta

Toda alerta lleva uno de estos tres niveles, con estos nombres exactos:

| Nivel | Cuándo | Ejemplos |
|---|---|---|
| INFO | Hechos normales que conviene saber; no piden nada | Órdenes ejecutadas, reconexión breve, salida de modo UNKNOWN |
| WARNING | Degradación que el bot gestiona solo, pero que conviene mirar | Exchange no sano, HTTP 429, lecturas que agotan sus reintentos, datos obsoletos, desfase de reloj, gap del libro |
| CRITICAL | Exige atención humana | Ver la lista de abajo |

Son CRITICAL, como mínimo:

- entrar en modo UNKNOWN;
- el kill switch global;
- una orden huérfana con el prefijo del bot;
- una orden manual detectada (sin el prefijo del bot);
- un rechazo del capguard;
- un HTTP 418.

Un evento CRITICAL nunca se rebaja de nivel para no molestar. Los niveles del log (`info`, `warn`, `error`)
se alinean con estos en el refactor (§18).
