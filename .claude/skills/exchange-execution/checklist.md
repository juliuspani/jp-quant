# Checklist de código de ejecución

Se completa **antes de aprobar** cualquier cambio que toque `src/exchange/`, `src/execution/`, el capguard,
conexiones REST o WebSocket con el exchange, órdenes, fills, saldos, la reconciliación o el arranque. Se copia
en la descripción del cambio, junto al [checklist de trading-risk](../trading-risk/checklist.md).

Cada casilla sin marcar se justifica por escrito. Si queda una sin marcar sin justificación, el cambio no se
aprueba. Las referencias a apartados son de [SKILL.md](SKILL.md).

## Estado UNKNOWN (§3)

- [ ] Un timeout o una respuesta perdida al crear, cancelar o sustituir una orden lleva a modo UNKNOWN
- [ ] Una respuesta que no se entiende, una transición imposible o un fill de una orden desconocida llevan a
      modo UNKNOWN
- [ ] Un rechazo por saldo insuficiente lleva a modo UNKNOWN
- [ ] En modo UNKNOWN no sale ninguna orden nueva, ni entradas, ni ventas del bot, ni stops nuevos
      (`EXEC_STATE_UNKNOWN` en Execution)
- [ ] En modo UNKNOWN no se cancelan los stops de protección nativos
- [ ] Entrar en modo UNKNOWN lanza una alerta CRITICAL
- [ ] La única orden que sale en modo UNKNOWN es el stop de protección que falta, `reduce_only` y aprobado
      por Risk, y solo con órdenes y saldos ya cuadrados
- [ ] Solo se sale de modo UNKNOWN con una reconciliación completa en verde
- [ ] Si no se resuelve en 2 ciclos de reconciliación, salta el kill switch global
- [ ] El arranque empieza en modo UNKNOWN

## Ciclo de vida de las órdenes (§4)

- [ ] Los estados y las transiciones son los de §4.1 y §4.2; cualquier otra transición va a UNKNOWN
- [ ] Una orden terminal no cambia nunca
- [ ] `filled` solo crece y nunca supera la cantidad pedida
- [ ] La posición es la suma de los fills, no la cantidad pedida
- [ ] Cada cambio de estado guarda su origen y las marcas de tiempo del exchange y local

## Client order IDs e idempotencia (§5)

- [ ] Cada orden lleva un client order ID derivado de su `approval_id`, con prefijo `ijp-`
- [ ] El client order ID cumple el formato del exchange sin recortarse
- [ ] Ningún client order ID se reutiliza, ni para reintentos
- [ ] La aprobación usada y la orden en `PENDING_SEND` se guardan en la misma transacción antes de enviar
- [ ] Los fills tienen clave única y un evento repetido (WebSocket y REST, o tras reconectar) no cuenta dos
      veces
- [ ] Ninguna petición que crea una orden se reintenta automáticamente

## Ejecuciones parciales y rechazos (§6, §7)

- [ ] Las ejecuciones parciales se tratan en todas las órdenes, también las de mercado
- [ ] La comisión en el activo base se descuenta de la cantidad disponible
- [ ] Cada parte ejecutada de una entrada queda protegida por su stop nativo
- [ ] El polvo se registra y queda fuera de la lógica de posición
- [ ] Las reglas del mercado se validan antes de enviar (`EXEC_MARKET_RULES`)
- [ ] El redondeo nunca aumenta la cantidad ni el riesgo
- [ ] Un rechazo definitivo queda en `REJECTED` con `EXCHANGE_REJECTED` y el código del exchange

## Cancel/replace y timeouts (§8, §9)

- [ ] Se cancela, se confirma y solo entonces se coloca la sustituta, con la cantidad que de verdad queda
- [ ] Una cancelación dudosa deja la orden en UNKNOWN y no se coloca la sustituta
- [ ] Un endpoint atómico de cancel/replace se interpreta parte por parte
- [ ] La ventana sin stop al sustituir un stop de protección se mide y se registra
- [ ] Toda petición tiene timeout explícito (10 s) y las duraciones usan el reloj monótono
- [ ] Una orden dudosa solo pasa a `NOT_SENT` con las dos condiciones de §9.2, y no se reenvía sola
- [ ] Toda orden que no es un stop de protección tiene TTL

## REST, backoff y rate limits (§10, §11)

- [ ] Los errores se clasifican en `src/exchange/` y nadie más mira las excepciones de ccxt
- [ ] Solo se reintentan lecturas, con full jitter, base 1 s, tope 60 s y como mucho 4 reintentos
- [ ] Se respeta `Retry-After`
- [ ] `enableRateLimit` activo y una sola instancia del cliente por proceso y exchange
- [ ] El presupuesto de peso está repartido: 35 % para el bot y 15 % para el capguard, cada uno ≤ su parte
- [ ] Ante 429 o 418 se dejan de enviar peticiones, el exchange queda como no sano y Execution rechaza con
      `EXEC_RATE_LIMITED`

## WebSockets (§12)

- [ ] Cada mensaje se valida contra su esquema; los valores se convierten a decimal desde la cadena
- [ ] El libro se sincroniza con instantánea y sequence numbers, y un gap lo invalida y resincroniza
- [ ] Una desconexión del canal privado se trata como un gap y lleva a modo UNKNOWN
- [ ] Se responde al ping del servidor y el vigilante propio corta la conexión sin mensajes en 60 s
- [ ] La reconexión usa backoff con jitter, resuscribe, resincroniza y reconcilia antes de usar los datos
- [ ] Hay reconexión planificada antes del cierre forzoso del exchange
- [ ] Hay pruebas con gaps, mensajes duplicados, desordenados y conexiones mudas

## Reloj (§13)

- [ ] El desfase se mide al arrancar, cada hora y tras errores de timestamp, descontando la ida y vuelta
- [ ] Con un desfase de más de 1 s no salen órdenes (`CLOCK_SKEW`)
- [ ] `recvWindow` ≤ 5000 ms, sin subirlo para tapar el desfase

## Reconciliación (§14)

- [ ] Se reconcilia al arrancar, en modo UNKNOWN, tras reconectar el canal privado y al menos cada 10 min
- [ ] Las órdenes locales no terminales se consultan por su client order ID
- [ ] Las órdenes del exchange que no constan en SQLite no se adoptan ni se tocan: se avisa
- [ ] Una orden huérfana con el prefijo del bot bloquea las órdenes nuevas en su símbolo
      (`EXEC_ORPHAN_ORDER`) hasta que la resuelva una persona
- [ ] El desbloqueo de una huérfana exige una orden desde un canal autenticado, con motivo escrito, y queda
      registrado
- [ ] Una orden sin el prefijo del bot (manual) bloquea todo el sistema: modo UNKNOWN hasta resolverla
- [ ] Los saldos se comparan en decimal con tolerancia de 1 paso de cantidad, y no se corrigen solos
- [ ] Cada posición abierta tiene su stop nativo confirmado

## Dead-man switch y crash recovery (§15, §16)

- [ ] El cancel-on-disconnect del exchange solo se usa si no cancela los stops de protección
- [ ] Con el bot caído, en el exchange solo pueden quedar stops de protección (TTL en todo lo demás)
- [ ] El latido externo sale del final de cada ciclo completo del bucle de trading
- [ ] Un bucle colgado lleva a modo UNKNOWN y avisa
- [ ] El código aguanta una caída en cualquier instante: transacciones en SQLite (WAL) y reconciliación al
      arrancar
- [ ] Las órdenes en `PENDING_SEND` al arrancar se tratan como posiblemente enviadas
- [ ] Hay pruebas de caída antes, durante y después del envío

## Precisión decimal (§17)

- [ ] Ningún precio, cantidad, balance, comisión, importe ni PnL usa `number`
- [ ] El tipo decimal propio envuelve la biblioteca; nadie la importa directamente
- [ ] La regla de ESLint de los módulos de dinero (desde el paso 18) y el test de columnas (desde el paso 33)
      están en PASS
- [ ] Los valores del exchange se convierten a decimal desde su cadena original
- [ ] Las órdenes salen con cadenas redondeadas al paso del mercado
- [ ] SQLite guarda esos valores como `TEXT`, nunca `REAL`
- [ ] El float solo aparece en análisis, y la conversión a orden tiene redondeo explícito
- [ ] Un valor no decimal en una orden lleva a UNKNOWN

## Niveles de alerta (§20)

- [ ] Toda alerta lleva un nivel: INFO, WARNING o CRITICAL
- [ ] Son CRITICAL: entrar en UNKNOWN, el kill switch, una orden huérfana, una orden manual, un rechazo del
      capguard y un HTTP 418
- [ ] Ningún evento CRITICAL se rebaja de nivel

## Cierre

- [ ] Los detalles marcados [verificar] que usa el cambio están comprobados y con su fuente citada
- [ ] Las pruebas usan un exchange simulado que pierde, duplica y reordena respuestas, nunca el real
- [ ] `npm run check:all` en PASS
- [ ] Riesgos residuales anotados en `PROGRESS.md`
