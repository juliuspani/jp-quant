# ADR 0003 — Riesgo y ejecución: token de aprobación, tres capas de capital y kill switch

Fecha: 2026-10-01 · Estado: aceptado (umbrales PROVISIONALES) · Paso: 6

**Umbrales PROVISIONALES.** El usuario aprobó este ADR el 2026-10-01. Las decisiones de diseño quedan
aceptadas. Todos los valores numéricos (decisiones 2, 4, 5, 6 y 8) son provisionales y se fijarán con datos:

- en el **paso 35** (Risk Engine): los límites del Risk Engine y de los circuit breakers;
- en el **paso 46** (micro-live): la validez del token, los topes del capguard y los **umbrales de
  mercado** (spread, slippage y liquidez). No hay que confundirlos con los parámetros de conectividad del
  ADR 0005 (timeouts, rate limits, WebSocket, reloj), que se fijan en los pasos 32 y 36.

Fijarlos exige un ADR nuevo. Hasta entonces se aplican estos valores, y ninguno se relaja sin datos.

## Contexto

`CLAUDE.md` §2 exige el flujo Strategy → Risk → Execution, *fail closed*, solo spot y ninguna orden sin pasar
por Risk. No dice cómo se hace cumplir. En el código previo (`PRE-REFACTOR-RECOVERY`), `src/engine.ts` llama
directamente al broker. Las entradas pasan por los controles de `src/risk.ts` solo por convención, y las
ventas no pasan por ellos. Los motivos de rechazo son texto libre que no se persiste. No hay kill switch
global ni ninguna barrera fuera del propio proceso. El paso 6 fija las reglas en el skill
`.claude/skills/trading-risk/`.

## Decisiones

1. **Las reglas viven en un Project Skill** (`.claude/skills/trading-risk/SKILL.md`), con un checklist de
   revisión al lado.
2. **Token de aprobación firmado con Ed25519.**
   - El Risk Engine genera el par de claves en memoria al arrancar. La clave privada no se persiste ni sale
     de `risk/`.
   - Execution y el capguard verifican con la clave pública.
   - El token caduca en ≤ 10 s y su `approval_id` se usa una sola vez: se marca como usado en SQLite antes
     de enviar.
   - La orden tiene que coincidir con lo aprobado.
   - Se suman un tipo marcado que no se exporta fuera de `risk/` y reglas de dependency-cruiser.
   - El firmante vive en `src/risk/signer.ts`. La regla `solo-risk-usa-el-firmante` prohíbe importarlo
     desde fuera de `src/risk/`.
   - Un fallo de firma o una reutilización activa el kill switch.
3. **Tres capas de límite de capital**, de la más fuerte a la más débil:
   1. Exchange: subcuenta con solo el capital asignado, API sin retiros, whitelist de IP.
   2. Capguard: proceso independiente en `capguard/`, fuera de `src/`, sin código compartido. Es el único
      con la clave de trading, lee sus propios datos del exchange y tiene topes propios en un archivo que
      el bot no puede escribir.
      - Las reglas `capguard-no-importa-src` y `src-no-importa-capguard` impiden compartir código.
        `npm run boundaries` analiza `capguard/` en cuanto exista.
      - La separación de usuarios del sistema operativo en el VPS se implementa en el paso 39.
   3. Risk Engine.
4. **Topes del capguard**, más laxos que los del Risk Engine para que salte solo si este falla:
   - importe por orden ≤ 30 % del capital asignado;
   - exposición ≤ 80 % del capital asignado;
   - bloqueo de compras en el día al perder el 3 % del capital asignado;
   - bloqueo que solo levanta un humano al perder el 12 % del capital asignado.
5. **Límites del Risk Engine** (valores por defecto; los de `src/config.ts` se mantienen):
   - Riesgo por operación: 0,75 % del patrimonio, con los costes dentro del riesgo por unidad.
   - Exposición ≤ 75 % del patrimonio y ≤ 6 posiciones abiertas.
   - Concentración por activo ≤ 25 % del patrimonio. Explorador ≤ 5 % del patrimonio.
   - Clúster correlacionado ≤ 50 % del patrimonio, con ρ ≥ 0,80 en 90 días. Sin datos, ρ = 1.
   - Liquidez: orden ≤ 1 % del volumen de 24 h y profundidad a ±0,5 % ≥ 5 veces el importe.
   - Spread ≤ 0,15 % en el núcleo y ≤ 0,40 % en el explorador. Slippage ≤ 0,30 % estimado.
   - Datos: precio ≤ 60 s, señal ≤ 20 min, reconciliación ≤ 10 min y desfase de reloj ≤ 1 s.
   - Exchange no sano con 3 errores de API consecutivos, 429 o 418. Vuelve tras 5 min sin errores.
   - Evento: sin entradas desde 30 min antes hasta 60 min después de un dato macro de alto impacto, con
     deslistado o mantenimiento del símbolo, o con USDT por debajo de 0,99.
6. **Circuit breakers.** Bloquean entradas y dejan pasar las salidas `reduce_only`.
   - Pérdida diaria: −2 % desde el inicio del día UTC.
   - Drawdown: caída del 10 % desde el máximo. Solo lo rearma un humano.
   - Pérdidas consecutivas: 3 pérdidas seguidas, 24 h sin entradas.
   - Slippage real por encima de 2 veces el estimado.
7. **Kill switch global.**
   - Bloquea todas las órdenes nuevas, incluidas las salidas por software.
   - Cancela las pendientes, pero **mantiene los stops de protección nativos**.
   - **No vende posiciones**: eso lo decide una persona.
   - Se activa a mano (Telegram, panel, archivo `data/KILL`) o solo, ante condiciones graves.
   - Persiste tras un reinicio y solo lo desactiva un humano.
8. **Kill switch externo.** Procedimiento manual para eliminar la API key desde la app del exchange, con
   runbook y simulacro cada 3 meses, en menos de 5 min.
9. **reason_code.** Catálogo cerrado en SKILL.md §9.2. Cada decisión, y cada rechazo de cualquier capa, se
   persiste en la tabla `risk_decisions`, solo de inserción, antes de responder. Si no se puede persistir,
   se rechaza y salta el kill switch.
10. **Stops de protección nativos del exchange** (SKILL.md §2.4). Se implementan en el paso 36.
    - Cada posición abierta tiene una orden de stop en el exchange que la protege aunque el bot y el
      capguard estén caídos. Sin ella no se abren posiciones nuevas (`PROTECTIVE_STOP_MISSING`).
    - **La reconciliación debe conocer esos stops** para no duplicar órdenes. Se cancelan o se ajustan
      antes de cualquier salida por software. Un stop ya ejecutado cierra la posición sin vender de nuevo.
    - **Un stop-limit puede no ejecutarse en un gap**: se queda como orden límite sin llenar mientras el
      precio sigue cayendo. Por eso se prefiere el stop a mercado cuando el par lo admite. Con stop-limit
      se deja margen entre el disparo y el límite, y un stop disparado sin llenar se trata como salida
      urgente a mercado.
11. **Registro de incidentes** en `docs/incidents/AAAA-MM-DD-<resumen>.md`. La carpeta se crea con el primer
    incidente.

## Alternativas descartadas

- **Token con HMAC.** Quien verifica tiene el mismo secreto que quien firma, así que Execution o el capguard
  podrían fabricar aprobaciones. Con Ed25519, verificar no permite firmar.
- **Solo un tipo marcado, sin firma.** Evita errores en tiempo de compilación, pero no se comprueba en
  ejecución y un `as` lo esquiva.
- **Capguard como vigilante con clave de solo lectura.** Solo podría avisar después de la orden. Como único
  poseedor de la clave de trading, puede impedirla.
- **Capguard que reutiliza `risk/`.** Un mismo fallo tumbaría dos capas a la vez. Por eso no comparte código.
- **Kill switch que liquida.** Vender todo de golpe en pánico o sin liquidez puede costar más que esperar.
  Esa decisión la toma un humano.
- **Kill switch que también cancela los stops nativos.** Dejaría las posiciones sin ninguna protección
  justo cuando algo va mal.
- **Solo stops por software.** Si se caen el bot o el capguard, la posición queda sin stop.
- **Breakers que también bloquean salidas.** Dejarían posiciones abiertas sin poder cerrarse cuando más
  falta hace. Solo el kill switch bloquea las salidas.
- **Motivos de rechazo en texto libre.** No se pueden contar, agregar ni comprobar en una prueba.

## Consecuencias

- El código previo no cumple este ADR (SKILL.md §10). Hasta corregirlo en el refactor, **no se opera en
  real**.
- Hacen falta dos procesos y dos usuarios del sistema operativo en el VPS, y dos claves: lectura para el
  bot y trading para el capguard.
- **Las salidas por software dependen del capguard.** Si se cae, no se pueden enviar. Los stops nativos
  (decisión 10) cubren ese hueco, salvo el riesgo de gap de los stop-limit.
- Los stops nativos complican la reconciliación y el trailing: sustituir un stop deja una ventana breve
  sin protección, porque en spot el saldo no da para dos órdenes de venta.
- `npm run boundaries` ejecuta `scripts/boundaries.ts`, que analiza `src/` y `capguard/` si existe. Las
  reglas del firmante y del capguard están activas, pero no muerden hasta que existan
  `src/risk/signer.ts` y `capguard/`.
- El kill switch externo deja las posiciones protegidas solo por los stops nativos. Una persona tiene que
  decidir qué hacer con ellas en ese momento.
- Cambiar un umbral, añadir una capa o quitarla exige un ADR nuevo.

## Corrección editorial (2026-10-05)

Renumeración del plan en el paso 12 ([ADR 0010](0010-regla-de-decisiones-y-nuevo-plan.md)). Solo cambian
los números de paso, con la tabla de `docs/progress/PLAN_MAP.md` (registro de trabajo privado, no publicado); no cambia
ninguna decisión. Cambios:

- 30 → 35 (Risk Engine) y 57 → 46 (micro-live);
- 17 y 31 → 32 y 36 (parámetros de conectividad del ADR 0005);
- 31 → 36 (stops nativos) y 47 → 39 (separación de usuarios en el VPS).
