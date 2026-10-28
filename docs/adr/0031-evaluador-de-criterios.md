# ADR 0031 — Evaluador de los criterios congelados

Fecha: 2026-10-15 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 27B

## Contexto

El paso 27 congeló los criterios de promoción (`docs/PROMOTION_CRITERIA.md`, ADR 0030), pero el código no los medía:
todo experimento terminaba con el veredicto en `null`. El prompt del paso 27B pide implementar la medición de cada
criterio, con una prueba por criterio, para que los experimentos del paso 28 den PASS o FAIL en lugar de
`NO CONCLUYENTE`. Regla principal del paso: **el evaluador se construye y se prueba solo con datos sintéticos de
resultado conocido**; ninguna estrategia se ejecuta sobre datos reales.

Al revisar la primera versión, la persona pidió además (2026-10-15): implementar la ablación y el universo alternativo
(A.3.14), comprobar la validez del simulador del control aleatorio y repetirlo con el backtester real si se aleja más de
un 10 %, corregir el año del desglose del paso 26 y fijar la lectura de la muestra insuficiente (decisiones 6, 7, 11 y
12).

## Decisión

### 1. Las ejecuciones de robustez cuentan en N y se declaran en el registro

`docs/PROMOTION_CRITERIA.md` (regla 4) dice que las variantes de sensibilidad, ablación y estrés se pre-registran con su
experimento y cuentan en `N`. El registro exigía `n_pruebas` igual al tamaño de la rejilla, así que no había dónde
contarlas.

- La línea de pre-registro lleva un campo nuevo, `variantes`: las ejecuciones de robustez sobre datos reales que hará
  el ejecutor. La lectura exige `n_pruebas = configuraciones + variantes`. Es opcional solo para leer las líneas
  anteriores al 27B; el comando de backtest exige declararlo siempre, también cuando es 0, y una prueba previa no puede
  declararlo.
- El formato de línea sigue siendo el 1: un campo opcional nuevo no cambia ninguna línea escrita.
- El ejecutor comprueba que las variantes que va a ejecutar son exactamente las registradas; si no, lanza y el
  experimento queda `fallido`, contando en `N`.

### 2. N global

El ejecutor recibe, además de la evidencia de la familia, la del registro entero tal como estaba al pre-registrar
(`globalEvidence`): `N` es la suma de `n_pruebas` de todas las líneas hasta la suya incluida, de todas las familias y
con las previas, fallidas, abortadas e invalidadas; los Sharpe para `V[SRₙ]`, los de las completadas antes con el mismo
timeframe. Con ella se calcula el segundo DSR de A.3.2.

> Sustituido por el ADR 0039 (2026-10-21): el DSR global ya no se calcula al cerrar cada experimento, sino en la
> decisión, con la N de todo el registro en ese momento y la V[SRₙ] de una prueba sin habilidad.

### 3. El veredicto lo da el ejecutor

`RunOutput` lleva el veredicto de `quant-research` §11 y `runExperiment` lo escribe en el cierre. La reproducción exige
el mismo veredicto, además del mismo hash de salida.

### 4. El evaluador es puro y está en `analytics/criteria.ts`

Recibe lo medido (`CriteriaEvidence`) y devuelve, por cada criterio de A.3.1 a A.3.15, su estado (`PASS`, `FAIL` o
`NO CONCLUYENTE`), el valor medido, el umbral y una nota cuando algo no se mide. El veredicto sigue la regla 2 del
documento: un `FAIL` basta para `RECHAZADA`; sin fallos, uno sin medir da `NO CONCLUYENTE`; todo en `PASS` da
`CANDIDATA A TEST FINAL` (VALIDATED, A.1). Cada informe lleva la huella de los dos documentos congelados
(`FROZEN_DOCUMENTS`), que una prueba compara con la de `test/docs/frozen-criteria.test.ts`. A.4 (paso 31), las etapas 2
y 3 (A.5 y A.6) y el PRE-LIVE GATE quedan fuera y se listan en el informe como no evaluados.

### 5. Cómo se mide cada cosa (`windows.ts`, `robustness.ts`, `random-control.ts`)

- **Fecha de un periodo.** Las marcas de la curva llevan el instante de recepción de la vela (cierre más la latencia de
  la fuente). Un periodo se asigna a la fecha de su punto medio (`periodInstant`), que cae dentro de su vela mientras la
  latencia sea menor que media vela. Así la vela del 31 de diciembre cuenta en su año aunque se reciba el 1 de enero.
- **Ventanas de crisis (A.3.7).** Una ventana se evalúa si los tramos de validación la cubren entera. Si la cubren en
  parte, `NO CONCLUYENTE`; si no la tocan, no cuenta; si ninguna cae en validación, `NO CONCLUYENTE`. La rentabilidad de
  BTC en la ventana es la de su buy-and-hold en los mismos periodos, sin cobrarle una compra al entrar en la ventana:
  eso favorece a BTC, que es lo conservador.
- **Regímenes (A.3.9).** Cada bajista, solo si está entero fuera de muestra. Alcista y lateral, con la etiqueta de
  `regimen-precio@1` de BTC conocida al empezar cada periodo. Si BTC no sube en sus periodos alcistas, la estrategia no
  puede perder en ellos (la regla simétrica a la del bajista, que el documento sí escribe). Las familias de
  Cross-Sectional y Price + Volume tienen perfil, pero aún no slug: se asocian al abrir la segunda ronda. Desde el ADR
  0042 (aceptado, auditoría Q-02), el bajista y el alcista comparan en crecimiento logarítmico con BTC escalado por la
  exposición de la estrategia, sin polvo, en toda la serie y en cada régimen, y vale la más exigente; ya no con todo el
  capital.
- **Sensibilidad (A.3.8).** Cada parámetro numérico, de uno en uno, por 0,5, 0,75, 1,25 y 1,5. Los enteros se redondean
  hacia fuera (hacia abajo al bajar, hacia arriba al subir), para que el cambio no desaparezca. Una variante que no se
  puede construir (por ejemplo, un periodo de 1 que la feature rechaza) queda sin medir: `NO CONCLUYENTE`. Un Sharpe base
  no positivo es `FAIL`. Sin barrido, la estabilidad del elegido en train no aplica; la función que la mide existe para
  cuando haya barridos.
- **Control aleatorio (A.3.12).** Las mismas operaciones (número, símbolo, duración y fracción del patrimonio) en
  instantes al azar del mismo tramo, sin solaparse dos del mismo símbolo, con el mismo coste por lado, 1000 veces con la
  semilla del experimento. Se compara el Sharpe real con el percentil 95 (cuantil de tipo 7). Las colocaciones se
  evalúan primero con un simulador de operaciones de tamaño fijo, que suma las operaciones abiertas sin componer.
- **Validez del simulador** (fijada por la persona). La «réplica» es el Sharpe de las operaciones de la estrategia con el
  simulador. Si se aleja más de un 10 % del Sharpe del backtester, o no se puede comprobar (falta alguno o el real es 0),
  el simulador no decide: el evaluador da `NO CONCLUYENTE` a cualquier control que dependa de él, y el ejecutor repite las
  mismas colocaciones con el backtester real (decisión 11). El 10 % justo vale.
- **Pruebas de humo (A.3.15).** La señal desplazada gira el calendario de cada tramo un número de periodos al azar y
  conserva la estructura de las operaciones (la que pasaría del final se corta en él); se toma la mediana de 100
  desplazamientos, porque un solo sorteo supera el percentil 95 una vez de cada veinte sin que haya ningún fallo. Se
  evalúa con el mismo método que decidió el control. El paseo aleatorio pasa por el backtester completo y se compara con
  su propio control aleatorio, con la misma regla de validez.
- **PBO (A.3.6).** `pboAcross` alinea las series de las configuraciones en sus instantes comunes y aplica el CSCV del
  paso 26 (S = 16), dentro de la familia y entre familias. Con menos de dos configuraciones, o menos de 32 periodos en
  común, no se mide.
- **Sin el mejor año (A.3.13).** Se quitan los periodos del año UTC con más rentabilidad compuesta y se recalcula el
  Sharpe; con un solo año, sin medir.

### 6. Ablación y universo alternativo (A.3.14)

La primera versión del 27B lo dejaba siempre en `NO CONCLUYENTE`; la persona pidió implementarlo antes de cerrar el paso,
para que ningún criterio quede sin código antes del 28.

- **Ablación.** Cada estrategia declara los componentes que se pueden quitar, y la regla se construye sin cada uno con
  las mismas features y el mismo calentamiento. Un componente aporta si quitarlo baja el Sharpe (desde el 2026-10-21,
  con la exposición controlada: baja el exceso sobre su control aleatorio, ADR 0037). Todos aportan: `PASS`;
  alguno no: `FAIL`; sin declarar, sin componentes o sin poder construir uno: `NO CONCLUYENTE`.
  - Tendencia: `salida-canal` (sin ella sale solo por el stop).
  - Reversión: `filtro-tendencia` (entra también bajo la media de 200) y `salida-media` (sale solo por el stop).
  - No se quitan la señal de entrada, que es la estrategia, ni el stop, que exige Risk para dimensionar
    (`trading-risk`): quitarlo cambiaría el tamaño, no solo la protección. Cada ficha de la biblioteca lo declara
    (`noAblables`).
- **Universo alternativo.** Los activos se fijan en el pre-registro, en un campo nuevo y opcional del universo,
  `alternativos`, que la lectura del registro exige sin repetidos y sin símbolos del universo de diseño. Sus velas vienen
  del mismo dataset registrado. Sharpe > 0: `PASS`; si no: `FAIL`; sin `alternativos`: `NO CONCLUYENTE`.
- Cada componente quitado y el universo alternativo son variantes: cuentan en `N` (regla 4).

### 6 bis. Lo que aún no se puede medir da `NO CONCLUYENTE`

**A.3.6 en un experimento sin barrido** tiene una sola configuración: `NO CONCLUYENTE` hasta que haya barridos o la
decisión del paso 31 junte las series de la ronda. Por eso el paso 28 pre-registra un barrido pequeño por familia.

### 7. Muestra insuficiente: `FAIL` si se mide y no llega, `NO CONCLUYENTE` si no se puede medir

Lectura fijada por la persona al revisar el paso, siguiendo el documento congelado: si el criterio se mide y no llega
al umbral (menos de 100 operaciones cerradas, MinTRL sin cumplir), es `FAIL` de A.3.5 y basta para `RECHAZADA`. Si no se
puede medir (ningún bajista completo fuera de muestra), es `NO CONCLUYENTE`, como en los perfiles de A.3.9.
`quant-research` §11 se alinea con esta lectura con el texto del anexo, que pega la persona.

### 8. Retraso de una vela: features retrasadas, no un venue más lento

La tabla A.3.7 pide ejecutar en la apertura de t + 2 en lugar de la de t + 1. `strategy/delay.ts` envuelve la
estrategia para que decida al cierre de t con las features de t − 1 (`lagged` en `features/definitions.ts`), así que
toma la decisión que la original tomaba una vela antes y la orden sale una vela más tarde. Sigue siendo pura y no toca el
venue ni Execution. La posición que recibe es la real; si un stop saltó entre medias, decide con la posición de verdad,
que es lo que pasaría en real. Alternativa descartada: alargar la latencia del venue simulado hasta la vela siguiente,
que choca con el tope de latencia (60 s) y con el TTL de las órdenes, y cambiaría el modelo de ejecución en lugar de la
señal.

### 9. El ejecutor hace las ejecuciones y junta la evidencia (`app/criteria-evidence.ts`)

- **Variantes que cuentan en N** (`robustnessPlan`): costes ×2 y ×3, retraso de una vela, cada parámetro numérico a
  ±25 % y ±50 %, el universo sin su mejor activo si tiene más de uno, cada componente quitado y el universo alternativo
  si se registró. Para las estrategias de la biblioteca con su universo de dos pares y un universo alternativo: 22 en la
  tendencia (4 parámetros, 1 componente) y 31 en la reversión (6 parámetros, 2 componentes). El ejecutor comprueba antes
  de cargar las velas que son las registradas.
- **Controles que no cuentan en N**, porque no son estrategias candidatas que compitan por la decisión: el control
  aleatorio, la señal desplazada y el paseo aleatorio. Contarlos haría imposible el DSR sin hacer nada más estricto el
  protocolo que ya los exige.
- **Paseo aleatorio** (`app/smoke-data.ts`): las velas de cada símbolo, barajadas con la semilla. Cada vela conserva su
  forma respecto del cierre anterior y su volumen; el camino tiene las mismas rentabilidades y el mismo precio final, sin
  estructura temporal. La estrategia pasa por el backtester completo con esas velas, y su Sharpe se compara con el
  percentil 95 de su propio control aleatorio sobre el mismo camino (el arrastre de la media lo tienen los dos).
- **Sin el mejor activo:** el de más P&L cerrado en el run base, y otro run sin él.
- **Qué queda «sin medir».** Solo lo que no se puede construir: una variante cuyo parámetro rechaza la regla, o un
  control sin operaciones que imitar. Cualquier otro error lanza y el experimento queda `fallido`, contando en `N`.
- **Peor caso dentro de la vela.** `backtest/intrabar.ts` declara su política (`INTRABAR_POLICY`); una prueba la compara
  con la que exige el evaluador, y la de `sellTrigger` comprueba el comportamiento.
- **Salida.** Lleva el informe de criterios entero, con la huella, y la serie fuera de muestra de la configuración. Las
  métricas del cierre llevan el estado de cada criterio, el DSR global y el número de variantes.

### 10. El comando comprueba la huella y guarda la salida

- Antes de registrar nada, `npm run backtest` comprueba que los documentos congelados en disco tienen la huella que
  implementa el evaluador. Si no, se niega: es la parada obligatoria del ADR 0030.
- La especificación tiene que declarar `variantes`. Las especificaciones de EXP-0021 y EXP-0022 no lo llevan: describen
  lo que se ejecutó entonces y no se tocan; el paso 28 escribe las suyas.
- Al cerrar, el comando guarda `{ metricas, salida }` en `docs/research/experiments/salidas/EXP-NNNN.json`, solo si
  coincide con el `hash_salida` del registro y sin reescribir nunca. `readOutput` la lee comprobando el hash. De ahí sale
  la matriz del PBO de la ronda en el paso 31.

### 11. Control aleatorio con el backtester real (`strategy/scheduled.ts`)

Cuando el simulador no es válido, cada colocación al azar se ejecuta con el backtester completo mediante una estrategia
programada: entra y sale en las marcas de la colocación y pasa por Risk, Execution, costes y fills como cualquier otra.
Con la colocación de las propias operaciones de una estrategia, abre y cierra en los mismos instantes (lo comprueba una
prueba). El tamaño lo decide Risk con un stop lejano (25 %): sale una fracción menor que la de la estrategia, porque
`src/risk/limits.ts` no admite subir el riesgo por operación, pero el Sharpe apenas depende del tamaño, ya que
rentabilidad y costes escalan con él. Es un control: no cuenta en `N`. Cuesta un backtest por simulación (1000 por
control, más 100 para la señal desplazada). El ejecutor admite bajar esos números solo en pruebas; con menos de 1000
simulaciones el evaluador da `NO CONCLUYENTE`.

### 12. Años por el punto medio también en el desglose del paso 26

`breakdown.byYear` fechaba cada periodo por su final, el instante de recepción de la vela, así que la vela del 31 de
diciembre contaba en el año siguiente. Ahora usa el punto medio (`periodInstant`, en `breakdown.ts`), como los criterios.

## Alternativas

- **Registrar cada variante como un experimento propio.** Más líneas en el registro, y el informe de un experimento
  dependería de otros; el campo `variantes` cuenta lo mismo en `N` sin partir el experimento.
- **No contar las variantes en N.** Contradice la regla 4 del documento congelado.
- **Control aleatorio siempre con 1000 backtests completos.** Sería el más fiel, pero multiplica por mil el tiempo de
  cada experimento. Se usa solo cuando la réplica muestra que el simulador se aleja más de un 10 % (decisión 11).
- **Igualar el tamaño en el control con el backtester.** Exigiría stops cercanos, que acortarían las operaciones, o subir
  el riesgo por operación, que `src/risk/limits.ts` no admite. Se conserva la duración y se acepta otro tamaño.
- **Paseo aleatorio generado (normal o uniforme).** Tendría otra distribución que los datos; barajar conserva la
  distribución real y quita solo la estructura temporal.
- **Ablación del stop.** Risk lo usa para dimensionar: quitarlo mediría otra cosa (el tamaño), no lo que aporta.
- **Muestra insuficiente siempre como `NO CONCLUYENTE`.** Ver la decisión 7.

## Consecuencias

- Los experimentos del paso 28 terminan con cada criterio en `PASS`, `FAIL` o `NO CONCLUYENTE`, el valor y el umbral.
  Todos los criterios de A.3 tienen código. Sin barrido, A.3.6 queda en `NO CONCLUYENTE`: por eso el paso 28 pre-registra
  un barrido pequeño por familia (compromiso). Un solo `FAIL` da `RECHAZADA`.
- Cada experimento tarda bastante más: el run base, entre 22 y 31 variantes, el paseo aleatorio, 1000 simulaciones y
  100 desplazamientos, además del bootstrap; y hasta 2200 backtests más si el simulador no es válido en el control real y
  en el del paseo aleatorio.
- **Compromisos nuevos:** un barrido pequeño por familia en el paso 28; la matriz del PBO de la ronda con las salidas
  guardadas, antes del paso 31; los criterios de las etapas 2 y 3 (A.5 y A.6) y el código del PRE-LIVE GATE, en los pasos
  42 a 45.
- El evaluador no se ha ejecutado sobre datos reales: solo sobre datos sintéticos de resultado conocido, como pide el
  paso.

## Anexo — Texto para `quant-research` (lo pega la persona)

Líneas según `.claude/skills/quant-research/SKILL.md` tal como está en el commit de este paso.

**§10, línea 242.** Sustituir la fila:

```markdown
| `n_pruebas` | Configuraciones que evalúa: 1 con valores, el producto de la rejilla con un barrido |
```

por estas dos filas:

```markdown
| `n_pruebas` | Pruebas que cuenta: las configuraciones (1 con valores, el producto de la rejilla con un barrido) más `variantes` |
| `variantes` | Ejecuciones de robustez sobre datos reales: costes ×2 y ×3, retraso de una vela, cada parámetro a ±25 % y ±50 %, sin el mejor activo, cada componente quitado (ablación) y el universo alternativo. Cuentan en N (ADR 0031). Los controles (aleatorio, señal desplazada y paseo aleatorio) no cuentan |
```

**§10, línea 250.** Sustituir la fila:

```markdown
| `universo` | Regla y símbolos. Sin símbolos solo en una prueba previa que no los detalla |
```

por:

```markdown
| `universo` | Regla y símbolos. Sin símbolos solo en una prueba previa que no los detalla. `alternativos`: activos que no se usaron para diseñarla, fijados antes de mirar datos y distintos de los símbolos (universo alternativo, §7) |
```

**§11, líneas 278 y 279.** Sustituir las dos filas:

```markdown
| `RECHAZADA` | Falla un criterio de §9, o falla el test final |
| `NO CONCLUYENTE` | No llega a la muestra mínima, o falta algún control o prueba de robustez |
```

por:

```markdown
| `RECHAZADA` | Un criterio que se mide no llega a su umbral (también la muestra: menos de 100 operaciones cerradas o el MinTRL sin cumplir), o falla el test final. Basta uno (`docs/PROMOTION_CRITERIA.md`, regla 2) |
| `NO CONCLUYENTE` | Ningún criterio falla, pero alguno no se puede medir: falta un control o una prueba de robustez, el simulador del control aleatorio no es válido y no se repitió con el backtester, o no hay un bajista completo (2018 o 2022) fuera de muestra |
```
