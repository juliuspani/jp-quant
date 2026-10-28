# ADR 0034 — Reproducción en un worktree del commit y matriz del PBO de la ronda

Fecha: 2026-10-20 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el trabajo) · Compromisos «Antes del 31»

## Contexto

La persona paró el paso 29 (stress testing): se lanzó por error y no había estrategias supervivientes, así que se omite.
Pidió hacer ya los compromisos pendientes del paso 28: reproducir EXP-0025 y EXP-0026 (`docs/PROMOTION_CRITERIA.md`
A.4.3) y juntar la matriz del PBO de la ronda (A.3.6; ADR 0031, decisión 10; ADR 0032, decisión 5).

- `reproduceExperiment` (ADR 0024) existía, pero ningún comando la llamaba. Exige el código del commit registrado: si
  entre ese commit y HEAD cambió algo que no es documentación, se niega y pide reproducir «en un worktree de ese commit».
  EXP-0025 (`dcfa3c7`) ya no se puede reproducir en HEAD: `ef9d067` cambió `src/strategy/library.ts`. Y cualquier
  herramienta nueva que se confirme también cambia el código respecto de `ef9d067` (EXP-0026).
- `pboAcross` y `readOutput` existían, pero nada juntaba las salidas guardadas de una ronda.

## Decisión

### 1. `npm run reproduce -- --id EXP-NNNN` (`src/app/reproduction.ts`)

- Con solo cambios de documentación desde el commit del experimento, reproduce en este repositorio. Si cambió código,
  crea (o reutiliza) un worktree de ese commit en la carpeta temporal del sistema, fuera del repositorio, y carga desde él
  los módulos que ejecutan: el experimento, el ejecutor, el puerto de datos y git.
- El registro es el de este repositorio: `reproduceExperiment` lo lee y no escribe en él (una reproducción no es una
  prueba nueva y no cuenta en `N`). Los datos se leen con la clase de la guarda del commit y las rutas de la guarda de este
  repositorio: la guarda se niega a abrir el test final, y el hash del dataset se comprueba igual que al ejecutar. Con la
  guarda de este repositorio, las velas llevaban su clase `Decimal`, que el código del commit no serializa
  (`NotCanonicalError` en el primer intento, antes de ejecutar nada).
- El worktree enlaza (`junction`) el `node_modules` de este repositorio, que git ignora, y no se borra al terminar: borrar
  una carpeta con enlaces podría alcanzar su destino. Se quita a mano con `git worktree remove` tras quitar el enlace.
- Exige el árbol limpio también aquí: el código que orquesta la reproducción está confirmado.

### 2. `npm run pbo-ronda -- --id … --id …` (`src/app/round-matrix.ts`)

- Lee la salida guardada de cada experimento nombrado, comprobada contra el `hash_salida` de su cierre (`readOutput`), y
  toma sus configuraciones: cada punto de la rejilla (`series_rejilla`) o, sin barrido, su única serie. No toma la serie
  de lo elegido en cada tramo: está hecha de los mismos puntos y los contaría dos veces (ADR 0032, decisión 3).
- Da el PBO por CSCV (S = 16) dentro de cada familia y con todas las configuraciones de la ronda, con `pboAcross`.
- Desde el ADR 0039 (2026-10-21) da también el DSR global de cada candidato. Usa la serie de lo elegido, con la N de todo
  el registro en ese momento, la misma para todos.
- La primera ronda son EXP-0025 y EXP-0026: 7 configuraciones. Los sistemas de EXP-0021 y EXP-0022 están en esas
  rejillas, y sus salidas no se guardaban (anteriores al paso 27B).

## Alternativas

- **Reproducir sin worktree, relajando la comprobación del código.** Dejaría pasar como reproducción una ejecución con
  otro código.
- **Un script fuera del repositorio.** La reproducción es un control de A.4 que tiene que poder repetir la persona.
- **Copiar los datos al worktree.** Más espacio y otra copia que vigilar; la guarda de este repositorio ya protege el test
  final. El código fuera de la guarda no nombra rutas de datos (`test/enforcement/data-paths.test.ts`).
- **Incluir en la matriz la serie de lo elegido.** Duplica configuraciones y sesga el CSCV.

## Consecuencias

- Toda reproducción futura funciona aunque el código haya cambiado desde su commit.
- La matriz de la ronda deja de estar pendiente; su resultado y el de las reproducciones están en `STRATEGY_RESEARCH.md`
  y en `PROGRESS.md`. Lo usará el documento de decisión del paso 31.
- Quedan worktrees en la carpeta temporal hasta que se quitan a mano.
- Ningún criterio congelado, invariante ni límite cambia.
