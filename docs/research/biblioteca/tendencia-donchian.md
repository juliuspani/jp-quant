# tendencia-donchian 1.0.0: Trend Following / Time-Series Momentum

| Campo | Valor |
|---|---|
| Estado | **RESEARCH**. No tiene otro hasta el Strategy Registry completo (paso 34) |
| Familia del registro | `tendencia-donchian-atr`, la misma de las pruebas previas de `docs/research/02`: compiten por la misma decisión y cuentan en la N del Deflated Sharpe |
| Código | `src/strategy/trend-following.ts`; catálogo en `src/strategy/library.ts` |
| Decisión | [ADR 0028](../../adr/0028-strategy-library-primera-ronda.md) |
| Fuente de la regla y de los parámetros | Faith, *Way of the Turtle* (2007): sistema 2 de los Turtle |

Ninguna afirmación de este documento dice que la estrategia gane dinero. Los únicos veredictos posibles son los de
`quant-research` §11, y los da el protocolo, no esta ficha.

## 1. Hipótesis económica

**Los activos con tendencia tienden a continuarla.** Una ruptura del máximo de las últimas semanas anticipa, en promedio,
más subida en las semanas siguientes.

**Por qué existiría la ventaja.** La literatura de *time-series momentum* (Moskowitz, Ooi y Pedersen, 2012; Hurst, Ooi y
Pedersen, 2017, con un siglo de datos) la explica con dos mecanismos de comportamiento:
- **Infrarreacción inicial:** la información se difunde despacio y los precios se ajustan por etapas (anclaje,
  conservadurismo, efecto disposición: se vende pronto lo que gana).
- **Sobrerreacción posterior:** los flujos persiguen el precio (FOMO, reflexividad). En cripto se suman las cascadas de
  liquidaciones de los derivados apalancados, que arrastran al spot en la dirección del movimiento.

Liu y Tsyvinski (2021) documentan momentum de serie temporal en cripto a horizontes de una a varias semanas.

**Quién la paga.** Quien opera contra la tendencia o sale demasiado pronto: vendedores que recogen beneficios al primer
avance, quien toma el contrario en las rupturas y quien cierra posiciones cortas forzado. A cambio, la estrategia acepta
muchas pérdidas pequeñas en mercados laterales (*whipsaw*): una parte de la ventaja sería la compensación por ese
perfil, parecido al de una opción comprada.

**Hipótesis opuesta en la biblioteca:** [reversion-rsi2](reversion-rsi2.md). No son excluyentes: la literatura encuentra
reversión a pocos días y continuación a semanas o meses.

## 2. Entradas

Sobre la vela diaria cerrada, sin posición en el par:
- el cierre supera **estrictamente** el máximo de las 55 velas anteriores (sin la última);
- el ATR de 20 velas existe y deja un stop positivo.

Se decide al cierre y se ejecuta en la apertura siguiente (backtester, ADR 0026). Solo largo, sin piramidar: una
posición por par. El tamaño lo decide Risk, no la estrategia.

## 3. Salidas

- **Canal de salida:** el cierre cae **estrictamente** por debajo del mínimo de las 20 velas anteriores. Funciona como
  stop que sube con la tendencia.
- **Stop de protección:** fijo, a 2 ATR de 20 velas por debajo del cierre de la señal. No se mueve. El backtester lo
  ejecuta dentro de la vela (ADR 0026).
- Sin features con posición abierta (un hueco de datos): mantiene; el stop sigue protegiendo.

## 4. Features

| Feature | Definición (`src/features/definitions.ts`) | Calentamiento |
|---|---|---|
| `close` | Cierre de la última vela | 1 |
| `donchmax_55` | max(H[t−55]…H[t−1]), sin la vela t | 56 |
| `donchmin_20` | min(L[t−20]…L[t−1]), sin la vela t | 21 |
| `atr_20` | ATR de Wilder sobre 5·20 + 1 velas | 101 |

Calentamiento declarado de la estrategia: 101 velas. Todas sobre velas cerradas y cubiertas por la prueba anti look-ahead.

## 5. Parámetros y grados de libertad

| Parámetro | Valor | Origen |
|---|---|---|
| `entryPeriod` | 55 | Sistema 2 de los Turtle |
| `exitPeriod` | 20 | Ídem |
| `atrPeriod` | 20 | Ídem (N = ATR de 20 días) |
| `stopAtr` | 2 | Ídem (stop a 2 N) |

Son defaults de investigación de la literatura, **no ajustados a nuestros datos** ni al barrido de `docs/research/02`
(ADR 0019). La primera ronda solo acepta estos valores (`literatureParams`).

**Rejilla del paso 28** ([ADR 0032](../../adr/0032-barridos-con-eleccion-en-train.md)): las entradas y salidas de los
sistemas 1 (20/10) y 2 (55/20) de los Turtle, que incluyen la regla de 4 semanas de Donchian (20/20), con N = ATR de 20 y
stop a 2 N fijos. Son 4 configuraciones (`entryPeriod` ∈ {20, 55} × `exitPeriod` ∈ {10, 20}); el walk-forward elige una
en el train de cada tramo. Es el presupuesto de la familia, declarado antes de mirar datos: el ejecutor no acepta otra
rejilla, y cada punto cuenta en N.

**Grados de libertad** (quant-research §9): 4 numéricos y 4 elecciones discretas, que son el marco diario, el universo,
solo largo y sin piramidar. Total: 8. El riesgo por operación y los topes de exposición son de Risk, no de la estrategia.

Se quitó a propósito el filtro de régimen (BTC sobre su SMA 200) de las pruebas previas, porque no es de la regla
original y sumaría grados de libertad sin justificar.

## 6. Supuestos

- Velas diarias de Kraken en EUR con el modelo de ejecución de Bitvavo (ADR 0026): comisión taker del 0,25 %, medio
  spread y slippage mínimo de `quant-research` §5.
- Universo fijo de los experimentos: BTC/EUR y ETH/EUR. Son los dos pares con más historia y los únicos que cubren los
  bajistas de 2018 y 2022. Elegirlos hoy tiene sesgo de supervivencia, y el ejecutor lo declara.
- Risk dimensiona: un 0,75 % de riesgo por operación y como mucho un 25 % del patrimonio por par.
- Las rupturas se miden con el cierre, no dentro de la vela como hacían los Turtle: es más lento, pero no necesita
  órdenes stop de entrada (paso 36).

## 7. Riesgos

- **Muestra pequeña:** con 55/20 días salen pocas operaciones por año y par. Es probable no llegar a las 100 operaciones
  de `quant-research` §9, y entonces el veredicto es `NO CONCLUYENTE`.
- **Familia ya examinada:** las pruebas previas de `docs/research/02` cuentan en N. La idea de la familia se conocía
  antes de examinar estos datos, pero quien la eligió (Claude) conoce el periodo evaluado (quant-research §12). La regla
  y sus parámetros son de 1983 y 2007, anteriores a cualquier dato de cripto, lo que limita esa contaminación.
- **Whipsaw** en mercados laterales: muchas pérdidas pequeñas seguidas.
- **Gaps:** un stop puede ejecutarse muy por debajo de su precio, y el backtester lo cobra así.
- **Cambio de régimen:** la tendencia en cripto puede debilitarse a medida que el mercado madura.

## 8. Tests

- `test/src/strategy/library.test.ts`: decisiones con valores calculados a mano (entrada estricta, stop a 2 ATR,
  salida por el canal), parámetros inválidos, solo valores de la literatura y esta ficha.
- `test/src/features/definitions.test.ts` y `look-ahead.test.ts`: las features de Donchian excluyen la última vela y no
  miran el futuro.
- `test/src/app/library.test.ts`: camino completo Data → Features → Strategy → Risk → Execution → Portfolio sobre el
  backtester, con su ejecutor de investigación.
