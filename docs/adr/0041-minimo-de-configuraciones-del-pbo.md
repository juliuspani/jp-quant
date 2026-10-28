# ADR 0041 — Mínimo de configuraciones del PBO

Fecha: 2026-10-21 · Estado: **aceptado por la persona** el 2026-10-21, después de ver la tabla de «Tabla pedida por la
persona». Era una parada de la parte 6 del plan de la auditoría, porque cambiar A.3.6 es cambiar un criterio congelado.
El evaluador ya lo aplica; el texto de A.3.6 se congela en la parte 9.

## Contexto

- A.3.6 (`docs/PROMOTION_CRITERIA.md`) dice: «con menos de 2 configuraciones, `NO CONCLUYENTE`».
- La auditoría quant (Q-06) vio que con pocas configuraciones el PBO está sesgado: la regla λ ≤ 0 cuenta la mediana
  exacta como sobreajuste. Con N configuraciones intercambiables, el PBO esperado es ⌊(N + 1)/2⌋/N: 0,667 con N = 3.
- La persona pidió proponer, con evidencia sintética, el número mínimo de configuraciones por debajo del cual el PBO es
  `NO CONCLUYENTE`, y verlo antes de congelarlo.

## Evidencia sintética

Estudio reproducible: `node scripts/pbo-minimo.ts` (21 min). Solo datos sintéticos, con semilla, sin datos reales ni
registro.

- **Diseño:**
  - CSCV con S = 16 y umbral de 0,20, los de A.3.6;
  - T = 3650 periodos, los diez años de validación diaria del walk-forward;
  - 200 matrices por celda, con rentabilidades normales equicorrelacionadas (ρ = 0; 0,5 y 0,9), porque los puntos de
    una rejilla se parecen.
- **Sin ventaja.** Ninguna configuración tiene ventaja: la elección en muestra es ruido, y un PBO < 0,20 es una
  aceptación falsa.
- **Con ventaja.** Una configuración tiene un Sharpe anual de 1 y las demás de 0; un PBO < 0,20 es un acierto (potencia).
- Con 200 matrices, cada porcentaje tiene un error típico de unos 2 puntos.

| N | PBO < 0,20 sin ventaja (ρ = 0 · 0,5 · 0,9) | PBO medio sin ventaja | PBO < 0,20 con ventaja (ρ = 0 · 0,5 · 0,9) |
|---|---|---|---|
| 2 | 20,5 % · 20,5 % · 18,5 % | 0,51 | 81 % · 96 % · 100 % |
| 3 | 8,0 % · 7,5 % · 11,0 % | 0,66 | 66 % · 96 % · 100 % |
| 4 | 13,0 % · 13,0 % · 13,0 % | 0,50 | 75 % · 98 % · 100 % |
| 5 | 9,5 % · 7,5 % · 8,5 % | 0,60 | 74 % · 98 % · 100 % |
| 6 | 14,0 % · 13,0 % · 12,5 % | 0,50 | 80 % · 98 % · 100 % |
| 7 | 5,5 % · 7,5 % · 6,0 % | 0,58 | 71 % · 95 % · 100 % |
| 8 | 8,5 % · 9,0 % · 6,5 % | 0,50 | 75 % · 95 % · 100 % |
| 10 | 11,0 % · 10,5 % · 7,5 % | 0,51 | 74 % · 96 % · 100 % |
| 12 | 10,5 % · 10,0 % · 9,5 % | 0,49 | 72 % · 97 % · 100 % |
| 16 | 6,0 % · 7,0 % · 7,5 % | 0,50 | 70 % · 93 % · 100 % |

- **Con N = 2, el PBO acepta por error una rejilla sin ventaja de cada cinco:** el doble que con cualquier N ≥ 3, unos
  cinco errores típicos por encima.
- **Desde N = 3, la aceptación falsa queda entre el 5,5 % y el 14 %,** sin una tendencia clara a bajar.
  - Con N impar es algo menor y el PBO medio, mayor: es la mediana contada como sobreajuste (Q-06), que el estudio
    confirma: 0,66 con N = 3, 0,60 con N = 5 y 0,58 con N = 7.
  - Ningún N la baja al 5 %.
- **La potencia** frente a una ventaja real y persistente es alta con configuraciones correlacionadas (≥ 93 %) y de un
  66 % a un 81 % sin correlación, sea cual sea N.

## Propuesta

1. **Con menos de 3 configuraciones, A.3.6 es `NO CONCLUYENTE`** (hoy, con menos de 2).
   - Por debajo de 3, el PBO no se distingue de una moneda al aire que acierta una de cada cinco veces.
   - Desde 3, añadir configuraciones no mejora el error de forma sistemática.
2. **Lo que el mínimo no arregla.** Con el umbral de 0,20, el PBO acepta entre un 6 % y un 14 % de las rejillas sin
   ventaja, sea cual sea N. Es un filtro entre varios (DSR, control aleatorio, IC, estabilidad), no una prueba al 5 %.
   - Cambiar el umbral o la regla de la mediana sería otro cambio de un criterio congelado. Aquí no se propone, porque no
     se pidió. Se deja a la vista.

## Tabla pedida por la persona (2026-10-21)

- **Lo que pidió:**
  - una tabla para k = 3, 5, 8, 12 y 20 configuraciones, con la probabilidad de PBO < 0,20 con una estrategia con
    ventaja y sin ella;
  - proponer el mínimo k en el que la de ventaja pase al menos la mitad de las veces y la sin ventaja como mucho un
    10 %, dentro del límite de 20 configuraciones por estrategia.
- **Diseño, fijado antes de ejecutarlo.** Es el mismo estudio de arriba con 1000 matrices por celda, para que cada
  porcentaje tenga un error típico de un punto cerca del 10 %.
  - Comando: `node scripts/pbo-minimo.ts 1000 3 5 8 12 20`.
  - Las 200 primeras matrices de cada celda son las del estudio anterior.
- **Criterio.** El mínimo k de la tabla que cumpla dos cosas en las tres correlaciones: PBO < 0,20 en al menos un 50 % de
  las matrices con ventaja, y en como mucho un 10 % de las que no la tienen. Si un k mayor de la tabla no lo cumple, se
  dice: un mínimo solo protege si los de encima también cumplen.
- **Resultados.** Una sola ejecución con el diseño fijado (commit `48d2b60`), en 26 minutos:

  | k | PBO < 0,20 sin ventaja (ρ = 0 · 0,5 · 0,9) | PBO medio sin ventaja | PBO < 0,20 con ventaja (ρ = 0 · 0,5 · 0,9) |
  |---|---|---|---|
  | 3 | 7,0 % · 7,4 % · 6,9 % | 0,67 | 66,9 % · 93,2 % · 100 % |
  | 5 | 8,9 % · 7,7 % · 7,7 % | 0,60 | 75,2 % · 94,6 % · 100 % |
  | 8 | 11,0 % · 10,3 % · 8,8 % | 0,50 | 74,3 % · 96,7 % · 100 % |
  | 12 | 8,1 % · 10,2 % · 8,4 % | 0,49 | 68,2 % · 96,0 % · 100 % |
  | 20 | 7,0 % · 6,5 % · 7,1 % | 0,49 | 57,6 % · 92,4 % · 100 % |

- **Lectura, con el criterio fijado antes.**
  - **El mínimo k que cumple es 3.** En las tres correlaciones, la estrategia sin ventaja pasa en un 6,9–7,4 % y la que
    tiene ventaja, en un 66,9–100 %. También cumplen 5 y 20.
  - **Con 8 y 12 no cumple, por poco.** La aceptación falsa llega al 11,0 % y al 10,3 % con k = 8 (ρ = 0 y 0,5), y al
    10,2 % con k = 12 (ρ = 0,5): a un punto o menos del 10 %, más o menos un error típico.
  - **La aceptación falsa no baja con k,** como ya mostró el estudio de 200 matrices: depende del umbral de 0,20 y de la
    regla de la mediana, no del número de configuraciones. Así que ningún mínimo la mantiene en el 10 % o menos con todos
    los k.
  - **La potencia baja con muchas configuraciones independientes:** con k = 20 y ρ = 0, un 57,6 %.
- **Propuesta después de la tabla:** el mínimo sigue en 3 configuraciones, dentro del límite de 20 por estrategia.
  Garantizar el 10 % con todos los k exigiría cambiar el umbral del PBO o la regla de la mediana, que son otro cambio de
  un criterio congelado. Aquí no se propone, pero queda a la vista.

## Decisión de la persona (2026-10-21)

- **Aprobado el mínimo de 3 configuraciones** para que el PBO decida A.3.6.
- **La tabla completa** es la de «Tabla pedida por la persona» (1000 matrices por celda), y la de «Evidencia sintética»
  (200 matrices) la acompaña.
- **El PBO por sí solo acepta una rejilla sin ventaja entre un 7 % y un 11 % de las veces, con cualquier k.** Es
  aceptable porque el PBO es uno de varios criterios que deben cumplirse a la vez (DSR, control aleatorio, IC del Sharpe,
  estabilidad, ablación), y fallar uno solo basta para `RECHAZADA`.

## Alternativas

- **Mantener el mínimo en 2.** Con N = 2, la aceptación falsa es del 20 %.
- **Un mínimo de 7, la N con menos aceptación falsa del estudio.** Con 8, 10 y 12 vuelve a subir: el mínimo de 7 viene
  de la paridad y del ruido del estudio, no de un principio.
- **Contar la mediana exacta como acierto.** Quita el sesgo de la paridad, pero es cambiar la definición del PBO de
  `quant-research` §8, que no se pidió.

## Consecuencias

- **El evaluador ya lo aplica** (`criteria.ts`, `THRESHOLDS.minPboConfigurations`). Con menos de 3 configuraciones, A.3.6
  es `NO CONCLUYENTE`: el PBO se calcula y se informa, pero no aprueba ni rechaza. `pboAcross` no cambia: sigue midiendo
  con 2.
- En la parte 9, A.3.6 de `docs/PROMOTION_CRITERIA.md` pasa a «con menos de 3 configuraciones, `NO CONCLUYENTE`», con
  la huella nueva del documento y la validación reiniciada.
- La matriz de la primera ronda tiene 7 configuraciones (4 de A y 3 de B), así que se mide.
