# ADR 0025 — Feature Engine: ventanas fijas, received_time y huecos que vacían la ventana

Fecha: 2026-10-13 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 22

## Contexto

El prompt del paso 22 pide un Feature Engine independiente que empiece por: rentabilidades, momentum, volatilidad
realizada, RSI, EMA, volumen, RVOL y ATR si está justificado. Cada feature tiene que definir su fórmula, su ventana,
su calentamiento, su timestamp (solo usa datos con `received_time` anterior al cálculo) y su política de datos que
faltan, con pruebas de valores conocidos calculados a mano o con una referencia externa. Además pide una prueba
genérica anti look-ahead (alterar datos futuros no cambia ninguna feature pasada) y que las features no puedan
emitir órdenes.

`ARCHITECTURE.md` ya fijaba el marco: `src/features/` calcula en float sobre velas cerradas, con el mismo cálculo en
todos los modos, sin E/S y sin importar `execution/` ni `risk/` (§4.1, §15.1 y §16.4). quant-research §3 exige
calentar los indicadores recursivos con 3 a 5 veces su periodo y no rellenar nunca los huecos.

## Decisión

### 1. Ventana fija por feature

Cada feature recibe exactamente sus últimas `warmupBars` velas contiguas y calcula solo con ellas. Las recursivas
(EMA, RSI y ATR) se siembran con la media simple de los `n` primeros valores **de esa ventana**, no del inicio de la
serie. Así el valor es una función de las últimas `warmupBars` velas y no depende de dónde empezó el backtest ni de
cuándo arrancó el proceso en real: es el mismo cálculo en todos los modos. Una prueba lo comprueba arrancando el
motor en otro punto de la serie.

### 2. Calentamiento de 5 veces el periodo en las recursivas

`RECURSIVE_WARMUP_FACTOR = 5`, el extremo más exigente de quant-research §3. Con el suavizado de Wilder (α = 1/n),
lo que pesa la semilla tras 4·n pasos es e⁻⁴ ≈ 1,8 %; con la EMA (α = 2/(n+1)), del orden de e⁻⁸. Las no recursivas se
calientan con su propia ventana.

### 3. Catálogo

`C`, `H`, `L` y `V` son cierre, máximo, mínimo y volumen; `t` es la última vela cerrada y recibida.

| Feature | Fórmula | Ventana | Calentamiento | Da null además de sin calentamiento |
|---|---|---|---|---|
| `logret_k` | ln(C[t] / C[t−k]) | k + 1 | k + 1 | — |
| `mom_n` | C[t] / C[t−n] − 1 | n + 1 | n + 1 | — |
| `realvol_n` | Desviación típica muestral (n − 1) de las n últimas rentabilidades logarítmicas, por vela y sin anualizar | n + 1 | n + 1 | — |
| `rsi_n` | 100·G/(G + L), con G y L medias de Wilder de subidas y bajadas | n + 1 | 5n + 1 | G + L = 0: sin movimiento el RSI es indefinido |
| `ema_n` | E = α·C + (1 − α)·E, α = 2/(n + 1) | n | 5n | — |
| `volume` | V[t], en unidades del activo base | 1 | 1 | — |
| `relvol_n` | V[t] / media(V[t−n]…V[t−1]); la vela actual no entra en la media | n + 1 | n + 1 | La media es 0 |
| `atr_n` | Media de Wilder de TR = max(H − L, \|H − C previo\|, \|L − C previo\|) | n + 1 | 5n + 1 | — |

- **RSI sin movimiento es `null`**, no 0 ni 50. Un 0 parecería sobreventa extrema y dispararía compras en datos
  planos o ilíquidos; con `null`, la regla que lo necesita no opera.
- **ATR justificado:** la única estrategia del repositorio (`src/strategy/trend.ts`) lo usa para sus stops, y
  `ARCHITECTURE.md` §18 lo pasa a `features/`.
- **Ningún periodo tiene valor por defecto.** Los elige el pre-registro de cada experimento, y los del paso 25
  salen de la literatura (ADR 0019).
- La volatilidad realizada se da por vela; quien la anualice usa 365 días (quant-research §3).

### 4. Timestamp: `received_time` ≤ instante del cálculo

El motor procesa cada vela en su `received_time`, que es el instante del cálculo (`computedAt`). Solo usa velas con
`received_time ≤ computedAt`: la que dispara el cálculo y las anteriores. Es la regla de visibilidad de
`ARCHITECTURE.md` §5.1 y de `historical/point-in-time.ts`. «Anterior al cálculo» se lee así: el cálculo ocurre al
recibir la vela, no antes. `asOf` es el cierre de la última vela usada. El motor rechaza una vela recibida antes de
cerrar y cualquier `received_time` que retroceda, también entre símbolos.

### 5. Datos que faltan: un hueco vacía la ventana

> Sustituido por el ADR 0036 (2026-10-20): la vela que falta se excluye sin vaciar la ventana, con un tope de velas de
> menos que sale de cada fórmula.

- Si una vela no es la siguiente de su símbolo (falta alguna), la ventana de ese símbolo vuelve a empezar y sus
  features dan `null` hasta tener otra vez `warmupBars` velas contiguas. Nunca se rellena ni se calcula a través de
  un hueco (quant-research §3; `ARCHITECTURE.md` §4.3).
- Un resultado no finito da `null`.
- Un volumen 0 es un dato válido: no es un hueco.

### 6. Fail closed ante una entrada que incumple el contrato

Una vela desordenada, repetida, de otro timeframe, con el cierre incoherente con la apertura, recibida antes de
cerrar, o con valores imposibles (precio no positivo, volumen negativo, máximo o mínimo incoherentes) lanza
`FeatureInputError`. El motor no la descarta en silencio: filtrar es del normalizador.

### 7. Sin normalizador en este paso

La persona permitió un normalizador mínimo en `marketdata/` si hacía falta. No hace falta: el motor valida su propia
entrada (decisión 6) y las velas de `historical/` ya pasan por `historical/quality.ts`. El normalizador
(`ARCHITECTURE.md` §4.3: descartar la vela en curso, repetidas y desordenadas, y publicar `MarketDataGap`) llega
cuando algo publica velas por el bus: es compromiso del paso 23, que compone el replay.

### 8. Las features no emiten órdenes

- `FeatureEngine.onCandleClosed` devuelve un `FeatureVector` congelado cuyos valores son números o `null`. No publica
  eventos ni tiene acceso al bus.
- Nueva regla de límites `features-sin-contratos-de-ordenes`: `src/features/` no puede importar
  `src/kernel/orders.ts`, `execution.ts` ni `stores.ts`, aunque la matriz le permita importar `kernel/`. Se suma a
  `features-no-execution-ni-risk` y a la matriz. Endurece los límites; no relaja ninguno.

### 9. Ajustes sobre el extracto de `ARCHITECTURE.md` §16.4

- `FeatureDefinition` pierde `timeframe` y gana `formula`, `window` y `missingData`. El timeframe pasa a
  `FeatureSet`, que agrupa las definiciones: la misma definición sirve para cualquier timeframe.
- `FeatureVector` gana `computedAt`.
- `src/indicators.ts` no se mueve a `features/` «sin cambios de cálculo» (§18): sus EMA y ATR se siembran al inicio
  de la serie y dependen de dónde empieza. Se queda en la raíz hasta que `strategy/trend.ts` lea el `FeatureVector`.

## Alternativas

- **Cálculo incremental desde el inicio de la serie** (como `src/indicators.ts`). Más barato, pero el valor depende
  del punto de arranque: el mismo instante daría números distintos en un backtest que empieza en 2020, en otro que
  empieza en 2022 y en real. Descartada por la regla de mismo cálculo en todos los modos.
- **Calentamiento de 3 veces el periodo.** Más barato, pero la semilla de Wilder pesaría e⁻² ≈ 13,5 %. Descartada:
  se toma el extremo más exigente.
- **Rellenar o saltar los huecos.** Calcular a través de un hueco mezcla velas no contiguas. Descartada por
  quant-research §3.
- **Descartar en silencio las velas inválidas.** Ocultaría un fallo aguas arriba. Descartada por fail closed.
- **RSI = 50 o 0 sin movimiento** (convenciones de otras bibliotecas). Descartada (decisión 3).
- **Normalizador ya en este paso.** Más código sin consumidor: no hay bus que publique velas. Descartada (decisión 7).

## Consecuencias

- El coste por vela es proporcional a la suma de los calentamientos del conjunto: unos 0,2 ms por vela con 29
  features y ventanas de hasta 71 velas (medido en la máquina de desarrollo). Basta para velas de 4 h; si el paso 23 lo necesita, se optimiza sin cambiar los valores.
- Una feature nueva se añade al catálogo con su ficha y sus pruebas de valores conocidos. La prueba anti look-ahead
  la recorre sola; otra prueba falla si una función exportada no está en el catálogo.
- Cambiar la fórmula, la ventana o el calentamiento de una feature sube su `version`.
- Las features solo se han ejercitado con datos sintéticos; el primer uso con datos reales es del paso 23.

## Nota del paso 23 (2026-10-13)

El normalizador de velas ya existe en `marketdata/` (ADR 0026): el replay alimenta `features/` solo con velas cerradas,
en orden y sin repetir. El coste medido en el backtest completo es de unos 0,38 ms por vela con 29 features, de los que
unos 0,30 ms son las features; no hizo falta optimizar. El primer uso con datos reales sigue pendiente: pasa al paso 25
con el primer experimento.
