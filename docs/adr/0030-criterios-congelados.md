# ADR 0030 — Criterios congelados: promoción, PRE-LIVE GATE y plan si nada pasa

Fecha: 2026-10-15 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 27 ·
Cambiado por la persona el 2026-10-22, a la vista de resultados (decisión 9)

## Contexto

El prompt del paso 27 pide definir y congelar tres cosas **antes de ver ningún resultado de investigación**:

- **A.** Criterios de promoción RESEARCH → BACKTESTED → VALIDATED → PAPER, partiendo de los umbrales provisionales
  del [ADR 0002](0002-protocolo-quant-research.md) y fijándolos definitivamente.
- **B.** Criterios PASS/FAIL del PRE-LIVE GATE, marcando los críticos: un solo FAIL crítico bloquea live.
- **C.** Qué se hace si ninguna estrategia cumple A en el paso 31.

A y C van en `docs/PROMOTION_CRITERIA.md` y B en `docs/PRE_LIVE_GATE.md`. Cualquier cambio posterior requiere un ADR
justificado y reinicia la validación.

Compromisos de `PROGRESS.md` para este paso:
- (37 y 46) congelar los umbrales de `quant-research`: se cumple con A;
- (17) congelar los criterios de coherencia de micro-live (etapa 2) y de promoción para subir capital (etapa 3) del
  [ADR 0019](0019-periodo-del-test-final.md): se cumple con A.5 y A.6;
- (23 a 26) pruebas que faltan de EXP-0021 y EXP-0022, barridos con elección en train y PBO, control aleatorio y
  cálculo del veredicto: **no se hacen en este paso** (decisión 6).

Al congelar, Claude no había visto ninguna métrica de estrategia en esta sesión. Del registro solo se contaron las
pruebas por familia. Sí conoce el periodo y los informes de EXP-0021 y EXP-0022 de sesiones anteriores
(`quant-research` §12): por eso ningún umbral se acerca a una cifra conocida, y todos son iguales o más estrictos
que los provisionales.

## Decisión

### 1. Los umbrales del ADR 0002 se congelan y se endurecen, nunca se relajan

Se conservan todos: DSR ≥ 0,95, PBO < 0,20, IC del bootstrap > 0, superar al buy-and-hold y al percentil 95 del
control aleatorio, costes ×2, sensibilidad ±50 %, estabilidad sin el mejor año ni el mejor activo, ≥ 100
operaciones, ≥ 3 tramos, MinTRL y un bajista completo. Se añade lo que el prompt pide y el ADR 0002 no fijaba:

| Añadido | Valor | Por qué |
|---|---|---|
| `N` global en el DSR | Todas las pruebas del registro (hoy 65) | La decisión del paso 31 elige entre familias: compiten todas. Es la `N` más exigente |
| PBO entre 0,20 y 0,50 | `RECHAZADA` | El ADR 0002 no decía qué pasaba en medio. Fail closed |
| PBO con una sola configuración | `NO CONCLUYENTE` | Sin matriz no se mide; la matriz incluye todas las configuraciones que compiten |
| Drawdown máximo | ≤ 10 % y límite superior del IC ≤ 20 % | Es el breaker `DRAWDOWN_HALT` de `trading-risk` §5: una estrategia que lo dispara en el backtest no opera como se probó |
| Tramos positivos | Al menos la mitad | Que el resultado no salga de un solo tramo (ADR 0028: 2017 domina la tendencia) |
| Estrés | Retraso de una vela, cuatro ventanas de crisis fijadas hoy y peor caso dentro de la vela | Lo pide el prompt; ventanas fijadas antes de mirar resultados |
| Estabilidad de parámetros | ±25 % además de ±50 %, y el elegido en train no salta entre tramos | Meseta, no pico (`quant-research` §7) |
| Regímenes | Perfil por régimen de cada familia, sacado de su hipótesis y registrado antes de mirar resultados (A.3.9). Tendencia: en cada bajista (2018 y 2022) pierde ≤ 50 % de lo que pierde BTC, captura ≥ 50 % del alcista y pierde ≤ 5 % anual en lateral | En spot, una estrategia defensiva gana sobre todo en bajista: exigirle lo mismo en todos los regímenes contradice su diseño (cambio 5 de la persona). Solo rechaza: los parámetros del régimen los eligió Claude (ADR 0029) |
| Buy-and-hold ajustado por riesgo | Sharpe **y** Calmar por encima de BTC y del equiponderado | El Sharpe solo no ve la caída; el Calmar sí |
| Paso a PAPER | Consultor quant sin hallazgos altos o críticos abiertos, reproducción con el mismo hash y límites de `src/risk/limits.ts` | Base de la etapa 1 del ADR 0019 |

### 2. Etapas 2 y 3: coherencia medida contra el bootstrap del propio experimento

La etapa 2 solo puede refutar. Lo esperado sale del bootstrap estacionario de la serie fuera de muestra aprobada, con
remuestreos de la misma longitud que el periodo hacia delante: rentabilidad ≥ percentil 5, caída ≤ percentil 95 y
≤ 10 %, frecuencia dentro de la Poisson al 95 %, costes ≤ 1,5 veces el modelo y señales idénticas a la reproducción.
La etapa 3 repite esa coherencia sobre el año completo y exige P&L y Sharpe positivos, caída ≤ 10 % y menor que la
del buy-and-hold, y ningún incidente crítico. Son condiciones necesarias: el capital lo decide la persona.

Fallar la etapa 3 significa no subir capital (cambio 4 de la persona). Si falla la coherencia, la estrategia queda
`RECHAZADA` y se retira. Si falla otro criterio, sigue en micro-live con el mismo capital y la etapa 3 se repite con el
año siguiente. Nunca se reoptimiza entre etapas. Esto precisa la regla 5 del ADR 0019 («fallar una etapa la
rechaza») para la etapa 3; la etapa 2 sigue rechazando.

### 3. PRE-LIVE GATE: 17 criterios, 14 críticos

Los 13 temas del prompt dan 14 criterios críticos (el kill switch se separa en interno y externo). Se añaden 3 no
críticos: disponibilidad, avisos y latencia. Reglas:

- **Fail closed.** Sin evidencia, FAIL.
- **Un FAIL no crítico también bloquea**, salvo que la persona lo acepte en un ADR. Como mucho 2 a la vez, y nunca
  el mismo dos veces seguidas.
- **Vigencia por tipo de cambio** (cambio 3 de la persona). Documentación o tests: solo G-01. Strategy, risk,
  capguard, execution, reconciliación o configuración de riesgo: G-07 a G-09. Infraestructura: los afectados de G-13
  a G-17. Los 30 días valen para las comprobaciones puntuales, no para el paper. Claude añadió, por ser más
  conservador, que un cambio en execution o reconciliación repite además G-02 a G-05 y G-10, y que cualquier otro
  código repite los criterios que dependan de él.
- **M-03 lo exige.** Se añade a su paso 1 en `SECURITY_AND_TRADING_INVARIANTS.md`. Es añadir un control, no
  relajarlo (§2 de ese documento).

### 4. Paper: 8 semanas, 3 ciclos completos y decisiones idénticas

Cambio 2 de la persona, que sustituye al mínimo de 20 operaciones de la primera versión. El paper dura al menos 8
semanas y no termina antes del 2027-01-01. Exige al menos 3 ciclos completos de entrada y salida en paper o shadow, una
frecuencia dentro de la Poisson al 95 % y el 100 % de las decisiones iguales al backtest en todas las velas evaluadas.
Paper valida la ejecución. Los costes reales, que en paper son simulados, se validan con órdenes de verdad en la etapa
2 (A.5.4). Con 20 operaciones obligatorias, una estrategia de unas 12 operaciones al año tendría más de un año y medio
de paper sin aprender nada que 3 ciclos y la comparación vela a vela no den.

### 5. Plan si nada pasa: una segunda ronda acotada y después parar

Si nada pasa, hay una segunda ronda y solo una, con las tres familias pendientes del ADR 0028:

- mismo contador de multiple testing, que suma a la `N` global;
- la ruptura intradía de `docs/research/02` cuenta en Breakout;
- pre-registro conjunto de como mucho 2 estrategias por familia y 20 configuraciones por estrategia;
- mismos criterios y mismos datos, sin test final.

Si tampoco pasa nada, se para el trading activo y se documenta la alternativa pasiva (buy-and-hold o DCA) como
conclusión del proyecto, no como consejo personalizado. Una tercera ronda exige un ADR aprobado por la persona.

### 6. Los compromisos de research del 27 pasan a «antes del 31»

El prompt pide congelar antes de ver resultados y no pide ejecutar experimentos. Las pruebas que faltan de EXP-0021
y EXP-0022, los barridos con elección en train, el PBO, el control aleatorio y el cálculo del veredicto se mueven a
una fila «Antes del 31» de `PROGRESS.md`. Ese código tendrá que aplicar exactamente estos criterios. Es la opción
conservadora: hacerlos aquí mezclaría la congelación con los primeros resultados.

### 7. Huella y prueba

Cualquier cambio de texto hace fallar `test/docs/frozen-criteria.test.ts`, que fija el SHA-256 (finales LF) de cada
documento. Además comprueba que este ADR y `PROGRESS.md` lo recogen y que cada criterio del gate está marcado C o N.

| Documento | SHA-256 |
|---|---|
| `docs/PROMOTION_CRITERIA.md` | `7967cb763d0a773e6e6ccf055afeea332c15c4f6ca883ba17e3304da79db7893` (desde el cambio de la decisión 9) |
| `docs/PRE_LIVE_GATE.md` | `10d075607b3e051aabe2fe0c0012e09209ba203633623f388a78f4a71d75331c` |

### 8. Cambios de la persona antes de aprobar (2026-10-15)

La primera versión (commit `56c61db`) no estaba aprobada, ni la segunda (`613619a`). Antes de aprobar, la persona
pidió estos cambios, ya incluidos en las huellas de arriba:

1. régimen relativo al buy-and-hold, sustituido después por el cambio 5;
2. paper de 8 semanas con 3 ciclos y decisiones idénticas, en lugar de 20 operaciones (decisión 4);
3. qué cambios reinician qué criterios del gate (decisión 3);
4. fallar la etapa 3 es no subir capital (decisión 2);
5. **perfil por régimen de cada familia** (decisión 1, tabla A.3.9). El de tendencia lo fijó la persona; los de
   reversión, breakout, Cross-Sectional Momentum y Price + Volume los propuso Claude desde la hipótesis de cada familia
   y la persona los aceptó sin igualarlos. Se quita «ningún régimen aporta toda la ventaja», que choca con una
   estrategia defensiva. El pre-registro exige que 2018 y 2022 caigan enteros en tramos de validación.

Ninguna cifra de estrategia se había visto al hacerlos.

**Comprobación de datos para el cambio 5** (manifiesto de Kraken del 2026Q2):

- BTC/EUR empieza el 2013-09-10 y ETH/EUR el 2015-08-07, en 1d, 4h y 1h.
- Con el diseño de las especificaciones de EXP-0021 y EXP-0022 (datos desde el 2014-01-01, 3 años de train y
  validaciones anuales de 2017 al 2026-09-30), 2018 y 2022 son tramos de validación completos para los dos pares.
  Hay calentamiento de sobra y el régimen de BTC tiene etiqueta desde 2015.
- Vale para las cinco familias con ese diseño. Cross-Sectional Momentum también puede medirlos, pero con un corte
  transversal pequeño en 2018: hay 13 pares en EUR con velas diarias antes de 2018, y antes de 2023 el universo tiene
  sesgo de supervivencia (DATA.md). Su pre-registro lo declara. No hace falta relajar nada ni ampliar el histórico.

### 9. Cambio de la persona a la vista de resultados (2026-10-22)

Es el primer cambio de estos criterios desde que se congelaron, y se hizo **después de ver resultados**: los de la
primera ronda (EXP-0025 y EXP-0026) y la auditoría quant ciega que los revisó
(`docs/audits/2026-10-20-quant-primera-ronda.md`). La persona aprobó cada corrección (`docs/progress/DECISIONS.md`) y
pidió congelarlas en la parte 9 del plan de la auditoría.

| Criterio | Qué cambia | ADR |
|---|---|---|
| A.3.2 | `V[SRₙ]` es la de una prueba sin habilidad; la `N` global se cuenta al decidir y es la misma para todos; PSR y DSR usan la varianza a largo plazo del Sharpe | 0038 y 0039 |
| A.3.5 | El MinTRL usa la varianza a largo plazo del Sharpe | 0038 |
| A.3.6 | Con menos de 3 configuraciones, `NO CONCLUYENTE` (antes, con menos de 2); el PBO de cada familia se informa y no decide | 0041 y auditoría Q-06 |
| A.3.9 | Bajista y alcista en crecimiento logarítmico frente a BTC escalado por la exposición de la estrategia, sin polvo, en toda la serie y en cada régimen, y vale la más exigente | 0042 |
| A.3.11 | Decide el menor de dos límites inferiores del IC: el del bootstrap y el de la varianza a largo plazo | 0038 |
| A.3.14 | Un componente aporta si, sin él, baja el exceso sobre su propio control aleatorio | 0037 |

- **Los umbrales no cambian; cambia cómo se mide cada criterio.** Con el texto anterior:
  - la captura del alcista era inalcanzable con los límites de Risk (Q-02);
  - el DSR global dependía del orden de los experimentos (Q-03);
  - el PBO decidía con 2 configuraciones, cuando su aceptación falsa es del 20 % (Q-06);
  - la ablación no controlaba la exposición, y el Sharpe suponía rentabilidades independientes.

  El bajista de A.3.9 se endurece y su alcista deja de ser inalcanzable.
- **Contaminación declarada.** Claude y la persona conocían los resultados de A y B, y la auditoría los cita. Para
  acotarla:
  - los umbrales de A.3.9 se mantienen, y su medida se fijó con estudios sintéticos de diseño fijado antes de
    ejecutarlos, validados con caminos de otra semilla, sin calcular A ni B con ella (ADR 0042);
  - el mínimo de configuraciones del PBO sale de una tabla sintética (ADR 0041);
  - A y B no se reabren: siguen `RECHAZADA` con los criterios anteriores. Se repiten una sola vez, como estaban
    pre-registradas, como experimentos nuevos que cuentan en `N`.
- **Validación reiniciada.** Ninguna estrategia estaba por encima de RESEARCH: A y B estaban `RECHAZADA`. Desde este
  cambio, todo experimento se evalúa con estos criterios, y la `N` cuenta todas las pruebas anteriores.
- **Huellas.** `docs/PROMOTION_CRITERIA.md` tenía `13c513bffaa23ad6e572ec1c8e4ecdd0bd5db15d1789417fda940ab1dea336d7`
  (commit `a586f07`); ahora tiene la de la decisión 7. `docs/PRE_LIVE_GATE.md` no cambia.
- **Texto para el skill.** El anexo 2 trae lo que cambia en `quant-research`, para que lo pegue la persona. Hasta
  entonces mandan `docs/PROMOTION_CRITERIA.md` y los ADR citados.

## Alternativas

- **Congelar el ADR 0002 sin más.** No cubriría drawdown, estrés, regímenes, el hueco del PBO entre 0,20 y 0,50 ni
  las etapas 2 y 3, que el prompt y el ADR 0019 exigen.
- **`N` solo por familia.** Bajaría el umbral del DSR en una decisión que elige entre familias.
- **Drawdown de 20 o 25 %.** Con el breaker al 10 %, la estrategia pararía en real antes de llegar a lo probado.
- **Exigir que el límite inferior del IC del exceso de Sharpe sobre BTC sea positivo.** Rechazaría casi cualquier
  estrategia defensiva, cuyo valor está en la caída y no en el Sharpe. Se exige el Calmar y el IC se informa.
- **Paper con 20 operaciones obligatorias** (primera versión). Alargaba el paper más de un año en estrategias lentas
  para validar costes que en paper son simulados; la persona lo sustituyó (decisión 4).
- **Régimen con Sharpe > 0 sin el más favorable** (primera versión). Exigía ganar en bajista o lateral, donde en spot
  lo correcto puede ser estar en liquidez; la persona lo sustituyó (decisión 1).
- **Régimen relativo al buy-and-hold** (segunda versión). Si el bajista era el régimen más favorable, como es de
  esperar en una estrategia defensiva, exigía ganar a BTC en alcista y lateral; lo sustituyen los perfiles por familia.
- **Admitir FAIL no críticos sin límite.** Convertiría el gate en una lista de avisos.
- **Hacer ya los experimentos pendientes.** Ver la decisión 6.

## Consecuencias

- Es probable que ninguna estrategia de la primera ronda pase. Con unas 12 operaciones al año, la tendencia no llega
  a 100 operaciones (ADR 0002). Entonces se aplica la parte C. Es intencionado.
- **Código pendiente para medir A.** Retraso de una vela en el backtester, ventanas de crisis, `N` global en el DSR,
  CSCV entre familias, regímenes en el veredicto, sensibilidad ±25 % y la distribución de referencia de las etapas 2
  y 3. Mientras falte, el resultado es `NO CONCLUYENTE`.
- **Código pendiente para el gate.** Inyección de fallos, simulacros de caída, copias y restauración, y rollback. Hoy
  el gate está en FAIL por la regla 1.
- **Cambiar estos documentos es una parada obligatoria** (`CLAUDE.md` §7) y reinicia la validación.
- **Texto para el skill.** `quant-research` sigue diciendo que el ADR 0002 es provisional. El texto nuevo está en el
  anexo, para que lo pegue la persona (`.claude/` solo lo edita ella). Hasta entonces manda este ADR.

## Anexo — Texto para `quant-research` (lo pega la persona)

En `.claude/skills/quant-research/SKILL.md`, cabecera: sustituir el párrafo «**ADR 0002 está aceptado
provisional.** … etapas están en el ADR 0019 (§4).» por:

```markdown
**Umbrales congelados en el paso 27** ([ADR 0030](../../../docs/adr/0030-criterios-congelados.md)): los criterios
de promoción están en `docs/PROMOTION_CRITERIA.md` y el gate antes de operar en real en `docs/PRE_LIVE_GATE.md`.
Donde difieran de este skill, mandan esos documentos, que son más estrictos. Cambiarlos es una parada obligatoria y
reinicia la validación. El periodo del test final y sus etapas están en el ADR 0019 (§4).
```

En §4, en el apartado del test final, sustituir «Si la estrategia falla en una etapa queda rechazada; cambiarla después
es una hipótesis nueva que ya no tiene test final limpio en esa familia.» por:

```markdown
Si falla la etapa 2, o la coherencia en la etapa 3, queda rechazada. Si en la etapa 3 falla otro criterio, no se sube
capital: sigue en micro-live con el mismo capital hasta la revisión del año siguiente (ADR 0030). Cambiarla después es
una hipótesis nueva que ya no tiene test final limpio en esa familia.
```

En §9, después de la primera frase, añadir: «Los criterios completos y congelados, más estrictos que esta tabla, están
en `docs/PROMOTION_CRITERIA.md` (A.3).»

## Anexo 2 — Texto para `quant-research` tras el cambio del 2026-10-22 (lo pega la persona)

Todo en `.claude/skills/quant-research/SKILL.md`. Las pruebas del skill siguen pasando con estos textos: comprueban
términos y umbrales que no cambian.

1. En §6, sustituir el apartado «**Benchmark (buy-and-hold).** … equiponderado del universo point-in-time.» por:

   ```markdown
   - **Benchmark (buy-and-hold).** Comprar BTC al inicio y mantenerlo, pagando los costes de la compra. Con
     más de un activo, también el buy-and-hold equiponderado del universo point-in-time. En los regímenes
     (A.3.9) se compara con BTC escalado por la exposición de la estrategia, sin polvo (ADR 0042).
   ```
2. En §7, sustituir el apartado «**Ablación.** … Un componente que no aporta se elimina.» por:

   ```markdown
   - **Ablación.** Se quita cada componente (filtros, stops, reglas de salida, features) y se mide su
     aportación a la métrica primaria fuera de muestra, como exceso sobre su propio control aleatorio con
     las mismas operaciones y duraciones (ADR 0037). Un componente que no aporta se elimina.
   ```
3. En §8, sustituir las dos líneas «`N` es el **número total de pruebas de la familia** … de las pruebas que tienen
   métricas.» por:

   ```markdown
     - `N` es el **número total de pruebas de la familia** según el registro, contando las fallidas y las
       abortadas; la `N` global, todas las del registro al decidir (ADR 0039). `V[SRₙ]` es la varianza del
       Sharpe estimado de una prueba sin habilidad con la misma longitud y dependencia, nunca por debajo de
       `1/(T − 1)` (ADR 0039).
     - Con autocorrelación, la varianza del Sharpe es la varianza a largo plazo de su función de influencia
       (ADR 0038), que nunca baja de la de la fórmula de arriba. La usan PSR, DSR y MinTRL.
   ```
4. En §8, sustituir la línea «- **Probability of Backtest Overfitting (CSCV)**, obligatoria cuando se comparan varias
   configuraciones.» por:

   ```markdown
   - **Probability of Backtest Overfitting (CSCV)**, obligatoria cuando se comparan varias configuraciones.
     Con menos de 3 configuraciones se informa y no decide (A.3.6, ADR 0041).
   ```
5. En §8, sustituir las dos líneas «Se dan IC al 95 % de la métrica primaria, el CAGR y el drawdown máximo, y del exceso
   sobre el benchmark.» por:

   ```markdown
     - Se dan IC al 95 % de la métrica primaria, el CAGR y el drawdown máximo, y del exceso sobre el
       benchmark. Para la métrica primaria, también el de la varianza a largo plazo del Sharpe, y decide el
       menor de los dos límites inferiores (A.3.11, ADR 0038).
   ```
6. En la tabla de §9, sustituir las filas de Bootstrap y Ablación por:

   ```markdown
   | Bootstrap | El límite inferior del IC al 95 % de la métrica primaria es mayor que 0 (el menor de los dos de A.3.11) |
   ```

   ```markdown
   | Ablación | Todos los componentes que quedan aportan, frente a su propio control aleatorio (ADR 0037) |
   ```
