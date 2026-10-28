# ADR 0042 — Regímenes de A.3.9 frente a un buy-and-hold factible y en crecimiento logarítmico

Fecha: 2026-10-21 · Estado: **aceptado por la persona** el 2026-10-21: B2, los umbrales y la condición por régimen sin
polvo. Era la parada de la parte 7 del plan de la auditoría, porque cambiar A.3.9 es cambiar un criterio congelado. La
condición está validada con caminos sintéticos nuevos («Validación»: V1 a V4 se cumplen). Se congela en la parte 9.

## Contexto

- **Q-02 (High) de la auditoría quant.** La captura ≥ 50 % del alcista de A.3.9 es inalcanzable con los límites de A.4.5
  e incompatible con la caída ≤ 10 % de A.3.4. Tiene dos causas:
  - el benchmark tiene todo el capital en BTC, y Risk limita la estrategia: 0,75 % de riesgo por operación, 25 % por par
    y 75 % en total;
  - la captura es un cociente de rentabilidades simples compuestas durante años y tramos, que crece con la exponencial
    del benchmark.
- **Lo que decidió la persona (2026-10-20,** `docs/progress/DECISIONS.md`**):**
  - un benchmark buy-and-hold con las mismas restricciones de Risk;
  - la captura medida en términos logarítmicos;
  - comprobar con datos sintéticos que los umbrales son alcanzables antes de congelarlos.

  Se aplica a todas las familias, con ADR, reiniciando la validación y con la contaminación declarada. Los umbrales se
  fijan sin mirar los números de EXP-0025 ni de EXP-0026, y la propuesta se enseña antes de congelarla.
- **Q-05 se mantiene:** A.3.7 no cambia.

## Propuesta

1. **El benchmark de A.3.9 es BTC con la exposición que Risk dio a la estrategia.**
   - Es el buy-and-hold de BTC con todo el capital, escalado periodo a periodo por la exposición e de la estrategia: en
     cada periodo gana e veces lo que gana aquel. Es la cartera que mantiene siempre la fracción e en BTC y el resto en
     liquidez: el «escalar por la exposición» del ADR 0027.
   - Tiene los mismos costes sobre esa fracción (la compra al empezar cada tramo y la venta al acabarlo) y los mismos
     reinicios por tramo.
   - e es la exposición de las posiciones entre el patrimonio en las marcas de toda la serie fuera de muestra, con la
     media ponderada por la propia exposición. Con posiciones de tamaño fijo es ese tamaño, y no pesan ni las marcas sin
     posición ni un resto en polvo, que el backtester cuenta en la exposición (ADR 0033).
   - **Por qué cada periodo y no comprar la fracción e al empezar el tramo.** Un buy-and-hold que no se reequilibra sube
     su exposición en los alcistas. Con e igual a la exposición media de una posición que crece, empezaría por encima del
     tamaño de entrada, y una estrategia que no sale nunca capturaría bastante menos que su propio benchmark.
   - **Por qué esa exposición y no la máxima de los límites.** Con stops de varios ATR, el límite de A.4.5 que manda es
     el riesgo por operación, no los topes.
     - Con un stop del 7 % y costes de ida y vuelta del 0,6 %, Risk da 0,75 % / 7,6 % ≈ 10 % del patrimonio por
       entrada. Llegar al tope del 25 % exige un stop por debajo del 2,4 %.
     - Un buy-and-hold no tiene stop. Escalado al tope, deja la captura de una estrategia dimensionada por riesgo en unas
       10/25 = 0,4 veces su participación, y el 50 % sigue fuera de su alcance: el mismo falso negativo de Q-02, más
       pequeño.
     - Con la misma exposición, A.3.9 mide lo que dice la hipótesis de cada familia (cuándo está dentro y cuándo fuera),
       no el tamaño que le deja Risk. Es lo mismo que hace el Sharpe de A.3.10, que no depende de la parte invertida.
   - **Sin ninguna posición en toda la serie,** no hay exposición: el bajista y el alcista quedan `NO CONCLUYENTE`.
2. **Se compara el crecimiento logarítmico.** En cada episodio bajista y en los periodos alcistas se compara ln(1 + r) de
   la estrategia con el del benchmark, con r la rentabilidad compuesta en esos periodos:
   - **bajista:** si el benchmark cae, ln(1 + r_e) ≥ X · ln(1 + r_b) («pierde ≤ X %»); si no cae, la estrategia no
     puede perder, como hoy;
   - **alcista:** si el benchmark sube, ln(1 + r_e) ≥ X · ln(1 + r_b) («captura ≥ X %»); si no sube, la estrategia no
     puede perder, como hoy.

   El crecimiento logarítmico se suma entre periodos y tramos, así que no crece con la exponencial de varios años como
   el cociente de rentabilidades compuestas.
3. **El lateral no cambia.** Es un umbral absoluto (pérdida anualizada ≤ 5 % o rentabilidad ≥ 0 %), no una comparación
   con BTC.
4. **Los umbrales son los congelados** de la tabla A.3.9, si el estudio sintético muestra que son alcanzables. Si alguno
   no lo es, se enseña con su evidencia y no se ajusta por su cuenta.
5. **A.3.7 no cambia** (Q-05 se mantiene): sus ventanas de crisis siguen comparando con el buy-and-hold de BTC con todo
   el capital.

## Estudio sintético

El diseño queda fijado aquí antes de ejecutarlo. Comando: `node scripts/regimenes-alcanzables.ts`.

- Solo datos sintéticos con semilla: no lee datos reales ni el registro.
- Usa el mismo código que el evaluador: `regimeMeasures`, `regimeStatuses` y `regimen-precio@1`.

**Mercado.**
- Un BTC sintético diario de 2015 a 2025, con log-rentabilidades t de Student de 5 grados de libertad y una desviación
  típica diaria del 3,5 %.
- Deriva anual en log: +0,8 en alcista, −1,0 en bajista y 0 en lateral.
- Calendario fijo:
  - 2015, lateral: calentamiento del régimen;
  - 2016 y 2017, alcistas; 2018, bajista; 2019, lateral;
  - 2020 y 2021, alcistas; 2022, bajista; 2023, lateral;
  - 2024, alcista; 2025, lateral.

  Los bajistas caen en 2018 y 2022 para usar los episodios de A.3.9 tal como están.
- 400 caminos.

**Medida.** Diez tramos de validación de un año, de 2016 a 2025. Las etiquetas son las de `regimen-precio@1` sobre el BTC
sintético, point-in-time, como en un experimento.

**Estrategias sintéticas.**
- **Base común:**
  - un solo par;
  - entra con una fracción x del patrimonio y paga un 0,35 % por lado: comisión taker del 0,25 %, slippage del 0,05 % y
    medio spread del 0,05 %.
- **Ventaja, fijada de antemano:** estar dentro una fracción del tiempo que depende del régimen real del camino (la
  participación), en rachas de duración media D días.
  - **Tendencia con ventaja:** dentro el 80 % del alcista, el 50 % del lateral y el 20 % del bajista, con D = 30.
    - x = 0,10: el 0,75 % de riesgo con un stop del 7 % y costes del 0,6 %;
    - x = 0,25: el tope por par.
  - **Reversión con ventaja:** 35 %, 30 % y 5 % («poco tiempo en mercado», y fuera en bajista por su filtro), con D = 5
    y x = 0,10. Mientras está dentro gana sobre BTC los rebotes de su hipótesis: dos veces sus costes de ida y vuelta en
    cada racha, un 0,28 % al día.
  - **Sin ventaja:** el mismo tiempo en mercado que cada una de las dos anteriores, sin depender del régimen.
- **Curvas, con x = 0,10 y D = 30:**
  - la participación en alcista de 0,2 a 1, con el resto al 50 %;
  - la participación en bajista de 0 a 0,6, con el resto al 50 %;
  - una estrategia que solo está dentro con la etiqueta `ALCISTA`: el techo de la medida.

**Tres medidas.**
- **Congelada:** rentabilidades compuestas frente a BTC con todo el capital.
- **B1:** escalada al tope de los límites, el 25 % con un par.
- **B2, la propuesta:** la exposición media de la estrategia en mercado.

B1 y B2 comparan en logaritmos.

**Criterios fijados antes de ejecutarlo.**
- **Alcanzable:** la estrategia con la ventaja de su hipótesis pasa el umbral con una probabilidad ≥ 50 %.
- **Discrimina:** la estrategia sin ventaja pasa A.3.9 con, como mucho, la mitad de esa probabilidad.
- **Compatible con A.3.4:** la de tendencia con ventaja (x = 0,10) pasa A.3.9 y una caída máxima ≤ 10 % de la serie con
  una probabilidad ≥ 50 %.
- **Cross-Sectional (≥ 100 %)** solo se alcanza con activos que crezcan más que BTC. Con una participación p, su
  crecimiento logarítmico tiene que ser 1/p veces el de BTC. No se simula la selección.

**Antes de fijarlo.** Se ejecutó con 3 caminos solo para comprobar que corría, y salieron dos fallos del diseño, que se
corrigieron:
- el benchmark compraba la fracción e al empezar el tramo y la mantenía. Una estrategia siempre dentro en alcista, que
  es ese mismo buy-and-hold a su tamaño de entrada, capturaba un 58 % de su propio benchmark;
- la reversión no tenía ventaja en mercado, que es lo que dice su hipótesis, y con rachas de 5 días solo pagaba costes.

## Resultados

Una sola ejecución con el diseño fijado (commit `36baae9`): 400 caminos en 9 minutos. Cada porcentaje tiene un error
típico de unos 2,5 puntos.

**Alcista, según la participación en alcista** (x = 0,10, rachas de 30 días y el resto al 50 %):

| Participación | Captura mediana: congelada · B1 · B2 | B2: P(≥ 25 %) · P(≥ 50 %) · P(≥ 100 %) |
|---|---|---|
| 0,2 | 0,003 · 0,066 · 0,152 | 34,8 % · 12,5 % · 1,5 % |
| 0,4 | 0,007 · 0,158 · 0,362 | 62,7 % · 29,5 % · 4,8 % |
| 0,6 | 0,015 · 0,246 · 0,551 | 82,0 % · 56,8 % · 8,0 % |
| 0,8 | 0,027 · 0,350 · 0,773 | 94,5 % · 84,8 % · 21,0 % |
| 1 | 0,073 · 0,742 · 1,044 | 96,5 % · 95,5 % · 56,3 % |
| Solo con la etiqueta `ALCISTA` | 0,065 · 0,606 · 0,845 | 96,5 % · 94,8 % · 15,8 % |

**Bajista, según la participación en bajista** (2018 y 2022 juntos, con el resto al 50 %):

| Participación | Fracción de la pérdida mediana: congelada · B1 · B2 | B2: P(pierde ≤ 25 %) · P(≤ 50 %) |
|---|---|---|
| 0 | 0 · 0 · 0 | 100 % · 100 % |
| 0,1 | 0,011 · 0,031 · 0,079 | 74,8 % · 86,8 % |
| 0,2 | 0,031 · 0,079 · 0,192 | 58,4 % · 77,9 % |
| 0,4 | 0,063 · 0,172 · 0,417 | 34,1 % · 59,1 % |
| 0,6 | 0,091 · 0,243 · 0,595 | 21,1 % · 38,8 % |

**A.3.9 por familia, con B2.** Entre paréntesis, la medida congelada. La última columna exige además la caída máxima ≤ 10 %
de A.3.4.

| Estrategia | Perfil | Bajista 2018 · 2022 | Alcista | Lateral | A.3.9 | Y caída ≤ 10 % |
|---|---|---|---|---|---|---|
| Tendencia con ventaja, x = 0,10 | Tendencia y Breakout | 76,8 % · 73,5 % (97,8 % · 96,5 %) | 84,3 % (7,0 %) | 97,3 % | 49,3 % (6,5 %) | 20,8 % (1,3 %) |
| | Price + Volume | igual | igual | 77,3 % | 39,8 % (5,5 %) | 18,8 % (1,3 %) |
| | Cross-Sectional | igual | 17,8 % (6,8 %) | 97,3 % | 11,5 % (6,3 %) | 4,5 % (1,3 %) |
| Tendencia con ventaja, x = 0,25 | Tendencia | 76,8 % · 74,3 % (96,0 % · 96,0 %) | 82,5 % (12,8 %) | 91,3 % | 42,8 % (11,5 %) | 0 % (0 %) |
| Sin ventaja, 59 % dentro | Tendencia | 39,8 % · 40,5 % (98,0 % · 96,5 %) | 51,7 % (4,0 %) | 96,8 % | 10,0 % (4,0 %) | 3,5 % (0,3 %) |
| Reversión con ventaja, x = 0,10 | Reversión | 87,0 % · 84,5 % (97,0 % · 96,8 %) | 95,5 % (14,5 %) | 87,0 % | 62,3 % (12,5 %) | 60,5 % (11,8 %) |
| Sin ventaja, 27,5 % dentro | Reversión | 29,0 % · 34,3 % (94,3 % · 95,0 %) | 18,0 % (2,0 %) | 41,8 % | 1,0 % (0,8 %) | 0,5 % (0 %) |

- **Con B1 y x = 0,10,** la tendencia con ventaja pasa el alcista en un 13,0 % de los caminos y A.3.9 en un 11,5 %; la
  reversión, en un 56,5 % y un 43,8 %. Con x = 0,25, B1 y B2 coinciden (A.3.9 en un 41,5 % y un 42,8 %).
- **Caída máxima ≤ 10 % de toda la serie, sin mirar A.3.9:**
  - tendencia con ventaja, en un 32,0 % de los caminos con x = 0,10 y en ninguno con x = 0,25;
  - sin ventaja, en un 12,5 %;
  - reversión con ventaja, en un 95,0 %, y sin ventaja, en un 20,0 %.
- **Exposición mediana del benchmark B2:** 0,107 con x = 0,10, 0,263 con x = 0,25 y 0,102 en la reversión. Las
  posiciones crecen algo por encima de su tamaño de entrada.

**Lectura, con los criterios fijados antes de ejecutarlo.**
- **La medida congelada es inalcanzable,** como dijo Q-02. Con participación completa, la captura mediana es del 7 %, y
  ninguna estrategia pasa el alcista en más de un 15 % de los caminos. Lo pasa casi igual con el 100 % que con el 50 %
  (6,8 % frente a 7,0 %), señal de que pasa cuando BTC apenas sube en esos periodos. Su bajista no falla casi nunca, así
  que no informa.
- **B1 deja el falso negativo** con el tamaño que da la regla de riesgo. Con x = 0,10, la captura es unas 0,4 veces la
  participación.
- **Con B2, la captura y la fracción de la pérdida miden la participación:** la mediana es casi la fracción del tiempo
  dentro.
- **Alcanzable: sí, salvo Cross-Sectional.** La estrategia con la ventaja de su hipótesis pasa cada umbral con una
  probabilidad ≥ 50 %:
  - el alcista, en un 84 % la tendencia y en un 96 % la reversión;
  - cada bajista, entre un 73,5 % y un 87 %;
  - el lateral, entre un 77 % y un 97 %.

  A.3.9 entero lo pasa en un 49 % la tendencia, en un 40 % con el lateral de Price + Volume y en un 62 % la reversión.
  Cross-Sectional (≥ 100 %) no se alcanza solo estando dentro (18 %): necesita activos que crezcan más que BTC, como
  dice su hipótesis, y la selección no se simuló.
- **Discrimina: sí.** Sin ventaja y con el mismo tiempo en mercado, A.3.9 pasa en un 10 % de los caminos (tendencia) y
  en un 1 % (reversión): menos de la mitad que con ventaja.
- **Compatible con A.3.4: no, con x = 0,10 en este mercado sintético.** La tendencia con ventaja pasa A.3.9 y la caída
  ≤ 10 % a la vez en un 21 % de los caminos, por debajo del 50 % fijado.
  - Lo que falla es la caída: sin mirar A.3.9 solo la cumple un 32 % de los caminos, y con x = 0,25, ninguno.
  - Con B2, A.3.9 ya no depende del tamaño y la caída baja con él. Desaparece así la incompatibilidad que describía
    Q-02: capturar el 50 % ya no exige estar invertido al 50 %.
  - Lo que queda es lo exigente que es A.3.4 con diez años de la volatilidad de BTC. No forma parte de Q-02 y aquí no se
    propone cambiarlo.

## Lo que decidió la persona (2026-10-21)

- **B2,** el benchmark con la exposición de la propia estrategia. Antes de congelar, una comprobación con datos sintéticos
  y sin cambiar umbrales: que una estrategia que se queda fuera durante la mayor parte de los periodos alcistas no puede
  pasar A.3.9 gracias a que su benchmark escalado sea casi nulo. Si puede, Claude propone por principio la condición
  mínima de participación que lo impida y la enseña.
- **Se mantienen los umbrales congelados** de la tabla A.3.9, también el 100 % de Cross-Sectional, con el compromiso de
  «Consecuencias».
- **Q-02 no toca A.3.7** (Q-05 se mantiene) **ni A.3.4.** A y B se repiten como estaban pre-registradas, y no se calculan
  con la medida nueva hasta que los criterios estén congelados.

## Comprobación de participación

El diseño queda fijado aquí antes de ejecutarla. Son los bloques 4 y 5 de `node scripts/regimenes-alcanzables.ts`, con los
mismos 400 caminos y la medida B2.

**Estrategias fuera de la mayor parte del alcista.**
- Participación en alcista de 0,2 y 0,4 con el perfil de tendencia (≥ 50 %), y de 0,1 y 0,2 con el de reversión (≥ 25 %).
- Fuera del alcista están dentro el 90 % del tiempo, con rachas de 30 días. Las rachas de cada camino son las mismas con
  todos los tamaños.
- Cinco tamaños, que son la única diferencia:
  - 0,10 en todo: la referencia;
  - 0,001 en todo: el benchmark casi nulo;
  - 0,10 en alcista y 0,001 fuera: polvo fuera del alcista;
  - 0,10 en alcista y 0,03 o 0,05 fuera: posiciones pequeñas, pero reales, fuera del alcista.

**Condición candidata, fijada aquí por principio.**
- En los periodos alcistas, la captura tiene que ser también ≥ X frente a BTC escalado por la exposición que la
  estrategia tuvo en esos mismos periodos, con la misma media ponderada.
- Sin posición en ellos no añade nada: la captura frente a la exposición de toda la serie ya falla si BTC subió.
- Para una estrategia que, cuando está dentro, gana lo mismo que BTC, equivale a estar dentro al menos una fracción X del
  alcista. Una que gana más que BTC cuando está dentro (rebotes, selección) puede estar dentro menos tiempo.
- Se informa también de la misma condición en cada bajista, con la exposición de ese episodio.

**Criterios fijados antes de ejecutarla.**
- **Hueco:** con algún tamaño, el alcista pasa con B2 más de 5 puntos (unos dos errores típicos) por encima de la
  referencia con la misma participación.
- Si hay hueco, se propone la condición si cumple dos cosas:
  - con ella, ningún tamaño queda más de 5 puntos por encima de la referencia;
  - a ninguna estrategia con ventaja del estudio anterior le baja A.3.9 en más de 5 puntos (bloque 5).
- **Lo que no mide.** Con la referencia, una estrategia fuera de la mayor parte del alcista pasa a veces por el ruido de
  la medida: en el bloque 1, con participación 0,4, un 29,5 % pasa el umbral del 50 %. Eso no viene del escalado, y esta
  condición no lo quita.

**Resultados.** Una sola ejecución con el diseño fijado (commit `48d2b60`), con los mismos 400 caminos. Los bloques 1 a 3
salieron idénticos a la ejecución anterior.

En cada fila, el alcista con B2 · con la condición, y A.3.9 con B2 · con la condición · con la condición también en cada
bajista. «Fuera» es fuera del alcista.

| Perfil | Participación en alcista | Tamaño | Exposición B2 | Alcista | A.3.9 |
|---|---|---|---|---|---|
| Tendencia (≥ 50 %) | 0,2 | 0,10 en todo (referencia) | 0,102 | 8,0 % · 6,8 % | 0,3 % · 0,3 % · 0,3 % |
| | | 0,001 en todo | 0,001 | 7,8 % · 6,3 % | 0,3 % · 0,3 % · 0,3 % |
| | | polvo fuera | 0,103 | 12,3 % · 10,3 % | 12,3 % · 10,3 % · 0 % |
| | | 0,03 fuera | 0,067 | 22,3 % · 12,8 % | 12,3 % · 7,2 % · 0,3 % |
| | | 0,05 fuera | 0,070 | 18,8 % · 10,3 % | 1,8 % · 1,3 % · 0,3 % |
| | 0,4 | 0,10 en todo (referencia) | 0,104 | 27,5 % · 23,5 % | 0,5 % · 0,5 % · 0,5 % |
| | | 0,001 en todo | 0,001 | 28,7 % · 23,3 % | 0,8 % · 0,8 % · 0,5 % |
| | | polvo fuera | 0,107 | 32,8 % · 30,0 % | 31,3 % · 28,5 % · 0,3 % |
| | | 0,03 fuera | 0,079 | 50,5 % · 37,5 % | 37,8 % · 28,5 % · 0,5 % |
| | | 0,05 fuera | 0,079 | 49,0 % · 36,0 % | 7,2 % · 6,3 % · 0,5 % |
| Reversión (≥ 25 %) | 0,1 | 0,10 en todo (referencia) | 0,102 | 18,8 % · 16,3 % | 0,3 % · 0,3 % · 0,3 % |
| | | 0,001 en todo | 0,001 | 19,3 % · 16,0 % | 0,3 % · 0,3 % · 0,3 % |
| | | polvo fuera | 0,099 | 17,5 % · 16,8 % | 10,3 % · 9,5 % · 0 % |
| | | 0,03 fuera | 0,055 | 26,8 % · 19,8 % | 0 % · 0 % · 0 % |
| | | 0,05 fuera | 0,063 | 24,0 % · 20,0 % | 0 % · 0 % · 0 % |
| | 0,2 | 0,10 en todo (referencia) | 0,102 | 31,8 % · 28,2 % | 0 % · 0 % · 0 % |
| | | 0,001 en todo | 0,001 | 33,0 % · 29,8 % | 0,3 % · 0,3 % · 0,3 % |
| | | polvo fuera | 0,103 | 38,5 % · 36,0 % | 24,8 % · 23,3 % · 0,3 % |
| | | 0,03 fuera | 0,067 | 49,8 % · 40,3 % | 0,8 % · 0,8 % · 0,3 % |
| | | 0,05 fuera | 0,070 | 45,5 % · 39,5 % | 0,3 % · 0,3 % · 0,3 % |

La condición en las estrategias del estudio anterior (bloque 5):

| Estrategia | Perfil | Alcista | A.3.9 |
|---|---|---|---|
| Tendencia con ventaja, x = 0,10 | Tendencia | 84,3 % · 82,0 % | 49,3 % · 47,8 % · 38,8 % |
| | Price + Volume | 84,3 % · 82,0 % | 39,8 % · 38,5 % · 30,8 % |
| | Cross-Sectional | 17,8 % · 15,5 % | 11,5 % · 10,3 % · 7,8 % |
| Tendencia con ventaja, x = 0,25 | Tendencia | 82,5 % · 81,3 % | 42,8 % · 42,3 % · 38,0 % |
| Sin ventaja, 59 % dentro | Tendencia | 51,7 % · 48,3 % | 10,0 % · 10,0 % · 7,0 % |
| Reversión con ventaja | Reversión | 95,5 % · 95,5 % | 62,3 % · 62,3 % · 62,0 % |
| Sin ventaja, 27,5 % dentro | Reversión | 18,0 % · 17,8 % | 1,0 % · 1,0 % · 0,8 % |

**Lectura, con los criterios fijados antes de ejecutarla.**
- **Un benchmark casi nulo no abre ningún hueco.** Con todo a 0,001, el alcista pasa como la referencia, con
  diferencias de −0,2 a +1,2 puntos. La captura es un cociente que no depende del tamaño, y estar fuera no baja la
  exposición del benchmark, porque las marcas sin posición no pesan.
- **Sí hay hueco con tamaños distintos según el régimen.**
  - Con posiciones pequeñas, pero reales, fuera del alcista (0,03 y 0,05), la exposición del benchmark baja a
    0,055–0,079. El alcista pasa entre 5 y 23 puntos por encima de la referencia: con la tendencia y participación 0,4,
    un 50,5 % frente a un 27,5 %.
  - A.3.9 entero llega al 37,8 %, frente al 0,5 % de la referencia: el escalado también rebaja la pérdida en los
    bajistas, donde sus posiciones son pequeñas.
- **El polvo fuera del alcista no baja la exposición del benchmark** (0,099–0,107). El alcista pasa entre 1 punto menos
  y 7 más que la referencia (en dos filas, más de 5), pero no por el escalado. Fuera del alcista está de hecho fuera y no
  pierde en los periodos que la etiqueta, con su retraso, todavía llama alcistas.
- **La condición candidata, solo en el alcista, no cumple el criterio (a).**
  - Reduce el hueco (con 0,4 y 0,03 fuera, del 50,5 % al 37,5 %), pero deja hasta 14 puntos sobre la referencia.
  - Parte es el mismo efecto del polvo. Otra parte, que los periodos alcistas incluyen los que la etiqueta llama así con
    retraso, donde la estrategia tiene sus posiciones pequeñas y bajan su exposición.
  - Sí cumple el (b): a las estrategias con ventaja les quita como mucho 1,5 puntos de A.3.9.
- **La misma condición también en cada bajista no cumple el criterio (b).**
  - Deja A.3.9 de todas las trampas al nivel de la referencia (≤ 0,5 %).
  - Pero a la tendencia con ventaja le quita 10,5 puntos de A.3.9 (del 49,3 % al 38,8 %).
  - **Por qué:** con una sola exposición para toda la serie, B2 favorece a toda estrategia que compra y mantiene. Las
    posiciones crecen en el alcista y encogen en el bajista: su exposición en el alcista queda por encima de la media, y
    la del bajista por debajo. Eso infla la captura y rebaja la pérdida, y esos 10 puntos son el tamaño de ese sesgo.
  - **Un fallo propio:** cuenta el polvo como exposición. En un bajista con solo polvo la estrategia está de hecho fuera,
    pero se compara con un benchmark del tamaño del polvo y suspende. Por eso las filas de polvo bajan al 0–0,3 %.
- **Ningún candidato cumple los dos criterios fijados antes**, así que no se propone ninguno tal cual.

**Propuesta, para que decida la persona.**
- **Condición por régimen, en los dos lados:**
  - en el alcista y en cada bajista, A.3.9 compara también con BTC escalado por la exposición que la estrategia tuvo en
    esos mismos periodos, y vale la más exigente de las dos comparaciones;
  - esa exposición no cuenta el polvo (ADR 0033). Para eso la curva del backtester tiene que guardar la exposición sin
    polvo, que hoy no guarda: el ledger ya marca el polvo de cada posición;
  - sin una posición que no sea polvo en esos periodos, la condición no añade nada.
- **Qué significa.** Si la estrategia, cuando está dentro, gana lo mismo que BTC, tiene que estar dentro al menos una
  fracción X del alcista y como mucho una fracción X de cada bajista, cada uno con su propio tamaño. Tamaños distintos
  por régimen ya no cambian la medida, y desaparece el sesgo de las posiciones que crecen y encogen.
- **Evidencia y coste:**
  - en la comprobación, cierra el hueco: A.3.9 de las trampas con posiciones reales queda al nivel de la referencia;
  - a las estrategias con ventaja les quita lo que les daba ese sesgo: 10,5 puntos a la tendencia con x = 0,10, 4,8 con
    x = 0,25 y 0,3 a la reversión;
  - la exclusión del polvo no está probada todavía: el polvo sintético no lleva marca.
- **Si se aprueba:** se implementa con sus pruebas y se valida con caminos nuevos (otra semilla), con el diseño fijado
  antes, todo ello antes de la parte 9.
- **Alternativas:**
  - solo en el alcista: cuesta 1,5 puntos, pero deja el hueco del bajista y parte del del alcista;
  - una participación mínima en tiempo (dentro al menos en min(X, 50 %) de los periodos alcistas). Quita también los
    pases por ruido, pero castiga a quien acierta los mejores días (los rebotes de la reversión, la selección de
    Cross-Sectional), y depende de qué cuenta como «dentro» (polvo, retraso de la etiqueta);
  - B2 sin condición: se acepta el hueco y el sesgo, y lo frenan el pre-registro y el consultor.

## Condición por régimen: lo que aprobó la persona y cómo se mide

**La decisión (2026-10-21).**
- La condición por régimen en los dos lados, el alcista y cada bajista, sin contar el polvo. Compara también con BTC a la
  exposición que tuvo la estrategia en esos periodos, y se queda con la comparación más exigente.
- La curva del backtester guarda la exposición sin polvo, con pruebas.
- Se valida con caminos sintéticos nuevos, de semillas distintas de las del diseño, antes de la parte 9.
- **El valor de entrar y salir entre regímenes no lo mide A.3.9.** Lo evalúan otros criterios frente a buy-and-hold:
  A.3.10 (Sharpe y Calmar frente a BTC y al equiponderado, con todo el capital) y A.3.7 (las ventanas de crisis). A.3.9
  mide la participación en cada régimen, con el tamaño que tuvo la estrategia en él.

**Cómo se mide.**
- **La exposición de cada periodo** es la de las posiciones que no son polvo entre el patrimonio, en la marca que cierra
  el periodo.
  - Es la posición que dio su rentabilidad: lo que se decide en una marca se ejecuta dentro del periodo siguiente, a la
    apertura de su vela (ADR 0026).
  - El ledger ya marcaba el polvo de cada posición. Ahora la foto de la cartera y la curva llevan la exposición sin
    polvo (`exposureWithoutDust`), y `exposure` sigue con el polvo, para Risk.
  - Los informes usan lo mismo: si un periodo está en mercado (`inMarket`) sale de la marca que lo cierra y sin polvo, y
    el tiempo en mercado y la exposición media del resumen y de la ablación tampoco cuentan el polvo. No es un criterio,
    pero sale en los informes.
- **Exposición de toda la serie (B2):** la media de las de cada periodo, ponderada por la propia exposición, como antes,
  pero ya sin polvo.
- **Exposición de cada régimen:** la misma media, con los periodos que la etiqueta llama alcistas o con los de cada
  episodio bajista.
- **Comparación:** en el alcista y en cada bajista vale la más exigente de dos, frente a BTC escalado por la exposición
  de toda la serie y frente a BTC escalado por la del régimen. Si en esos periodos no hubo ninguna posición que no fuera
  polvo, decide solo la primera.
- **En el código:** `regimeMeasures` (`windows.ts`) da las dos comparaciones (`own`), y `regimeStatuses` (`criteria.ts`)
  se queda con la más exigente. El informe de A.3.9 da la exposición y la fracción logarítmica de cada régimen.
- **Los estudios sintéticos** comparten el mercado y las estrategias (`scripts/regimenes-sinteticos.ts`). El de diseño
  (`scripts/regimenes-alcanzables.ts`) sigue dando la misma salida, byte a byte.

## Validación

El diseño queda fijado aquí antes de ejecutarla. Comando: `node scripts/regimenes-validacion.ts`.

- **Caminos nuevos:** 400, con la semilla 2026-10-22 y flujos propios (`validacion-…`), distintos de los del diseño
  (2026-10-21). Mismo mercado sintético.
- **Se mide con el evaluador tal como queda:**
  - `regimeMeasures` y `regimeStatuses`, con la exposición sin polvo de cada periodo;
  - con B2 solo y con B2 y la condición por régimen.
- **Las trampas de la comprobación de participación:**
  - la misma participación en alcista (0,2 y 0,4 con la tendencia; 0,1 y 0,2 con la reversión), dentro el 90 % del
    resto del tiempo y las mismas rachas en cada camino;
  - tamaños: 0,10 en todo (la referencia), 0,001 en todo, 0,10 en alcista con 0,03 o 0,05 fuera, y 0,10 en alcista con
    polvo fuera;
  - en esta última, el polvo va marcado como tal, como lo marca ya el backtester: vale y gana, pero no cuenta en la
    exposición.
- **Las estrategias con ventaja y sin ella del estudio de diseño,** con sus mismos parámetros, por cada parte de A.3.9 y
  con la caída máxima de A.3.4.
- **Criterios fijados antes de ejecutarla:**
  - **V1, hueco cerrado:** con la condición, A.3.9 de las trampas con 0,001 en todo y con 0,03 o 0,05 fuera queda como
    mucho 5 puntos por encima de la referencia con la misma participación;
  - **V2, polvo:** con la condición, A.3.9 de la trampa con polvo fuera no baja más de 5 puntos frente a B2 solo, porque
    el polvo no cuenta como exposición;
  - **V3, alcanzable:** con la condición, la tendencia con ventaja (x = 0,10, perfil de tendencia) y la reversión con
    ventaja pasan cada parte de A.3.9 con una probabilidad ≥ 50 %;
  - **V4, discrimina:** con la condición, cada estrategia sin ventaja pasa A.3.9 como mucho la mitad de veces que la de
    ventaja de su perfil.
- **Se informa además** de lo que cuesta la condición a cada estrategia (B2 frente a la condición), junto a lo del
  diseño.
- **Si un criterio no se cumple,** se enseña a la persona y no se ajusta nada.

**Resultados.** Una sola ejecución con el diseño fijado (commit `2691e30`), en 98 segundos.

Trampas: en cada celda, B2 solo · con la condición.

| Perfil | Participación en alcista | Tamaño | Alcista | A.3.9 |
|---|---|---|---|---|
| Tendencia (≥ 50 %) | 0,2 | 0,10 en todo (referencia) | 6,0 % · 4,0 % | 0,5 % · 0,3 % |
| | | 0,001 en todo | 5,8 % · 4,0 % | 0,5 % · 0,3 % |
| | | polvo marcado fuera | 11,8 % · 10,3 % | 10,5 % · 9,0 % |
| | | 0,03 fuera | 20,0 % · 11,8 % | 12,3 % · 0,3 % |
| | | 0,05 fuera | 16,5 % · 9,5 % | 1,8 % · 0,3 % |
| | 0,4 | 0,10 en todo (referencia) | 24,5 % · 20,3 % | 0 % · 0 % |
| | | 0,001 en todo | 25,0 % · 20,0 % | 0,3 % · 0 % |
| | | polvo marcado fuera | 31,0 % · 28,2 % | 28,5 % · 25,8 % |
| | | 0,03 fuera | 47,3 % · 36,0 % | 33,0 % · 0 % |
| | | 0,05 fuera | 43,8 % · 33,3 % | 5,5 % · 0 % |
| Reversión (≥ 25 %) | 0,1 | 0,10 en todo (referencia) | 17,3 % · 16,0 % | 0,3 % · 0,3 % |
| | | 0,001 en todo | 17,5 % · 16,3 % | 0,3 % · 0,3 % |
| | | polvo marcado fuera | 15,8 % · 15,5 % | 10,8 % · 10,5 % |
| | | 0,03 fuera | 30,8 % · 23,3 % | 1,0 % · 0,3 % |
| | | 0,05 fuera | 26,5 % · 22,8 % | 0,3 % · 0,3 % |
| | 0,2 | 0,10 en todo (referencia) | 31,5 % · 28,7 % | 0,8 % · 0,8 % |
| | | 0,001 en todo | 32,3 % · 29,5 % | 0,8 % · 0,8 % |
| | | polvo marcado fuera | 36,0 % · 34,3 % | 24,0 % · 22,8 % |
| | | 0,03 fuera | 52,5 % · 43,5 % | 1,3 % · 0,8 % |
| | | 0,05 fuera | 47,5 % · 40,8 % | 0,8 % · 0,8 % |

Estrategias del estudio de diseño, con la condición; entre paréntesis, con B2 solo. La última columna exige además la
caída máxima ≤ 10 % de A.3.4.

| Estrategia | Perfil | Bajista 2018 · 2022 | Alcista | Lateral | A.3.9 | Y caída ≤ 10 % |
|---|---|---|---|---|---|---|
| Tendencia con ventaja, x = 0,10 | Tendencia | 70,0 % · 70,8 % (77,3 % · 76,5 %) | 80,3 % (82,5 %) | 99,3 % | 41,3 % (50,0 %) | 19,3 % (22,5 %) |
| | Price + Volume | igual | igual | 81,0 % | 34,5 % (42,3 %) | 17,8 % (20,8 %) |
| | Cross-Sectional | igual | 14,8 % (20,3 %) | 99,3 % | 8,5 % (13,0 %) | 2,3 % (4,5 %) |
| Tendencia con ventaja, x = 0,25 | Tendencia | 72,5 % · 73,3 % (77,0 % · 78,3 %) | 81,0 % (82,3 %) | 91,0 % | 41,5 % (47,3 %) | 0 % (0 %) |
| Sin ventaja, 59 % dentro | Tendencia | 31,5 % · 34,0 % (37,0 % · 41,0 %) | 47,8 % (53,3 %) | 97,0 % | 5,8 % (9,0 %) | 2,5 % (2,8 %) |
| Reversión con ventaja | Reversión | 83,3 % · 84,3 % (84,3 % · 84,5 %) | 94,3 % (94,3 %) | 90,0 % | 61,3 % (62,0 %) | 59,8 % (60,3 %) |
| Sin ventaja, 27,5 % dentro | Reversión | 30,8 % · 29,0 % (31,0 % · 29,0 %) | 15,8 % (15,8 %) | 44,8 % | 1,5 % (1,5 %) | 0,5 % (0,5 %) |

**Lectura, con los criterios fijados antes de ejecutarla.**
- **V1, hueco cerrado: se cumple.** Con la condición, las trampas con 0,001 en todo y con 0,03 o 0,05 fuera pasan A.3.9
  igual que la referencia (0–0,8 %). Con B2 solo, la de 0,03 fuera pasaba un 12,3 % y un 33,0 % con la tendencia.
- **V2, polvo: se cumple.** Con el polvo marcado, la condición baja A.3.9 de esa trampa entre 0,3 y 2,7 puntos frente a
  B2 solo. En el diseño, sin la marca, bajaba al 0–0,3 %.
  - Esa trampa sigue pasando entre un 9 % y un 26 %, pero no por el escalado. Está fuera de los bajistas (solo tiene
    polvo), y su alcista pasa por el ruido de la medida: algo más que el de la referencia (12–36 % frente a 6–32 %),
    porque no pierde en los periodos que la etiqueta, con su retraso, todavía llama alcistas.
- **V3, alcanzable: se cumple.** Con la condición, la tendencia con ventaja pasa cada parte en un 70,0–99,3 %, y la
  reversión, en un 83,3–94,3 %. A.3.9 entero: un 41,3 % y un 61,3 %.
- **V4, discrimina: se cumple.** Sin ventaja, A.3.9 pasa en un 5,8 % (tendencia) y un 1,5 % (reversión).
- **Coste de la condición,** parecido al del diseño: a la tendencia con ventaja le quita 8,7 puntos de A.3.9 (10,5 en el
  diseño), 7,8 con el lateral de Price + Volume (9,0), 4,5 a Cross-Sectional (3,7), 5,8 con x = 0,25 (4,8) y 0,7 a la
  reversión (0,3).
- **La condición queda validada.** Se congela en la parte 9 con el resto de A.3.9.

## Alternativas

- **Mantener la medida congelada.** Deja el falso negativo estructural de Q-02 en todas las familias.
- **B1, el tope de los límites:** 0,25 por par del universo, como mucho 0,75. Una estrategia dimensionada por riesgo con
  stops de varios ATR no llega al tope, así que su captura queda por debajo de su participación por construcción.
- **El BUY_AND_HOLD del ADR 0027 pasado por Risk.** Necesita un stop:
  - con uno ancho, Risk le da menos del 2 % del patrimonio y la comparación es trivial;
  - con uno estrecho, salta cada pocos días y deja de ser un buy-and-hold.
- **Captura como cociente de medias por periodo** (upside capture): la persona eligió los logaritmos.
- **Una exposición por régimen,** la de la estrategia en cada uno. Mide solo la participación, pero sin posición en un
  régimen no hay benchmark. Una sola exposición es más simple.
- **La media simple en las marcas con posición.** Un resto en polvo cuenta como posición en la curva: bajaría la
  exposición del benchmark y subiría la captura.

## Consecuencias

- **El evaluador ya mide B2 y la condición por régimen,** probados solo con datos sintéticos: B2 en `36baae9`, la
  exposición sin polvo en `8c88544` y la condición en el commit que añade «Condición por régimen».
- **Parte 9:** cambian el texto de A.3.9 («Cómo se mide») y sus notas, con la huella nueva del documento, la validación
  reiniciada y la contaminación declarada.
- **El bajista se endurece.** Hoy lo pasa cualquier estrategia dimensionada por riesgo: lo implica A.3.4 cuando BTC cae
  al menos un 20 %. Con la misma exposición, la estrategia tiene que estar fuera buena parte del bajista. En el estudio,
  la de tendencia con ventaja pasa cada bajista en un 73,5–77 % de los caminos, frente a un 96,5–98 % con la regla de hoy.
- **A.3.4 escala con el tamaño de las posiciones.**
  - En el estudio es lo que más limita a la tendencia: la cumple un 32 % de los caminos con x = 0,10 y ninguno con
    x = 0,25.
  - La caída máxima baja con la exposición, y A.3.9 ya no depende de ella. Un pre-registro futuro puede elegir un
    dimensionado más conservador para cumplir A.3.4, siempre que sus posiciones no caigan en la regla del polvo (por
    debajo del mínimo del mercado, 5 EUR; ADR 0033).
  - A.3.4 no se toca.
- **Cross-Sectional mantiene el 100 %, con un compromiso.** Antes de pre-registrarla en la segunda ronda (C.1), se hace un
  estudio sintético de alcanzabilidad con su ventaja de selección modelada. Si resulta inalcanzable incluso con ventaja,
  se revisa por principio antes del pre-registro (compromiso en `PROGRESS.md`).
- **A y B** se repiten como estaban pre-registradas (parte 10).
- **Límites:**
  - el benchmark tiene una exposición constante. El dimensionado por riesgo la baja cuando sube la volatilidad, sobre
    todo en los bajistas, y eso favorece algo a la estrategia;
  - la exposición sale de la propia estrategia. Una que agranda sus posiciones en alcista y las encoge en lo demás
    captura más con la misma participación. Es legítimo si lo dice su hipótesis pre-registrada; si no, lo tiene que ver
    el consultor.
- **Contaminación.** Claude conoce los números de EXP-0025 y EXP-0026, también los que cita la auditoría (su exposición
  media y su captura).
  - No se ha calculado qué darían A ni B con la medida nueva.
  - Los umbrales no cambian, y el estudio no usa sus datos.
  - La fracción x = 0,10 sale de la aritmética del riesgo por operación.
  - El estudio se fijó en un commit antes de ejecutarlo entero, y se ejecutó una vez.
