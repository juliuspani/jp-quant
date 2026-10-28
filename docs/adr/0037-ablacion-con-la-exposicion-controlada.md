# ADR 0037 — Ablación con la exposición controlada

Fecha: 2026-10-21 · Estado: aceptado (la persona lo pidió el 2026-10-20; el cómo, en modo autónomo, ADR 0011) ·
Auditoría quant, parte 3. Cambia cómo mide el ADR 0031 (§6) la aportación de cada componente en A.3.14.

## Contexto

- A.3.14 pide que todos los componentes que quedan «aporten», y `quant-research` §7 mide su aportación a la métrica
  primaria fuera de muestra. El evaluador del ADR 0031 daba un componente por aportado si, sin él, bajaba el Sharpe.
- La auditoría quant (Q-08) vio que así no se controla la exposición. Sin una regla de salida, la posición se queda más
  tiempo en mercado, y en un periodo alcista eso sube el Sharpe aunque el componente funcione. Un `FAIL` o un `PASS`
  podía medir la deriva del mercado, y no el componente.
- La persona pidió controlar la exposición.

## Decisión

1. **Un control aleatorio por variante.** Cada variante de ablación tiene su propio control aleatorio:
   - las mismas operaciones y duraciones que la variante, colocadas al azar;
   - el mismo método que A.3.12: el simulador si su réplica se aleja como mucho un 10 %, y si no, el backtester;
   - su propia semilla (`control-ablacion-<componente>`).
2. **Lo que cuenta es el exceso:** el Sharpe menos la mediana de su control. La mediana es lo que gana cualquier
   colocación al azar con esas operaciones y esa exposición. El exceso es lo que la exposición no explica.
3. **Un componente aporta** si, sin él, el exceso es menor que el de la estrategia completa sobre su propio control (el
   de A.3.12). Un control sin medir deja el criterio en `NO CONCLUYENTE`.
4. **El informe da, para cada variante,** su Sharpe, su exceso, su tiempo en mercado y su exposición media.
5. **El texto congelado de A.3.14 no cambia.** Dice que los componentes aportan, y esto fija cómo se mide. Se revisa
   junto con los demás cambios en la parte 9 del plan de la auditoría.

## Alternativas

- **Comparar los Sharpe sin más.** Es lo que confunde exposición y aportación.
- **Ajustar por la beta frente a BTC** (ratio de valoración). Supone una relación lineal con un solo factor y obliga a
  elegirlo. El control aleatorio no supone nada y ya es el control del proyecto (A.3.12).
- **Comparar percentiles en el control.** Se saturan: el percentil 100 de una estrategia fuerte no se puede superar.

## Consecuencias

- Hay un control más por componente: hasta 1000 simulaciones, con el simulador o, si no es válido, con el backtester.
- Cambian los estados de A.3.14 en los experimentos nuevos. A y B se repiten en la parte 10 del plan.
- **Pruebas:**
  - `test/src/analytics/criteria.test.ts`, con el caso de una variante que gana Sharpe por estar más expuesta y aun así
    deja aportando al componente;
  - `test/src/app/research-runner.test.ts`, con el exceso y la exposición de la variante en un run sintético.
