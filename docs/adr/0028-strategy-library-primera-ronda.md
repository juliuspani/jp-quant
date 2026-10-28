# ADR 0028 — Strategy Library, primera ronda: tendencia y reversión a la media

Fecha: 2026-10-14 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 25

## Contexto

El prompt del paso 25 pide una Strategy Library modular. En la primera ronda entran, sin optimizar, solo dos familias con
hipótesis opuestas:

- **Trend Following / Time-Series Momentum:** los activos con tendencia tienden a continuarla.
- **Mean Reversion:** los movimientos extremos a corto plazo tienden a revertir.

Breakout / Volatility Expansion, Cross-Sectional Momentum y Price + Volume Momentum quedan para una segunda ronda, solo
si el paso 31 la activa. Cada estrategia documenta hipótesis económica (por qué existiría la ventaja y quién la paga),
entradas, salidas, features, parámetros y grados de libertad, supuestos, riesgos y tests. Los parámetros iniciales son
defaults de investigación de la literatura. Ninguna se etiqueta como rentable. Todas nacen en estado RESEARCH,
registrado en el Experiment Registry; el Strategy Registry completo llega en el paso 34.

Compromisos de `PROGRESS.md` para este paso:
- (17) los parámetros por defecto salen de la literatura, nunca del barrido de `docs/research/02` (ADR 0019);
- (22) los periodos de las features tampoco tienen valor por defecto (ADR 0025);
- (21 y 23) primer experimento con datos reales por `npm run backtest`, dando de alta la estrategia en
  `RESEARCH_RUNNERS` con su `StrategyEntry`;
- (23) antes de un experimento con pares que se dan de baja, liquidarlos al deslistar con un slippage alto fijado de
  antemano.

El registro ya tenía pruebas previas de las dos familias: `tendencia-donchian-atr` (48 pruebas) y `reversion-rsi2`
(7), de `docs/research/02`, dadas de alta en el paso 21 como invalidadas para que cuenten en N.

## Decisión

### 1. Una regla de la literatura por familia, anterior a los datos de cripto

| Familia | Estrategia | Regla | Fuente |
|---|---|---|---|
| Tendencia | `tendencia-donchian` 1.0.0 | Entra al superar el máximo de 55 días y sale bajo el mínimo de 20, con stop a 2 ATR de 20 | Sistema 2 de los Turtle (Faith, 2007) |
| Reversión | `reversion-rsi2` 1.0.0 | Sobre la SMA 200, entra con el RSI(2) bajo 10 y sale sobre la SMA 5 | Connors y Alvarez (2008) |

Las dos reglas y sus parámetros se publicaron antes de que existieran datos de cripto suficientes para ajustarlas
(1983 y 2007; 2008). Así se limita la contaminación de `quant-research` §12: quien las elige (Claude) conoce el periodo
evaluado, pero no puede haber ajustado a él una regla publicada antes.

Las fichas, con las ocho secciones pedidas, están en `docs/research/biblioteca/`. Una prueba exige esas secciones y
el estado RESEARCH, y prohíbe calificarlas de rentables, validadas o ganadoras.

### 2. Cada estrategia va a la familia ya existente de su hipótesis

`tendencia-donchian` cuenta en `tendencia-donchian-atr` y `reversion-rsi2` en `reversion-rsi2`, y ninguna abre familia
nueva. Una familia es la decisión por la que compiten las pruebas (quant-research §2). Abrir una familia nueva con
N = 1 para una variante de la misma hipótesis bajaría el umbral del Deflated Sharpe sin motivo. La N parte de 49 y de
8: es la opción más exigente.

### 3. Primera ronda sin optimizar: solo los valores de la literatura

`src/strategy/library.ts` guarda los valores de la literatura de cada estrategia. Los constructores siguen sin valores
por defecto (ADR 0027): los fija quien las usa. El ejecutor de investigación (`libraryRunner`) solo acepta exactamente
esos valores (`literatureParams`), y cualquier otro valor, clave de más o clave de menos lanza. Un barrido ya lo
rechazaba el comando (paso 23). Cambiar un parámetro es una hipótesis nueva de la misma familia, y su prueba suma a N.

Los parámetros ambiguos en la fuente se resolvieron con reglas fijadas antes de mirar datos, documentadas en las fichas:
- el umbral del RSI(2) es 10 y no 5, porque da más operaciones;
- el stop de la reversión, que la regla original no tiene, es la convención 2 N de los Turtle. Lo exige Risk para
  dimensionar.

Se quitó el filtro de régimen de BTC de las pruebas previas de tendencia, porque no es de la regla original.

### 4. Estado RESEARCH sin otro posible

`LibraryEntry.estado` es el literal `'RESEARCH'`: el tipo no admite otro estado. Los estados y las aprobaciones por modo
son del Strategy Registry completo (paso 34). Nacer en RESEARCH significa estar en la biblioteca con su ejecutor
(`libraryRunners`, que alimenta `RESEARCH_RUNNERS`) y tener su experimento en el Experiment Registry. Sin entrada en
la biblioteca no hay ejecutor, y sin ejecutor `npm run backtest` se niega antes de registrar nada.

### 5. Primer experimento de cada estrategia con datos reales

Hay un experimento por estrategia por `npm run backtest`, con la especificación versionada en
`docs/research/experiments/specs/`:

- Velas diarias de Kraken en EUR, BTC/EUR y ETH/EUR.
- Walk-forward de 3 años de train, 1 de validación y avance de 1, con validaciones de 2017 a 2026-09-30.
- Train no ajusta nada, porque los parámetros son fijos: se declara, y el purging y el embargo son 0.
- Costes del modelo de Bitvavo: comisión del 0,25 %, medio spread del 0,075 % y slippage del 0,05 % por lado, ×1.

Ninguno de los dos pares se da de baja en el periodo. Por eso el compromiso de liquidar al deslistar no se activa, y
sigue pendiente para el primer experimento con universo dinámico.

El veredicto queda en `null` en el registro, porque el protocolo de §9 aún no lo calcula. Faltan el DSR, el PBO, el
bootstrap, las 1000 simulaciones aleatorias y el estrés de costes, así que el informe de cada experimento da
`NO CONCLUYENTE` (quant-research §11). Las cifras no se usan para cambiar nada de la primera ronda.

## Alternativas

- **Momentum de serie temporal por el signo de la rentabilidad a 12 meses (Moskowitz, Ooi y Pedersen, 2012).** Es la
  definición académica, pero su horizonte de un año da muy pocas operaciones en cripto. Además, la familia ya examinada
  de este proyecto es Donchian: una regla nueva habría pedido abrir familia o mezclar dos reglas en una.
- **Abrir familias nuevas** (`tendencia-turtle`, `reversion-connors`): descartado por la decisión 2.
- **Elegir 5 y 10 para el RSI(2) y quedarse con el mejor:** sería optimizar, que la primera ronda prohíbe.
- **Sin stop en la reversión, como la fuente:** Risk no dimensiona sin stop (`trading-risk`), y quitar ese control no
  es una opción.
- **Universo con SOL:** más operaciones, pero con más sesgo de supervivencia y sin el bajista de 2018.
- **Solo registrar, sin ejecutar:** el registro no tiene una línea de alta sin experimento. Añadirla cambiaría el formato
  del ADR 0024 sin necesidad, y el compromiso del paso pide el primer experimento con datos reales.

## Consecuencias

- La N de las dos familias sube en 1 cada una (49 y 8). Cualquier prueba futura de la misma hipótesis la sube más.
- Con 55/20 días y dos pares, la tendencia probablemente no llegue a las 100 operaciones de §9. Sería `NO
  CONCLUYENTE` aunque existieran todos los controles.
- `literatureParams` impide repetir el experimento con otros parámetros sin cambiar el código. Ampliarlo (barridos con
  elección en train) es de los pasos 26 y 27.
- Un parámetro registrado que no sea el de la literatura se detecta en el ejecutor, después del pre-registro: la prueba
  queda como fallida y cuenta en N. Es fail closed, pero cuesta una prueba. La especificación versionada y su prueba lo
  evitan en la práctica.
- Catálogo de features ampliado (ADR 0025) con `sma`, `donchianHigh` y `donchianLow`, todas en la prueba anti
  look-ahead.
