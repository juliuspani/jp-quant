# PRE-LIVE GATE

**CONGELADO** el 2026-10-15 en el paso 27 ([ADR 0030](adr/0030-criterios-congelados.md)). Es la parte B de los
criterios del paso 27. Las partes A y C están en [PROMOTION_CRITERIA.md](PROMOTION_CRITERIA.md).

Es el examen PASS/FAIL que se aprueba antes de operar con dinero real por primera vez (micro-live, etapa 2 del
[ADR 0019](adr/0019-periodo-del-test-final.md)), y otra vez antes de cada aumento de capital. No sustituye a nada:
se suma a `CLAUDE.md` §2, a los invariantes ([SECURITY_AND_TRADING_INVARIANTS.md](../SECURITY_AND_TRADING_INVARIANTS.md)),
a `trading-risk`, a `exchange-execution` y al procedimiento M-03, que lo exige.

- **Cambios.** Cambiar, quitar o relajar cualquier criterio es una parada obligatoria (`CLAUDE.md` §7). Exige un
  ADR justificado y aprobado por la persona, y reinicia la validación: el gate se repite entero con los criterios
  nuevos.
- **Huella.** El SHA-256 de este archivo (con finales de línea LF) está en el ADR 0030 y en `PROGRESS.md`, y
  `test/docs/frozen-criteria.test.ts` falla si el archivo cambia.

## 1. Reglas

1. **Fail closed.** Un criterio sin evidencia, con evidencia incompleta o que no se puede evaluar es FAIL.
2. **Un solo FAIL crítico (C) bloquea live**, sin excepciones ni aceptación posible.
3. **Un FAIL no crítico (N) también bloquea**, salvo que la persona lo acepte por escrito en un ADR, con el motivo y
   la fecha en que se corrige. Como mucho 2 aceptados a la vez, y nunca el mismo en dos gates seguidos.
4. **Vigencia.** El resultado vale para un commit. Un commit nuevo reinicia los criterios de la tabla de §1.1, y
   ningún otro.
5. **Evidencia.** Cada ejecución se anota en `docs/prelive/AAAA-MM-DD-gate.md`: commit, fechas, quién lo ejecutó y,
   por criterio, el resultado, la evidencia (registro, prueba o captura) y su ruta. Nunca valores de claves.
6. **Quién decide.** Claude puede preparar y ejecutar las comprobaciones. Activar el modo real lo hace la persona,
   con M-03 y con el gate en PASS. Es una parada obligatoria.
7. **Mismo código.** Paper, shadow y live ejecutan el mismo código y la misma estrategia, con el mismo hash (ADR
   0013). La evidencia de paper y shadow solo vale para ese hash.

### 1.1 Qué cambios reinician qué criterios

| Cambio | Se repite |
|---|---|
| Solo documentación o tests | Nada más que G-01 en el commit nuevo |
| Strategy, risk, capguard, execution, reconciliación o configuración de riesgo | G-01, G-07, G-08 y G-09 |
| Execution o reconciliación, además | G-02, G-03, G-04, G-05 y G-10, cuya evidencia depende de ese código |
| Infraestructura (VPS, despliegue, copias, supervisor, avisos) | G-01 y los afectados de G-13 a G-17 |
| Cualquier otro código | G-01 y los criterios cuya evidencia dependa del código cambiado; ante la duda, todos |

- **Los 30 días** de validez se refieren a las comprobaciones puntuales (G-04, G-05, G-10, G-13 y G-14: caídas
  forzadas, simulacros, inyecciones, copias y rollback); G-06 y G-12 tienen sus propios plazos. No se aplican al
  paper ni al shadow (G-07 a G-09), que solo se reinician por los cambios de esta tabla.

## 2. Criterios

| ID | Área | PASS si | Crítico |
|---|---|---|---|
| G-01 | Tests | `npm run check:all` y `npm run secrets` en PASS en el commit que se despliega. Ningún control de los invariantes hasta el paso 46 sigue `pendiente`, y todas las pruebas de esos controles están en PASS | C |
| G-02 | Reconciliation | Durante todo el paper y el shadow, la reconciliación de saldos, posiciones y órdenes corre cada ≤ 10 min sin huecos. Toda discrepancia se resuelve en ≤ 2 ciclos y queda explicada en el registro. Al final, 0 discrepancias abiertas. Una discrepancia inyectada se detecta en el ciclo siguiente y, sin resolver en 2 ciclos, activa el kill switch | C |
| G-03 | Zero duplicate orders | 0 órdenes duplicadas en paper y shadow: un client order ID por orden, nunca reutilizado, y como mucho una orden por token de aprobación. En al menos 50 inyecciones de respuesta perdida, timeout y reconexión, 0 duplicadas: cada duda termina en UNKNOWN y se resuelve por reconciliación, nunca reenviando | C |
| G-04 | Recovery | Al menos 3 caídas forzadas (`kill -9`) en cada estado de orden (`PENDING_SEND`, `SENT`, `OPEN`, `PARTIALLY_FILLED` y durante una cancelación). En todas: reconcilia antes de enviar nada, 0 duplicadas, 0 huérfanas, y el kill switch y los breakers conservan su estado. Vuelve a operar en ≤ 5 min | C |
| G-05 | Kill switch interno | INV-07a, INV-07b e INV-07d en `auto` y PASS. Simulacro en shadow, con `data/KILL` y con el canal autenticado: desde el ciclo siguiente rechaza toda intención (`KILL_SWITCH_ACTIVE`), cancela las órdenes pendientes, mantiene los stops nativos, sobrevive a un reinicio y solo lo desactiva una persona con motivo escrito | C |
| G-06 | Kill switch externo | M-07 ejecutado en los últimos 90 días con el runbook del exchange y de la versión de la app vigentes: revocar la clave en < 5 min | C |
| G-07 | Paper trading | Paper continuo de al menos 8 semanas, que no termina antes del 2027-01-01, con el hash de estrategia y la configuración que irán a live. Al menos 3 ciclos completos (entrada y salida) ejecutados en paper o shadow. El número de operaciones está en el intervalo central del 95 % de una Poisson con la tasa del backtest aprobado. El 100 % de las decisiones son iguales a las del backtest en todas las velas evaluadas (§3) | C |
| G-08 | Shadow | Shadow continuo de al menos 14 días en el VPS de producción, con datos y saldos reales y solo la clave de lectura. 100 % de las órdenes en `NOT_SENT` y 0 transmitidas. Sus decisiones coinciden con las de paper en las mismas velas | C |
| G-09 | Paper frente a backtest | (a) Una reproducción del backtest sobre las velas del periodo de paper da las mismas decisiones en el 100 % de las velas evaluadas, como en G-07. (b) Coste realizado medio por operación ≤ 1,5 veces el del modelo, y ninguna operación por encima de 3 veces. (c) Diferencia de P&L neto acumulado entre paper y la reproducción ≤ el mayor de 1 % del capital y 25 % de los costes del periodo | C |
| G-10 | Stress testing | Cada inyección de la tabla de §4 produce el comportamiento documentado, y los breakers de `trading-risk` §5 disparan con sus umbrales al reproducir en paper las ventanas de crisis de PROMOTION_CRITERIA (A.3.7) | C |
| G-11 | Strategy validation | La estrategia está en PAPER (PROMOTION_CRITERIA A.4), consta en el Strategy Registry con su hash y el código desplegado tiene ese hash. La etapa 2 (A.5) está en PASS, con sus fechas, y la persona autorizó la apertura del test final (M-13) | C |
| G-12 | Security | M-04 en los últimos 30 días; M-05 y M-12 en los últimos 90; ningún M-10 abierto. INV-04c, INV-04d e INV-05b en PASS. `npm audit --omit=dev` sin vulnerabilidades altas ni críticas. Los informes de `consultor-security` y `consultor-execution-risk` sobre el commit no dejan hallazgos de severidad alta o crítica sin resolver | C |
| G-13 | Backups y restore | Copia automática diaria, cifrada y fuera del VPS de las bases de datos del modo y del registro de decisiones y del estado del kill switch. Restauración probada en los últimos 30 días en una máquina limpia: pasa la comprobación de integridad, el bot arranca en paper con el estado restaurado y reconcilia. Pérdida máxima ≤ 24 h de datos; restauración en ≤ 1 h | C |
| G-14 | Rollback | Procedimiento escrito y probado en los últimos 30 días: volver de la versión N a la N − 1 en ≤ 15 min con el estado intacto, y volver de live a paper (M-03, paso 5) en ≤ 5 min. Se conserva la versión anterior desplegable | C |
| G-15 | Disponibilidad | Proceso activo ≥ 99 % del tiempo en paper y en shadow, sin contar las caídas forzadas de G-04 | N |
| G-16 | Avisos | El resumen diario llegó todos los días del paper y del shadow, y los avisos de kill switch y de breaker llegaron en ≤ 1 min en los simulacros | N |
| G-17 | Latencia | Del cierre de la vela a la decisión, percentil 99 ≤ 60 s en paper y en shadow | N |

## 3. Paper (G-07)

Paper valida la ejecución y que el código hace lo que se probó, no la ventaja. Los costes reales se validan en la
etapa 2 (PROMOTION_CRITERIA A.5.4), con órdenes de verdad.

- **Duración.** Al menos 8 semanas continuas, que no terminan antes del 2027-01-01. Se fija antes de empezar.
- **Ciclos completos.** Al menos 3 ciclos de entrada y salida ejecutados en paper o en shadow, para ver la vida
  completa de una orden con la estrategia real.
- **Frecuencia coherente.** Si `λ` es la tasa de operaciones por semana del backtest aprobado y `D` la duración, el
  número de operaciones tiene que estar en el intervalo central del 95 % de una Poisson de media `λ·D`. Fuera de él,
  FAIL: indica un fallo de datos o de código, o una estrategia que no se comporta como se probó.
- **Decisiones idénticas.** En todas las velas evaluadas, la decisión de paper (entrar, salir o no hacer nada, con
  su lado) es la misma que da el backtest con esas velas. Una sola diferencia es FAIL.
- **Tipos de orden.** Cada tipo de orden que usa la estrategia (entrada, salida por señal y stop) se ejecuta al
  menos una vez en paper o en shadow. Si no salta ningún stop, su ciclo completo se prueba en G-10.

## 4. Inyecciones de G-10

| Inyección | Comportamiento esperado |
|---|---|
| Desconexión del WebSocket o hueco de secuencia | Resincroniza el libro y no decide con datos incompletos |
| Timeout con respuesta perdida | UNKNOWN, sin reenviar; se resuelve por reconciliación (`EXEC_STATE_UNKNOWN`) |
| HTTP 429 o 418 | `EXCHANGE_UNHEALTHY`, respeta `Retry-After` y no insiste |
| Errores de autenticación repetidos | Activa el kill switch |
| Reloj desfasado más de 1 s | `CLOCK_SKEW`, sin entradas |
| Precio de más de 60 s o señal de más de 20 min | `STALE_DATA` o `SIGNAL_TOO_OLD` |
| Ejecución parcial | Posición y stop correctos con la cantidad ejecutada |
| Rechazo del exchange | Definitivo, registrado con su `reason_code`, sin reintento ciego |
| Mantenimiento o suspensión del par | Sin entradas en ese par |
| Capguard caído | `CAP_UNAVAILABLE`, ninguna orden sale |
| Base de datos no disponible | `DECISION_LOG_UNAVAILABLE` y kill switch |
| Stop nativo que salta | Posición cerrada, cartera y registro correctos tras reconciliar |

## 5. Estado

Hoy no se puede pasar: faltan los módulos de los pasos 32 a 46 y varios controles siguen `pendiente`. Por la regla
1, todos los criterios están en FAIL hasta que se ejecuten con evidencia.
