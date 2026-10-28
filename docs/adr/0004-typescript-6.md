# ADR 0004 — TypeScript 6.0.3 por compatibilidad de herramientas

Fecha: 2026-10-01 · Estado: aceptado · Paso: 4 (decisión), aprobada el 2026-10-01

## Contexto

El proyecto empezó con TypeScript 7.0.2. En el paso 4 se bajó a 6.0.3 (ADR 0001, decisión 1), sin aprobación
previa. El usuario la aprobó el 2026-10-01 con una condición: que el motivo sea la compatibilidad de las
herramientas, y que se deje escrito cuándo revisarla. Este ADR recoge las dos cosas.

## Decisión

Se mantiene **TypeScript 6.0.3**, fijado con `~6.0.3` en `package.json`.

**Motivo: compatibilidad de herramientas, no preferencia de lenguaje.** TypeScript 7 es el compilador nativo
y no expone la API de JavaScript que necesitan dos herramientas del enforcement:

- **typescript-eslint 8.71.0.** Su `peerDependencies` exige `typescript >=4.8.4 <6.1.0`, y sin su información
  de tipos no funciona `@typescript-eslint/no-floating-promises`. Esa regla impide promesas sin `await` ni
  manejo de errores, lo que en un bot de trading puede dejar una orden o un error sin tratar.
- **dependency-cruiser 18.4.0.** Lee los `import type` a través del compilador de TypeScript
  (`tsPreCompilationDeps`). Los límites de `CLAUDE.md` §2 cuentan esos imports.

Con 6.0.3, `tsc --noEmit`, ESLint con tipos y dependency-cruiser pasan juntos en `check:all`.

## Condición para volver a revisarlo

Se revisa cuando se cumpla **cualquiera** de estas condiciones:

1. typescript-eslint publica una versión cuyo `peerDependencies` admite TypeScript 7.
2. dependency-cruiser documenta soporte de TypeScript 7.
3. TypeScript 6.0 deja de recibir correcciones de seguridad, o una de las dos herramientas deja de admitir
   la 6.0.
4. Una dependencia nueva que haga falta exige TypeScript 7.

Volver a TypeScript 7 exige las dos primeras condiciones a la vez, y además:

- `npm run check:all` en PASS en una rama aparte con TypeScript 7;
- sin perder ninguna regla de ESLint con tipos;
- sin crecer `eslint-suppressions.json` ni `.dependency-cruiser-known-violations.json`.

Se comprueba en cada actualización de dependencias. El cambio va en un ADR nuevo que sustituya a este.

## Alternativas descartadas

- **TypeScript 7 sin las reglas con tipos.** Se pierde `no-floating-promises`.
- **Dos TypeScript a la vez** (7 para `tsc`, 6 para las herramientas): dos binarios `tsc` en conflicto y
  resultados distintos según quién compile.
- **Quedarse en TypeScript 7 y esperar a las herramientas.** El enforcement del paso 4 no existiría.

## Consecuencias

- El proyecto no usa nada exclusivo de TypeScript 7. Al volver, no hay que deshacer nada del código.
- Node ejecuta el TypeScript directamente con *type stripping*, así que la versión de `tsc` no cambia lo que
  se ejecuta, solo lo que se comprueba.
- Este ADR desarrolla la decisión 1 del ADR 0001.
