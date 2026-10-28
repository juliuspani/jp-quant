# ADR 0019 — Test final por etapas

Fecha: 2026-10-07 · Estado: **aceptado** por la persona el 2026-10-07, incluidos los cambios en `quant-research`
§4 y en el ADR 0002 · Paso: 17

## Contexto

`CLAUDE.md` §2 y `quant-research` §4: el test final es intocable, un periodo ya examinado no puede serlo, y su
periodo va en `config/holdout.lock`. La persona pidió comprobar primero qué rango llegó a evaluar la implementación
anterior, preferir un periodo pasado limpio y usar uno futuro solo si no hay otra opción.

### Qué datos usó la implementación anterior (comprobado el 2026-10-07)

| Dónde | Qué se encontró |
|---|---|
| Historial de git (81 commits, todas las ramas) | Nunca se versionaron datos, resultados ni bases de datos: ningún `.csv`, `.db`, `.parquet` ni informe de resultados en ningún commit (`git log --all --name-only`). Solo código y documentos |
| `data/` local | Vacía |
| `src/backtest.ts` (commit `902eb0a`, 2026-09-30) | Descarga velas de Binance al ejecutarse. Por defecto, los **últimos 1.095 días hasta `Date.now()`** (`--days`), con BTC/USDT, ETH/USDT y SOL/USDT en 4h (`config.json`). No guarda datos ni resultados, y no consta cuándo se ejecutó |
| `docs/research/02-estrategias-y-frecuencia.md` (mismo commit) | Pruebas propias [C] con velas de Binance **del 2017-08-17 al 2026-09-29**, sin huecos en el periodo. Inventario en «Pruebas previas» |
| `docs/research/03` a `05` | Sin pruebas de estrategias sobre precios |

**El último año sí se evaluó.** Hay resultados por año de 2025 y 2026 de la ruptura Donchian en 4h (línea 56:
«2025: +9 %», «2026 (hasta septiembre): +1 %») y de la regla de la media de 200 días sobre BTC (línea 504:
«2025: −3 %», «2026: +10 %»). Los valores por defecto se eligieron después de verlos (línea 60). El periodo pasado
más reciente sin tocar es una semana (desde el 2026-09-30), y en una semana no hay operaciones que medir.
Cambiar a Bitvavo o a EUR no limpia el periodo: los precios siguen casi exactamente a los de Binance en USDT.

## Decisión

**No hay periodo pasado limpio. El test final es hacia delante, del 2026-10-01T00:00:00Z (incluido) al
2027-10-01T00:00:00Z (excluido), y se usa por etapas.**

1. **Paso 31: decisión PROVISIONAL, que solo permite pasar a paper.** No abre el test final. Se basa en:
   - walk-forward y CSCV sobre toda la historia hasta el 2026-09-30;
   - Deflated Sharpe, con `N` contando como pruebas previas todo lo de `docs/research/02` (inventario abajo);
   - el informe del consultor quant (`consultor-quant`).
2. **Micro-live (unos 100 EUR).** Exige al menos 3 meses de datos hacia delante, nunca antes del 2027-01-01, y un
   comportamiento coherente con lo esperado según criterios que se congelan en el paso 27.
3. **Subir el capital por encima de micro-live.** Exige el año completo hacia delante (2027-10-01) y cumplir los
   criterios de promoción, también congelados en el paso 27.
4. **Paso 25: los parámetros por defecto salen de la literatura**, nunca del barrido de `docs/research/02`.
5. **Reglas comunes a las etapas:**
   - Cada apertura del test final (etapas 2 y 3) la autoriza la persona: es una parada obligatoria (M-13).
   - Entre etapas no se reoptimiza nada. Si la estrategia falla en una etapa queda `RECHAZADA`, y cambiarla es una
     hipótesis nueva sin test final limpio en esa familia.
   - Los resultados de paper durante el periodo forman parte del test hacia delante. Se miran para vigilar la
     operación y se juzgan solo en las etapas 2 y 3; nunca sirven para reajustar la estrategia.
6. **Universo:** los pares spot cotizados en EUR de Bitvavo (ADR 0018) en negociación el 2026-10-01T00:00:00Z.
   Cada estrategia aplica dentro de él su regla de universo con datos anteriores a esa fecha. Un par que se deslista
   durante el periodo sigue dentro: se sale al último precio negociable o, si no lo hay, la posición vale 0. Los
   deslistados entre el 2026-10-01 y la congelación se recuperan de los anuncios del exchange.
7. **Datos de research:** terminan el 2026-09-30T23:59:59Z, con el embargo de `quant-research` §4.
8. **Candado:** JSON, sin caracteres no ASCII (se crea con el Bloc de notas). Contenido en el anexo. El hash de los
   datos se añade en el paso 18 (INV-13f).

### Pruebas previas (`docs/research/02`) para el Experiment Registry

Se dan de alta como pruebas invalidadas de su familia al crear el registry (`quant-research` §10), para que cuenten
en el Deflated Sharpe. Donde el documento da un rango sin detallar, se cuenta el mínimo seguro y se anota «al menos».

| Familia | Pruebas | Dónde |
|---|---|---|
| Tendencia: ruptura Donchian con stop por ATR | Al menos 48: siete configuraciones (la de 1h con N de 60 a 240 cuenta al menos 2), el barrido de 21 combinaciones sobre seis pares, la ruptura de 20 velas en 6 marcos para BTC y ETH (12), riesgo por operación del 0,5, 1 y 2 % (3), trailing de 2 y 4 ATR (2) y la variante diaria con comisión del 0,6 % (2) | Líneas 44 a 58, 236, 282, 284 y 508 |
| Régimen de BTC sobre la media de 200 días | 3 (largo/plano, con banda del ±3 % y con objetivo de volatilidad); comprar y mantener es la referencia | Línea 134 y §6.2 |
| Reversión a la media (RSI(2)) | Al menos 7: umbrales 5, 10 y 20 en 1d y 4h, y una sin costes | Línea 73 |
| Ruptura de volatilidad intradía (Bollinger en 5m y 15m) | Al menos 1 | Línea 116 |
| DCA en BTC | 2 (simple y condicionado a la media de 200 días) | Línea 99 |
| Vistazos descriptivos | Correlaciones y caídas frente a BTC (últimos 3 años) y movimiento mediano por marco | §3.3 y línea 191 |

## Alternativas

| Opción | Por qué no |
|---|---|
| Del 2025-10-01 al 2026-09-30 | Examinado: confirmaría lo que ya se vio |
| El periodo pasado sin tocar (del 2026-09-30 a hoy) | Una semana: sin operaciones no mide nada |
| Un periodo pasado con una familia o unas monedas nuevas | La regla es por periodo. El filtro de régimen depende de BTC, y saber cómo se comportó en 2025 y 2026 sesga el diseño |
| Test final de una sola vez al terminar el año | Retrasa paper y micro-live hasta octubre de 2027 sin ganar seguridad: micro-live arriesga unos 100 EUR, y subir de ahí sigue exigiendo el año completo |
| Alargar el periodo sobre la marcha | Prohibido: decidir la duración viendo resultados es leakage |

## Consecuencias

- **El paso 31 decide antes, pero de forma provisional.** Su decisión solo vale para paper; la ventaja no se da por
  demostrada hasta la etapa 3.
- **Micro-live no antes del 2027-01-01, y más capital no antes del 2027-10-01.** El plan del tramo 2 se ordena
  con esas fechas.
- **Mirar en dos etapas tiene coste estadístico.** La etapa 2 solo comprueba coherencia y no aprueba nada. La
  aprobación es la de la etapa 3, con criterios fijados antes de mirar (paso 27).
- **12 meses es poco para demostrar una ventaja.** La prueba principal sigue siendo el walk-forward hasta 2026-09,
  con `N` contando todo lo anterior. El test hacia delante sirve sobre todo para refutar.
- Claude no puede escribir el candado (hook y M-13). Lo crea la persona, y el control INV-13e pasa a ser una prueba
  automática que comprueba que existe.
- `.claude/` solo lo edita la persona: el texto nuevo de `quant-research` está en el anexo, para pegarlo.

## Anexo A — Contenido de `config/holdout.lock`

`frozenOn` es el día en que se crea el archivo.

```json
{
  "version": 1,
  "adr": "docs/adr/0019-periodo-del-test-final.md",
  "periodUtc": { "start": "2026-10-01T00:00:00Z", "endExclusive": "2027-10-01T00:00:00Z" },
  "exchange": "bitvavo",
  "universe": "Spot pairs quoted in EUR on the exchange and trading at 2026-10-01T00:00:00Z; pairs delisted during the period stay in.",
  "researchDataEndUtc": "2026-09-30T23:59:59Z",
  "stages": [
    { "stage": 1, "name": "paper-provisional", "step": 31, "opensTestData": false, "basis": "walk-forward and CSCV up to researchDataEndUtc, Deflated Sharpe counting docs/research/02 as prior trials, consultor-quant report" },
    { "stage": 2, "name": "micro-live", "capital": "about 100 EUR, fixed by ADR in step 32", "notBeforeUtc": "2027-01-01T00:00:00Z", "minForwardMonths": 3, "opensTestData": true, "criteria": "behaviour consistent with expectations, frozen in step 27" },
    { "stage": 3, "name": "capital-above-micro-live", "notBeforeUtc": "2027-10-01T00:00:00Z", "requiresFullPeriod": true, "opensTestData": true, "criteria": "promotion criteria, frozen in step 27" }
  ],
  "rules": "Each opening of test data is a human decision (M-13). No re-optimisation between stages. Failing a stage rejects the strategy.",
  "frozenOn": "2026-10-07",
  "dataHash": null
}
```

## Anexo B — Texto para `quant-research` (lo pega la persona)

En `.claude/skills/quant-research/SKILL.md`, cabecera: sustituir «El paso 17 decidirá el periodo del test final
(§4).» por «El periodo del test final y sus etapas están en el ADR 0019.»

En §4, sustituir el apartado «**Test final intocable.**» completo por:

```markdown
- **Test final intocable, usado por etapas** ([ADR 0019](../../../docs/adr/0019-periodo-del-test-final.md)).
  - Su periodo está en `config/holdout.lock`: del 2026-10-01 al 2027-10-01, hacia delante, porque todo lo
    anterior hasta el 2026-09-29 está examinado. Ningún código de research lo carga sin un flag humano
    explícito. El hook de Claude bloquea cualquier comando de shell que nombre ese archivo o
    `data/holdout/`: no se intenta.
  - **Un periodo ya examinado no puede ser test final.** Las pruebas de
    `docs/research/02-estrategias-y-frecuencia.md` cuentan en `N` como pruebas previas de su familia.
  - **Etapa 1, paso 31:** decisión provisional que solo permite pasar a paper. No abre el test final: se basa en
    walk-forward y CSCV hasta el 2026-09-30, en el Deflated Sharpe y en el informe del consultor quant.
  - **Etapa 2, micro-live:** al menos 3 meses de datos hacia delante, nunca antes del 2027-01-01, con un
    comportamiento coherente con lo esperado según criterios congelados en el paso 27.
  - **Etapa 3, más capital:** el año completo hacia delante, cumpliendo los criterios de promoción del paso 27.
  - Cada apertura la autoriza un humano. Entre etapas no se reoptimiza. Si la estrategia falla en una etapa
    queda rechazada; cambiarla después es una hipótesis nueva que ya no tiene test final limpio en esa familia.
  - Los resultados de paper durante el periodo se juzgan solo en las etapas 2 y 3, nunca para reajustar.
```

En §11, fila `CANDIDATA A PAPER`, sustituir su texto por: «Pasa la decisión provisional del paso 31 (etapa 1 del
ADR 0019). Lo siguiente es paper trading, que valida la ejecución y no la ventaja; micro-live y más capital exigen
las etapas 2 y 3».

## Cambio (2026-10-15, paso 27)

Los criterios de las etapas 2 y 3, que esta decisión dejaba para el paso 27, están congelados en
`docs/PROMOTION_CRITERIA.md` (A.5 y A.6), con el [ADR 0030](0030-criterios-congelados.md). La etapa 2 exige además el
PRE-LIVE GATE (`docs/PRE_LIVE_GATE.md`). Por decisión de la persona, la regla 5 se precisa para la etapa 3: fallarla
significa no subir capital. Solo queda `RECHAZADA` si falla la coherencia; si falla otro criterio, sigue en micro-live
con el mismo capital hasta la revisión del año siguiente. El resto no cambia.