# ADR 0044 — Experimentos que solo eligen en train

Fecha: 2026-10-22 · Estado: **aceptado**, decisión de Claude en modo autónomo (paso 31), pendiente de la aprobación del
paso. Amplía el formato del registro del ADR 0024 y el barrido del ADR 0032.

## Contexto

- **La petición.** La persona pide ejecutar ya la elección en train del tramo hacia delante de la comprobación de A (ADR
  0043), solo con datos hasta el 2026-09-30 y sin tocar el periodo del test final.
- **Las reglas que lo enmarcan:**
  - INV-14, aprobado por la persona en el paso 23: todo backtest pasa por el Experiment Registry, y solo lo lanza el
    ejecutor de experimentos, al que solo llama `runExperiment`;
  - `quant-research` §10: todo lo que se mira de datos reales queda en el registro.
- **El registro no lo admitía.** Cada tramo, también su validación, tenía que caber en `datos.rango`, y la validación del
  tramo hacia delante es el periodo del test final.

## Decisión

1. **Campo nuevo y opcional en el pre-registro: `solo_eleccion: true`.** Un experimento así es un barrido que solo elige
   en train. El ejecutor puntúa cada punto de la rejilla en el train de cada tramo, con el purging y el embargo
   registrados y con el mismo código que el barrido (`selectInTrain`). No mide ninguna validación.
2. **Reglas del registro,** que se comprueban al leer, como las demás:
   - hace falta una rejilla de al menos 2 puntos y `variantes` igual a 0, y cada punto cuenta en `N`;
   - solo el último tramo puede validar fuera de `datos.rango`, y lo que puntúa de su train (hasta h velas antes de su
     final) tiene que estar dentro; los demás tramos, como siempre;
   - su cierre `completado` no lleva veredicto, y una prueba previa no puede llevar el campo.
3. **El ejecutor lo sabe por la línea.** `backtestRunner` lo decide por el campo, que `execute` le pasa en `RunInput`, y
   la reproducción por id funciona igual.
4. **Salida:** la elección (`seleccion`, como en un barrido) y, en las métricas, la configuración elegida y su Sharpe de
   train en cada tramo. No hay ninguna cifra fuera de muestra.

## Alternativas

| Opción | Por qué no |
|---|---|
| Calcular la elección con un comando fuera del registro | Rompe INV-14, y cambiarlo es una parada obligatoria; también `quant-research` §10 |
| Abrir `particiones.test` | Es trabajo del paso 53, con la autorización humana, y abre el test final |
| Repetir el barrido completo con el tramo de más | Mediría validaciones (otra mirada y más pruebas en `N`), y no cabe: la validación del tramo de más es el test final |
| Una validación nula en el último tramo, sin campo nuevo | Las validaciones de los demás tramos quedarían sin medir sin que la línea lo diga |

## Consecuencias

- **EXP-0029 es el primero de este tipo:** la elección de la comprobación de A (ADR 0043). Suma 4 pruebas a la familia
  `tendencia-donchian-atr` y a la `N` global.
- **INV-14 no cambia:** el backtest sigue pasando por `runExperiment`.
- **`quant-research` §10 no recoge el campo.** El anexo trae la fila para que la pegue la persona (`.claude/` solo lo
  edita ella). Hasta entonces manda este ADR.

## Anexo — Texto para `quant-research` (lo pega la persona)

En `.claude/skills/quant-research/SKILL.md`, §10, tabla «Solo en la línea de pre-registro», después de la fila de
`variantes`:

```text
| `solo_eleccion` | `true` en un experimento que solo elige en train (ADR 0044): un barrido sin variantes, sin validaciones medidas y sin veredicto. Solo su último tramo puede validar fuera de los datos. Falta en los demás |
```
