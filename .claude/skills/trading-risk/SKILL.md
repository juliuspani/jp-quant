---
name: trading-risk
description: Reglas permanentes de riesgo y ejecución de Inversor JP. Fija el flujo Strategy → Risk Engine → Execution con token de aprobación firmado, las tres capas de límite de capital (exchange, capguard, Risk Engine), los controles del Risk Engine, los circuit breakers, el kill switch global y el externo, fail closed y los reason_code persistidos. Úsalo antes de escribir, revisar o cambiar código que genere, valide, dimensione, envíe o cancele órdenes, que toque límites, configuración de riesgo, claves del exchange o el arranque en real, y ante cualquier incidente con dinero real.
---

# trading-risk

Estas reglas son permanentes. Desarrollan `CLAUDE.md` §2 («Arquitectura y flujo» y «Seguridad operativa»),
pero no lo sustituyen: si algo de aquí choca con `CLAUDE.md`, manda `CLAUDE.md`. Las decisiones y los
umbrales están en [ADR 0003](../../../docs/adr/0003-trading-risk.md) y solo cambian con otro ADR.

**Los umbrales numéricos son provisionales.** Las reglas son firmes, pero las cifras se fijarán con datos en
el paso 35 (Risk Engine) y en el paso 46 (micro-live). Hasta entonces se usan los valores de este skill, y
ningún umbral se relaja sin ese dato y sin un ADR.

Archivos de este skill:

- [checklist.md](checklist.md): checklist de revisión de cambios y de paso a real.

## 1. Principios

1. **Strategy → Risk Engine → Execution, siempre.** Ningún módulo, usuario, LLM ni estrategia se salta el
   Risk Engine. No hay modo de depuración, flag ni comando manual que lo evite.
2. **Strategy propone, Risk decide, Execution obedece.** Strategy produce intenciones de orden. El Risk
   Engine las aprueba, las reduce o las rechaza; nunca las agranda. Execution solo envía lo que Risk firmó.
3. **Fail closed.** Ante duda, error, dato que falta o estado desconocido, no se abre riesgo (§8).
4. **Defensa en profundidad.** El Risk Engine es la capa más débil de las tres (§3): comparte proceso con el
   código del que protege. Las capas externas existen porque el Risk Engine puede fallar.
5. **Todo rechazo deja rastro.** Cada rechazo, en cualquier capa, tiene un `reason_code` persistido (§9).
6. **Un LLM solo puede apretar.** La inteligencia de LLM o de noticias puede reducir el tamaño o bloquear
   entradas. Nunca puede relajar un límite, crear una intención de orden ni llegar a Execution.

## 2. Flujo obligatorio y token de aprobación

### 2.1 Quién hace qué

| Paso | Módulo | Produce | No puede |
|---|---|---|---|
| 1 | Strategy (y comandos manuales de Telegram o del panel) | `OrderIntent`: símbolo, lado, cantidad o importe deseado, stop, motivo y origen | Importar `execution/`, `exchange/` ni el firmante de `risk/` |
| 2 | Risk Engine | `RiskDecision` persistida y, si aprueba, un `ApprovedOrder` firmado | Enviar órdenes ni agrandar una intención |
| 3 | Orquestación (`engine`) | Pasa el `ApprovedOrder` a Execution sin modificarlo | Crear o alterar aprobaciones |
| 4 | Execution | Verifica el token y envía la orden (o la pasa al capguard, §3) | Aceptar una orden sin token válido |

Un comando manual del usuario (por ejemplo, una compra pedida por Telegram) es un `OrderIntent` con
`origen: "manual"` y pasa por el mismo Risk Engine. Operar a mano en la subcuenta del bot desde la app del
exchange está prohibido: el bot lo detecta al reconciliar y queda en `STATE_UNRECONCILED` (§8).

### 2.2 El token de aprobación

Un `ApprovedOrder` lleva estos campos, serializados en JSON canónico (claves ordenadas, sin espacios):

| Campo | Contenido |
|---|---|
| `approval_id` | UUID aleatorio. Es el nonce: se usa una sola vez |
| `intent_id` | Intención de la que sale |
| `symbol`, `side`, `type` | Exactamente los aprobados |
| `max_quantity` | Cantidad máxima en moneda base |
| `max_notional` | Importe máximo en moneda de cotización, para compras |
| `reduce_only` | `true` en salidas: solo puede reducir una posición existente |
| `issued_at`, `expires_at` | Validez ≤ 10 s |
| `config_hash` | Hash de la configuración de riesgo con la que se decidió |
| `signature` | Firma Ed25519 del resto de campos |

**Firma.** El Risk Engine genera un par de claves Ed25519 en memoria al arrancar. La clave privada no se
guarda en disco, no sale de `risk/` y no se exporta: vive en un cierre del módulo firmante,
`src/risk/signer.ts`, que solo se importa desde `src/risk/`. La clave pública
se entrega a Execution (y al capguard) en el arranque. Al reiniciar cambia el par, así que los tokens
anteriores dejan de valer.

**Verificación en Execution.** Antes de enviar nada, Execution comprueba, en este orden:

1. Que hay token (`APPROVAL_MISSING`).
2. Que la firma es válida (`APPROVAL_BAD_SIGNATURE`).
3. Que no ha caducado (`APPROVAL_EXPIRED`).
4. Que el `approval_id` no se ha usado (`APPROVAL_REPLAYED`). Se marca como usado en SQLite, con restricción
   `UNIQUE`, **antes** de enviar la orden. Así un reintento o un reinicio no lo reutilizan.
5. Que la orden coincide con lo aprobado: mismo símbolo, lado y tipo; cantidad ≤ `max_quantity`; importe al
   precio de envío ≤ `max_notional`; y, si `reduce_only`, cantidad ≤ posición abierta
   (`APPROVAL_MISMATCH`).

Un fallo de firma o una reutilización no es un error normal: indica un fallo de programación o una
manipulación. Activa el kill switch global (§6).

**Única excepción.** Cancelar órdenes propias abiertas no necesita token, porque no crea exposición. Toda
cancelación se registra igual. Los stops de protección nativos (§2.4) quedan fuera de esta excepción:
cancelar uno deja la posición sin protección. Solo se cancelan como parte de una salida o de una
sustitución aprobadas por el Risk Engine.

### 2.3 Por qué no se puede falsificar desde Strategy

La garantía tiene tres partes, y las tres son obligatorias:

1. **Criptografía.** Sin la clave privada no se puede producir una firma que Execution acepte.
2. **Tipos.** `ApprovedOrder` es un tipo marcado con un `unique symbol` que no se exporta fuera de `risk/`.
   Strategy no puede construir uno ni siquiera por error.
3. **Límites entre módulos.** dependency-cruiser prohíbe que `strategy/`, `features/`, `llm/` y `news/`
   importen `execution/` o `exchange/`. La regla `solo-risk-usa-el-firmante` prohíbe que ningún módulo de
   fuera de `src/risk/` importe `src/risk/signer.ts`, ni siquiera Execution o la orquestación.

Esto protege contra errores y contra rutas de código de estrategia o de LLM. **No protege contra un proceso
comprometido**, que podría leer la memoria del Risk Engine. Contra eso están las capas 1 y 2 (§3).

### 2.4 Stops de protección nativos del exchange

Cada posición abierta tiene, además del stop que vigila el bot, una orden de stop nativa en el exchange.
Esa orden protege la posición aunque el bot, el capguard o el VPS estén caídos. Se implementa en el paso 36.

- **Pasa por el flujo normal.** El stop nativo es una orden `reduce_only` aprobada por el Risk Engine y
  enviada por Execution a través del capguard, justo después de que se llene la entrada.
- **Sin stop nativo no hay entradas nuevas.** Si una posición abierta no tiene su stop nativo confirmado en
  el exchange, el Risk Engine rechaza las entradas (`PROTECTIVE_STOP_MISSING`) y avisa hasta que se coloca.
- **La reconciliación conoce los stops nativos.** El bot guarda cada stop nativo: identificador del
  exchange, `clientOrderId`, cantidad, precio de disparo y precio límite. En cada reconciliación los compara
  con las órdenes abiertas del exchange. Así se evitan órdenes duplicadas:
  - antes de una salida por software (stop, trailing, venta parcial o salida de la estrategia), se cancela o
    se ajusta el stop nativo. Si no, se venderían dos veces. En spot, además, la orden de stop bloquea el
    saldo y la venta fallaría;
  - un stop nativo que ya se ejecutó con el bot caído se detecta al reconciliar, y la posición se da por
    cerrada: no se vuelve a vender ni se coloca otro stop;
  - al subir el stop (trailing) se sustituye el anterior. Hay que cancelar antes de colocar el nuevo, porque
    el saldo no da para los dos. Esa ventana sin protección se acota y se registra;
  - un stop nativo que no aparece en el exchange y no consta como ejecutado deja el estado sin reconciliar
    (`STATE_UNRECONCILED`).
- **Un stop-limit puede no ejecutarse en un gap.** Al dispararse, un stop-limit se convierte en una orden
  límite. Si el precio salta por debajo del límite, la orden se queda sin llenar y la pérdida puede superar
  con mucho la prevista. Por eso:
  - se prefiere un stop a mercado cuando el par lo admite en spot. Los tipos disponibles cambian según el
    exchange y el par, y se comprueban en el paso 36;
  - con stop-limit, el precio límite deja un margen por debajo del de disparo;
  - un stop disparado que no se llena se trata como salida urgente: se cancela y se envía una venta
    `reduce_only` a mercado;
  - el riesgo por operación (§4.1) asume que el stop se ejecuta cerca de su precio. Un gap lo rompe, y ese
    riesgo residual no desaparece con ningún tamaño.

## 3. Tres capas de límite de capital

Van de la más fuerte a la más débil. Cuanto más débil es una capa, más código comparte con aquello de lo
que protege. Una capa nunca justifica relajar otra.

### Capa 1 — Exchange

No depende de nuestro código: es la única que aguanta un bot completamente roto o comprometido.

- **Subcuenta o cuenta dedicada solo al bot** con solo el capital asignado. Si el exchange no da subcuentas a
  particulares (Bitvavo, ADR 0018), la cuenta entera es del bot y el resto del dinero está en otra entidad, sin
  transferencias automáticas. Las recargas las hace un humano, a mano.
- **API sin retiros.** Permisos: lectura y trading spot. Sin retiros, sin transferencias entre cuentas, sin margen y sin futuros.
- **Whitelist de IP.** La clave solo funciona desde la IP fija del VPS (`docs/research/05` §2.2).
- En la cuenta principal: segundo factor (no SMS), código antiphishing y lista blanca de direcciones de
  retiro.
- **Comprobación al arrancar en real.** Si el exchange expone las restricciones de la clave, el bot las lee
  y no arranca si la clave permite retiros, margen o futuros, o si no tiene restricción de IP
  (`CONFIG_INVALID`). Si no las expone, se comprueba a mano con el checklist.

### Capa 2 — Capguard (proceso independiente de capital cap)

Proceso del sistema operativo aparte, que **no comparte código con Strategy** ni con el resto de `src/`.

- **Código separado.** Vive en `capguard/`, fuera de `src/`. No importa nada de `src/` y nada de `src/` lo
  importa. Solo depende de Node y del cliente mínimo del exchange. No usa LLM.
- **Es el único que tiene la clave de trading.** El proceso principal solo tiene una clave de lectura.
  Execution entrega cada orden aprobada al capguard por IPC local, y el capguard decide si la envía.
- **Datos propios.** Lee él mismo saldos, órdenes y precios del exchange. No se fía de lo que le cuenta el
  proceso principal.
- **Topes propios**, más laxos que los del Risk Engine pero muy por debajo del capital, de modo que salte
  solo si el Risk Engine ha fallado:

| Tope del capguard | Valor |
|---|---|
| Importe por orden | ≤ 30 % del capital asignado |
| Exposición total | ≤ 80 % del capital asignado |
| Pérdida en el día (UTC) | 3 % del capital asignado: bloquea compras hasta el día siguiente |
| Pérdida acumulada | 12 % del capital asignado: bloqueo que solo levanta un humano |
| Mercados | Solo spot y solo los símbolos de su lista |

- **Configuración que el bot no puede tocar.** Su archivo de topes pertenece a otro usuario del sistema
  operativo, sin permiso de escritura para el proceso principal. La separación de usuarios en el VPS se
  implementa en el paso 39.
- **Límites en el código.** dependency-cruiser analiza `src/` y `capguard/` cuando existe. Las reglas
  `capguard-no-importa-src` y `src-no-importa-capguard` impiden compartir código en cualquier dirección.
- **Verifica el token** con la clave pública (defensa adicional). Lo que decide son sus topes.
- **Fail closed.** Si el capguard no responde, no sale ninguna orden (`CAP_UNAVAILABLE`).
- **Avisa por su cuenta**, por su propio canal de Telegram, y registra sus rechazos en su propio archivo
  con los códigos `CAP_*`.
- Cualquier rechazo del capguard es un incidente: significa que el Risk Engine dejó pasar algo que no
  debía. Activa el kill switch global.

### Capa 3 — Risk Engine

Módulo `risk/` del proceso principal. Aplica todos los controles de §4 y §5 a cada intención, mantiene el
estado de los circuit breakers y del kill switch, y firma las aprobaciones.

## 4. Controles del Risk Engine

Valores por defecto en el ADR 0003. Los topes duros de `src/config.ts` impiden arrancar con valores más
arriesgados. Cada control tiene su `reason_code` (§9).

### 4.1 Tamaño de posición (position sizing) y riesgo por operación (risk per trade)

- El tamaño sale del riesgo: la pérdida si salta el stop es **0,75 % del patrimonio** por operación del
  núcleo. El tope duro es 2 %.
- `cantidad = (patrimonio × riesgo %) / riesgo por unidad`, donde el riesgo por unidad es
  `(entrada − stop) + costes por unidad`. Los costes incluyen la comisión de entrada y de salida, medio
  spread y el slippage estimado. Sin costes, el tamaño sale más grande de lo que debe.
- Sin stop, o con un stop que no está por debajo de la entrada, se rechaza (`STOP_INVALID`).
- Después se aplica el menor de todos los topes (§4.2–§4.6) y el 99 % de la caja libre. Si la cantidad
  final queda por debajo del mínimo propio o del exchange, se rechaza (`BELOW_MIN_NOTIONAL`).
- El multiplicador de la inteligencia (0–1) solo reduce. Con 0, se rechaza (`EVENT_RISK`).

### 4.2 Exposición máxima (maximum exposure)

- Exposición total en activos que no son la moneda de cotización: ≤ **75 % del patrimonio**
  (`MAX_EXPOSURE`).
- Posiciones abiertas a la vez: ≤ **6** (`MAX_OPEN_POSITIONS`).
- Sin caja suficiente, se rechaza (`INSUFFICIENT_CASH`).

### 4.3 Concentración (concentration)

- Por activo, sumando la posición que ya existe: ≤ **25 % del patrimonio** (`CONCENTRATION_LIMIT`).
- Por clúster correlacionado (§4.4): ≤ **50 % del patrimonio** (`CORRELATION_LIMIT`).
- Explorador de monedas pequeñas: ≤ **5 % del patrimonio** en total (`CONCENTRATION_LIMIT`).

### 4.4 Correlación (correlation)

- Dos activos están en el mismo clúster si la correlación de sus rendimientos diarios en 90 días es
  **ρ ≥ 0,80**, calculada solo con datos pasados.
- Sin datos suficientes para calcularla (listado reciente, huecos), se asume ρ = 1.
- En una caída fuerte las criptomonedas tienden a moverse juntas: por eso la exposición total (§4.2) es el
  tope que de verdad manda.

### 4.5 Liquidez (liquidity), spread y slippage

- **Liquidez.** Importe de la orden ≤ **1 % del volumen de 24 h** del par, y profundidad del libro a ±0,5 %
  del precio medio ≥ **5 veces el importe** de la orden (`LIQUIDITY_TOO_LOW`).
- **Spread.** `(ask − bid) / precio medio` ≤ **0,15 % en el núcleo** y ≤ **0,40 % en el explorador**
  (`SPREAD_TOO_WIDE`).
- **Slippage.** El slippage se estima recorriendo el libro con el tamaño de la orden. Si supera el
  **0,30 % estimado**, se rechaza (`SLIPPAGE_TOO_HIGH`).

### 4.6 Datos obsoletos (stale data)

- Precio (ticker o libro) con más de **60 s** de antigüedad: `STALE_DATA`.
- Señal calculada sobre una vela cerrada hace más de **20 min**: `SIGNAL_TOO_OLD`.
- Saldos y posiciones sin reconciliar con el exchange en los últimos **10 min**: `STATE_UNRECONCILED`.
- Reloj local desfasado más de **1 s** respecto al del exchange: `CLOCK_SKEW`.

### 4.7 Salud del exchange (exchange health)

El exchange se marca como no sano (`EXCHANGE_UNHEALTHY`) si se da cualquiera de estas condiciones:

- su endpoint de estado no informa de funcionamiento normal o anuncia mantenimiento;
- hay **3 errores de API consecutivos**;
- llega cualquier HTTP 429 o 418 (`docs/research/05`): hay que dejar de insistir y respetar
  `Retry-After`.

Vuelve a sano tras **5 min sin errores**. Los errores de autenticación repetidos (clave revocada o IP fuera
de la whitelist) activan el kill switch global.

### 4.8 Riesgo de evento (event risk)

No se abren posiciones (`EVENT_RISK`) en estos casos:

- desde **30 min antes hasta 60 min después** de un dato macro de alto impacto de EE. UU. (FOMC, IPC,
  empleo, PCE), con el calendario de `docs/research/03-fuentes-de-informacion.md`;
- en un símbolo con anuncio de deslistado, mantenimiento o suspensión de depósitos o retiros;
- si la moneda de cotización (USDT) pierde la paridad por debajo de **0,99**;
- si el módulo de inteligencia bloquea entradas.

### 4.9 Mercado permitido

Solo spot, sin apalancamiento, mercado activo y símbolo dentro del universo configurado
(`MARKET_NOT_ALLOWED`).

## 5. Circuit breakers

Un circuit breaker bloquea **entradas**. Las salidas que solo reducen (`reduce_only`) siguen permitidas,
salvo con el kill switch activo (§6).

| Breaker | Dispara con | Efecto | Se rearma |
|---|---|---|---|
| Pérdida diaria (daily loss) | Patrimonio −**2 %** desde el inicio del día UTC | Sin entradas (`DAILY_LOSS_LIMIT`) | Solo, al empezar el día UTC siguiente |
| Drawdown | Caída del **10 %** desde el máximo | Sin entradas (`DRAWDOWN_HALT`) | Solo un humano |
| Pérdidas consecutivas (consecutive losses) | **3 pérdidas** seguidas | Sin entradas durante **24 h** (`LOSS_STREAK_COOLDOWN`) | Solo, al pasar el plazo |
| Slippage real | Media de los 10 últimos fills > 2 veces lo estimado | Sin entradas (`SLIPPAGE_BREAKER`) | Solo un humano |
| Datos y exchange | §4.6 y §4.7 | Sin entradas | Solo, con histéresis |
| Pausa manual | Orden del usuario | Sin entradas (`MANUAL_PAUSE`) | Solo un humano |

- El estado de los breakers se persiste: sobrevive a un reinicio.
- Rearmar un breaker manual exige una orden explícita desde un canal autenticado, con un motivo escrito,
  y queda registrado. Rearmar el de drawdown no borra el máximo histórico sin dejar constancia.

## 6. Kill switch global

Para todo. Es más fuerte que cualquier breaker.

- **Efecto.**
  - **Bloquea órdenes nuevas.** El Risk Engine rechaza todas las intenciones, incluidas las salidas por
    software (`KILL_SWITCH_ACTIVE`).
  - **Cancela las pendientes.** Execution cancela las órdenes propias abiertas.
  - **Mantiene los stops de protección.** Los stops nativos (§2.4) no se cancelan: siguen protegiendo las
    posiciones mientras el bot está parado.
  - **No vende posiciones.** Vender en pánico o en un mercado sin liquidez puede costar más que esperar.
    Qué hacer con las posiciones lo decide una persona.
- **Cómo se activa a mano.** Comando de Telegram desde el chat autorizado, botón del panel, o un archivo
  centinela `data/KILL` (basta con que exista).
- **Cómo se activa solo.** Con cualquiera de estas condiciones:
  - un rechazo del capguard;
  - un fallo de firma o una reutilización de token;
  - errores de autenticación repetidos con el exchange;
  - una discrepancia entre las posiciones del bot y las del exchange que no se resuelve en 2 ciclos;
  - no poder persistir una decisión de riesgo (`DECISION_LOG_UNAVAILABLE`).
- **Persistencia.** El estado se guarda en SQLite y se comprueba al arrancar: un bot que arranca con el kill
  switch activo sigue parado.
- **Desactivación.** Solo un humano, desde un canal autenticado, con motivo escrito, después de revisar la
  causa y con la reconciliación en verde. Nunca se desactiva solo.

## 7. Kill switch externo: revocar la API key

Es el último recurso y no depende del bot, del VPS ni de nuestro código. Se usa cuando:

- el bot hace algo que no se explica;
- el kill switch global no responde o no se puede confirmar;
- no hay acceso al VPS o al portátil;
- se sospecha que la clave o la cuenta están comprometidas;
- hay actividad no reconocida en la cuenta.

### 7.1 Procedimiento manual

1. Abrir la app del exchange en el móvil e iniciar sesión con el segundo factor.
2. Ir a la gestión de API de la subcuenta del bot. En la mayoría de exchanges las claves de las subcuentas
   se gestionan desde la cuenta principal. La ruta exacta de menús está anotada en el runbook (§7.2).
3. **Eliminar** la clave del bot, no solo editar sus permisos. Eliminar es inmediato y no tiene vuelta
   atrás. Si hay más de una clave del bot, eliminarlas todas.
4. Revisar las órdenes abiertas de la subcuenta. Cancelar a mano las pendientes, pero **no los stops de
   protección nativos** (§2.4). Comprobar que siguen activos: una orden ya colocada normalmente sobrevive a
   la eliminación de la clave, pero hay que verlo en la app.
5. Revisar las posiciones y decidir a mano si se mantienen o se venden. Desde este momento el bot no puede
   tocarlas: solo las protegen los stops nativos, con el riesgo de gap de §2.4.
6. Revisar el historial: retiros, transferencias, claves API que no se reconocen y sesiones o dispositivos
   abiertos. Si hay sospecha de que la cuenta está comprometida, cambiar la contraseña, revisar el segundo
   factor y, si el exchange lo ofrece, bloquear la cuenta.
7. Si el bot sigue accesible, activar también el kill switch global o parar el proceso, para que deje de
   reintentar y no acabe con la IP vetada.
8. Registrar el incidente en `docs/incidents/AAAA-MM-DD-<resumen>.md`: hora, motivo, qué se hizo, órdenes y
   posiciones en ese momento.
9. No crear una clave nueva hasta cerrar el análisis del incidente y repasar el checklist. La clave nueva
   sigue el procedimiento de rotación de `docs/research/05` §5.4.

### 7.2 Preparación antes de operar en real

- App del exchange instalada, con sesión iniciada y segundo factor a mano.
- Nombre de clave reconocible, por ejemplo `inversor-jp-live`.
- **Runbook** con la ruta exacta de menús para eliminar la clave en ese exchange y esa versión de la app.
  Se anota al crear la clave porque cambia entre exchanges y versiones.
- **Simulacro** con una clave de testnet o de solo lectura: medir el tiempo de los pasos 1 a 3. El objetivo
  es hacerlo en menos de **5 min**. Se repite cada 3 meses y siempre que cambie el exchange o la app.

## 8. Fail closed

El Risk Engine rechaza, y nunca aprueba por defecto, cuando:

- salta una excepción en cualquier control (`INTERNAL_ERROR`);
- falta un campo de configuración o un valor no es un número finito: patrimonio, precio, stop o tamaño
  (`CONFIG_INVALID` o `INTERNAL_ERROR`);
- el estado no está reconciliado con el exchange (`STATE_UNRECONCILED`);
- los datos están obsoletos o el exchange no está sano (§4.6, §4.7);
- el capguard no responde (`CAP_UNAVAILABLE`);
- no puede persistir la decisión (`DECISION_LOG_UNAVAILABLE`).

Además:

- `LIVE_TRADING=false` por defecto. Sin la confirmación explícita de `src/config.ts`, Execution solo usa el
  broker de simulación, y una orden real se rechaza (`LIVE_TRADING_DISABLED`).
- Un control que no se puede evaluar cuenta como suspendido, no como aprobado.
- Las salidas `reduce_only` se aprueban aunque falle un control de mercado, porque vender en spot reduce el
  riesgo. Solo las bloquean:
  - el kill switch, `REDUCE_ONLY_VIOLATION` y no saber qué se tiene (`STATE_UNRECONCILED`);
  - en Execution (exchange-execution): el modo UNKNOWN (`EXEC_STATE_UNKNOWN`), una orden huérfana en ese
    símbolo (`EXEC_ORPHAN_ORDER`) y la pausa por límite de peticiones (`EXEC_RATE_LIMITED`).

  Única excepción a `STATE_UNRECONCILED` y `EXEC_STATE_UNKNOWN`: el stop de protección que le falta a una
  posición, cuando la reconciliación ya ha cuadrado órdenes y saldos (exchange-execution §3.2).

## 9. reason_code y persistencia

### 9.1 Qué se guarda

Cada decisión del Risk Engine (aprobada, reducida o rechazada) y cada rechazo de Execution, del capguard o
del exchange se guarda en la tabla `risk_decisions` de SQLite.

- La tabla es **solo de inserción**: unos triggers `BEFORE UPDATE` y `BEFORE DELETE` abortan cualquier
  cambio.
- La decisión se guarda **antes** de responder. Si no se puede guardar, se rechaza y salta el kill switch.
- Un rechazo puede tener varios códigos. Se guardan todos, y el principal es el primero según el orden de
  evaluación (§9.3).
- Una reducción guarda el código del límite que recortó el tamaño.
- El capguard guarda sus rechazos en su propio archivo, porque no comparte código. El proceso principal
  también guarda el código `CAP_*` que recibe.

| Campo | Contenido |
|---|---|
| `id`, `ts` | Correlativo y marca de tiempo UTC |
| `layer` | `risk`, `execution`, `capguard` o `exchange` |
| `intent_id`, `approval_id` | Intención y aprobación relacionadas |
| `origin` | Estrategia, `manual` o `sistema` |
| `symbol`, `side`, `quantity`, `notional` | Lo pedido |
| `decision` | `APPROVED`, `REDUCED` o `REJECTED` |
| `reason_code` | Código principal |
| `reason_codes` | Todos los códigos, en JSON |
| `detail` | JSON con el valor medido, el límite, y las marcas de tiempo de los datos usados |
| `config_hash`, `commit` | Configuración y código que decidieron |

### 9.2 Catálogo de reason_code

Lista cerrada. Un código nuevo exige añadirlo aquí y en las pruebas.

| Código | Capa | Cuándo |
|---|---|---|
| `KILL_SWITCH_ACTIVE` | risk | Kill switch global activo (§6) |
| `CONFIG_INVALID` | risk | Configuración incompleta, inválida o clave con permisos de más |
| `INTERNAL_ERROR` | risk | Excepción o valor no finito en un control |
| `STATE_UNRECONCILED` | risk | Posiciones o saldos sin reconciliar con el exchange |
| `DECISION_LOG_UNAVAILABLE` | risk | No se puede persistir la decisión |
| `MANUAL_PAUSE` | risk | Pausa manual |
| `DAILY_LOSS_LIMIT` | risk | Breaker de pérdida diaria |
| `DRAWDOWN_HALT` | risk | Breaker de drawdown |
| `LOSS_STREAK_COOLDOWN` | risk | Breaker de pérdidas consecutivas |
| `SLIPPAGE_BREAKER` | risk | Slippage real muy por encima del estimado |
| `STALE_DATA` | risk | Precio con más antigüedad de la permitida |
| `SIGNAL_TOO_OLD` | risk | Señal sobre una vela demasiado antigua |
| `CLOCK_SKEW` | risk | Reloj desfasado respecto al exchange |
| `EXCHANGE_UNHEALTHY` | risk | Exchange en mantenimiento, con errores o limitando peticiones |
| `EVENT_RISK` | risk | Ventana de evento, deslistado, pérdida de paridad o bloqueo de inteligencia |
| `MARKET_NOT_ALLOWED` | risk | No es spot, está inactivo o queda fuera del universo |
| `SPREAD_TOO_WIDE` | risk | Spread por encima del límite |
| `LIQUIDITY_TOO_LOW` | risk | Volumen o profundidad insuficientes |
| `SLIPPAGE_TOO_HIGH` | risk | Slippage estimado por encima del límite |
| `STOP_INVALID` | risk | Sin stop o con un stop que no está por debajo de la entrada |
| `RISK_PER_TRADE` | risk | El tamaño pedido arriesga más que el riesgo por operación |
| `MAX_EXPOSURE` | risk | Se supera la exposición total |
| `MAX_OPEN_POSITIONS` | risk | Se supera el número de posiciones abiertas |
| `CONCENTRATION_LIMIT` | risk | Se supera el tope por activo o el del explorador |
| `CORRELATION_LIMIT` | risk | Se supera el tope por clúster correlacionado |
| `INSUFFICIENT_CASH` | risk | No hay caja libre suficiente |
| `BELOW_MIN_NOTIONAL` | risk | Tamaño final por debajo del mínimo |
| `REDUCE_ONLY_VIOLATION` | risk | Una salida vende más de lo que se tiene |
| `PROTECTIVE_STOP_MISSING` | risk | Una posición abierta no tiene su stop nativo confirmado en el exchange |
| `LIVE_TRADING_DISABLED` | execution | Orden real sin `LIVE_TRADING` confirmado |
| `APPROVAL_MISSING` | execution | Orden sin token |
| `APPROVAL_BAD_SIGNATURE` | execution | Firma inválida |
| `APPROVAL_EXPIRED` | execution | Token caducado |
| `APPROVAL_REPLAYED` | execution | Token ya usado |
| `APPROVAL_MISMATCH` | execution | La orden no coincide con lo aprobado |
| `EXEC_STATE_UNKNOWN` | execution | Sistema en modo UNKNOWN: Execution no envía órdenes nuevas (exchange-execution §3) |
| `EXEC_ORPHAN_ORDER` | execution | Símbolo bloqueado por una orden huérfana con el prefijo del bot (exchange-execution §14) |
| `EXEC_MARKET_RULES` | execution | La orden no cumple las reglas del mercado: paso de precio o cantidad, mínimos o filtros (exchange-execution §7) |
| `EXEC_RATE_LIMITED` | execution | En pausa por HTTP 429 o 418 hasta que pase `Retry-After` (exchange-execution §11) |
| `CAP_UNAVAILABLE` | capguard | El capguard no responde |
| `CAP_ORDER_NOTIONAL` | capguard | Importe por orden por encima de su tope |
| `CAP_EXPOSURE` | capguard | Exposición total por encima de su tope |
| `CAP_LOSS_LOCK` | capguard | Bloqueo por pérdida diaria o acumulada |
| `CAP_MARKET_NOT_ALLOWED` | capguard | Símbolo o tipo de mercado fuera de su lista |
| `CAP_BALANCE_MISMATCH` | capguard | Sus saldos no cuadran con lo que dice el proceso principal |
| `EXCHANGE_REJECTED` | exchange | El exchange rechaza la orden; su código va en `detail` |

### 9.3 Orden de evaluación

El orden es fijo, para que el código principal sea reproducible:

1. kill switch;
2. configuración, estado y persistencia;
3. circuit breakers;
4. datos, reloj y salud del exchange;
5. riesgo de evento;
6. mercado permitido;
7. spread, liquidez y slippage;
8. stop y tamaño;
9. exposición, concentración, correlación, posiciones y caja;
10. mínimo de la orden.

Una salida `reduce_only` solo pasa por los pasos 1, 2 y la comprobación de `REDUCE_ONLY_VIOLATION`.

## 10. Estado actual del código

El código previo (`PRE-REFACTOR-RECOVERY`) **no cumple** este skill. Las brechas se corrigen en el refactor,
no a escondidas en otro paso:

- `engine.ts` llama directamente a `broker.buy` y `broker.sell`. Las entradas pasan por `entryGate` y
  `sizeBy*` por convención, no por un token. **Las ventas no pasan por el Risk Engine.**
- Los motivos de rechazo son texto libre y solo van al log. No hay `reason_code` ni tabla
  `risk_decisions`.
- `sizeByRisk` no incluye los costes en el riesgo por unidad.
- No hay token de aprobación, capguard, kill switch global, control de correlación, liquidez por
  profundidad, slippage estimado, frescura de precios, desfase de reloj, reconciliación ni comprobación de
  los permisos de la clave.
- Lo que sí existe: tamaño por riesgo, topes de posición y exposición, número de posiciones, pérdida
  diaria, drawdown, pérdidas consecutivas, pausa manual, filtro de spread y volumen en el explorador
  (`scout.ts`), antigüedad de la señal (`maxSignalAgeMinutes`), aviso tras 5 fallos de precio y bloqueo de
  entradas por inteligencia.
- `RiskManager.resume()` levanta a la vez la pausa, el halt por drawdown y el enfriamiento, y reinicia el
  máximo sin dejar constancia.
- No hay stops nativos en el exchange: si el bot se cae, las posiciones quedan sin stop (paso 36).
- Las reglas de dependency-cruiser del firmante y del capguard ya están activas, pero aún no muerden: no
  existen `src/risk/signer.ts` ni `capguard/`.
- Las brechas de conexión con el exchange y de seguimiento de órdenes están en
  [exchange-execution §18](../exchange-execution/SKILL.md). Entre ellas, el riesgo de orden duplicada en
  `LiveBroker` y que todos los importes son float.

Hasta que se corrijan, **no se opera en real**.

## 11. Cómo trabajar

1. Antes de tocar código que genere, valide, dimensione, envíe o cancele órdenes, leer este skill y copiar
   [checklist.md](checklist.md) en la descripción del cambio.
2. Un límite no se relaja para que pase una prueba ni una operación. Cambiar un umbral exige un ADR nuevo.
3. Cada control nuevo lleva su `reason_code` en §9.2 y pruebas que demuestren que rechaza, incluido el caso
   de dato que falta.
4. Ante un incidente con dinero real: primero el kill switch (§6 o §7) y después el análisis.
