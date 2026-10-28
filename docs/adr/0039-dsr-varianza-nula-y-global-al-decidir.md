# ADR 0039 — Deflated Sharpe: la varianza de una prueba sin habilidad, y el global en el momento de decidir

Fecha: 2026-10-21 · Estado: aceptado (la persona lo pidió el 2026-10-20; el método, por principio, en modo autónomo, ADR
0011) · Auditoría quant, parte 5. Se fija antes de recalcular ningún DSR. Sustituye la V[SRₙ] del ADR 0029 y el DSR
global del ADR 0031.

## Contexto

- El DSR (`quant-research` §8) compara el Sharpe de una prueba con SR₀, el máximo esperado de N Sharpe sin habilidad:
  SR₀ = √V·((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))).
- Hasta ahora (ADR 0029 y 0031), N eran las pruebas registradas hasta la línea de pre-registro de la prueba. V era la
  varianza de los Sharpe con métricas cerrados antes, con un suelo de 1/(T − 1).
- La auditoría quant (Q-03) encontró tres problemas:
  - **El DSR global depende del orden.** La primera prueba de la ronda no ve los Sharpe de las siguientes, y la misma
    regla, aplicada después, cambia su estado.
  - **N y V salen de conjuntos distintos.** N cuenta todas las pruebas, también las previas y las variantes, y V solo
    unos pocos Sharpe.
  - **Con familias distintas, V mezcla** las diferencias reales entre estrategias con el ruido de estimación.
- La persona pidió calcular el DSR global sin depender del orden, con todas las pruebas del registro en el momento de
  decidir, y fijar antes, por principio, el método de la varianza.

## Decisión

1. **V es la varianza del Sharpe estimado de una prueba sin habilidad,** con la misma longitud T y la misma dependencia
   que la prueba evaluada.
   - **Cómo se calcula.** Es la varianza a largo plazo de sus rentabilidades estandarizadas (la función de influencia
     con SR = 0, ADR 0038), por T − 1, y nunca por debajo de 1/(T − 1).
   - **Por qué.** SR₀ es el máximo esperado de N Sharpe sin habilidad. Bajo esa hipótesis nula, el Sharpe estimado de
     una prueba de longitud T solo varía por el ruido de estimación, y su varianza es la de esa estimación. La dispersión
     observada entre pruebas mezcla eso con diferencias reales entre estrategias, que no son parte de la hipótesis nula.
     Además, depende de qué pruebas tienen métricas y de cuándo se cerraron.
   - **Valores.** Con rentabilidades independientes es 1/(T − 1), el suelo de antes; con autocorrelación positiva,
     mayor.
2. **N es el total del registro en el momento de decidir.** Es la suma de `n_pruebas` de todas las líneas de
   pre-registro, de todas las familias, con las previas, las fallidas, las abortadas, las invalidadas y las variantes.
   N trata las pruebas como independientes aunque muchas estén correlacionadas, y eso exagera SR₀: es lo conservador.
3. **El DSR global se calcula al decidir, no al cerrar cada prueba.**
   - Al cierre de un experimento, el DSR global de A.3.2 queda en `NO CONCLUYENTE` («se calcula en la decisión»), igual
     que el PBO entre familias (ADR 0032).
   - En la decisión se calcula a partir de la serie guardada de cada candidato, con la misma N para todos y el mismo
     método de V. Lo da `npm run pbo-ronda`, que pasa a dar también el DSR global.
4. **El DSR de la familia usa el mismo método de V.** Su N sigue siendo la de la familia hasta su pre-registro: dentro
   de la familia, cada prueba se juzga con lo que ya se había probado.
5. **Sin orden.** V no depende de qué otras pruebas tienen métricas, así que da igual en qué orden se cierren.

## Alternativas

- **La dispersión observada entre las pruebas con métricas** (como hacen en la práctica Bailey y López de Prado, 2014).
  Depende del orden y de qué pruebas guardan métricas. Con familias distintas mide diferencias entre estrategias, no el
  ruido de la hipótesis nula.
- **Un N efectivo por clústeres de pruebas correlacionadas** (López de Prado, 2019). Es más preciso, pero necesita la
  serie de cada prueba, y no la tienen las pruebas previas ni las anteriores al paso 27B. Contar todas las pruebas como
  independientes es la cota conservadora.
- **El máximo entre la varianza nula y la dispersión observada.** Vuelve a depender del orden y castiga mezclar familias
  por sus diferencias reales.

## Consecuencias

- El DSR global deja de cambiar con el orden de los experimentos: todos los candidatos de una decisión usan la misma N y
  el mismo método.
- Al cierre de un experimento, el DSR global de A.3.2 queda en `NO CONCLUYENTE` hasta la decisión, igual que A.3.6 con
  barrido. Por eso un experimento que pasara todo lo demás también queda en `NO CONCLUYENTE`.
- Los Sharpe que el ejecutor pasaba para calcular V dejan de usarse.
- Se fija antes de recalcular nada: al escribirlo, ningún DSR se ha recalculado con este método sobre datos reales.
- Las pruebas, con datos sintéticos, van con la implementación.
