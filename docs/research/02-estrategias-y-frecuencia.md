# 02 — Estrategias, frecuencia y gestión de riesgo para un bot cripto spot minorista

Fecha del informe: 2026-09-30
Ámbito: bot 24/7, solo spot (largo o en liquidez), sin apalancamiento ni cortos, capital de cientos de euros/dólares, comisión ~0,1 % por lado, velas OHLCV e indicadores propios (EMA, RSI, ATR, Donchian). Stack: Node 24 + TypeScript + ccxt.

> **Aviso.** Esto es información técnica general con fines educativos y de ingeniería. **No es asesoramiento financiero personalizado** ni una recomendación de inversión. Operar con criptomonedas puede suponer la pérdida total del capital. Ninguna estrategia es "infalible": todo lo que sigue habla de probabilidades, no de certezas.

## Cómo leer este documento

Cada afirmación relevante lleva una etiqueta:

- **[F]** — respaldado por una fuente externa (con URL).
- **[C]** — cálculo propio hecho para este informe con datos públicos de mercado (velas y libro de órdenes de la API pública de Binance, `data-api.binance.vision`). No auditado ni replicado por terceros.
- **[R]** — razonamiento u opinión propia. No tiene más autoridad que la lógica que lo acompaña.

Al final hay una sección **"No verificado"** con todo lo que no pude comprobar directamente.

---

## 0. Resumen ejecutivo

1. **La única familia con evidencia razonable y costes asumibles para este perfil es el seguimiento de tendencia (momentum de series temporales) en marco de horas-días**, con tamaño de posición ajustado a la volatilidad. [F][C]
2. **Scalping (1m–15m) no es viable con 0,1 % por lado.** El coste de ida y vuelta (~0,30 %) es entre 3 y 16 veces el movimiento mediano de una vela de BTC en esos marcos. La misma regla de ruptura, aplicada a 1m, 5m, 15m y 1h, pierde dinero neto; solo empieza a ser positiva en 4h y 1d. [C] Un preprint de 2026 mide la reversión a 15 minutos en 183 pares de Binance y concluye que es real pero demasiado pequeña para capturarla tras costes. [F]
3. **Hay una contradicción entre el objetivo del usuario y la evidencia.** "Beneficios pequeños pero consistentes" describe el perfil de la reversión a la media y del grid (muchas ganancias pequeñas, pocas pérdidas grandes). Lo que tiene evidencia (tendencia) tiene el perfil contrario: ~40 % de aciertos, muchas pérdidas pequeñas, pocas ganancias grandes, y años enteros sin operar. En mi prueba, comprar caídas con RSI daba ~70 % de aciertos y aun así no ganaba nada tras costes. [C]
4. **Recomendación de frecuencia:** decisiones sobre velas cerradas de **4h** (régimen sobre velas de **1d**), bucle de mantenimiento cada **60 s**, del orden de **0,5–1,5 operaciones por semana** en total.
5. **Expectativa honesta:** con riesgo de 0,75 % por operación, un rango plausible es **0–15 % anual con drawdowns de 10–25 %**, con años planos o negativos. Sobre 300 €, eso son decenas de euros al año: **el coste de un VPS puede superar el beneficio esperado**. A esta escala el proyecto es sobre todo de aprendizaje. [R]

---

## 1. Familias de estrategias

### 1.1 Seguimiento de tendencia / momentum de series temporales

**Qué es.** Comprar cuando el precio sube con fuerza (ruptura de máximos, precio sobre medias) y salir cuando la tendencia se rompe.

**Evidencia.**

- Han, Kang y Ryu analizan momentum en cripto "bajo supuestos realistas" (costes, fluctuaciones diarias). Conclusión del resumen: la evidencia de momentum de **series temporales es fuerte**, la de momentum **transversal es débil**, y al contabilizar bien los costes muchas carteras que parecían rentables dejan de serlo. [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565
- Zarattini, Pagani y Barbon (2025) aplican un conjunto de canales de Donchian con varios periodos y tamaño de posición por volatilidad a las 20 monedas más líquidas, con datos "libres de sesgo de supervivencia" desde 2015. Reportan, neto de comisiones, Sharpe > 1,5 y alfa anualizada del 10,8 % frente a Bitcoin. Es **solo largo**, lo que lo hace directamente aplicable a spot. [F] https://ideas.repec.org/p/chf/rpseri/rp2580.html · https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907
- Hudson y Urquhart (Annals of Operations Research, 2021) prueban casi 15 000 reglas técnicas con correcciones por data-snooping y encuentran capacidad predictiva, pero **en Bitcoin la predictibilidad desaparece fuera de muestra**. [F] https://link.springer.com/content/pdf/10.1007/s10479-019-03357-1.pdf
- Summitward (análisis independiente, BTC/ETH/SOL, 2017–2025): la estrategia de tendencia escalada a volatilidad obtuvo Sharpe 0,79 y drawdown −14,6 %, pero **casi toda la reducción de drawdown venía del escalado por volatilidad, no de la señal de tendencia** (de −84 % a −17 % solo con escalado). El intervalo de confianza bootstrap del Sharpe iba de ~0,1 a ~1,5: 8,5 años de datos no bastan para saber si la estrategia es mediocre o excelente. [F] https://summitward.com/learn/crypto-trend-following
- Moreira y Muir (Journal of Finance, 2017): reducir exposición cuando la volatilidad es alta mejora el Sharpe en múltiples factores de renta variable. Respalda el tamaño de posición inverso a la volatilidad. [F] https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12513

**Mi comprobación rápida.** [C] Ruptura Donchian + stop trailing por ATR + filtro BTC > SMA200, solo largo, 0,10 % de comisión + 0,05 % de slippage por lado, velas de Binance desde 2017-08-17 hasta 2026-09-29:

| Configuración | CAGR | Máx. DD | Sharpe | Ops/año | Aciertos | Gan. media / Pérd. media |
|---|---|---|---|---|---|---|
| 4h, BTC+ETH, N=60, riesgo 0,75 % | 7,8 % | −7,2 % | 1,02 | 23 | 37 % | +10,7 % / −3,6 % |
| 4h, BTC+ETH+SOL, N=60, riesgo 0,75 % | 10,5 % | −9,1 % | 1,08 | 32 | 39 % | +12,0 % / −4,2 % |
| Igual, costes ×2 (0,6 % ida y vuelta) | 9,0 % | −9,5 % | 0,94 | 32 | 38 % | — |
| Igual, sin filtro de régimen | 14,7 % | −17,1 % | 1,22 | 50 | 37 % | — |
| 4h, 10 monedas top de mediados de 2018 (incluye EOS, IOTA, NEO, XLM), N=60, riesgo 1 % | 16,8 % | −28,0 % | 0,89 | 56 | 34 % | +13,7 % / −4,6 % |
| 1d, BTC+ETH+SOL, N=20, riesgo 0,75 % | 8,6 % | −9,4 % | 1,12 | 10 | 53 % | +38,9 % / −9,2 % |
| 1h, BTC+ETH, N=60–240, riesgo 1 % | 3,4–5,2 % | −18 a −21 % | 0,33–0,53 | 45–81 | 33–37 % | — |

Rendimiento por año de la configuración 4h BTC+ETH+SOL: 2018: 0 % · 2019: +15 % · 2020: +27 % · 2021: +18 % · 2022: 0 % · 2023: +14 % · 2024: +17 % · 2025: +9 % · 2026 (hasta septiembre): +1 %.

Barrido de 21 combinaciones (N ∈ {20, 30, 45, 60, 90, 120, 180} × trailing ∈ {2, 3, 4} ATR) sobre 6 pares: todas positivas, CAGR 10–37 %, drawdown −14 a −29 %, Sharpe 0,82–1,51. Es una meseta, no un pico aislado, lo que reduce (no elimina) la sospecha de sobreajuste.

**Advertencias sobre estas cifras.** [R] Están dentro de muestra, en una clase de activo que subió de forma secular durante el periodo; SOL y BNB están elegidos sabiendo que sobrevivieron y se multiplicaron; la simulación es por velas (el stop se supone ejecutado a su precio); y elegí los valores por defecto después de ver los resultados. **No son una validación.** Espere bastante menos en real.

**Cuándo funciona.** Tendencias amplias y sostenidas (2019–2021, 2023–2024).
**Cuándo falla.** Mercados laterales y con dientes de sierra: rupturas falsas encadenadas. En mi prueba la racha máxima de pérdidas consecutivas fue de 8 a 15 según la variante. [C] En un activo aislado puede fallar durante años: la misma regla sobre ETH en los últimos 4 años fue negativa incluso antes de costes. [C]
**Riesgo de ruina.** Bajo si el riesgo por operación es ≤ 1 % y hay stop en el exchange. Los riesgos dominantes son operativos (fallo del exchange, error de software, hueco de precio que atraviesa el stop). [R]

### 1.2 Reversión a la media

**Evidencia.** Existe reversión a corto plazo, pero concentrada donde un minorista no puede explotarla:

- En 200 criptomonedas (2015–2019) los perdedores pasados superan a los ganadores, pero el efecto es más fuerte en monedas pequeñas e ilíquidas; las monedas grandes muestran más bien momentum diario. [F] https://www.sciencedirect.com/science/article/pii/S1057521921002349 · https://www.tandfonline.com/doi/abs/10.1080/13504851.2020.1784831
- Kitron y Wengrowicz (preprint, 2026), 183 pares spot USDT de Binance a 15 minutos, enero 2025–febrero 2026, con walk-forward fuera de muestra: el 90 % de los pares muestra reversión direccional significativa, pero la ventaja bruta alcanza como máximo ~1,3 pb por operación frente a un coste de 5 pb de ida y vuelta. En sus palabras: "big enough to measure, too small to capture at benchmark spot costs". A 5 minutos es aún peor. [F] https://arxiv.org/abs/2608.21888

**Mi comprobación.** [C] Comprar caídas (RSI(2) < 5/10/20) solo en tendencia alcista (precio y BTC sobre SMA200), salida al cruzar la SMA(5) o a las 10 velas, stop a 3 ATR:

- Velas de 1d: 67–71 % de aciertos, pero la pérdida media dobla a la ganancia media. CAGR 0,3–1,2 %. Prácticamente cero.
- Velas de 4h: **negativo en todas las variantes** (factor de beneficio 0,59–0,69). Incluso sin costes queda plano (factor 0,97).

**Cuándo funciona.** Rangos laterales en activos líquidos, y solo si el coste es casi nulo.
**Cuándo falla.** Tendencias bajistas ("cuchillo que cae") y siempre que el coste supere la pequeña ventaja.
**Riesgo de ruina.** Asimetría negativa: muchas ganancias pequeñas ocultan pérdidas grandes y raras. Sin stop, el riesgo de quedarse atrapado en una caída del 50–80 % es alto. [R]

### 1.3 Grid trading

**Evidencia.**

- Chen et al. (arXiv, 2025) demuestran que, bajo supuestos simples, **el valor esperado del grid tradicional es esencialmente cero** antes de costes; su variante dinámica mejora en un backtest de BTC/ETH 2021–2024, pero es un único backtest de los propios autores. [F] https://arxiv.org/abs/2506.11921
- La documentación de Hummingbot describe el problema central: en tendencia bajista se ejecutan las compras una tras otra y no las ventas, de modo que se acumula inventario del activo que se deprecia ("inventory risk"). Recomiendan el grid fijo para pares estables y mercados en consolidación. [F] https://hummingbot.org/blog/what-is-inventory-risk/ · https://hummingbot.org/strategies/v2-strategies/executors/gridexecutor/

**Cuándo funciona.** Rango lateral que contiene toda la rejilla.
**Cuándo falla.** Ruptura bajista (se queda cargado de un activo que cae) o alcista (vende pronto y se queda fuera).
**Riesgo de ruina.** Alto en spot sin stop: el resultado final es una cartera concentrada comprada durante toda la caída. Con stop, el grid se convierte en una apuesta de rango con esperanza ~0 menos comisiones. **No recomendado.** [R]

### 1.4 DCA y DCA condicionado

**Evidencia.**

- Vanguard (2023): invertir de golpe superó al promediado en el 61,6–73,7 % de los periodos según mercado (1976–2022). El DCA no mejora la rentabilidad esperada; reduce el arrepentimiento y retrasa la asunción de riesgo. [F] https://corporate.vanguard.com/content/dam/corp/research/pdf/cost_averaging_invest_now_or_temporarily_hold_your_cash.pdf

**Mi comprobación.** [C] BTC, aportación semanal desde marzo de 2018:

| Variante | Valor final / aportado | Peor momento frente a lo aportado |
|---|---|---|
| DCA semanal simple | 5,12× | −53 % |
| DCA condicionado (compra solo si BTC > SMA200; a liquidez si está por debajo) | 4,26× | −25 % |

El condicionado renuncia a parte de la ganancia a cambio de la mitad del peor bache. Ambos dependen por completo de que BTC suba a largo plazo.

**Importante.** [R] El "DCA de bots" comercial (comprar más cada vez que cae, sin stop, para bajar el precio medio) es una martingala: funciona hasta que deja de funcionar. No confundir con el DCA de aportaciones periódicas.

**Riesgo de ruina.** El del activo subyacente. No es una estrategia de trading, es una forma de acumular.

### 1.5 Breakout de volatilidad

Es la misma familia que 1.1 (la ruptura Donchian es un breakout). La evidencia y los fallos son los mismos. Las reglas originales de las Tortugas (rupturas de 20 y 55 días, unidad dimensionada para que 1 N —ATR— equivalga al 1 % de la cuenta, stop a 2 N) son la referencia clásica. [F] https://oxfordstrat.com/coasdfASD32/uploads/2016/01/turtle-rules.pdf

Los breakouts intradía (compresión de Bollinger en 5m/15m) chocan con el problema de costes de la sección 2. [C]

### 1.6 Momentum transversal (rotación entre monedas)

**Evidencia.** Mixta.

- Liu, Tsyvinski y Wu (Journal of Finance, 2022): tres factores —mercado, tamaño y momentum— explican los rendimientos transversales. Pero son carteras largo-corto sobre cientos de monedas. [F] https://www.nber.org/papers/w25882
- Han, Kang y Ryu: la evidencia transversal es **débil** con supuestos realistas. [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565

**Aplicabilidad.** [R] Baja para este caso: sin cortos solo se captura la pata larga, el factor tamaño empuja hacia monedas pequeñas e ilíquidas (spreads anchos, riesgo de exclusión del exchange), y rotar genera muchas operaciones. Con cientos de euros, 3–4 pares líquidos es lo máximo razonable. El núcleo propuesto ya hace una rotación implícita: entra solo en los pares que rompen.

### 1.7 Filtro de régimen (BTC sobre su media de 200 días)

**Evidencia.**

- Summitward: la regla larga/plana de 200 días sobre BTC igualó a un conjunto multi-horizonte más complejo, con Sharpe y drawdown algo mejores. [F] https://summitward.com/learn/crypto-trend-following
- Kaminski y Lo: bajo paseo aleatorio las reglas de stop **reducen** el rendimiento esperado; solo aportan valor cuando hay persistencia (momentum). [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338

**Mi comprobación.** [C] BTC desde marzo de 2018:

| Variante | CAGR | Máx. DD | Órdenes/año |
|---|---|---|---|
| Comprar y mantener | 26,1 % | −76,6 % | 0 |
| Largo/plano SMA200, 100 % del capital | 26,7 % | −64,4 % | 3,7 |
| Igual con banda de histéresis ±3 % | 30,9 % | −52,5 % | 1,5 |
| Banda ±3 % + objetivo de volatilidad 25 % | 17,8 % | −29,2 % | 12 |

**Dos conclusiones incómodas.** [C][R]

1. El filtro solo **no** evita drawdowns grandes: desde un máximo, el precio cae un 30–50 % antes de cruzar la media. Lo que de verdad recorta el drawdown es el tamaño de posición (coincide con Summitward).
2. En la estrategia de ruptura el filtro **no es gratis**: redujo el drawdown a la mitad (−17 % → −9 %) pero también el rendimiento (14,7 % → 10,5 %) y no mejoró el Sharpe (1,22 → 1,08). Lo mantengo como valor por defecto porque el objetivo declarado es estabilidad, no porque "mejore" la estrategia.

### Tabla resumen

| Familia | Evidencia | Compatible con spot + 0,1 % + capital pequeño | Perfil de resultados | Veredicto |
|---|---|---|---|---|
| Tendencia (4h–1d) | Razonable | Sí | Pocos aciertos grandes, años planos | **Núcleo** |
| Régimen BTC + volatilidad | Razonable | Sí | 1–12 órdenes/año | **Alternativa** |
| DCA periódico | Sólida como método de acumulación | Sí | Depende de BTC | Complemento, no trading |
| Reversión a la media | Existe, no capturable tras costes | No | Aciertos frecuentes, cola negativa | Descartada |
| Grid | Esperanza ~0 antes de costes | No | Igual que la anterior | Descartada |
| Momentum transversal | Débil con supuestos realistas | Poco | Requiere muchas monedas | Descartada |
| Scalping / intradía | Negativa | No | Pierde por costes | Descartada |

---

## 2. Frecuencia óptima: las cuentas

### 2.1 Coste de una operación de ida y vuelta

| Componente | Valor | Origen |
|---|---|---|
| Comisión spot Binance, usuario normal | 0,10 % maker / 0,10 % taker (0,075 % pagando con BNB) | [F] https://www.binance.com/en/fee/schedule |
| Spread BTC/USDT | 1 tick: 0,01 sobre 83 722 ≈ 0,0001 pb | [C] instantánea del libro, 2026-09-30 |
| Spread ETH/USDT | ≈ 0,04 pb | [C] |
| Spread SOL/USDT, XRP/USDT, LINK/USDT | ≈ 0,7–0,8 pb | [C] |
| Spread ADA/USDT | ≈ 4 pb | [C] |
| Slippage en órdenes de 50–100 € | ≈ 0 en condiciones normales (había ~140 000 $ en el mejor precio de BTC/USDT) | [C] |
| Slippage en stops durante movimientos rápidos | Supuesto: 0,05 % por lado | [R] |

Kaiko confirma que los pares con USDT tienen los spreads más estrechos y que Binance lidera en BTC y ETH. [F] https://www.kaiko.com/resources/a-cheatsheet-for-bid-ask-spreads

**Escenarios de coste de ida y vuelta:**

| Escenario | Coste |
|---|---|
| Optimista (solo comisiones, BTC/ETH) | 0,20 % |
| **Base (comisiones + 0,05 % de slippage por lado)** | **0,30 %** |
| Conservador (altcoins, mercado rápido) | 0,50 % |
| Exchange caro (0,4–0,8 % por lado) | 0,8–1,6 % |

Para un capital pequeño el spread es despreciable en pares grandes. **La comisión lo es casi todo.** [C]

### 2.2 Movimiento típico por vela frente al coste

Movimiento absoluto mediano de apertura a cierre, en %. [C]

| Marco | BTC | ETH | SOL | Coste base (0,30 %) ÷ vela mediana de BTC |
|---|---|---|---|---|
| 1m | 0,019 | 0,026 | 0,034 | **16×** |
| 5m | 0,049 | 0,064 | 0,080 | **6,1×** |
| 15m | 0,100 | 0,131 | 0,159 | **3,0×** |
| 1h | 0,203 | 0,296 | 0,383 | 1,5× |
| 4h | 0,390 | 0,522 | 0,842 | 0,77× |
| 1d | 1,389 | 1,974 | 2,940 | 0,22× |

Ventanas: 60 días (1m), 180 días (5m), 1 año (15m), 2 años (1h), 4 años (4h), 8 años (1d).

En 1m, solo el 0,3 % de las velas de BTC se mueve más de 0,25 %. En 1d, el 88 %.

### 2.3 Qué movimiento hay que capturar

**Punto de equilibrio.** El movimiento bruto medio por operación debe superar el coste: 0,30 % en el escenario base.

**Para que los costes no se coman más del 20 % del beneficio bruto** [R]: el movimiento bruto medio debe ser ≥ 5 × coste:

| Escenario | Movimiento bruto medio necesario |
|---|---|
| Optimista | ≥ 1,0 % |
| Base | ≥ 1,5 % |
| Conservador | ≥ 2,5 % |

Expresado en velas medianas de BTC, un 1,5 % equivale a 79 velas de 1m, 30 de 5m, 15 de 15m, 7 de 1h, 4 de 4h o 1 de 1d.

Como el desplazamiento típico crece con la raíz del tiempo, hay que mantener la posición **del orden de 1 a 4 días** para que el movimiento típico llegue al 1,5 %, *sea cual sea* el tamaño de vela: (1,5 / 0,203)² ≈ 55 horas con velas de 1h; (1,5 / 0,390)² ≈ 15 velas de 4h ≈ 2,5 días. **Lo que determina la viabilidad es el tiempo de permanencia, no el tamaño de la vela.** [C][R]

**Tasa de acierto necesaria** con objetivo y stop simétricos de tamaño X y coste c = 0,30 %: p = (X + c) / (2X). [R]

| Objetivo = stop | Aciertos necesarios solo para empatar |
|---|---|
| 0,2 % | 125 % (imposible) |
| 0,3 % | 100 % |
| 0,5 % | 80 % |
| 1 % | 65 % |
| 2 % | 57,5 % |
| 5 % | 53 % |
| 10 % | 51,5 % |

### 2.4 Experimento: la misma regla en todos los marcos

Ruptura de 20 velas con stop trailing de 3 ATR, solo largo, capital completo. Bruto frente a neto (0,30 % ida y vuelta). [C]

| Marco | Ops/año | BTC: bruto → neto por operación | ETH: bruto → neto por operación | Arrastre anual de costes |
|---|---|---|---|---|
| 1m | ~11 000 | +0,01 % → −0,29 % | +0,02 % → −0,29 % | > 3 000 % |
| 5m | ~1 800 | −0,01 % → −0,31 % | +0,03 % → −0,27 % | ~530 % |
| 15m | ~560 | −0,03 % → −0,33 % | −0,06 % → −0,37 % | ~170 % |
| 1h | ~125 | +0,12 % → −0,19 % | +0,19 % → −0,11 % | ~38 % |
| 4h | ~31 | +1,39 % → +0,99 % | +0,35 % → 0,00 % | ~9 % |
| 1d | ~6 | +3,20 % → +2,90 % | −1,73 % → −2,00 % | ~2 % |

Periodos: último año (1m: 90 días; 4h y 1d: 4 años). Los resultados brutos a 1m no son fiables ni siquiera como bruto: con velas no se sabe qué ocurrió primero dentro de cada una.

**Lectura.** Por debajo de 4h la ventaja bruta por operación es menor que el coste. En 1m–15m el bot liquidaría la cuenta en comisiones.

### 2.5 Qué dice la evidencia sobre el scalping minorista

- Brasil, futuros, 2013–2015: el 97 % de quienes hicieron day trading más de 300 días perdió dinero; solo el 1,1 % ganó más que el salario mínimo. [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3423101
- Taiwán, 1992–2006: menos del 1 % de los day traders obtiene de forma predecible rendimientos positivos netos de comisiones. [F] https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/Day%20Trading%20and%20Learning%20110217.pdf
- Cripto spot a 15 minutos: señal medible, no capturable tras costes. [F] https://arxiv.org/abs/2608.21888
- Existe momentum intradía documentado en Bitcoin (la primera media hora predice la última), pero el mecanismo es provisión de liquidez, terreno de creadores de mercado con costes casi nulos. [F] https://centaur.reading.ac.uk/100181/

### 2.6 Recomendación concreta

| Parámetro | Recomendación | Motivo |
|---|---|---|
| Marco de decisión | Velas cerradas de **4h** | Primer marco donde la ventaja bruta supera con holgura el coste [C] |
| Marco de régimen | Velas cerradas de **1d** (SMA200 de BTC) | |
| Evaluación de señales | **Una vez por vela de 4h**, unos segundos después del cierre (00/04/08/12/16/20 UTC) | Evaluar velas abiertas introduce señales que luego desaparecen |
| Sondeo del bucle | **Cada 60 s**, solo mantenimiento: estado de órdenes, que el stop siga vivo en el exchange, conciliación de saldos, latido | No hace falta WebSocket |
| Operaciones por semana | **0,5–1,5** en total (25–75 al año con 3–4 pares) | 32 al año en la prueba [C] |
| Alarma de sobreoperación | Más de 5 operaciones en una semana indica un fallo | [R] |
| Entradas | **Limit "cruzada"**: precio límite = mejor venta × 1,001, espera 60–120 s, cancelar el resto | Acota el slippage sin arriesgar perder la ruptura |
| Stops | Orden **STOP_LOSS_LIMIT en el exchange**, con límite ~0,5 % bajo el disparo; si no se ejecuta, venta a mercado en el siguiente ciclo | El stop no puede vivir solo en la memoria del bot |
| Maker frente a taker | En Binance (0,10 % en ambos) ser maker **no ahorra comisión**, solo el spread, que es ~0 en BTC/ETH | [F][C] |

**Si el exchange cobra mucho más que 0,1 %** (la tabla pública de Kraken Pro mostraba hoy 0,40 % maker / 0,80 % taker en el tramo inicial [F] https://www.kraken.com/features/fee-schedule): usar la **variante diaria**. Con 0,6 % por lado la versión de 4h cae a CAGR 4,5 % con drawdown −15 %, mientras que la de 1d se mantiene en 7,8 % con −10,4 %. [C]

---

## 3. Gestión de riesgo

### 3.1 Valores por defecto

| Límite | Valor | Justificación |
|---|---|---|
| Riesgo por operación | **0,75 %** del capital (rango 0,5–1 %) | Las Tortugas usaban ~1 % por unidad [F]. En la prueba, 0,5 % → DD −7,7 %, 1 % → DD −12 %, 2 % → DD −32 % [C] |
| Stop inicial | **2,5 × ATR(14)** de 4h bajo la entrada | Tortugas: 2 N [F] |
| Stop trailing | **3 × ATR(14)** bajo el cierre más alto desde la entrada; solo sube | Con 2 ATR, más operaciones y menos rendimiento; con 4 ATR, más rendimiento y más drawdown [C] |
| Tamaño máximo por posición | **25 %** del capital | Evita que un ATR pequeño genere una posición enorme |
| Posiciones abiertas | Máximo **3** | |
| Exposición total | Máximo **75 %**; el resto siempre en liquidez | |
| Riesgo abierto total | Máximo **2,25 %** (suma de distancias a los stops) | Ver correlación abajo |
| Pérdida diaria | **−2 %** sobre el capital a las 00:00 UTC → sin entradas nuevas hasta el día siguiente; los stops siguen activos | [R] |
| Drawdown −10 % desde máximos | Riesgo por operación a la mitad (0,375 %) | [R] |
| Drawdown **−15 %** desde máximos | **Interruptor**: sin entradas nuevas, las posiciones salen por sus stops, revisión manual obligatoria | ≈ 1,5× el peor drawdown de la prueba (−9 %) [R] |
| Enfriamiento por par | **6 velas (24 h)** sin reentrar tras un stop | Freqtrade ofrece `CooldownPeriod` [F] |
| Enfriamiento global | Tras **5 pérdidas seguidas**, 18 velas (3 días) sin entradas | Ver nota |
| Orden mínima | Omitir si el nominal es < 10 USDT | Mínimo de Binance: 5 USDT [C] |

Freqtrade documenta protecciones equivalentes: `StoplossGuard` (ejemplo: 4 stops en 24 velas → pausa de 4 velas), `MaxDrawdown` (ejemplo: 20 %), `LowProfitPairs` y `CooldownPeriod`. [F] https://www.freqtrade.io/en/stable/plugins/

**Nota sobre rachas.** [R] Con ~39 % de aciertos, tres pérdidas seguidas ocurren el 23 % de las veces (0,61³); un enfriamiento a las 3 pérdidas se dispararía continuamente. La racha más larga esperable en ~300 operaciones es de unas 11 (ln 300 / ln(1/0,61)); en la prueba fue de 8 a 15. Con 0,75 % de riesgo, 12 pérdidas seguidas son ≈ −8,6 %. **El enfriamiento y el límite diario no están probados en backtest**: son cortafuegos contra errores de software y mercados rotos, no fuentes de rentabilidad.

### 3.2 Stops

- Kaminski y Lo: los stops solo aportan valor si hay persistencia en los rendimientos. En una estrategia de tendencia son coherentes; en una de reversión a la media van contra la propia hipótesis. [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338
- Freqtrade advierte contra stops demasiado ajustados en el exchange (riesgo de que la orden límite no se ejecute) y documenta el stop en el exchange y sus variantes de trailing. [F] https://www.freqtrade.io/en/stable/stoploss/
- Sin objetivo de beneficio fijo. La estrategia vive de que la ganancia media (+12 %) triplique la pérdida media (−4 %); un take-profit corto destruye esa asimetría. [C][R]

### 3.3 Correlación entre altcoins y BTC

Rendimientos diarios, últimos 3 años. [C]

| Par | Correlación con BTC | Beta | Caída media cuando BTC cae > 3 % (BTC: −4,6 %) | Días en que también cae |
|---|---|---|---|---|
| ETH | 0,82 | 1,15 | −5,7 % | 99 % |
| SOL | 0,75 | 1,33 | −6,5 % | 97 % |
| DOGE | 0,77 | 1,45 | −6,8 % | 94 % |
| ADA | 0,72 | 1,35 | −6,6 % | 94 % |
| LINK | 0,69 | 1,25 | −6,6 % | 94 % |
| BNB | 0,67 | 0,74 | −3,9 % | 91 % |
| XRP | 0,65 | 1,06 | −5,4 % | 94 % |
| LTC | 0,61 | 0,91 | −5,1 % | 86 % |

**Consecuencia.** [R] Tres posiciones en tres altcoins no son tres apuestas; son aproximadamente una sola apuesta con beta mayor que 1. Por eso el límite relevante es el riesgo abierto total, y por eso el filtro de régimen se calcula sobre BTC.

### 3.4 Riesgos que ningún stop cubre

[R] Quiebra, hackeo o congelación de retiradas del exchange; pérdida de paridad de la stablecoin; huecos de precio que atraviesan el stop; errores del bot (órdenes duplicadas, estado perdido tras un reinicio); claves API con permisos de retirada. Mitigación mínima: claves sin permiso de retirada, stop siempre en el exchange, conciliación de saldos en cada ciclo y tener en el exchange solo el capital del bot.

---

## 4. Trampas de backtesting y validación

### 4.1 Trampas

| Trampa | Descripción | Mitigación |
|---|---|---|
| **Sobreajuste** | Probar muchas variantes y quedarse con la mejor. Cuantas más pruebas, más probable es que la ganadora lo sea por azar. | Pocos parámetros; buscar mesetas, no picos; contar cuántas variantes se probaron |
| **Look-ahead** | Usar datos que no existían en el momento de decidir. | Decidir con la vela cerrada y ejecutar en la apertura siguiente; Donchian sin incluir la vela actual; descartar la última vela de `fetchOHLCV` si sigue abierta |
| **Sesgo de supervivencia** | Probar solo monedas que existen hoy. | Usar el universo de la época. En mi prueba, pasar de 6 supervivientes al top-10 de 2018 bajó el Sharpe de 1,22 a 0,89 y llevó el drawdown de −17 % a −28 % [C] |
| **Costes irreales** | Comisión cero, sin slippage, ejecución al precio deseado. | Comisión real + slippage; prueba de estrés con costes ×2 |
| **Ambigüedad dentro de la vela** | No se sabe si se tocó antes el stop o el máximo. | Supuesto pesimista; desconfiar de marcos cortos |
| **Indicadores recursivos** | EMA, RSI y ATR dependen de cuánta historia previa se cargó. | Al menos 3–5× el periodo como calentamiento; mismo calentamiento en backtest y en real |
| **Calendario** | Cripto opera 365 días; anualizar con 252 subestima la volatilidad ~17 %. | Anualizar con 365 [F] |
| **Huecos de datos** | Rellenar huecos crea periodos planos falsos. | Detectar y excluir [F] |

Fuentes:

- Bailey, Borwein, López de Prado y Zhu, "The Probability of Backtest Overfitting". [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
- Bailey y López de Prado, "The Deflated Sharpe Ratio": corrige por selección entre múltiples pruebas y por no normalidad. [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- McLean y Pontiff (Journal of Finance, 2016): en 97 predictores de renta variable, el rendimiento fue un 26 % menor fuera de muestra y un 58 % menor tras la publicación. [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2156623
- Freqtrade, `lookahead-analysis` y `recursive-analysis`: el backtest carga todo el histórico y calcula los indicadores de una vez, por lo que es fácil mirar al futuro sin querer (`shift(-n)`, medias sin ventana). La propia herramienta admite falsos negativos: las señales que no se disparan no se verifican. [F] https://www.freqtrade.io/en/stable/lookahead-analysis/ · https://www.freqtrade.io/en/stable/recursive-analysis/
- Freqtrade, supuestos del backtest: entradas a la apertura, todas las órdenes se ejecutan al precio pedido si está dentro del rango de la vela (sin slippage), el stop se evalúa antes que el objetivo dentro de una vela. "Backtesting will never replace running a strategy in dry-run mode". [F] https://www.freqtrade.io/en/stable/backtesting/
- Freqtrade, hyperopt: más de 3 decimales en un parámetro "will usually result in overfitted results". [F] https://www.freqtrade.io/en/stable/hyperopt/
- Jesse declara que su motor evita el look-ahead en estrategias multi-símbolo y multi-marco. [F] https://docs.jesse.trade/
- Summitward: calendario de 365 días, huecos de datos y supervivencia. [F] https://summitward.com/learn/crypto-trend-following

### 4.2 Cómo validar

[R] salvo donde se indique.

1. **Backtest con historia suficiente.** Al menos 5–6 años que incluyan un mercado bajista completo (2018, 2022). Reservar los últimos 12–18 meses sin tocarlos hasta el final.
2. **Walk-forward.** Elegir parámetros con los años 1–3, probar en el 4; avanzar un año y repetir. El resultado que cuenta es la concatenación de los tramos fuera de muestra.
3. **Meseta de parámetros.** Mover cada parámetro ±50 %. Si el resultado se hunde, está sobreajustado.
4. **Estrés de costes.** Repetir con costes ×2 y ×3. Una estrategia que muere al duplicar costes no tiene margen.
5. **Universo alternativo.** Probar con monedas que no se usaron para diseñar y con un universo histórico que incluya las que fracasaron.
6. **Paridad backtest–real.** El mismo código de señales debe ejecutarse en backtest y en vivo. Cada señal en vivo debe coincidir con la que da el backtest sobre esas mismas velas.

### 4.3 Cuánto tiempo antes de usar dinero real

**Dato incómodo.** [R] Con ~0,6 operaciones por semana, 12 semanas de paper trading son unas 7 operaciones: estadísticamente no significan nada. El estadístico t de un Sharpe es aproximadamente Sharpe × √años; con Sharpe 1 hacen falta unos **4 años** para distinguirlo de cero con t = 2. Summitward llega a lo mismo: 8,5 años dejan el Sharpe entre 0,1 y 1,5. [F]

Por tanto, **el paper trading valida la fontanería, no la ventaja**:

| Fase | Duración mínima | Qué valida | Criterio de paso |
|---|---|---|---|
| Backtest + walk-forward | — | Que la idea no es absurda | Positivo fuera de muestra, meseta, sobrevive a costes ×2 |
| Paper trading (dry-run) | **4–8 semanas** y al menos 5–10 operaciones cerradas | Paridad de señales, órdenes, stops, reinicios, conciliación | Cero discrepancias sin explicar |
| Real con tamaño mínimo (10–20 € por posición, riesgo 0,25 %) | **3 meses** | Comisiones, slippage y ejecución reales | Slippage real ≤ 2× el supuesto; sin incidentes |
| Real con tamaño objetivo | Indefinido | — | Interruptor de −15 % activo |

**Criterios de parada fijados de antemano:** drawdown real > 1,5× el del backtest; slippage medio > 2× el supuesto; cualquier discrepancia de paridad sin explicar.

---

## 5. Expectativas realistas

### 5.1 La infalibilidad no existe

- La estrategia con mejor evidencia acierta ~4 de cada 10 operaciones. [C]
- Tuvo años enteros sin operar (2018, 2022) y un año casi plano (2026 hasta septiembre: +1 %). [C]
- Encadena rachas de 8–15 pérdidas seguidas. [C]
- La incertidumbre sobre si la ventaja existe es enorme incluso con 8 años de datos. [F]
- En Bitcoin, la predictibilidad de las reglas técnicas desapareció fuera de muestra en al menos un estudio serio. [F]

Un sistema que gana "poco pero siempre" no es un sistema robusto: es uno con riesgo de cola que todavía no se ha manifestado. [R]

### 5.2 Rentabilidad y drawdown plausibles

[R] Partiendo de la prueba (CAGR 8–14 %, drawdown −7 a −12 % con riesgo 0,75 %) y aplicando un recorte del orden del de McLean–Pontiff (26–58 %) más el hecho de que el periodo fue excepcionalmente favorable:

| Escenario | Rentabilidad anual neta | Drawdown máximo |
|---|---|---|
| Pesimista (la ventaja no existe o se ha erosionado) | −5 % a 0 % | −15 % (salta el interruptor) |
| Central | +3 % a +8 % | −10 % a −20 % |
| Optimista (se repite algo como 2019–2024) | +10 % a +15 % | −10 % |

Son rangos de opinión, no predicciones.

**En euros, con 300 € de capital:** posición típica de 75 €; coste de ida y vuelta ≈ 0,22 €; ~32 operaciones al año ≈ 7 € en costes; beneficio esperado en el escenario central **9–24 € al año**. Un VPS de 4–5 € al mes cuesta 48–60 € al año. **A esta escala el bot no se paga a sí mismo** salvo que funcione en una máquina que ya esté encendida. [R]

Referencia: comprar y mantener BTC desde marzo de 2018 dio 26 % anual con un drawdown de −77 %. [C] La estrategia propuesta sacrifica gran parte de esa rentabilidad a cambio de un drawdown unas ocho veces menor. Si el usuario puede tolerar −77 %, el bot no le aporta rentabilidad; le aporta control del riesgo.

### 5.3 Cuántos minoristas pierden

| Población | Resultado | Fuente |
|---|---|---|
| Day traders de futuros en Brasil con más de 300 días | 97 % perdió; 1,1 % ganó más que el salario mínimo | [F] https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3423101 |
| Day traders en Taiwán | Menos del 1 % gana de forma predecible neto de comisiones | [F] https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/Day%20Trading%20and%20Learning%20110217.pdf |
| Cuentas minoristas de CFD en la UE | 74–89 % pierde; pérdida media de 1 600 a 29 000 € por cliente | [F] https://www.esma.europa.eu/press-news/esma-news/esma-agrees-prohibit-binary-options-and-restrict-cfds-protect-retail-investors |
| Usuarios de apps de cripto, 95 países, 2015–2022 | La mayoría en casi todas las economías perdió en sus tenencias de bitcoin; los grandes vendían mientras los pequeños compraban | [F] https://www.bis.org/publ/bisbull69.htm |

**Sobre bots minoristas en concreto no encontré ninguna fuente fiable.** Las cifras que circulan proceden de blogs de los propios vendedores de bots y no son verificables (ver "No verificado"). Los datos anteriores son de trading manual y con apalancamiento, así que no se trasladan directamente; pero automatizar una estrategia sin ventaja solo la hace perder más deprisa. [R]

---

## 6. Especificación

### 6.1 Estrategia núcleo: "Ruptura 4h con régimen"

**Idea.** Comprar la ruptura del máximo de 10 días en velas de 4h cuando BTC está en régimen alcista; salir por stop trailing basado en ATR. Sin objetivo de beneficio.

**Parámetros por defecto**

| Parámetro | Valor |
|---|---|
| `timeframe` | `4h` |
| `regimeTimeframe` | `1d` |
| `pairs` | BTC, ETH, SOL contra la moneda de cotización disponible (USDT, USDC o EUR) |
| `donchianPeriod` | 60 velas (10 días) |
| `atrPeriod` | 14 (media de Wilder) |
| `initialStopAtr` | 2,5 |
| `trailAtr` | 3,0 |
| `regimeSmaPeriod` | 200 velas diarias de BTC |
| `riskPerTrade` | 0,0075 |
| `maxPositionPct` | 0,25 |
| `maxOpenPositions` | 3 |
| `maxOpenRiskPct` | 0,0225 |
| `pairCooldownCandles` | 6 |
| `lossStreakPause` | 5 pérdidas → 18 velas |
| `dailyLossLimitPct` | 0,02 |
| `ddHalfRiskPct` / `ddKillPct` | 0,10 / 0,15 |
| `minNotional` | 10 (moneda de cotización) |
| `warmupCandles` | 300 de 4h y 260 de 1d |
| Supuestos de coste en backtest | 0,10 % de comisión + 0,05 % de slippage por lado |

**Régimen.** Activo si el último cierre diario completo de BTC > SMA(200) de cierres diarios de BTC. Si está inactivo no se abren posiciones; las abiertas siguen gestionadas por su stop.

**Entrada** (se evalúa al cierre de cada vela de 4h, por par). Todas las condiciones:

1. Régimen activo.
2. `close` de la vela recién cerrada > máximo de los `high` de las 60 velas **anteriores** (sin incluir la actual).
3. Sin posición abierta en el par.
4. Posiciones abiertas < 3 y riesgo abierto total + riesgo nuevo ≤ 2,25 %.
5. Par fuera de enfriamiento; sin pausa global; sin límite diario ni interruptor activos.

Ejecución: compra inmediata con orden limit cruzada (mejor venta × 1,001), cancelando lo no ejecutado a los 60–120 s.

**Tamaño de posición**

```
stop     = precioEntrada − 2,5 × ATR14
riesgo   = capital × riskPerTrade        (la mitad si drawdown ≥ 10 %)
cantidad = riesgo / (precioEntrada − stop)
nominal  = min(cantidad × precioEntrada, capital × 0,25, saldoLibre × 0,999)
```

Si `nominal` < `minNotional`, no se opera. Redondear a los filtros del exchange (paso de cantidad y tick de precio).

**Stop y salida**

- Al ejecutarse la entrada, colocar de inmediato una orden stop en el exchange en `stop`.
- En cada cierre de vela de 4h: `stop = max(stop, cierreMásAltoDesdeEntrada − 3 × ATR14)`. Si sube, cancelar y reemplazar la orden.
- El stop nunca baja. No hay objetivo de beneficio ni salida por tiempo.

**Pares.** BTC y ETH son la base. SOL añade diversificación de señales, con la advertencia de que su buen resultado histórico es en parte sesgo de supervivencia. [C] No ampliar a monedas pequeñas: el spread de ADA ya era ~4 pb y el capital no permite diversificar de verdad.

**Qué mostró la prueba con estos valores** [C] (2017-08 a 2026-09, no es validación): CAGR 10,5 %, drawdown máximo −9,1 %, Sharpe 1,08, 32 operaciones al año, 39 % de aciertos, ganancia media +12,0 %, pérdida media −4,2 %, exposición media del 6 % del capital. Solo con BTC+ETH: 7,8 % / −7,2 %.

**Opciones a evaluar en el backtest propio** [R]: (a) sin filtro de régimen (más rendimiento, el doble de drawdown); (b) con el régimen inactivo, reducir el riesgo a la mitad en lugar de no operar; (c) N = 30 o 120 como contraste de robustez.

### 6.2 Alternativa: "BTC por régimen con objetivo de volatilidad"

**Idea.** Un solo activo, una decisión al día. Mantener BTC solo cuando está sobre su media de 200 días, con un tamaño inversamente proporcional a su volatilidad reciente.

| Parámetro | Valor |
|---|---|
| Par | BTC contra la moneda de cotización |
| Marco | `1d`, una evaluación diaria tras el cierre de 00:00 UTC |
| Entrada en régimen | Cierre > SMA200 × 1,03 |
| Salida de régimen | Cierre < SMA200 × 0,97 |
| Volatilidad | Desviación típica de rendimientos logarítmicos diarios de 30 días × √365 |
| Peso objetivo | `min(1, 0,25 / volatilidad)` en régimen; 0 fuera |
| Reequilibrio | Solo si el peso actual difiere del objetivo en más de 10 puntos, o al entrar o salir del régimen |
| Interruptor | Drawdown de −25 % → todo a liquidez y revisión manual |

**Resultado de la prueba** [C] (desde marzo de 2018): CAGR 17,8 %, drawdown máximo −29,2 %, Sharpe 0,89, unas 12 órdenes al año. Por año: 2018: −4 % · 2019: +27 % · 2020: +86 % · 2021: 0 % · 2022: 0 % · 2023: +31 % · 2024: +30 % · 2025: −3 % · 2026: +10 %.

**Cuándo elegirla.** [R] Si el exchange cobra más de 0,1 %, si se quiere el mínimo de código y de operaciones, o como primera versión del bot para validar la infraestructura. **Inconvenientes:** drawdown tres veces mayor que el núcleo, dependencia de un solo activo y dos años seguidos planos (2021–2022).

**Variante diaria del núcleo** [C], para exchanges caros: misma lógica con velas de 1d y Donchian de 20 días. CAGR 8,6 %, drawdown −9,4 %, 10 operaciones al año, y apenas sensible a comisiones de 0,6 % por lado (7,8 %).

---

## 7. No verificado

**Fuentes que no pude leer completas**

- **Han, Kang y Ryu** (SSRN 4675565): SSRN y el espejo en PDF devolvieron error 403. Solo dispongo del resumen tal como aparece en resultados de búsqueda. No conozco su muestra exacta, sus supuestos de coste ni sus cifras.
- **Zarattini, Pagani y Barbon**: solo el resumen (RePEc y la web de los autores). Los periodos exactos del conjunto Donchian, el objetivo de volatilidad y el supuesto de comisiones no los verifiqué. Las cifras "CAGR 30 %, Sharpe 1,58, comisiones 0,10–0,50 %" que circulan proceden de resúmenes de terceros.
- **Hudson y Urquhart**: solo el resumen; el PDF devolvió acceso denegado.
- **Reglas de las Tortugas**: citadas a través de resúmenes; no abrí el PDF original.
- **Liu, Tsyvinski y Wu**; **Moreira y Muir**; **Kaminski y Lo**; **McLean y Pontiff**; **Bailey et al.**; **Barber et al.**; **Chague et al.**; **Vanguard**; **Shen, Urquhart y Wang**: citados a partir de sus resúmenes, no del texto completo.
- **Jesse**: la afirmación de que evita el look-ahead es lo que declara el propio proyecto; no lo comprobé.

**Preprints sin revisión por pares**

- Kitron y Wengrowicz (arXiv 2608.21888), investigadores independientes.
- Chen et al. sobre grid dinámico (arXiv 2506.11921).
- Bui y Nguyen (arXiv 2602.11708) reportan Sharpe 2,41 con una estrategia largo-corto en futuros perpetuos. **No lo uso como evidencia**: no es spot, usa cortos y los propios autores señalan riesgo de look-ahead en su reoptimización mensual. https://arxiv.org/abs/2602.11708

**Datos de mercado**

- Los spreads son **una única instantánea** del libro de Binance del 2026-09-30. No medí el spread medio ni en momentos de tensión. La cifra "0,0014 pb" atribuida a Kaiko proviene de un resultado de búsqueda; en el artículo los números están en gráficos.
- El slippage del 0,05 % por lado es un **supuesto**, no una medición.
- La tabla de comisiones de Kraken Pro (0,40 % / 0,80 %) es lo que devolvió su página hoy; no coincide con lo que yo recordaba de años anteriores y conviene comprobarla.
- Las comisiones de Binance pueden variar por región, promoción o nivel.
- **No verifiqué qué pares están disponibles para residentes en la UE**; la normativa MiCA ha restringido algunas stablecoins en ciertos exchanges. Hay que confirmar qué moneda de cotización puede usar el usuario.
- Los libros en EUR son menos profundos que los de USDT (en la instantánea, ~0,01 BTC en el mejor precio de BTC/EUR). No medí el slippage en esos pares.

**Mis propios cálculos [C]**

- Hechos con scripts ad hoc que **no forman parte del repositorio** y no han sido revisados por nadie. Pueden contener errores.
- Simulación por velas: el stop se supone ejecutado a su precio más slippage; no se modelan rechazos de orden, redondeos de cantidad ni mínimos.
- Un solo exchange, un solo camino histórico, sin walk-forward formal, sin corrección por pruebas múltiples.
- El universo "top-10 de 2018" lo compuse de memoria y excluye Bitcoin Cash por el cambio de símbolo.
- Los valores por defecto se fijaron **después** de ver resultados.
- **No probados en backtest:** límite de pérdida diaria, enfriamientos, interruptor por drawdown y la reducción de riesgo a la mitad.

**Afirmaciones sin fuente fiable**

- **Porcentaje de bots minoristas que pierden dinero:** no encontré ningún estudio independiente. Las cifras de blogs de vendedores ("mediana del 12 % anual", "el 25 % inferior pierde 5–15 %") no citan datos verificables y provienen de partes interesadas. No las considero evidencia.
- "El lump sum superó al DCA en el 66 % de las simulaciones en cripto": fuente secundaria, no verificada.
- Los rangos de rentabilidad de la sección 5.2 y las duraciones de la sección 4.3 son **opinión propia**.

**Fuera de alcance**

- Fiscalidad: cada venta puede ser un hecho imponible y una estrategia con decenas de operaciones al año genera obligaciones de declaración. Consultar con un asesor fiscal.
- Seguridad de claves API, elección de exchange y arquitectura del bot.

---

## 8. Fuentes

**Académicas y preprints**

- Han, Kang, Ryu — Time-Series and Cross-Sectional Momentum in the Cryptocurrency Market: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565
- Zarattini, Pagani, Barbon — Catching Crypto Trends: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907 · https://ideas.repec.org/p/chf/rpseri/rp2580.html · https://concretumgroup.com/catching-crypto-trends-a-tactical-approach-for-bitcoin-and-altcoins/
- Hudson, Urquhart — Technical trading and cryptocurrencies: https://link.springer.com/content/pdf/10.1007/s10479-019-03357-1.pdf
- Liu, Tsyvinski, Wu — Common Risk Factors in Cryptocurrency: https://www.nber.org/papers/w25882
- Shen, Urquhart, Wang — Bitcoin intraday time-series momentum: https://centaur.reading.ac.uk/100181/
- Kitron, Wengrowicz — Short-horizon mean reversion in cryptocurrency markets: https://arxiv.org/abs/2608.21888
- Up or down? Short-term reversal, momentum, and liquidity effects in cryptocurrency markets: https://www.sciencedirect.com/science/article/pii/S1057521921002349
- Cryptocurrency return reversals: https://www.tandfonline.com/doi/abs/10.1080/13504851.2020.1784831
- Dynamic Grid Trading Strategy: https://arxiv.org/abs/2506.11921
- Moreira, Muir — Volatility-Managed Portfolios: https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12513
- Kaminski, Lo — When Do Stop-Loss Rules Stop Losses?: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=968338
- Bailey, Borwein, López de Prado, Zhu — The Probability of Backtest Overfitting: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
- Bailey, López de Prado — The Deflated Sharpe Ratio: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- McLean, Pontiff — Does Academic Research Destroy Stock Return Predictability?: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2156623
- Chague, De-Losso, Giovannetti — Day Trading for a Living?: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3423101
- Barber, Lee, Liu, Odean — Do Day Traders Rationally Learn About Their Ability?: https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/Day%20Trading%20and%20Learning%20110217.pdf

**Instituciones**

- BIS Bulletin 69 — Crypto shocks and retail losses: https://www.bis.org/publ/bisbull69.htm
- ESMA — medidas sobre CFD y opciones binarias: https://www.esma.europa.eu/press-news/esma-news/esma-agrees-prohibit-binary-options-and-restrict-cfds-protect-retail-investors
- Vanguard — Cost averaging: invest now or temporarily hold your cash?: https://corporate.vanguard.com/content/dam/corp/research/pdf/cost_averaging_invest_now_or_temporarily_hold_your_cash.pdf

**Documentación de frameworks**

- Freqtrade — Backtesting: https://www.freqtrade.io/en/stable/backtesting/
- Freqtrade — Lookahead analysis: https://www.freqtrade.io/en/stable/lookahead-analysis/
- Freqtrade — Recursive analysis: https://www.freqtrade.io/en/stable/recursive-analysis/
- Freqtrade — Protections: https://www.freqtrade.io/en/stable/plugins/
- Freqtrade — Stoploss: https://www.freqtrade.io/en/stable/stoploss/
- Freqtrade — Hyperopt: https://www.freqtrade.io/en/stable/hyperopt/
- Hummingbot — What is inventory risk?: https://hummingbot.org/blog/what-is-inventory-risk/
- Hummingbot — Grid Executor: https://hummingbot.org/strategies/v2-strategies/executors/gridexecutor/
- Jesse: https://docs.jesse.trade/

**Análisis independientes y datos**

- Summitward — Does Trend Following Work on Crypto?: https://summitward.com/learn/crypto-trend-following
- Kaiko — A Cheatsheet for Bid Ask Spreads: https://www.kaiko.com/resources/a-cheatsheet-for-bid-ask-spreads
- Binance — tabla de comisiones: https://www.binance.com/en/fee/schedule
- Kraken — tabla de comisiones: https://www.kraken.com/features/fee-schedule
- Reglas originales de las Tortugas: https://oxfordstrat.com/coasdfASD32/uploads/2016/01/turtle-rules.pdf
- API pública de datos de mercado de Binance (velas, libro, filtros): https://data-api.binance.vision
