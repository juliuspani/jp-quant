# Punto de decisión del proyecto (paso 31)

| Campo | Valor |
|---|---|
| Fecha | 2026-10-22 |
| Decide | La persona, con los resultados de EXP-0027 y EXP-0028 |
| Redacta | Claude (`claude-opus-5-5`) |
| Resultado | Ninguna estrategia cumple los criterios congelados: ninguna llega a VALIDATED ni a PAPER |
| Test final | No se desbloquea para promocionar nada. Lo usará una sola vez, después del 2027-10-01, la comprobación hacia delante de A ([ADR 0043](adr/0043-comprobacion-hacia-delante-de-a.md)), que no es una promoción |
| Segunda ronda | No se activa, por decisión de la persona |
| Lo siguiente | Se para el desarrollo de trading activo. Plan B: el paso 41B en versión local y después los pasos 49 a 52; el 53, después del 2027-10-01 |
| Conclusión del plan B | La alternativa pasiva, documentada de forma factual en §10. Aplicarla, y cómo, es decisión de la persona y no asesoramiento financiero |

**En una frase.** Las dos estrategias de la primera ronda quedan `RECHAZADA` con una `N` global de 237 y un PBO de la
ronda de 0,039:
- la tendencia (EXP-0027), con un DSR de 0,391, falla 5 criterios;
- la reversión (EXP-0028), con un DSR de 0,074, falla 7.

El umbral del DSR es 0,95. Que ninguna pase es un resultado previsto (ADR 0030, «Consecuencias»): así deben funcionar
unos criterios fijados antes de mirar.

## 1. Resultado por estrategia

| Estrategia | Familia | Experimento | Veredicto | `N` (familia · global) | DSR (familia · global) | PBO de la ronda | Sharpe neto · límite inferior del IC que decide | Criterios que fallan |
|---|---|---|---|---|---|---|---|---|
| A: `tendencia-donchian` 1.0.0 | `tendencia-donchian-atr` | [EXP-0027](research/experiments/EXP-0027.md) | `RECHAZADA` | 153 · 237 | 0,482 · 0,391 | 0,039 | 1,47 · 0,76 | A.3.2, A.3.4, A.3.5, A.3.7 y A.3.9 |
| B: `reversion-rsi2` 1.0.0 | `reversion-rsi2` | [EXP-0028](research/experiments/EXP-0028.md) | `RECHAZADA` | 76 · 237 | 0,139 · 0,074 | 0,039 | 0,41 · −0,26 | A.3.2, A.3.5, A.3.7, A.3.8, A.3.9, A.3.10 y A.3.11 |

- **Ninguna llega a VALIDATED (A.3), así que ninguna llega a PAPER.** A.4.1 falla en las dos, y el resto de A.4 no
  hace falta:
  - no hay informe del consultor sobre EXP-0027 ni EXP-0028 (A.4.2), ni se han reproducido (A.4.3);
  - A.4.4 es este documento, con las líneas del registro (§7), y los backtests usan los límites de `src/risk/limits.ts`
    (A.4.5).
- **Las dos siguen en RESEARCH y `RECHAZADA`.** No vuelven con otros parámetros: cambiarlas es una hipótesis nueva de su
  familia, que suma a `N` (A.1).
- **Las candidatas eran las dos estrategias de la biblioteca** (ADR 0028). BASELINE, RANDOM y BUY_AND_HOLD son
  referencias (ADR 0027). Todos sus experimentos anteriores cuentan en `N`:
  - EXP-0021 y EXP-0022 (paso 25, parámetros de la literatura, sin veredicto), cuyas configuraciones están en las
    rejillas de A y B;
  - EXP-0023 (abortado) y EXP-0024 (fallido);
  - EXP-0025 y EXP-0026, `RECHAZADA` con los criterios de entonces y con el error de Q-01.

## 2. Comprobaciones previas

### 2.1 Hallazgos Critical y High del consultor quant

La auditoría ciega de la primera ronda ([informe](audits/2026-10-20-quant-primera-ronda.md), paso 30) dio 0 Critical, 4
High, 2 Medium y 2 Low, todos confirmados por la sesión principal. Los High se corrigieron antes de repetir A y B:

| Hallazgo | Corrección | ADR | Commits | Pruebas |
|---|---|---|---|---|
| Q-01: falso `STALE_DATA` con varios pares | Lo que llega en un mismo instante se ingiere antes de evaluar | 0035 | `85503ee` | `same-instant.test.ts` y `composition.test.ts` |
| Q-02: la captura del alcista de A.3.9 era inalcanzable | A.3.9 frente a BTC escalado por la exposición sin polvo, en logaritmos, con la condición por régimen | 0042 | Código: `36baae9`, `8c88544` y `a0b807b`. Estudios y validación: `bb4b459`, `3d7e6de`, `2691e30` y `fd3c9ff`. Criterios: `cd3593d` | `criteria.test.ts`, `windows.test.ts`, `ledger.test.ts` y otras |
| Q-03: el DSR global dependía del orden de los experimentos | V[SRₙ] de una prueba sin habilidad y DSR global al decidir | 0039 | `627e180` (método) y `4a48677` (código) | `statistics.test.ts`, `criteria.test.ts` y `round-matrix.test.ts` |
| Q-04: el universo se eligió con una justificación falsa | El universo de A y B no cambia, porque estaban pre-registradas así (decisión de la persona). Se documenta y se corrige la regla para futuros pre-registros | 0040 | `1ceb25d` | Ninguna: no cambia código |

- **Un commit por hallazgo, con prueba:**
  - se cumple en Q-01 y en el código de Q-03;
  - Q-02 necesitó una parada de la persona, estudios sintéticos y varios commits, cada uno de código con su prueba;
  - Q-04 es solo documentación, por decisión de la persona.
- **Medium y Low:**
  - Q-05 se mantiene, por decisión de la persona (convención conservadora del ADR 0031);
  - Q-06, ADR 0041 (`38d2fd3` y `8b19c35`);
  - Q-07, ADR 0036 (`70664f6`);
  - Q-08, ADR 0037 (`07ff0a8`) y la declaración de `2e75877`.

  Además, la autocorrelación del Sharpe: ADR 0038 (`8aaecba`).
- **Experimentos repetidos:** EXP-0025 como EXP-0027 y EXP-0026 como EXP-0028, una sola vez y como estaban
  pre-registrados. Después se hizo la matriz del PBO de la ronda ([STRATEGY_RESEARCH.md](../STRATEGY_RESEARCH.md) §4).

### 2.2 Huella de los criterios

- **Coincide con la registrada.** El SHA-256 de `docs/PROMOTION_CRITERIA.md` es
  `7967cb763d0a773e6e6ccf055afeea332c15c4f6ca883ba17e3304da79db7893`. Es el registrado en el ADR 0030 (§7), en
  `PROGRESS.md` y en `test/docs/frozen-criteria.test.ts` (en PASS), y el que EXP-0027 y EXP-0028 llevan en su salida.
- **No coincide con la del paso 27.** En el commit `a586f07` el archivo tenía
  `13c513bffaa23ad6e572ec1c8e4ecdd0bd5db15d1789417fda940ab1dea336d7` (comprobado hoy).
  - La persona cambió los criterios el 2026-10-22, después de ver los resultados de la primera ronda y la auditoría (ADR
    0030, decisión 9; commit `cd3593d`).
  - Cambió cómo se miden A.3.2, A.3.5, A.3.6, A.3.9, A.3.11 y A.3.14, sin cambiar umbrales, y la validación se reinició.
  - EXP-0027 y EXP-0028 son las evaluaciones con el texto actual.
- **La decisión no depende de ese cambio.** Cada estrategia falla criterios cuyo texto no ha cambiado desde el paso 27
  (comprobado con el diff):
  - A: A.3.4 (caída del 20,5 %), A.3.7 (crisis de 2020) y el mínimo de 100 operaciones de A.3.5 (79);
  - B: A.3.7, A.3.8, A.3.10 y el mismo mínimo (38).

  Con el texto del paso 27 también serían `RECHAZADA`.

## 3. Evaluación contra `docs/PROMOTION_CRITERIA.md` (A.3)

| Criterio | A (EXP-0027) | B (EXP-0028) |
|---|---|---|
| A.3.1 Fuera de muestra | PASS: 10 tramos, 8 positivos | PASS: 10 tramos, 7 positivos |
| A.3.2 Deflated Sharpe | **FAIL**: 0,482 (`N` = 153) y 0,391 (`N` = 237) | **FAIL**: 0,139 (`N` = 76) y 0,074 (`N` = 237) |
| A.3.3 Costes ×2 | PASS: Sharpe 1,42 y P&L de 2709 EUR | PASS: Sharpe 0,18 y P&L de 17 EUR |
| A.3.4 Caída | **FAIL**: 20,5 % (máximo 10 %); límite superior del IC, 29,6 % (máximo 20 %) | PASS: 1,4 % |
| A.3.5 Muestra | **FAIL**: 79 operaciones (mínimo 100) | **FAIL**: 38 operaciones; MinTRL de 6787 periodos frente a 3559 |
| A.3.6 PBO | PASS: 0,039 en la ronda | PASS: 0,039 en la ronda, gracias a la tendencia (0,898 en su familia, que no decide) |
| A.3.7 Estrés | **FAIL**: crisis de 2020, +1,4 % frente al +2,1 % de BTC | **FAIL**: con retraso de una vela, Sharpe −0,03; en la crisis de 2020, sin operaciones |
| A.3.8 Parámetros | PASS: meseta, de 1,36 a 1,50 | **FAIL**: cambia de signo con `rsiEntry` −50 % |
| A.3.9 Regímenes | **FAIL**: en el bajista de 2022 pierde el 52 % de lo que pierde su benchmark (máximo 50 %) | **FAIL**: captura el 4,0 % del alcista (mínimo 25 %) |
| A.3.10 Buy-and-hold | PASS: Sharpe 1,47 y Calmar 1,01, frente a 0,99 y 0,65 de BTC y 1,14 y 0,90 del equiponderado | **FAIL**: Sharpe 0,41 y Calmar 0,29, frente a 0,99 y 0,65 de BTC |
| A.3.11 IC | PASS: límite inferior de 0,76 | **FAIL**: límite inferior de −0,26 |
| A.3.12 Control aleatorio | PASS: percentil 99,9 | PASS: percentil 96,0 |
| A.3.13 Sin lo mejor | PASS: 1,13 sin 2017 y 1,26 sin ETH | PASS: 0,27 sin 2025 y 0,15 sin ETH |
| A.3.14 Ablación y universo alternativo | PASS | PASS |
| A.3.15 Pruebas de humo | PASS | PASS |

Las cifras y su cálculo están en los informes de cada experimento (§6 a §10).

## 4. Por qué no se reajustan los criterios después de verlos

- **Se fijaron antes de mirar** (paso 27, ADR 0030) para que el resultado no pueda elegirlos. Un criterio ajustado a un
  resultado conocido deja de ser una prueba: cualquier estrategia pasa un criterio hecho a su medida (`quant-research`
  §1).
- **Ya cambiaron una vez a la vista de resultados** (ADR 0030, decisión 9). Lo decidió la persona, con la contaminación
  declarada: cambió cómo se mide, no los umbrales, y la validación se reinició. Otro cambio, ahora dirigido a los
  criterios que fallan, sería justo el ajuste que los criterios impiden.
- **El 52 % frente al 50 % de A.3.9 en 2022 (A):**
  - la comparación más exigente y su umbral los aprobó la persona antes de calcular A con ellos (ADR 0042), y se
    validaron con caminos sintéticos de otra semilla, sin calcular A ni B;
  - dos puntos en un solo episodio están dentro del ruido, y eso vale en los dos sentidos: tampoco demuestran que A sea
    defensiva en bajista;
  - aunque A.3.9 pasara, A seguiría `RECHAZADA` por otros cuatro criterios: un DSR de 0,391 a 0,482 frente a 0,95, una
    caída del 20,5 % frente al 10 %, 79 operaciones frente a 100 y la crisis de 2020. Para que pasara habría que relajar
    cinco criterios, entre ellos el que corrige por las 237 pruebas.
- **La crisis de 2020 (A.3.7, las dos).** La auditoría señaló que exige ganar a BTC en una ventana en la que BTC acaba
  subiendo (Q-05), y la persona la mantuvo como convención conservadora (ADR 0031). Cambiarla ahora sería hacerlo a la
  vista de un fallo.
- **Tampoco se tocan los márgenes estrechos que pasan.** B pasa A.3.12 con el percentil 96,0, y A.3.6 gracias a la
  tendencia (0,898 dentro de su familia). Así funciona el texto congelado, y B falla siete criterios.
- **Contaminación.** Claude y la persona conocen EXP-0025 a EXP-0028. Cualquier criterio nuevo se escribiría sabiendo
  la respuesta (`quant-research` §12).
- **Cambiarlos es una parada obligatoria que reinicia la validación** (cabecera de `docs/PROMOTION_CRITERIA.md`;
  `CLAUDE.md` §7). La persona no lo pide.

## 5. Decisión de la persona y parte C

La parte C de `docs/PROMOTION_CRITERIA.md` dice que, si nada llega a PAPER, se hace una segunda ronda (C.1) y que, si
tampoco hay evidencia, se para el trading activo (C.2). La persona decide, con los resultados de EXP-0027 y EXP-0028:

1. **Ninguna estrategia cumple los criterios congelados, y no se activa la segunda ronda.** Se para sin probar
   Breakout, Cross-Sectional Momentum ni Price + Volume Momentum. No cambia el texto congelado ni relaja ningún
   criterio: nada se promociona, y parar es más conservador que seguir probando.
2. **Se para el desarrollo de trading activo** (C.2.1). No se empiezan los pasos de ejecución real del tramo 2 para
   estrategias activas, y el código de research y los registros se conservan tal cual. El tramo 2 solo se abría si el
   paso 31 aprobaba alguna estrategia (`docs/progress/PLAN_MAP.md`, registro de trabajo privado, no publicado).
3. **El proyecto sigue por el plan B:** el paso 41B en versión local y después los pasos 49 a 52. Su contenido lo fija
   la persona al pegar el prompt de cada paso.
4. **Comprobación hacia delante de A** ([ADR 0043](adr/0043-comprobacion-hacia-delante-de-a.md)), como parada obligatoria
   aprobada por la persona.
   - Congelada hoy, con la especificación exacta de EXP-0027 y un tramo más.
   - Su configuración se eligió en train ese mismo día, con datos de research ([EXP-0029](research/experiments/EXP-0029.md),
     ADR 0044): `entryPeriod` 55 y `exitPeriod` 10. El trabajo previo y la ejecución van en el paso 53, después del
     2027-10-01.
   - Se ejecuta una sola vez, con los datos del 2026-10-01 al 2027-10-01, después del 2027-10-01 y con el desbloqueo del
     ADR 0020.
   - Sus criterios, fijados hoy: los de coherencia de la etapa 2 sobre el año, ganancia neta y Sharpe > 0, y caída
     dentro de lo esperado (≤ 10 %).
   - Solo puede servir para decidir si se abre una investigación nueva, nunca para operar, y no cuenta como promoción.

**Lo que la parte C prevé y no se hace:**
- **C.1, la segunda ronda.** Si algún día se abre una investigación nueva, la vía sigue siendo la parte C: la segunda
  ronda con sus reglas, o un ADR aprobado por la persona (C.2.3). En los dos casos, `N` cuenta todo lo anterior.
- **C.2.2, documentar la alternativa pasiva** (buy-and-hold o DCA). Al aprobar el paso 31, la persona pidió
  documentarla como conclusión del plan B: está en §10, de forma factual y sin recomendación personal.

## 6. El test final

- **No se desbloquea en el paso 31:** ninguna estrategia supera los criterios.
- **Lo usará una vez la comprobación hacia delante de A,** después del 2027-10-01 y con el desbloqueo que firma la
  persona. Al hacerlo, el periodo queda examinado, y cualquier estrategia futura necesitará otro periodo hacia delante
  (ADR 0043, «Consecuencias»).

## 7. Registro

**Experiment Registry** (`docs/research/experiments/registry.jsonl`). La decisión consta en el veredicto de cada cierre.
No hay Strategy Registry (paso 34; regla de la persona del paso 25), y el registro no tiene otro tipo de línea.

| Línea | Experimento | Estado | SHA-256 de la línea | `hash_salida` |
|---|---|---|---|---|
| 53 | EXP-0027 | `registrado` | `d5efcd0de7f86eccbb97c3c3f3ad67a526919bc8adf1576f7c5a810fb53d409a` | — |
| 54 | EXP-0028 | `registrado` | `2962a9c6c2067ba80b1561620f04cf57ff505534941b5957630ce1e740825ce2` | — |
| 55 | EXP-0027 | `completado`, `RECHAZADA` | `6c76b7ed197770b01874899f6b7d1a289745d7eef15b2c6807c72b88968a870e` | `35938e022e32db6d3027d61cca700671bebcfab924a795f129b7c3c45e2b6edc` |
| 56 | EXP-0028 | `completado`, `RECHAZADA` | `1a272ed4f23c8a0d5a79f74bf9edb28f44c7179e2efd77270de8d7b5e8a78cdb` | `d09290da44cb1e4bcac8a8ceeec53bc1ca11b07a58cb6b5cd966d1bf9a1395d3` |

- La cadena está comprobada: cada línea lleva el SHA-256 de la anterior.
- Salidas completas: `docs/research/experiments/salidas/EXP-0027.json` y `EXP-0028.json`.
- Código: commit `3ad406b966200e436184dd5b98f1952e06948940`. Datos: Kraken diario en EUR, hash `677d5fee…`.

## 8. Qué no demuestra esta decisión

- **Que la tendencia o la reversión no existan en cripto.** Solo que estas dos reglas no muestran evidencia robusta,
  con estos datos diarios de Kraken, este universo y los límites de Risk.
- **Nada sobre el rendimiento futuro** de ninguna estrategia ni de ninguna alternativa.
- **Nada limpio sobre el universo.** El universo de diseño se eligió a mano y a posteriori, con el sesgo de supervivencia
  declarado (Q-04, ADR 0040).

## 9. Lo que sigue vigente

- **No se opera en real.** El bot que arranca hoy es el código previo, que no pasa por `risk/` ni `execution/`.
  `LIVE_TRADING=false` por defecto y nada de esta decisión lo cambia.
- **Los riesgos de `PROGRESS.md`,** sin cambios.
- **Los compromisos de los pasos del tramo 2 quedan en espera.** Solo se activan si una investigación nueva aprueba
  alguna estrategia.

## 10. Conclusión del plan B: la alternativa pasiva (C.2.2)

**Esto no es asesoramiento financiero ni una recomendación personal.** Claude no es un asesor financiero autorizado.
Es la conclusión que la parte C de `docs/PROMOTION_CRITERIA.md` pide documentar al parar el trading activo: qué dice la
evidencia del proyecto sobre las dos alternativas pasivas. Aplicar alguna, y cómo, es decisión de la persona.

**Qué son:**
- **Comprar y mantener** (buy-and-hold): comprar una vez y no volver a operar.
- **DCA** (promediado): aportar una cantidad fija a intervalos fijos, sin vender. Su variante condicionada solo compra
  si BTC está por encima de su media de 200 días, y si no se queda en liquidez.

**Lo que tiene el proyecto:**

| Fuente | Alternativa | Resultado | Caída | Calidad de la evidencia |
|---|---|---|---|---|
| Primera ronda (EXP-0027 y EXP-0028): fuera de muestra, de 2017 al 2026-09-29, por tramos anuales y con los costes del modelo | Comprar y mantener BTC | Sharpe 0,99 y Calmar 0,65 | Máxima del 84,6 % | Con protocolo, pero es el benchmark, no una estrategia evaluada con los criterios |
| La misma | Comprar y mantener BTC y ETH a partes iguales | Sharpe 1,14 y Calmar 0,90 | No informada | Igual, y con el universo elegido a posteriori (Q-04) |
| `docs/research/02` §1.7 (prueba previa EXP-0014) | Comprar y mantener BTC desde marzo de 2018 | Crecimiento anual compuesto del 26,1 % | Máxima del 76,6 % | Previa: sin protocolo, con datos de Binance y no reproducible |
| La misma | Largo o en liquidez según la SMA 200 de BTC | 26,7 % anual | Máxima del 64,4 % | Previa |
| `docs/research/02` §1.4 (prueba previa EXP-0018) | DCA semanal en BTC desde marzo de 2018 | 5,12 veces lo aportado | En el peor momento, un 53 % por debajo de lo aportado | Previa |
| La misma | DCA condicionado a BTC por encima de su SMA 200 | 4,26 veces lo aportado | En el peor momento, un 25 % por debajo | Previa |
| Vanguard (2023), mercados tradicionales de 1976 a 2022 | Invertir de golpe frente a promediar | Invertir de golpe dio más en el 61,6 % al 73,7 % de los periodos | — | Externa ([enlace](https://corporate.vanguard.com/content/dam/corp/research/pdf/cost_averaging_invest_now_or_temporarily_hold_your_cash.pdf)) |

**Qué dice esta evidencia y qué no:**
- **Todo depende de que el activo suba a largo plazo.** Lo que dio el periodo examinado no dice nada del futuro, y no
  hay ningún periodo hacia delante ni test final para estas alternativas.
- **La caída es grande.** En el periodo examinado, comprar y mantener BTC llegó a perder entre el 77 % y el 85 % desde un
  máximo. El DCA reparte la entrada en el tiempo, pero no evita esa caída sobre lo que ya se ha invertido.
- **El DCA no mejora la rentabilidad esperada** frente a invertir de golpe (Vanguard). Reduce el riesgo de entrar en un
  mal momento y retrasa la exposición al riesgo.
- **El universo tiene sesgo de supervivencia.** BTC y ETH se eligieron sabiendo que siguen existiendo (Q-04, ADR 0040).
- **Las pruebas previas son orientación, no evidencia validada.** Se hicieron sin protocolo y constan en el registro
  como previas e invalidadas (EXP-0014 y EXP-0018).
- **Faltan costes.** Ninguna cifra incluye impuestos ni custodia. Las de la ronda sí incluyen comisión, spread y
  slippage.
- **Las estrategias activas tenían menos caída** (A, un 20,5 %), pero ninguna pasa los criterios (§1). Esa menor caída
  tampoco está validada.

**Lo que decide la persona:** si aplica alguna de estas alternativas o ninguna, cuál, con qué importe, frecuencia y
horizonte, y cómo custodia los activos. El proyecto no lo decide ni lo recomienda.
