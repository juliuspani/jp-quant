# ADR 0038 — Autocorrelación en el IC del Sharpe y en el Deflated Sharpe

Fecha: 2026-10-21 · Estado: aceptado (la persona lo pidió el 2026-10-20; el cómo, en modo autónomo, ADR 0011) ·
Auditoría quant, parte 4. Cambia la varianza del Sharpe estimado del ADR 0029 (PSR, DSR y MinTRL) y añade un IC a
A.3.11.

## Contexto

- PSR, DSR y MinTRL (`quant-research` §8, ADR 0029) usan como varianza del Sharpe estimado
  1 − γ₃·SR + ((γ₄ − 1)/4)·SR², dividida por T − 1. Es la de rentabilidades independientes en el tiempo (Mertens, 2002).
- Una estrategia que mantiene posiciones varias velas tiene rentabilidades autocorrelacionadas, y el código no lo
  corregía. La auditoría quant lo midió (C7): autocorrelación positiva en los primeros retardos. Con autocorrelación
  positiva, la varianza real del Sharpe estimado es mayor, y PSR, DSR y MinTRL salían más favorables de lo que son.
- El IC del Sharpe (A.3.11) sale del bootstrap estacionario, que conserva la dependencia dentro de cada bloque.
- La persona pidió una corrección por autocorrelación elegida por principio, en el IC del Sharpe y en el DSR.

## Decisión

1. **Varianza del Sharpe estimado.** Es la varianza a largo plazo de su función de influencia (método delta; Lo, 2002):
   ψ_t = z_t − (SR/2)·(z_t² − 1), con z_t = (r_t − μ)/σ.
   - Su término sin retardo es exactamente la fórmula de rentabilidades independientes.
   - Las autocovarianzas de ψ se suman con los pesos de Bartlett de Newey y West (1987), que nunca dan una varianza
     negativa.
2. **Retardos: la longitud media de bloque del bootstrap,** max(⌈T^(1/3)⌉, duración media de una operación)
   (`quant-research` §8).
   - Es el horizonte de dependencia que el proyecto ya fijó: una posición dura eso.
   - T^(1/3) es el orden óptimo tanto para los retardos del núcleo de Bartlett como para los bloques del bootstrap.
   - Así hay un solo horizonte para el bootstrap y para la varianza.
3. **Nunca menos exigente.** La varianza no baja de la de rentabilidades independientes: con autocorrelación negativa se
   usa la fórmula de siempre.
4. **Dónde se usa:** PSR, DSR (de la familia y global) y MinTRL, es decir, en A.3.2 y A.3.5.
5. **IC del Sharpe (A.3.11).**
   - El bootstrap estacionario se mantiene, porque lo exige `quant-research` §8.
   - Se añade el IC de la varianza a largo plazo, SR ± 1,96·√(v/(T − 1)), anualizado.
   - Decide el menor de los dos límites inferiores: si dos métodos válidos no coinciden, el más conservador
     (`quant-research` §1).
6. **El informe da** la varianza usada, sus retardos y los dos IC. El texto congelado de A.3.2, A.3.5 y A.3.11 se
   revisa en la parte 9 del plan de la auditoría.

## Alternativas

- **Corregir solo la anualización** con el factor de Lo (2002) en lugar de √365. Cambia la métrica primaria, no su
  incertidumbre, y no toca el DSR.
- **Elegir los retardos con una regla automática** (Andrews, 1991; Newey y West, 1994). Necesita un modelo de la
  dependencia (un AR(1)) y daría para la misma serie un horizonte distinto del del bootstrap.
- **Sustituir el bootstrap por el IC de la varianza a largo plazo.** `quant-research` §8 exige el bootstrap por bloques.
- **Prewhitening o núcleos espectrales cuadráticos** (Ledoit y Wolf, 2008). Son más precisos con muestras grandes, pero
  piden más elecciones. Bartlett es el estándar y no puede dar una varianza negativa.

## Consecuencias

- Con autocorrelación positiva, PSR y DSR bajan, el MinTRL sube y el IC se ensancha. Sin ella, nada cambia.
- Cambian A.3.2, A.3.5 y A.3.11 en los experimentos nuevos (parte 10 del plan).
- La varianza entre pruebas del DSR, V[SRₙ] (su suelo y su conjunto), es de la parte 5 (Q-03).
- **Pruebas:**
  - `test/src/analytics/statistics.test.ts`: un AR(1) con la varianza de la teoría, y el suelo con autocorrelación
    negativa;
  - `test/src/analytics/report.test.ts`: DSR, MinTRL e IC con rentabilidades autocorrelacionadas.
