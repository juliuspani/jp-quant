# reversion-rsi2 1.0.0: Mean Reversion

| Campo | Valor |
|---|---|
| Estado | **RESEARCH**. No tiene otro hasta el Strategy Registry completo (paso 34) |
| Familia del registro | `reversion-rsi2`, la misma de las pruebas previas de `docs/research/02`: compiten por la misma decisión y cuentan en la N del Deflated Sharpe |
| Código | `src/strategy/mean-reversion.ts`; catálogo en `src/strategy/library.ts` |
| Decisión | [ADR 0028](../../adr/0028-strategy-library-primera-ronda.md) |
| Fuente de la regla y de los parámetros | Connors y Alvarez, *Short Term Trading Strategies That Work* (2008): RSI de 2 periodos |

Ninguna afirmación de este documento dice que la estrategia gane dinero. Los únicos veredictos posibles son los de
`quant-research` §11, y los da el protocolo, no esta ficha.

## 1. Hipótesis económica

**Los movimientos extremos a corto plazo tienden a revertir.** Tras una caída brusca de uno o dos días dentro de una
tendencia alcista, el precio tiende a volver a su media de pocos días.

**Por qué existiría la ventaja.** La reversión a corto plazo (Jegadeesh, 1990; Lehmann, 1990) se explica como **pago
por proveer liquidez** (Nagel, 2012). Quien necesita vender ya acepta una rebaja de precio, y quien compra en ese momento
asume el riesgo de inventario y cobra la rebaja cuando la presión desaparece. El filtro de la media de 200 días evita
comprar caídas dentro de una tendencia bajista, en la que la caída puede ser información y no presión de flujo.

**Quién la paga.** Quien vende con urgencia: liquidaciones de posiciones apalancadas, stops que saltan en cadena,
ventas de pánico y rebalanceos forzados. En cripto, las cascadas de liquidación de los derivados son frecuentes y
arrastran al spot.

**Hipótesis opuesta en la biblioteca:** [tendencia-donchian](tendencia-donchian.md). No son excluyentes: la literatura
encuentra reversión a pocos días y continuación a semanas o meses.

## 2. Entradas

Sobre la vela diaria cerrada, sin posición en el par:
- el cierre está **estrictamente** sobre su media simple de 200 velas;
- el RSI de 2 periodos está **estrictamente** por debajo de 10;
- el ATR de 20 velas existe y deja un stop positivo.

Se decide al cierre y se ejecuta en la apertura siguiente. Connors compra al mismo cierre, pero el backtester no lo
permite (ADR 0026): la entrada es más tarde que en la fuente. Solo largo, una posición por par. El tamaño lo decide Risk.

## 3. Salidas

- **Salida de la regla:** el cierre supera **estrictamente** su media simple de 5 velas. Con posición abierta no se
  mira la media de 200: la regla original tampoco.
- **Stop de protección:** fijo, a 2 ATR de 20 velas por debajo del cierre de la señal. **No es de la regla original**,
  que no tiene stop; lo exige Risk para dimensionar (`trading-risk`). Se toma la convención de 2 N de los Turtle para no
  inventar un número ni ajustarlo. Connors y Alvarez informan de que los stops empeoran esta regla: este stop es un
  coste asumido por seguridad.
- Sin features con posición abierta (un hueco de datos): mantiene; el stop sigue protegiendo.

## 4. Features

| Feature | Definición (`src/features/definitions.ts`) | Calentamiento |
|---|---|---|
| `close` | Cierre de la última vela | 1 |
| `sma_200` | Media simple de los 200 últimos cierres, incluido el último | 200 |
| `rsi_2` | RSI de Wilder sobre 5·2 cambios | 11 |
| `sma_5` | Media simple de los 5 últimos cierres | 5 |
| `atr_20` | ATR de Wilder sobre 5·20 + 1 velas | 101 |

Calentamiento declarado de la estrategia: 200 velas. Todas sobre velas cerradas y cubiertas por la prueba anti
look-ahead. El RSI con ventana fija no coincide exactamente con el de bibliotecas que lo siembran al inicio de la serie
(ADR 0025); con 2 periodos la diferencia es despreciable.

## 5. Parámetros y grados de libertad

| Parámetro | Valor | Origen |
|---|---|---|
| `trendPeriod` | 200 | Connors y Alvarez |
| `rsiPeriod` | 2 | Ídem |
| `rsiEntry` | 10 | Ídem. Las versiones publicadas de la regla usan 5 y 10. Se toma 10 por una regla fijada antes de mirar datos: da más operaciones y acerca la muestra mínima de §9. No se compara con 5 |
| `exitPeriod` | 5 | Ídem |
| `atrPeriod` | 20 | Stop de protección: convención de los Turtle, no de la regla |
| `stopAtr` | 2 | Ídem |

Son defaults de investigación de la literatura, **no ajustados a nuestros datos** ni al barrido de `docs/research/02`
(ADR 0019). La primera ronda solo acepta estos valores (`literatureParams`).

**Rejilla del paso 28** ([ADR 0032](../../adr/0032-barridos-con-eleccion-en-train.md)): los umbrales del RSI(2) de Connors y
Alvarez (2008), `rsiEntry` ∈ {2, 5, 10}, con el resto de parámetros fijos. Son 3 configuraciones; el walk-forward elige una
en el train de cada tramo. Es el presupuesto de la familia, declarado antes de mirar datos, y cada punto cuenta en N.

**Grados de libertad** (quant-research §9): 6 numéricos (4 de la regla y 2 del stop) y 3 elecciones discretas, que son
el marco diario, el universo y solo largo. Total: 9. El riesgo por operación y los topes de exposición son de Risk.

## 6. Supuestos

- Velas diarias de Kraken en EUR con el modelo de ejecución de Bitvavo (ADR 0026): comisión taker del 0,25 %, medio
  spread y slippage mínimo de `quant-research` §5. Con operaciones de pocos días, los costes pesan mucho más que en la
  tendencia.
- Universo fijo de los experimentos: BTC/EUR y ETH/EUR, como en la tendencia y por el mismo motivo, con el sesgo de
  supervivencia declarado por el ejecutor.
- Risk dimensiona: un 0,75 % de riesgo por operación y como mucho un 25 % del patrimonio por par.
- La regla nació en acciones estadounidenses: trasladarla a cripto es una hipótesis, no un hecho.

## 7. Riesgos

- **Costes:** la ventaja por operación esperada es pequeña y la rotación alta. Con un 0,25 % de comisión por lado más
  spread y slippage, los costes pueden comérsela entera.
- **Familia ya examinada:** las pruebas previas de `docs/research/02` cuentan en N. La regla es de 2008, anterior a los
  datos de cripto, pero quien la eligió (Claude) conoce el periodo evaluado (quant-research §12).
- **Cuchillos que caen:** en un desplome (2018, 2022) la sobreventa puede seguir. El filtro de la SMA 200 lo mitiga, pero
  la primera caída de un mercado bajista empieza por encima de esa media.
- **Gaps:** el stop puede ejecutarse muy por debajo de su precio.
- **El stop cambia la regla:** corta pérdidas que la regla original habría recuperado. Lo que se mide es esta versión, no
  la de la fuente.

## 8. Tests

- `test/src/strategy/library.test.ts`: decisiones con valores calculados a mano (umbral estricto, RSI de 0, filtro de
  tendencia, salida sobre la SMA 5), parámetros inválidos, solo valores de la literatura y esta ficha.
- `test/src/features/definitions.test.ts` y `look-ahead.test.ts`: la SMA y el RSI no miran el futuro.
- `test/src/app/library.test.ts`: camino completo Data → Features → Strategy → Risk → Execution → Portfolio sobre el
  backtester, con su ejecutor de investigación.
