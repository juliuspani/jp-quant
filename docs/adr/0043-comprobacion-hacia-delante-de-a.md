# ADR 0043 — Comprobación hacia delante de A (EXP-0027), congelada

Fecha: 2026-10-22 · Estado: **aceptado por la persona** el 2026-10-22, en su decisión del paso 31. Es una parada
obligatoria, porque usará el test final del ADR 0019, y la persona la aprueba al pedirla. Al aprobar el paso, ese mismo
día, aprobó el procedimiento con un tramo más y los umbrales, dejó el candado sin tocar y pidió elegir ya la
configuración, que es la de EXP-0029 (§1). **Congelado:** `test/docs/forward-check.test.ts` fija el SHA-256 de este
archivo y el de la especificación de EXP-0027, comprueba las salidas guardadas de EXP-0027 y EXP-0029 y recalcula los
umbrales de §3. Cambiar cualquiera de ellos es una parada obligatoria.

## Contexto

- **Paso 31** ([DECISION_POINT.md](../DECISION_POINT.md)): ninguna estrategia cumple los criterios congelados. A
  (`tendencia-donchian` 1.0.0, EXP-0027) y B (`reversion-rsi2` 1.0.0, EXP-0028) quedan `RECHAZADA`, el test final no se
  desbloquea para promocionar nada y la persona para el desarrollo de trading activo.
- **Lo que pide la persona,** como parada obligatoria aprobada: una comprobación hacia delante de A, congelada desde hoy,
  con su especificación exacta y sin ningún cambio.
  - Se ejecuta una sola vez, con los datos del 2026-10-01 al 2027-10-01, después del 2027-10-01 y con el desbloqueo del
    ADR 0020.
  - Sus criterios se fijan ahora: los de coherencia de la etapa 2, ganancia neta y Sharpe > 0, y caída dentro de lo
    esperado.
  - Su resultado solo puede servir para decidir si se abre una investigación nueva, nunca para operar directamente. No
    cuenta como promoción.
- **El periodo es el del test final** (ADR 0019): nadie lo ha examinado. Una vela es del periodo si su `received_time`
  cae en él (ADR 0020, decisión 6). La primera diaria es la que abre el 2026-09-30 y la última, la que abre el 2027-09-29.
- **La especificación de EXP-0027 es un procedimiento, no una configuración.** Tiene una rejilla de 4 puntos
  (`entryPeriod` 20 o 55 y `exitPeriod` 10 o 20). En cada tramo se queda con el punto de mejor Sharpe neto en los 3 años
  de train, con purging y embargo de 55 velas (ADR 0032). Eligió 20/10 en los tramos 0 a 6 y 55/10 en los 7 a 9; en el
  9, por 0,001 de Sharpe de train.
- **Contaminación.** Claude y la persona conocen EXP-0025 a EXP-0028, y los criterios cambiaron a la vista de resultados
  (ADR 0030, decisión 9). El periodo hacia delante es posterior a todo eso, y nada de esta especificación se elige con él.

## Decisión

### 1. Qué se ejecuta: el procedimiento de EXP-0027 con un tramo más

- **Base, sin ningún cambio:**
  - el pre-registro de EXP-0027 (`registry.jsonl`, línea del 2026-10-22T10:31:18.442Z);
  - su especificación, `docs/research/experiments/specs/tendencia-donchian-1.0.0-rejilla-repeticion.json` (SHA-256
    `c38555d167ddd3d4f29d2ea4f8524524531cde6109fcaeee549af927c5edc3fa`);
  - el código del commit `3ad406b966200e436184dd5b98f1952e06948940`.

  Eso fija la estrategia y su versión, la rejilla, la elección en train, el purging y el embargo y el universo
  (BTC/EUR y ETH/EUR). También el marco diario, los costes (comisión del 0,25 %, medio spread del 0,075 % y slippage de
  al menos el 0,05 %, más el impacto del libro sintético), los 1000 EUR de cada tramo, los límites de Risk, el modelo de
  ejecución y el peor caso dentro de la vela.
- **El único cambio es un tramo 10** tras los 10 de EXP-0027, que construye el mismo código.
  - Train del 2023-10-01 al 2026-10-01 y periodo hacia delante del 2026-10-01 al 2027-10-01 (excluido), con el purging
    y el embargo de 55 velas. El train son los 3 años inmediatamente anteriores, como en todos los tramos.
  - El rango de datos llega al 2027-10-01. Lo anterior al periodo es el dataset de EXP-0027 (hash `677d5fee…`); lo del
    periodo, la captura del ADR 0020.
- **No se ejecutan** las 22 variantes, los controles, la ablación ni el universo alternativo de EXP-0027. No entran en
  los criterios de §3, y cada ejecución más sobre el periodo sería otra mirada al único periodo limpio.
- **Integridad, antes de cargar nada del periodo.** El mismo código repite los 10 tramos de EXP-0027 y tiene que dar
  las mismas configuraciones elegidas y la misma serie fuera de muestra, periodo a periodo, que la salida guardada
  (`salidas/EXP-0027.json`, `hash_salida` `35938e022e32db6d3027d61cca700671bebcfab924a795f129b7c3c45e2b6edc`). En el
  tramo 10 tiene que elegir lo mismo que EXP-0029, con los mismos Sharpes de train. Si no, no se carga nada del periodo:
  se corrige el código y se repite esta comprobación.
- **Configuración elegida hoy** (EXP-0029, ADR 0044), como pidió la persona, solo con datos hasta el 2026-09-30.
  - EXP-0029 repite, idéntica, la elección en train de los 10 tramos de EXP-0027. Elige la del tramo 10 con lo que
    puntúa de su train, del 2023-10-01 al 2026-08-07, sin los embargos de 2024, 2025 y 2026.
  - Sharpe de train: 20/10, 0,7517057119240543; 20/20, 0,6356193930225108; 55/10, 0,9771816110020467; 55/20,
    0,7138779960989727.
  - **Elegida: `entryPeriod` 55, `exitPeriod` 10, `atrPeriod` 20 y `stopAtr` 2**, por 0,225 de Sharpe de train sobre
    la siguiente.
  - `hash_salida` de EXP-0029: `3a0c4b8c6ee9a38b56e8d070bad74b00b2a0d88303d07c674850086172373994`.

### 2. Cuándo y cómo, una sola vez

- **No antes del 2027-10-01,** y con el periodo completo capturado.
- **Datos:** velas OHLCVT diarias en EUR de Kraken, de BTC/EUR y ETH/EUR, de la misma fuente que EXP-0027 (ADR 0022).
  Las captura el modo captura del ADR 0020, solo en `data/holdout/` y sin que ningún código de investigación las lea.
- **Desbloqueo** (ADR 0020, decisiones 7 y 8; M-13). La persona pone `dataHash` y `unlockPublicKey` en el candado y
  firma un token de la etapa que abre el periodo completo (la 3, desde el 2027-10-01). Claude no escribe el candado ni
  lee `data/holdout/`.
- **Pre-registro antes de cargar el periodo:** un experimento nuevo de la familia `tendencia-donchian-atr` en el
  Experiment Registry, que cuenta en `N`, con este ADR como criterios y los umbrales de §3.
- **Una sola ejecución.** Cuenta la primera que carga datos del periodo.
  - Si falla antes de dar ninguna cifra del periodo (ni en la salida ni en los registros), se anota `fallido` y se puede
    repetir con la causa corregida, sin cambiar nada de esta especificación.
  - Si dio alguna cifra, su resultado es el que hay; si quedó incompleto, es `NO CONCLUYENTE`.
  - La única ejecución más es la reproducción de F.4.

### 3. Criterios, fijados hoy

**Distribución de referencia** (A.5). Es el bootstrap estacionario de la serie fuera de muestra de EXP-0027: el campo
`serie_configuracion.rendimientos` de su salida guardada, con 3559 rentabilidades diarias netas y un Sharpe de 1,47.
- Semilla, la del experimento (28), con el flujo `referencia-hacia-delante`.
- 10 000 remuestreos de 365 periodos, los del periodo hacia delante.
- Longitud media de bloque, la de su informe (28).

Lo calcula `forwardReference` (`src/analytics/forward-reference.ts`), y la prueba lo repite. Da un percentil 5 de la
rentabilidad neta de −0,040646985916777886 y un percentil 95 de la caída máxima de 0,2048147691511416.

| # | Criterio | Pasa si | Origen |
|---|---|---|---|
| F.1 | Rentabilidad | La rentabilidad neta del tramo hacia delante es ≥ −0,040646985916777886 (−4,06 %), el percentil 5 de la referencia | A.5.1 sobre el año (A.6.1) |
| F.2 | Caída dentro de lo esperado | La caída máxima del tramo es ≤ 10 %: el menor entre el percentil 95 de la referencia (20,48 %) y el 10 % | A.5.2 sobre el año (A.6.1) y A.6.3 |
| F.3 | Frecuencia | Cierra entre 3 y 14 operaciones, ambos incluidos: el intervalo central del 95 % de una Poisson de media 79 · 365 / 3559 = 8,10, la tasa de EXP-0027 | A.5.3 |
| F.4 | Decisiones | Una segunda ejecución desde el mismo commit y con los mismos datos da la misma salida (mismo hash): las mismas señales, en la misma vela y con el mismo lado, en el 100 % de los casos | A.5.5 |
| F.5 | Ganancia y Sharpe | El P&L neto del tramo es > 0 y su Sharpe neto anualizado, > 0 | A.6.2 |

- **F.1 y F.5 se exigen a la vez** (la persona, al aprobar el paso 31): rentabilidad ≥ −4,06 % y P&L > 0. Decide el
  más exigente, que es F.5, porque un P&L > 0 es una rentabilidad > 0. F.1 se mide y se registra igual.
- **Cómo se mide cada cifra:** como EXP-0027 mide sus tramos, con el mismo código.
  - Son las cifras `tramo_N_rentabilidad_neta`, `tramo_N_caida_maxima`, `tramo_N_operaciones_cerradas` y
    `tramo_N_sharpe_anualizado`, netas de costes y con lo abierto liquidado al final del tramo.
  - El P&L es la rentabilidad por 1000 EUR. Sin operaciones, F.5 falla (P&L de 0).
  - Las operaciones cerradas son las que cierra la estrategia, sin la liquidación final, como las 79 de la tasa.
- **A.5.4 (costes realizados) no entra.** Sin órdenes de verdad ni de paper, el coste de una reproducción es el del
  modelo por construcción y no mide nada. Es uno de los motivos por los que el resultado no puede servir para operar.
- **`DRAWDOWN_HALT` y `SLIPPAGE_BREAKER` tampoco.** El backtester no aplica los breakers de Risk; con una caída ≤ 10 %,
  el de drawdown no habría saltado.
- **Resultado:**
  - `SUPERADA` si pasan los cinco;
  - `NO SUPERADA` si falla uno;
  - `NO CONCLUYENTE` si alguno no se puede medir tal como está escrito, o si al cargar el periodo falla una condición:
    datos que no son de la misma fuente, huecos que el código congelado no admite, o BTC/EUR o ETH/EUR que dejan de
    cotizar en el periodo. Esto último evita una regla de liquidación al deslistar, que el backtester congelado no
    tiene.
  - No se usan los veredictos de `quant-research` §11: A sigue `RECHAZADA` pase lo que pase.

### 4. Qué puede decidir su resultado

- **Solo si se abre una investigación nueva, y lo decide la persona.**
  - Nunca se opera A ni ninguna otra estrategia por este resultado.
  - No es una promoción ni una etapa. A sigue `RECHAZADA` (`docs/PROMOTION_CRITERIA.md` A.1) y no entra en ningún
    registro de estrategias.
  - No abre el tramo 2 ni cambia el plan B.
- **Con `SUPERADA`,** la persona puede abrir una investigación nueva. Necesita una hipótesis nueva y su pre-registro,
  `N` con todas las pruebas anteriores (esta incluida), un periodo hacia delante nuevo, posterior al 2027-10-01, y un ADR
  aprobado por ella (parte C de `docs/PROMOTION_CRITERIA.md`, C.2.3).
- **Con `NO SUPERADA` o `NO CONCLUYENTE`,** este resultado no abre nada.
- **Se registra tal cual,** sin editar lo anterior:
  - el cierre en el Experiment Registry;
  - un informe `EXP-NNNN.md`;
  - una adenda en `docs/DECISION_POINT.md`.

  No se ajusta nada después de verlo: no se repite, ni se cambian parámetros, criterios, periodo o datos.

## Alternativas

| Opción | Por qué no |
|---|---|
| Una configuración fija (55/10, la elegida en el train del último tramo) | No es la especificación de EXP-0027, que fija un procedimiento, y en ese tramo 55/10 ganó a 20/10 por 0,001 de Sharpe de train. El procedimiento eligió después la misma en el tramo 10 (EXP-0029), con un margen de 0,225 |
| Todos los criterios de A.3 sobre el año | En un año se esperan unas 8 operaciones: A.3.5, A.3.6 o el DSR no se pueden medir. La persona eligió los de coherencia y resultado |
| Añadir A.6.4 (caída menor que la del buy-and-hold de BTC) | La persona fijó la lista |
| Calcular los umbrales al ejecutarla | Dejaría margen de implementación cuando ya se conozca el camino del mercado de ese año. Se calculan y se fijan hoy |
| Ejecutar las variantes o los controles sobre el periodo | Más miradas al único periodo limpio, sin entrar en los criterios |
| Elegir en el train del tramo 10 sin repetir los 10 tramos | Sin la repetición, no habría forma de comprobar que el código no ha cambiado antes de mirar el periodo |

## Consecuencias

- **Gasta el periodo del test final.** Después de ejecutarla, del 2026-10-01 al 2027-10-01 queda examinado
  (`quant-research` §4). Cualquier estrategia futura necesita un periodo hacia delante nuevo, que cambia el ADR 0019 y el
  candado (parada obligatoria). Mientras no se ejecute, sigue limpio.
- **Trabajo previo: el paso 53** (la persona, 2026-10-22), que se ejecuta después del 2027-10-01, con pruebas
  sintéticas y sin tocar esta especificación:
  - el modo captura del ADR 0020 (decisión 8), que estaba en el paso 42;
  - la lectura con el token;
  - la apertura de `particiones.test` del registro con la autorización humana, que también estaba en el 42;
  - comprobar que Kraken da el periodo por la misma fuente.
- **Kraken:** si no da el periodo por la misma fuente (los ZIP trimestrales o la API del ADR 0022), el resultado es `NO
  CONCLUYENTE`.
- **El candado no se toca** (la persona, 2026-10-22). Describe la etapa 3 con los criterios de promoción. Esta
  comprobación usa el desbloqueo de esa etapa, el periodo completo desde el 2027-10-01, con los criterios de este ADR, y
  es este ADR el que lo documenta.
- **Cuenta en `N`,** de la familia y global: EXP-0029 ya suma 4 pruebas, y la ejecución del paso 53 sumará las suyas.
