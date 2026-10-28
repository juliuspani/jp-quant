# ADR 0023 — Risk Engine y Execution mínimos con las interfaces definitivas

Fecha: 2026-10-09 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 20

## Contexto

El prompt del paso 20 pide la versión mínima de Risk Engine y de Execution con las interfaces definitivas de
[ARCHITECTURE.md](../../ARCHITECTURE.md) §16. Los pasos 35 y 36 las amplían, pero no las reescriben.

- **Risk mínimo:** kill switch, posición máxima, exposición máxima, datos obsoletos, fail closed, `reason_code`
  persistido en cada rechazo y un token de aprobación que Execution exige. Hasta el paso 33, el `reason_code` se
  guarda en el almacenamiento de investigación.
- **Execution mínimo, solo simulado:** máquina de estados completa, client order IDs únicos y rechazo de toda orden
  sin token de Risk.
- **Pruebas:** una orden que no pasa por Risk se rechaza, las transiciones inválidas fallan y el kill switch lo
  bloquea todo.

El prompt nombra los estados ORDER_INTENT, VALIDATED, SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, CANCELLED,
REJECTED y UNKNOWN. Esos no son los de `exchange-execution` §4.1, que es un skill permanente, ni los de
ARCHITECTURE.md §16.7, que los copia. El prompt pide a la vez esas interfaces definitivas, y `.claude/` solo lo edita
la persona.

## Decisión

### 1. Estados de la orden: los de exchange-execution §4.1

Se usan los once estados del skill y de ARCHITECTURE.md §16.7. Son un superconjunto de los del prompt:

| Prompt | Código | Nota |
|---|---|---|
| ORDER_INTENT | — | No es un estado de orden: es el `OrderIntent` de Strategy, antes de Risk |
| VALIDATED | `PENDING_SEND` | Token verificado y, en una sola escritura, token usado y orden guardada |
| SUBMITTED | `SENT` | Entregada al venue, sin respuesta |
| ACKNOWLEDGED | `OPEN` | Aceptada y sin ejecuciones |
| PARTIALLY_FILLED | `PARTIALLY_FILLED` | |
| FILLED | `FILLED` | |
| CANCELLED | `CANCELED` | Con `CANCEL_PENDING` antes de la confirmación; la grafía es la de ccxt y la del skill |
| REJECTED | `REJECTED` | |
| UNKNOWN | `UNKNOWN` | Bloquea todos los envíos (exchange-execution §3) |
| — | `EXPIRED`, `NOT_SENT` | TTL vencido y «confirmado que no salió» (§9.2) |

Las transiciones son las de §4.2. Además, cualquier estado vivo puede pasar a `UNKNOWN`: un evento imposible lleva
ahí. De `UNKNOWN` solo se sale reconciliando, y solo a un estado que el exchange puede confirmar (no a `SENT` ni a
`CANCEL_PENDING`). Lo que no está en la tabla lanza `InvalidTransitionError`, y el motor no lo aplica: lo convierte en
una duda.

### 2. Contratos en `src/kernel/`, con ajustes mínimos a §16

Los tipos que cruzan módulos que no se importan entre sí (matriz de §15.1) viven en `kernel/`: intención, decisión,
token, cartera, órdenes, venue y los puertos de almacén. `Side` y `Bucket` van en `shared/`. Ajustes respecto al texto
de §16, todos más estrictos o más completos:

- `ReasonCode` es la unión cerrada del catálogo de trading-risk §9.2, con su capa. Una prueba la mantiene igual que
  el skill.
- `DecisionRecord` es la fila de `risk_decisions` con los campos de trading-risk §9.1. Sustituye a
  `RiskDecision & { layer }` en `RiskStore.appendDecision`.
- `ExecutionStore.isApprovalUsed` permite comprobar la reutilización (paso 4 de §2.2) antes que la coincidencia. Así,
  un token reutilizado que además no coincide da `APPROVAL_REPLAYED`, que activa el kill switch.
- `ExecutionRejected` lleva símbolo, lado, cantidad e importe, y `detail` estructurado, para la fila de §9.1.
- `OrderTransition` lleva la hora local y el motivo. `VenueOrderUpdate` lleva la hora del exchange (§4.3).
- `RiskState` solo tiene el kill switch. El paso 35 añade los breakers y el máximo de patrimonio.

### 3. Risk Engine mínimo

Aplica, en el orden de trading-risk §9.3, estos controles:

1. kill switch;
2. intención válida y modo UNKNOWN de Execution (`STATE_UNRECONCILED`);
3. datos obsoletos: precio con la más antigua de sus dos marcas, valoración de la cartera si hay posiciones, y señal;
4. mercado permitido;
5. stop por debajo de la entrada;
6. exposición total (75 %) y posición por activo (25 %, el «max position» del prompt);
7. mínimo de la orden.

Las salidas solo pasan por el kill switch, el estado y `REDUCE_ONLY_VIOLATION`.

- **Controles añadidos por fail closed**, aunque el prompt no los nombra: `MARKET_NOT_ALLOWED`, `STOP_INVALID`,
  `BELOW_MIN_NOTIONAL` y `STATE_UNRECONCILED`. Sin ellos se aprobarían órdenes sin precio, sin stop o imposibles.
- **Reduce, no rechaza,** cuando un tope recorta: la cantidad baja al paso del mercado y la decisión lleva el código
  del tope. La posición existente se valora al ask, que es lo más conservador. Nunca agranda.
- **Límites con techo:** hasta el paso 35, cada límite tiene como máximo el valor del skill. Uno más arriesgado no
  arranca (`CONFIG_INVALID`).
- **Lo que no está, rechaza:** el dimensionado por riesgo con costes (paso 23), los stops nativos (paso 36) y
  cualquier tipo de orden que no sea a mercado. Un control que no se puede evaluar cuenta como suspendido (§8).
- **Kill switch:** solo se activa. La desactivación exige una persona desde un canal autenticado (paso 35). Si no se
  puede guardar, sigue activo en memoria.
- **Un solo escritor de `risk_decisions`:** Risk guarda también los rechazos de Execution. Un fallo de firma, un token
  reutilizado o un rechazo del capguard activan antes el kill switch.

### 4. Token

- **Firma y forma.** Ed25519 sobre JSON canónico, con un par nuevo en cada arranque. La forma es exacta:
  - `approval_id` es un UUID;
  - las cantidades son decimales canónicos y positivos;
  - una compra lleva tope de importe y no es `reduce_only`;
  - una venta es `reduce_only` y no lleva tope de importe;
  - la validez es de 10 s como máximo.

  Otra forma cuenta como firma inválida, porque Risk no pudo firmarla.
- **Origen del `approval_id`.** Sale de `Ids`: `seededUuids` en replay, UUID aleatorios en tiempo real (`app/`).
- **Única fuente de azar fuera de `Rng`:** la generación del par de claves. Las firmas cambian entre ejecuciones y no
  pueden entrar en un hash de determinismo.

### 5. Execution mínimo, solo simulado

**Al recibir un token comprueba, en este orden:**

1. kill switch (`KILL_SWITCH_ACTIVE`, en la capa execution);
2. token: falta, firma, caducidad y reutilización;
3. modo UNKNOWN (`EXEC_STATE_UNKNOWN`);
4. reglas del mercado, tras redondear a la baja (`EXEC_MARKET_RULES`);
5. coincidencia con lo aprobado (`APPROVAL_MISMATCH`).

**Envío.** El token usado y la orden en `PENDING_SEND` se guardan en una sola escritura. Después la orden pasa a
`SENT` y se entrega al venue.

**Dudas y reconciliación.**

- Arranca en UNKNOWN.
- Cualquier duda, evento imposible o error del venue al crear o cancelar lleva a UNKNOWN. Solo es definitivo el
  rechazo del exchange.
- Sale de UNKNOWN con una reconciliación mínima: cada orden viva confirmada y ninguna orden ajena.
- Con el kill switch, cancela sus órdenes abiertas y no toca los stops de protección.

**Lo que llega en el paso 36:** la cola serializada, `NOT_SENT` con las condiciones de §9.2, la pausa por 429 y 418,
las órdenes huérfanas, la reconciliación de saldos y fills, la cancelación propia al vencer el TTL, las órdenes límite
y los stops. Hoy no hay ningún venue real.

### 6. Almacenamiento de investigación

`src/backtest/research-stores.ts` implementa `RiskStore` y `ExecutionStore` en memoria, como dice ARCHITECTURE.md §10
para los runs de backtest y replay. Aplica las reglas de las tablas del paso 33:

- solo inserción;
- un token una sola vez;
- un client order ID una sola vez;
- todo o nada al reservar;
- transiciones encadenadas;
- fills idempotentes;
- códigos del catálogo.

### 7. INV-12a compara texto

La prueba INV-12a busca `mode ===` para detectar quién pregunta por el modo del run, y también marcaría el modo de
Execution y el de dimensionado. No se ha tocado el control. El código consulta el modo UNKNOWN con
`isSendingBlocked()`, en el contrato de Execution, y recorre el dimensionado con `switch`.

## Alternativas

- **Renombrar los estados a los del prompt.** Habría contradicho un skill permanente y ARCHITECTURE.md, y el paso 36
  tendría que reescribir la máquina para añadir los estados que faltan.
- **Guardar las decisiones en un archivo JSONL bajo `data/`.** ARCHITECTURE.md §10 fija un almacén en memoria para
  cada run, solo la guarda puede nombrar rutas de `data/` (`test/enforcement/data-paths.test.ts`) y la durabilidad
  llega con SQLite en el paso 33.
- **`ReasonCode = string`, como en §16.6.** Una errata en un código pasaría el typecheck.
- **Desactivar el kill switch con un método ya en este paso.** Sin canal autenticado sería una puerta trasera.
- **Rechazar en lugar de reducir cuando un tope recorta.** Es más simple, pero el skill dimensiona con el menor de los
  topes (§4.1), y reducir nunca agranda.

## Consecuencias

- Las interfaces de §16 quedan en código y probadas. Los pasos 23, 35 y 36 añaden controles, campos de `RiskState` y
  capacidades de Execution sin cambiar los contratos.
- **Lo que no cubre:** `src/risk/` y `src/execution/` no los usa todavía el bot que arranca, que es el código previo
  hasta que `app/` los componga (pasos 32 a 36). Los controles de invariantes nuevos prueban estos módulos.
- **Persistencia en memoria:** el kill switch no sobrevive al proceso. INV-07a sigue pendiente (paso 35).
- **Compromisos nuevos** en `PROGRESS.md`:
  - paso 23: dimensionado por riesgo con costes, `SimulatedVenue` y firmas fuera del hash del diario;
  - paso 32: composición en `app/`, UUID aleatorios y de `config.json` a `RiskLimits`;
  - pasos 35 y 36: lo que queda pendiente en las decisiones 3 y 5.

## Nota del paso 23 (2026-10-13)

Lo que la decisión 3 dejaba para el paso 23 ya existe (ADR 0026): el dimensionado por riesgo con costes, con
`RISK_PER_TRADE` cuando una cantidad pedida arriesga más, e `INSUFFICIENT_CASH`. También existe el `SimulatedVenue` en
`backtest/`, que respeta `expiresAt` y responde con `VenueOrderUpdate`. Execution entrega cada fill nuevo por `onFill`,
el `FillRecorded` de ARCHITECTURE.md §6. Las firmas quedan fuera del diario, cuyo hash es el mismo entre ejecuciones.
El resto de los compromisos de este ADR para los pasos 32, 35 y 36 sigue igual.
