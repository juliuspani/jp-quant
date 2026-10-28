# STRATEGY_RESEARCH — investigación de las familias de estrategias

> **Copia pública (paso 49).** Las menciones a `PROGRESS.md` y `docs/progress/` se refieren al registro de trabajo
> privado del proyecto, que no se publica. Guía en inglés de la documentación: [docs/README.md](docs/README.md).

Paso 28 ([ADR 0032](docs/adr/0032-barridos-con-eleccion-en-train.md)). Investiga, una familia por sesión, las dos
familias de la primera ronda de la Strategy Library (paso 25, [ADR 0028](docs/adr/0028-strategy-library-primera-ronda.md))
con el protocolo de `quant-research` y los criterios congelados del paso 27
([docs/PROMOTION_CRITERIA.md](docs/PROMOTION_CRITERIA.md), A.3). El 2026-10-22, tras la auditoría quant, las dos se
repitieron una vez como estaban pre-registradas (EXP-0027 y EXP-0028), con los criterios que la persona cambió a la vista
de resultados (ADR 0030, decisión 9), y se juntó la matriz del PBO de la ronda (§4).

Este documento no recomienda operar ni invertir. Los únicos veredictos posibles son los de `quant-research` §11:
`RECHAZADA`, `NO CONCLUYENTE`, `CANDIDATA A TEST FINAL` y `CANDIDATA A PAPER`. Ninguna cifra de aquí es una
validación: el test final (2026-10-01 a 2027-10-01) sigue cerrado, y la decisión es del paso 31.

| Familia | Estrategia | Experimento | Estado |
|---|---|---|---|
| Trend following (`tendencia-donchian-atr`) | `tendencia-donchian` 1.0.0, rejilla de los Turtle | [EXP-0027](docs/research/experiments/EXP-0027.md), repetición de [EXP-0025](docs/research/experiments/EXP-0025.md) (`RECHAZADA` con los criterios de entonces). Antes, sin resultados y contando en N: [EXP-0023](docs/research/experiments/EXP-0023.md) (abortado) y [EXP-0024](docs/research/experiments/EXP-0024.md) (fallido, ADR 0033) | **`RECHAZADA`** |
| Reversión a la media (`reversion-rsi2`) | `reversion-rsi2` 1.0.0, umbrales del RSI(2) de Connors y Alvarez | [EXP-0028](docs/research/experiments/EXP-0028.md), repetición de [EXP-0026](docs/research/experiments/EXP-0026.md) (`RECHAZADA` con los criterios de entonces) | **`RECHAZADA`** |

## 1. Protocolo común

Lo mismo para todas las familias. Lo que se fija en el pre-registro de cada una está en su sección.

1. **Hipótesis antes de ejecutar.** Cada experimento registra hipótesis, mecanismo, métrica primaria, criterios, perfil
   por régimen y rejilla en el Experiment Registry antes de cargar datos reales. Su especificación está versionada en
   `docs/research/experiments/specs/` y se confirma en un commit anterior a la ejecución.
2. **Train y validation temporales.** Walk-forward de 10 tramos: 3 años de train y 1 de validación, avanzando 1 año. Las
   validaciones van de 2017 al 2026-09-30, contiguas; 2018 y 2022 caen enteros en validación.
3. **Elección en train, con purging y embargo** (ADR 0032). En cada tramo, cada punto de la rejilla se ejecuta con el
   backtester completo sobre su train y se puntúa con la métrica primaria; el mejor se mide en la validación de ese
   tramo. El train acaba `h` velas antes (purging) y no puntúan las `e` velas que siguen a cada tramo ya evaluado
   (embargo, `e ≥ h`). Una prueba comprueba que cambiar las velas de validación no cambia lo elegido antes.
4. **Test final intacto.** Ningún experimento lo carga: las particiones tienen `test: null` y la guarda del ADR 0020
   se niega a leerlo sin el flag humano.
5. **Métrica primaria:** el Sharpe anualizado con 365 días, neto de costes, de la serie concatenada de las validaciones.
6. **Costes** del modelo de Bitvavo en todo run: comisión del 0,25 %, medio spread del 0,075 % y slippage de al menos el
   0,05 % por lado, más el impacto del libro sintético. Estrés con costes ×2 y ×3.
7. **Robustez y controles** (ADR 0031): retraso de una vela, sensibilidad de cada parámetro a ±25 % y ±50 %, sin el
   mejor año y sin el mejor activo, ablación con la exposición controlada (ADR 0037), universo alternativo, ventanas de
   crisis, regímenes frente a BTC escalado por la exposición (ADR 0042), control aleatorio de 1000 simulaciones, señal
   desplazada y paseo aleatorio.
8. **Estadística:** DSR con la N de la familia y, en la decisión, con la de todo el registro (ADR 0039); MinTRL y un
   segundo IC con la varianza a largo plazo del Sharpe (ADR 0038); bootstrap estacionario de 10 000 remuestreos; PBO por
   CSCV con todas las configuraciones de la ronda, con el de la familia informado (ADR 0041); y estabilidad del elegido
   en train.
9. **Todo por el Experiment Registry.** `npm run backtest` registra antes de cargar datos, comprueba el hash de los datos
   y cierra con las métricas, el veredicto y el hash de la salida, que se guarda en
   `docs/research/experiments/salidas/`.

### Presupuesto de configuraciones y complejidad

- **Como mucho 20 configuraciones por estrategia** (C.1 y compromiso del paso 28). Cada familia declara su rejilla en
  la biblioteca antes de mirar datos, con valores de la literatura; el ejecutor no acepta otra. No hay barridos
  masivos: la de la tendencia tiene 4 puntos.
- **Todo cuenta en N:** cada punto de la rejilla y cada variante de robustez. Los controles no, porque no compiten por
  la decisión.
- **Penalización de la complejidad:** la N alta endurece el Deflated Sharpe; los grados de libertad de cada regla se
  cuentan en su ficha; entre variantes con evidencia comparable gana la más simple; y la ablación exige que cada
  componente aporte.

### Comparación con RANDOM y BUY_AND_HOLD

Como fijó el [ADR 0027](docs/adr/0027-estrategias-de-referencia.md), cada experimento se compara con:

- **RANDOM:** el control aleatorio de A.3.12, 1000 colocaciones al azar con las mismas operaciones, duración, tamaño y
  costes. Es más exigente que la estrategia RANDOM, que no imita la exposición.
- **BUY_AND_HOLD:** el buy-and-hold puro de BTC y el equiponderado del universo, con los mismos costes y periodos
  (A.3.10). La estrategia BUY_AND_HOLD está limitada por Risk y no sirve para comparar rentabilidades. En los regímenes
  (A.3.9), BTC escalado periodo a periodo por la exposición de la estrategia (ADR 0042).

### Presupuesto y N de cada familia

| Familia | Rejilla | Configuraciones | Variantes | Experimentos | N de la familia | N global |
|---|---|---|---|---|---|---|
| Tendencia | Sistemas 1 y 2 de los Turtle (entrada 20/55 × salida 10/20) | 4 | 22 | EXP-0023 (abortado), EXP-0024 (fallido), EXP-0025 y su repetición, EXP-0027 | 153 | 237 |
| Reversión | RSI(2) bajo 2, 5 o 10 | 3 | 31 | EXP-0026 y su repetición, EXP-0028 | 76 | 237 |

La N global es la de todo el registro en la matriz de la ronda (ADR 0039), la misma para los dos. La de la familia,
hasta el pre-registro de la repetición.

Los dos primeros experimentos de la tendencia no dieron ningún resultado, pero cuentan en N. EXP-0023 se abortó porque el
portátil se quedaba sin batería; EXP-0024 falló por un error del sistema de trading con liquidez fina (restos en polvo
sin stop), corregido en el [ADR 0033](docs/adr/0033-polvo-y-stops-cruzados.md) antes de repetirlo.

## 2. Tendencia (`tendencia-donchian-atr`): `RECHAZADA`

**Pre-registro** (especificación
[tendencia-donchian-1.0.0-rejilla.json](docs/research/experiments/specs/tendencia-donchian-1.0.0-rejilla.json),
confirmada antes de cargar datos). Hipótesis: los activos con tendencia tienden a continuarla, y una ruptura del máximo de
las 20 o 55 velas anteriores anticipa más subida. Universo BTC/EUR y ETH/EUR en velas diarias, con stop a 2 ATR de 20 y
el tamaño que decide Risk. Purging y embargo de 55 velas. Universo alternativo: ETC/EUR, LTC/EUR y ZEC/EUR. Perfil por
régimen de Trend following (A.3.9). La repetición usa
[tendencia-donchian-1.0.0-rejilla-repeticion.json](docs/research/experiments/specs/tendencia-donchian-1.0.0-rejilla-repeticion.json),
con el mismo diseño.

**Resultado de [EXP-0027](docs/research/experiments/EXP-0027.md)**, la repetición del 2026-10-22, fuera de muestra y neto
de costes, de 2017 al 2026-09-30. La elección en train se quedó con el sistema 1 (20/10) en los tramos 0 a 6 y con 55/10
en los tramos 7 a 9.

| Criterio | Medido | Umbral | Estado |
|---|---|---|---|
| A.3.1 Walk-forward | Sharpe 1,47; 8 de 10 tramos positivos | > 0 y la mitad de los tramos | PASS |
| A.3.2 Deflated Sharpe | 0,482 (N = 153) y 0,391 (N global = 237) | ≥ 0,95 | **FAIL** |
| A.3.3 Costes | Sharpe 1,42 y P&L positivo con costes ×2 | > 0 | PASS |
| A.3.4 Drawdown | 20,5 %; límite superior del IC, 29,6 % | ≤ 10 % y ≤ 20 % | **FAIL** |
| A.3.5 Muestra | 79 operaciones cerradas | ≥ 100 | **FAIL** |
| A.3.6 PBO | 0,039 en la ronda (7 configuraciones); 0,151 en la familia, que no decide | < 0,20 | PASS |
| A.3.7 Estrés | 2020-03 a 04: +1,4 % frente a +2,1 % de BTC | rentabilidad ≥ BTC en cada ventana | **FAIL** |
| A.3.8 Parámetros | Sharpe de 1,36 a 1,50 con ±25 % y ±50 % | sin cambio de signo y ≥ la mitad | PASS |
| A.3.9 Regímenes | Bajista de 2022: pierde el 52 % de lo que pierde BTC con su exposición de ese año (11,9 %) | ≤ 50 % | **FAIL** |
| A.3.10 Buy-and-hold | Sharpe 1,47 y Calmar 1,01 frente a 0,99 y 0,65 (BTC) y 1,14 y 0,90 (equiponderado) | mayores | PASS |
| A.3.11 IC | Límite inferior del Sharpe, 0,76 (bootstrap) y 0,79 (varianza a largo plazo) | > 0 | PASS |
| A.3.12 Control aleatorio | 1,47 frente a un percentil 95 de 1,21 (1000 simulaciones con el backtester) | mayor | PASS |
| A.3.13 Estabilidad | Sin 2017, 1,13; sin ETH, 1,26 | > 0 | PASS |
| A.3.14 Ablación y alternativo | Sin la salida por canal, exceso sobre su control de 0,13 frente a 0,61; con ETC, LTC y ZEC, 0,78 | aporta y > 0 | PASS |
| A.3.15 Humo | Señal desplazada, 0,81; paseo aleatorio, 0,44; percentiles 95 de 1,21 y 1,20 | no superarlos | PASS |

**Lectura.**
- Fallar un criterio basta para `RECHAZADA` (regla 2), y falla cinco. La estrategia no vuelve en la primera ronda: con
  otros parámetros sería una hipótesis nueva de su familia (A.1 y C.1).
- Lo que pasa no compensa lo que falla. El exceso de Sharpe sobre BTC tiene un IC de −0,20 a 1,13, que incluye el 0, y el
  Sharpe no supera el máximo esperado de las pruebas sin habilidad (DSR de 0,48 en la familia y de 0,39 en el registro).
  El P&L se concentra en 2017 (1734 de 2162 EUR) y en ETH (1776 EUR), aunque sin cada uno el Sharpe sigue positivo.
- La exposición media es del 8,2 %, por el riesgo de Risk (0,75 % por operación y como mucho el 25 % por par). Frente a
  BTC escalado por esa exposición, la captura del alcista pasa; falla el bajista de 2022 con la exposición de ese año.
- Las 79 operaciones se quedan cortas incluso con el sistema 1, el más rápido de la rejilla. Quien eligió la rejilla
  conocía las 48 operaciones de EXP-0021 (contaminación declarada).
- El backtest no aplica aún los breakers de Risk (paso 35): con el de drawdown, 2017 habría sido otro.

**[EXP-0025](docs/research/experiments/EXP-0025.md)** (2026-10-17), con el motor y los criterios de entonces: Sharpe 1,45
y 77 operaciones, `RECHAZADA` por cuatro criterios (caída, muestra, la crisis de 2020 y la captura del alcista frente a
BTC con todo el capital, un 9,8 %). En la repetición, las operaciones cambian por las correcciones del motor (ADR 0035 y
0036), A.3.2 pasa a fallar con la varianza de una prueba sin habilidad (ADR 0039) y A.3.9 falla por otra causa.

## 3. Reversión a la media (`reversion-rsi2`): `RECHAZADA`

**Pre-registro** (especificación
[reversion-rsi2-1.0.0-rejilla.json](docs/research/experiments/specs/reversion-rsi2-1.0.0-rejilla.json)). Hipótesis: tras una
sobreventa de 2 días en tendencia alcista (cierre sobre la SMA 200), el precio vuelve a su media. Rejilla `rsiEntry` ∈ {2,
5, 10}, purging y embargo de 20 velas, el mismo universo y el mismo alternativo que la tendencia, y el perfil de Reversión
a la media (A.3.9).

**Resultado de [EXP-0028](docs/research/experiments/EXP-0028.md)**, la repetición del 2026-10-22 (especificación
[reversion-rsi2-1.0.0-rejilla-repeticion.json](docs/research/experiments/specs/reversion-rsi2-1.0.0-rejilla-repeticion.json)):
Sharpe neto 0,41 (IC −0,07 a 0,98; con la varianza a largo plazo, −0,26 a 1,08), +4,0 % en 9,75 años, 38 operaciones y en
mercado el 2,4 % del tiempo. Falla 7 criterios: Deflated Sharpe (0,139 en la familia y 0,074 en el registro), muestra,
estrés (retraso de una vela y crisis de 2020), sensibilidad (cambia de signo con `rsiEntry` −50 %), captura del alcista
(4,0 % de su benchmark), buy-and-hold e IC. Pasan el walk-forward, los costes ×2, la caída (1,4 %), el PBO de la ronda
(por la tendencia: dentro de la familia es 0,898), el control aleatorio (percentil 96,0, por poco), la estabilidad, la
ablación con la exposición controlada y las pruebas de humo.

**Lectura.** La regla casi no opera en velas diarias con el filtro de la SMA 200 y el tamaño de Risk, y su Sharpe no se
distingue de cero. No demuestra que la reversión no exista en cripto: con 38 operaciones no se puede medir.

**[EXP-0026](docs/research/experiments/EXP-0026.md)** (2026-10-17), con el motor y los criterios de entonces: Sharpe 0,36
y 36 operaciones, `RECHAZADA` por 10 criterios. En la repetición pasan de FAIL a PASS A.3.6 y A.3.14, por los criterios
nuevos (el PBO de la familia ya no decide; la ablación descuenta la exposición), y A.3.12, por las operaciones del motor
corregido.

## 4. Conclusión de la primera ronda

**Ninguna estrategia muestra evidencia robusta.** Las dos familias de la primera ronda quedan `RECHAZADA` con los
criterios congelados, también en la repetición con los criterios que la persona cambió el 2026-10-22: la tendencia falla
5 criterios (Deflated Sharpe, caída, muestra, una ventana de crisis y el bajista de 2022) y la reversión falla 7. Ninguna
vuelve con otros parámetros en esta ronda (A.1 y C.1).

**Matriz del PBO de la ronda** (`npm run pbo-ronda -- --id EXP-0027 --id EXP-0028`, ADR 0034, 2026-10-22): las 7
configuraciones de las dos rejillas sobre los mismos 3559 periodos, con S = 16 y 12 870 combinaciones.

| Matriz | Configuraciones | PBO | ¿Decide? |
|---|---|---|---|
| Toda la ronda (A.3.6) | 7 | 0,039 | Sí: por debajo de 0,20 |
| Dentro de la tendencia | 4 | 0,151 | No: se informa |
| Dentro de la reversión | 3 | 0,898 | No: se informa |

- El PBO de la ronda es bajo porque dominan las configuraciones de la tendencia: en el 99,0 % de las combinaciones la
  mejor dentro de muestra es una de ellas, y en el 95,9 % las cuatro superan fuera de muestra a las tres de la reversión.
  Dice que elegir la mejor de la ronda no es sobreajuste a una mitad de los datos. No dice que tenga ventaja, ni nada de
  las configuraciones de la reversión, que pasan A.3.6 por estar en la misma ronda.
- EXP-0025 y EXP-0026 no entran: son las mismas configuraciones con el motor de antes, y contarlas dos veces sesgaría el
  CSCV, por el mismo motivo por el que el ADR 0034 deja fuera la serie de lo elegido. Sí cuentan en N.

**DSR global** (A.3.2, ADR 0039), con la N de todo el registro en ese momento, 237, la misma para los dos: EXP-0027,
0,391 (SR₀ = 0,0820 por periodo frente a un Sharpe de 0,0770); EXP-0028, 0,074 (SR₀ = 0,0473 frente a 0,0214). Los dos,
por debajo de 0,95.

Lo siguiente es la decisión del paso 31: escribir el documento de decisión con estas salidas y, si nada llega a PAPER,
aplicar la parte C de `docs/PROMOTION_CRITERIA.md`: una segunda ronda con Breakout, Cross-Sectional Momentum y Price +
Volume Momentum, y, si tampoco hay evidencia, documentar la alternativa pasiva. Esa conclusión no es un consejo de
inversión: qué hacer con ella lo decide la persona.
