# Checklist de revisión de riesgo

Se usa en dos casos:

- en todo cambio que toque Strategy, el Risk Engine, Execution, el exchange, la orquestación, la
  configuración de riesgo o el capguard: se copia en la descripción del cambio;
- antes de operar en real y en cada revisión trimestral.

Cada casilla sin marcar se justifica por escrito. Si queda una obligatoria sin marcar, el cambio no se
fusiona y no se opera en real. Las referencias a apartados son de [SKILL.md](SKILL.md).

## Flujo y token (§2)

- [ ] Ningún módulo nuevo o modificado llama a Execution sin pasar por el Risk Engine
- [ ] Strategy solo produce `OrderIntent`: no importa `execution/`, `exchange/` ni el firmante de `risk/`
- [ ] Los comandos manuales (Telegram, panel) crean `OrderIntent` con `origen: "manual"` y pasan por Risk
- [ ] Ningún LLM ni fuente de noticias crea intenciones ni relaja límites: solo reduce o bloquea
- [ ] Las salidas también pasan por Risk, como `reduce_only`
- [ ] Execution verifica la firma, la caducidad (≤ 10 s), la reutilización y la coincidencia antes de enviar
- [ ] El `approval_id` se marca como usado antes de enviar la orden
- [ ] La clave privada de firma no se guarda, no se registra en logs y no sale de `risk/`
- [ ] Un fallo de firma o una reutilización activa el kill switch global
- [ ] Hay pruebas que demuestran que Execution rechaza un token falso, caducado, reutilizado o que no coincide
- [ ] `src/risk/signer.ts` solo se importa desde `src/risk/` (`npm run boundaries` en PASS)

## Stops de protección nativos (§2.4)

- [ ] Cada posición abierta tiene su stop nativo confirmado en el exchange; sin él no hay entradas nuevas
- [ ] La reconciliación conoce los stops nativos y los compara con las órdenes abiertas del exchange
- [ ] Antes de una salida por software se cancela o ajusta el stop nativo, sin duplicar la venta
- [ ] Un stop nativo ejecutado con el bot caído cierra la posición sin volver a vender
- [ ] Stop a mercado si el par lo admite; con stop-limit, margen entre disparo y límite
- [ ] Un stop disparado sin llenar (gap) se trata como salida urgente a mercado

## Capas de capital (§3)

- [ ] Capa 1: subcuenta dedicada con solo el capital asignado
- [ ] Capa 1: API key sin retiros, sin transferencias, sin margen y sin futuros
- [ ] Capa 1: whitelist de IP con la IP fija del VPS
- [ ] Capa 1: el arranque en real comprueba los permisos de la clave o se han comprobado a mano
- [ ] Capa 2: el capguard no importa nada de `src/` y nada de `src/` lo importa (`npm run boundaries`)
- [ ] Capa 2: el capguard es el único proceso con la clave de trading; el bot solo tiene clave de lectura
- [ ] Capa 2: sus topes están en un archivo que el proceso principal no puede escribir
- [ ] Capa 2: si el capguard no responde, no sale ninguna orden
- [ ] Capa 3: el cambio no relaja ningún límite del Risk Engine sin un ADR nuevo

## Controles del Risk Engine (§4)

- [ ] Tamaño de posición calculado con el riesgo por operación e incluyendo costes
- [ ] Sin stop válido no hay entrada
- [ ] Exposición máxima y número de posiciones abiertas
- [ ] Concentración por activo y por explorador
- [ ] Correlación por clúster, con ρ = 1 si no hay datos
- [ ] Liquidez por volumen y por profundidad del libro
- [ ] Spread y slippage estimado
- [ ] Datos obsoletos, señal antigua, reconciliación y desfase de reloj
- [ ] Salud del exchange, incluidos 429 y 418
- [ ] Riesgo de evento: macro, deslistados, mantenimiento y paridad de USDT

## Circuit breakers y kill switch (§5, §6)

- [ ] Pérdida diaria, drawdown, pérdidas consecutivas y slippage real implementados y persistidos
- [ ] Los breakers bloquean entradas y dejan pasar las salidas `reduce_only`
- [ ] Los breakers manuales solo se rearman con orden humana autenticada y motivo escrito
- [ ] El kill switch global bloquea órdenes nuevas, cancela las pendientes, mantiene los stops de
      protección nativos y no vende posiciones
- [ ] El kill switch se puede activar por Telegram, por el panel y con el archivo centinela
- [ ] El kill switch sobrevive a un reinicio y solo lo desactiva un humano

## Kill switch externo (§7)

- [ ] Runbook con la ruta exacta para eliminar la clave en la app del exchange
- [ ] App instalada, con sesión iniciada y segundo factor a mano
- [ ] Último simulacro de revocación hecho hace menos de 3 meses, en menos de 5 min
- [ ] El procedimiento deja activos los stops nativos y comprueba en la app que siguen ahí
- [ ] Incidentes registrados en `docs/incidents/AAAA-MM-DD-<resumen>.md`

## Fail closed (§8)

- [ ] Cualquier excepción o valor no finito en un control termina en rechazo
- [ ] Un control que no se puede evaluar cuenta como suspendido
- [ ] Sin `LIVE_TRADING` confirmado, solo se usa el broker de simulación
- [ ] Hay pruebas del caso de dato que falta para cada control nuevo o modificado

## reason_code (§9)

- [ ] Cada rechazo, en cualquier capa, tiene un `reason_code` del catálogo
- [ ] La decisión se persiste en `risk_decisions` antes de responder
- [ ] La tabla `risk_decisions` es solo de inserción (triggers contra `UPDATE` y `DELETE`)
- [ ] Si no se puede persistir, se rechaza y salta el kill switch
- [ ] Los códigos nuevos están en el catálogo y en las pruebas

## Cierre

- [ ] `npm run check:all` en PASS
- [ ] Riesgos residuales anotados en `PROGRESS.md`
