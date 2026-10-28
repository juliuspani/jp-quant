# ADR 0005 — Estándares de ejecución con el exchange: estado UNKNOWN, idempotencia y precisión decimal

Fecha: 2026-10-01 · Estado: aceptado (parámetros de conectividad PROVISIONALES) · Paso: 7 (revisado en 7B y 7C)

**Parámetros de conectividad PROVISIONALES.** El usuario aprobó este ADR el 2026-10-01 (paso 7B). Las
decisiones quedan aceptadas. Sus cifras son **parámetros de conectividad**: timeouts, TTL, backoff, rate
limits, WebSocket, reloj y reconciliación. Se fijan en los **pasos 32 y 36** con la documentación oficial
del exchange elegido en el **paso 17**. Fijarlas exige un ADR nuevo. Hasta entonces se aplican estos valores,
y ninguno se relaja sin datos.

No son los **umbrales de mercado** del ADR 0003 (spread, slippage y liquidez), que aplica el Risk Engine y
se fijan en el paso 46.

## Contexto

`CLAUDE.md` §2 exige *fail closed* y que solo Execution envíe órdenes. El ADR 0003 (skill trading-risk) fija
qué órdenes pueden salir, pero no cómo se habla con el exchange ni cómo se sigue una orden hasta su final. La
investigación previa (`docs/research/05` §4) recoge las prácticas de robustez: reconciliar al arrancar,
`clientOrderId` persistido antes de enviar, nunca reintentar una orden a ciegas, límites de peticiones y
reloj.

El código previo (`PRE-REFACTOR-RECOVERY`) no las cumple. `src/broker.ts` puede duplicar una orden si pierde
la respuesta de `createOrder`, no hay tabla de órdenes ni reconciliación, y todos los importes son `number` y
`REAL` en SQLite. El paso 7 fija los estándares en el skill `.claude/skills/exchange-execution/`.

## Decisiones

1. **Los estándares viven en un Project Skill** (`.claude/skills/exchange-execution/SKILL.md`), con un
   checklist que se completa antes de aprobar código de ejecución.
2. **Estado UNKNOWN global.** Ante duda sobre el estado de una orden, el sistema pasa a UNKNOWN, deja de
   enviar órdenes nuevas y reconcilia con el exchange antes de continuar.
   - Es global y no por símbolo: en spot todas las órdenes comparten la caja.
   - Bloquea todas las órdenes nuevas, incluidas las ventas del bot y los stops nuevos: el Risk Engine con
     `STATE_UNRECONCILED` (trading-risk §8) y Execution con `EXEC_STATE_UNKNOWN`. Mientras dura, solo
     protegen los stops ya puestos en el exchange, que no se cancelan.
   - **Única excepción (7C):** si a una posición le falta su stop nativo y las órdenes y los saldos ya
     cuadran, ese stop se coloca como orden `reduce_only` aprobada por el Risk Engine, y después se sale de
     UNKNOWN. Sin ella, un stop que falta impediría salir de UNKNOWN y acabaría en el kill switch.
   - Lanza una alerta CRITICAL.
   - Se entra con: timeout o respuesta perdida en una orden, respuesta que no se entiende, transición
     imposible, fill de una orden desconocida, saldo insuficiente, desconexión o gap del canal privado,
     diferencia de saldos, orden manual en la subcuenta, HTTP 418, bucle colgado y siempre al arrancar.
   - Solo se sale con una reconciliación completa en verde. Si no se resuelve en 2 ciclos de
     reconciliación, salta el kill switch global (ADR 0003, decisión 7).
3. **Ciclo de vida con estados y transiciones cerrados**: `PENDING_SEND`, `SENT`, `OPEN`, `PARTIALLY_FILLED`,
   `CANCEL_PENDING`, `FILLED`, `CANCELED`, `EXPIRED`, `REJECTED`, `NOT_SENT` y `UNKNOWN`. Una transición fuera
   de la lista lleva a UNKNOWN. `filled` solo crece y las órdenes terminales no cambian.
4. **Client order ID derivado del `approval_id`**, con prefijo `ijp-`. Una aprobación de un solo uso da como
   mucho una orden, y reintentar exige una aprobación nueva. El `approval_id` usado y la orden en
   `PENDING_SEND` se guardan en la misma transacción antes de enviar.
5. **Una orden dudosa solo se da por no enviada** (`NOT_SENT`) cuando han pasado recvWindow + 5 s desde la
   firma y 2 consultas seguidas por su client order ID dicen que no existe. Nunca se reenvía sola.
6. **Timeouts y TTL.**
   - Timeout de 10 s por petición, y duraciones con el reloj monótono.
   - Toda orden que no es un stop de protección tiene TTL; las entradas, TTL ≤ 5 min.
7. **REST.**
   - Errores clasificados en `src/exchange/`.
   - Solo se reintentan lecturas: full jitter con base 1 s y tope 60 s, respetando `Retry-After`, y como
     mucho 4 reintentos.
   - Nunca se reintenta la creación de una orden.
8. **Rate limits.**
   - Presupuesto propio ≤ 50 % del límite de peso, repartido entre el bot y el capguard, que comparten IP:
     35 % para el bot y 15 % para el capguard (7C, provisional hasta el paso 32).
   - Ante 429 o 418 se deja de enviar peticiones, el exchange queda como no sano y Execution rechaza con
     `EXEC_RATE_LIMITED`.
9. **WebSockets.**
   - El libro se sincroniza con instantánea y sequence numbers; un gap lo invalida.
   - Toda desconexión del canal privado es un gap y lleva a UNKNOWN.
   - Un vigilante corta la conexión si no llega ningún mensaje en 60 s.
   - La reconexión usa el mismo backoff, y el contador vuelve a 0 con la conexión estable durante 60 s.
   - Reconexión planificada antes de 23 h. REST sigue siendo la fuente de verdad para reconciliar.
10. **Reloj.**
    - NTP obligatorio.
    - El desfase con el exchange se mide al arrancar, cada hora y tras errores de timestamp. La medición se
      descarta si la ida y vuelta tarda más de 1 s.
    - Con un desfase de más de 1 s no salen órdenes (`CLOCK_SKEW`).
    - recvWindow ≤ 5000 ms, sin subirlo nunca para tapar el desfase.
11. **Reconciliación** al arrancar, en modo UNKNOWN, tras reconectar el canal privado y al menos cada 10 min.
    - Las órdenes del exchange que no constan en SQLite no se adoptan ni se tocan: se avisa.
    - Una orden huérfana con el prefijo del bot, además, bloquea las órdenes nuevas en su símbolo
      (`EXEC_ORPHAN_ORDER`) hasta que la resuelva una persona. Por sí sola no mantiene el modo UNKNOWN
      global. `docs/research/05` §4.1 se actualizó para coincidir.
    - El desbloqueo de una huérfana exige una orden desde un canal autenticado, con motivo escrito, y queda
      registrado (7C).
    - Una orden **sin** el prefijo del bot (manual) provoca un **bloqueo total**: modo UNKNOWN mientras
      exista, alerta CRITICAL y, a los 2 ciclos, kill switch global. La subcuenta es exclusiva del bot, así
      que indica otro operador o una clave comprometida (7C).
    - Los saldos se comparan en decimal, con tolerancia de 1 paso de cantidad, y no se corrigen solos.
12. **Dead-man switch.**
    - El cancel-on-disconnect del exchange solo se usa si respeta los stops de protección.
    - Si no, los TTL hacen que con el bot caído solo queden stops en el exchange.
    - Latido externo desde el final de cada ciclo y vigilante interno de bucle colgado.
13. **Crash recovery.**
    - El arranque empieza en UNKNOWN y las órdenes en `PENDING_SEND` se tratan como posiblemente enviadas.
    - SQLite en WAL, con transacciones por cada cambio de estado.
    - Restaurar una copia exige revisión humana.
14. **Precisión decimal: nunca float para precios, cantidades ni balances**, ni para comisiones, importes o
    PnL.
    - Valores del exchange convertidos desde su cadena original, órdenes enviadas como cadenas redondeadas y
      `TEXT` en SQLite.
    - El float solo se permite en análisis.
    - El redondeo nunca aumenta la cantidad ni el riesgo.
    - El tipo decimal es propio y envuelve una biblioteca madura (por ejemplo decimal.js), para poder
      sustituirla. La decisión definitiva va en un ADR en el paso 14; la implementación, al inicio del
      paso 18.
    - Se hace cumplir de forma automática: regla de ESLint en los módulos de dinero en el paso 18, y test
      contra columnas `REAL`, `FLOAT` o `DOUBLE` en el paso 33.
15. **Códigos de rechazo de Execution con prefijo `EXEC_`**, para distinguirlos de los de Risk. Se añaden al
    catálogo cerrado de trading-risk §9.2, con capa `execution`: `EXEC_STATE_UNKNOWN`, `EXEC_ORPHAN_ORDER`,
    `EXEC_MARKET_RULES` y `EXEC_RATE_LIMITED`. El skill solo usa códigos de ese catálogo, y un test lo
    comprueba.
16. **Marcas [verificar].** Los detalles concretos de Binance y ccxt que no se han comprobado en la
    documentación oficial llevan esa marca. Se comprueban, con la fuente citada, contra la documentación
    del exchange elegido en el paso 17, en los pasos 32 y 36, antes de escribir el código que depende de
    ellos.
17. **Niveles de alerta INFO, WARNING y CRITICAL** (7C), con esos nombres exactos (SKILL.md §20). Son
    CRITICAL, como mínimo: entrar en UNKNOWN, el kill switch, una orden huérfana, una orden manual detectada,
    un rechazo del capguard y un HTTP 418.
18. **Stop con entradas ejecutadas por partes** (7C). Cuándo se ajusta el stop nativo (con cada parte o al
    terminar la entrada) se decide en el paso 36, eligiendo la opción que minimice el tiempo sin protección
    y documentándola.

## Alternativas descartadas

- **UNKNOWN por orden o por símbolo**, dejando operar al resto. En spot la caja es común: una orden dudosa de
  un símbolo puede haber gastado el saldo con el que cuenta otro.
- **Dar por no enviada una orden que no aparece al primer intento.** El exchange puede tardar en mostrarla;
  hasta que vence `recvWindow` aún puede aceptarla.
- **Reintentar la creación de órdenes con el mismo client order ID** y confiar en que el exchange deduplique.
  Binance solo exige que sea único entre las órdenes abiertas: una orden a mercado ya ejecutada no lo bloquea
  (`docs/research/05` §4.2).
- **Adoptar las órdenes con el prefijo del bot que no constan en SQLite** (`docs/research/05` §4.1 lo
  proponía hasta el paso 7). Como toda orden se escribe antes de enviarse, una así indica una base de datos perdida o
  restaurada. Adoptarla taparía el problema.
- **Corregir los saldos locales para que cuadren con el exchange.** Taparía fallos de contabilidad que hay que
  entender.
- **Cancel-on-disconnect del exchange en cualquier caso.** El de Kraken cancela también los stops: dejaría las
  posiciones sin protección justo cuando el bot está caído.
- **`number` con redondeo cuidadoso.** Los errores de float se acumulan en sumas de fills y comisiones, y las
  comparaciones de igualdad fallan. Un tipo decimal los elimina de raíz.
- **Tipo decimal propio sobre bigint.** Escribir bien la división y los modos de redondeo es fácil de
  equivocar. Se prefiere una biblioteca madura, envuelta para poder cambiarla.
- **Usar la biblioteca decimal directamente en todo el código.** Ataría el proyecto a ella; el envoltorio
  permite sustituirla tocando un solo módulo.
- **Bloquear todo el sistema por una orden huérfana.** Basta con bloquear su símbolo: las demás órdenes
  constan en SQLite y los saldos se siguen comparando.
- **Solo WebSocket, sin REST.** Un WebSocket puede perder eventos sin avisar. REST es la fuente de verdad para
  reconciliar.

## Consecuencias

- El código previo no cumple este ADR (SKILL.md §18). En particular, `LiveBroker` puede duplicar una orden.
  Hasta corregirlo en el refactor, **no se opera en real**.
- Hace falta una tabla de órdenes con su máquina de estados, y migrar a `TEXT` las columnas `REAL` de
  importes.
- Hace falta un exchange simulado para las pruebas, que pierda, duplique y reordene respuestas.
- El modo UNKNOWN bloquea también las salidas por software. Mientras dura, solo protegen los stops nativos
  (paso 36), con su riesgo de gap.
- El bot y el capguard comparten el límite de peticiones por IP y tienen que repartírselo.
- El catálogo de `reason_code` de trading-risk pasa de 42 a 46 códigos.
- Cambiar un parámetro de conectividad o una regla exige un ADR nuevo.

## Corrección editorial (2026-10-05)

Renumeración del plan en el paso 12 ([ADR 0010](0010-regla-de-decisiones-y-nuevo-plan.md)). Solo cambian
los números de paso, con la tabla de `docs/progress/PLAN_MAP.md` (registro de trabajo privado, no publicado); no cambia
ninguna decisión. Cambios:

- 16 → 17 (elección del exchange);
- 17 y 31 → 32 y 36 (parámetros de conectividad, reparto del presupuesto de peticiones y marcas [verificar]);
- 31 → 36 (stop con entradas parciales y stops nativos) y 57 → 46 (umbrales de mercado);
- 13 → 14 (ADR del tipo decimal);
- 17 → 18 (implementación del tipo decimal y regla de ESLint «nunca float»): ajuste pedido en el paso 12,
  primer paso que maneja precios;
- 19 → 33 (test contra columnas `REAL`, `FLOAT` o `DOUBLE`).

## Nota posterior (2026-10-06)

La biblioteca del tipo decimal se fijó en el [ADR 0014](0014-tipo-decimal-big-js.md): big.js, en lugar de
decimal.js, que la decisión 14 citaba como ejemplo. No cambia ninguna regla de este ADR.
