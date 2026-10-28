# ADR 0002 — Protocolo de investigación cuantitativa

Fecha: 2026-10-01 · Estado: aceptado provisional; umbrales congelados el 2026-10-15 por el
[ADR 0030](0030-criterios-congelados.md) · Paso: 5

**ACEPTADO PROVISIONAL.** El usuario lo aprobó el 2026-10-01 con estas condiciones:

- **Umbrales.** Los de las decisiones 2, 3 y 4 se aplican desde ya, pero se congelan definitivamente en el
  **paso 27**, con un ADR nuevo.
- **Registry.** El JSONL versionado en git (decisión 5) se aprueba por ahora. El **paso 21** decidirá si
  migra a una base de datos.
- **Periodo del test final.** No está decidido. El **paso 17** comprobará qué periodos de datos usó la
  implementación anterior y decidirá a partir de qué fecha hay datos limpios. Hasta entonces no se da por
  hecho que el test final tenga que ser posterior a 2026-09.
- **Checklist y plantilla** como archivos aparte en la carpeta del skill: aprobado.

## Contexto

`CLAUDE.md` §2 prohíbe el look-ahead, el sesgo de supervivencia y el leakage. También exige costes en todo
backtest y un test final intocable, pero no dice cómo se comprueba ni cuándo una evidencia es suficiente.
Las pruebas exploratorias de `docs/research/02-estrategias-y-frecuencia.md` se hicieron sin corrección por
pruebas múltiples ni walk-forward formal, y el propio documento lo reconoce. El paso 5 fija el procedimiento
en el skill `.claude/skills/quant-research/`.

## Decisiones

1. **El procedimiento vive en un Project Skill** (`.claude/skills/quant-research/SKILL.md`), con un
   checklist y una plantilla de informe al lado. Así se carga cuando se hace research y no ocupa
   `CLAUDE.md`.
2. **Umbrales de aceptación.** Son mínimos, se miden fuera de muestra y netos de costes:
   - `DSR ≥ 0,95`, con `N` igual a todas las pruebas de la familia.
   - `PBO < 0,20` para aceptar; con `≥ 0,50` se rechaza.
   - Límite inferior del IC al 95 % (bootstrap estacionario por bloques) mayor que 0.
   - Supera al buy-and-hold y al percentil 95 de ≥ 1000 simulaciones aleatorias.
   - Sigue siendo positiva con costes ×2.
   - Con ±50 % en cada parámetro, la métrica no cambia de signo ni cae a menos de la mitad.
   - Sigue siendo positiva sin el mejor año y sin el mejor activo.
3. **Muestra mínima.** ≥ 100 operaciones cerradas fuera de muestra, ≥ 3 tramos walk-forward, `MinTRL` al
   95 % y al menos un mercado bajista completo.
4. **Costes mínimos por lado.** Comisión taker real, como mínimo 0,10 %, más medio spread, más slippage de
   como mínimo 0,05 %. Son los supuestos de `docs/research/02` más el spread, que allí no se cobraba.
5. **Experiment Registry** en `docs/research/experiments/registry.jsonl`.
   - Es un JSONL solo de inserción, versionado en git.
   - Tiene una línea de pre-registro y otra de cierre por experimento.
   - Los informes van a `docs/research/experiments/EXP-NNNN.md`.
6. **Cuatro veredictos cerrados:** `RECHAZADA`, `NO CONCLUYENTE`, `CANDIDATA A TEST FINAL` y
   `CANDIDATA A PAPER`. "Rentable" no es un veredicto.
7. **Un periodo ya examinado no puede ser test final.** Las pruebas de `docs/research/02` cuentan en `N` como
   pruebas invalidadas de su familia. Qué periodos se examinaron de verdad, y por tanto qué periodo puede ser
   test final, lo decide el paso 17.

## Alternativas descartadas

- **Poner el procedimiento en `CLAUDE.md`.** Lo alargaría en cada sesión, y su §1 pide que sea corto.
- **Umbrales laxos, como `DSR ≥ 0,90` o `PBO < 0,50`.** Habría más candidatas, pero la prioridad del
  proyecto es no engañarse con el backtest.
- **Registry en SQLite (`node:sqlite`).** Ya está en el stack, pero no se revisa en un diff ni se puede
  comprobar en git que solo se inserta.
- **Exigir solo P&L y Sharpe dentro de muestra.** Es exactamente lo que el protocolo prohíbe.

## Consecuencias

- Con unas 12 operaciones al año, como la estrategia de tendencia de `docs/research/02`, no se llega a 100
  operaciones fuera de muestra en un plazo razonable. Esa estrategia quedará `NO CONCLUYENTE` salvo que se
  amplíe el universo point-in-time. Es intencionado, no un fallo.
- Hace falta una fuente de datos con activos deslistados. ccxt solo devuelve los mercados actuales.
- Mientras no exista `config/holdout.lock`, ningún experimento pasa de `CANDIDATA A TEST FINAL`.
- Las fórmulas (DSR, PSR, MinTRL, CSCV y bootstrap) están descritas pero no implementadas. Se implementan
  con pruebas en el paso que construya el código de research.
- Cambiar un umbral exige un ADR nuevo.

## Corrección editorial (2026-10-05)

Renumeración del plan en el paso 12 ([ADR 0010](0010-regla-de-decisiones-y-nuevo-plan.md)). Solo cambian
los números de paso, con la tabla de `docs/progress/PLAN_MAP.md` (registro de trabajo privado, no publicado); no cambia
ninguna decisión. Cambios:

- 37 → 27 (congelar los umbrales);
- 23 → 21 (migración del registry);
- 16 → 17 (periodo del test final).

## Cambio (2026-10-07, paso 17)

Aprobado por la persona en el paso 17. Sustituye la condición «Periodo del test final» de la cabecera y amplía la
decisión 7; el resto no cambia. Detalle en [ADR 0019](0019-periodo-del-test-final.md).

- **Periodo del test final:** del 2026-10-01 al 2027-10-01, hacia delante. Todo hasta el 2026-09-29 está
  examinado (`docs/research/02`), incluido el último año.
- **Uso por etapas:** el paso 31 toma una decisión provisional que solo permite paper, sin abrir el test final
  (walk-forward y CSCV sobre toda la historia, Deflated Sharpe y consultor quant). Micro-live exige al menos 3
  meses de datos hacia delante, nunca antes del 2027-01-01. Subir el capital exige el año completo. Los criterios de
  las dos últimas etapas se congelan en el paso 27.
- **Pruebas previas:** el ADR 0019 inventaría las de `docs/research/02` por familia, para darlas de alta en el
  registry y que cuenten en `N`.
- **Paso 25:** los parámetros por defecto salen de la literatura, nunca del barrido de `docs/research/02`.

## Cambio (2026-10-13, paso 21)

Cierra la condición «Registry» de la cabecera; el resto no cambia. Detalle en
[ADR 0024](0024-registro-de-experimentos.md).

- **El registro no migra a una base de datos.** Sigue siendo el JSONL de la decisión 5, ahora en JSON canónico y
  encadenado por SHA-256, con una prueba que compara lo confirmado en git.
- **Las pruebas previas de `docs/research/02` están dadas de alta** como invalidadas de su familia (decisión 7), con
  el inventario del ADR 0019.

## Cambio (2026-10-15, paso 27)

Cierra la condición «Umbrales» de la cabecera con el ADR nuevo que pedía: el
[ADR 0030](0030-criterios-congelados.md). Los umbrales de las decisiones 2, 3 y 4 quedan congelados, y endurecidos donde
el ADR 0030 lo dice, en `docs/PROMOTION_CRITERIA.md`. Ninguno se relaja. Cambiarlos es una parada obligatoria
(`CLAUDE.md` §7) y reinicia la validación.