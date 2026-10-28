# ADR 0001 — Herramientas del enforcement automático

Fecha: 2026-09-30 · Estado: aceptado · Paso: 4

## Contexto

Las reglas de `CLAUDE.md` eran solo texto. El paso 4 las convierte en comprobaciones que fallan solas. El
proyecto corre en Node 24 con TypeScript nativo, en Windows, para una sola persona, y el código recuperado
de `src/` ya incumple algunas reglas que no se corrigen hasta el paso 13.

## Decisiones

1. **TypeScript baja de 7.0.2 a 6.0.x.** TypeScript 7 es el compilador nativo y no expone la API de
   JavaScript que necesitan typescript-eslint (que declara `typescript <6.1.0`) y dependency-cruiser. Sin
   esa API no hay `no-floating-promises`, que exige información de tipos. `tsc --noEmit` pasa igual con 6.0.3.
2. **dependency-cruiser para los límites**, no eslint-plugin-boundaries. Las reglas son expresiones sobre
   rutas, valen para carpetas que aún no existen, cubren paquetes npm (`ccxt`) y traen una lista de
   infracciones conocidas de serie.
3. **secretlint para los secretos**, no gitleaks. gitleaks es un binario de Go que habría que instalar
   aparte en cada máquina y que no queda fijado por el repositorio. secretlint es una dependencia de
   desarrollo de npm: se instala con `npm install`, su versión queda en `package-lock.json` y funciona igual
   en Windows. Coste: más dependencias transitivas de desarrollo; ninguna en producción.
4. **Hooks de git con `core.hooksPath`**, sin husky: dos scripts de shell en `.githooks/` y un `prepare`.
5. **`merge.ff=false`** para que toda fusión cree un commit y pase por `pre-merge-commit`. Git no ofrece un
   hook que frene una fusión fast-forward.
6. **Excepciones como listas contadas**, no como reglas apagadas: supresiones de ESLint
   (`eslint-suppressions.json`) e infracciones conocidas de dependency-cruiser. Un test impide que crezcan o
   que incluyan código nuevo.
7. **`build` es `node --check` sobre cada `.ts`.** No hay compilación; lo que puede fallar es que Node no
   cargue un archivo, y eso es lo que se comprueba.
8. **El hook de Claude bloquea todo `.env*`**, también `.env.example`, porque la regla pedida es literal y
   ante la duda no se abre.

## Alternativas descartadas

- Mantener TypeScript 7 y prescindir de las reglas con tipos: deja fuera `no-floating-promises`.
- Dos TypeScript a la vez (7 para `tsc`, 6 para las herramientas): dos binarios `tsc` en conflicto.
- Apagar reglas por archivo para el código previo: permitiría infracciones nuevas en esos archivos.
- Un escáner de secretos propio con expresiones regulares: cero dependencias, pero peor cobertura.

## Consecuencias

- Se podrá volver a TypeScript 7 cuando typescript-eslint y dependency-cruiser lo soporten.
- Los hooks de git no existen en un clon hasta ejecutar `npm install`.
- Los hooks de git se pueden saltar a mano con `--no-verify`; el hook de Claude lo impide solo a Claude.
- El hook de Claude compara texto y tiene falsos positivos (mensajes de commit, documentación).
- El paso 13 debe vaciar las dos listas de excepciones.

## Revisiones

- **2026-10-01, decisión 1.** El usuario aprobó TypeScript 6.0.3 porque el motivo es la compatibilidad de las
  herramientas. El motivo y la condición para revisarlo están en
  [ADR 0004](0004-typescript-6.md).
- **2026-10-01, decisión 8.** Por decisión del usuario, el hook deja pasar `.env.example` con las
  herramientas de archivos, y solo con nombres sin valor. Sigue bloqueando `.env` y cualquier otro `.env.*`,
  y cualquier comando de shell que nombre un `.env*`, incluido `.env.example`. Detalle en
  `docs/enforcement.md`.

## Corrección editorial (2026-10-05)

Renumeración del plan en el paso 12 ([ADR 0010](0010-regla-de-decisiones-y-nuevo-plan.md)). Solo cambian
los números de paso, con la tabla de `docs/progress/PLAN_MAP.md` (registro de trabajo privado, no publicado); no cambia
ninguna decisión. Cambios:

- 12 → 13 (saneamiento de las listas de excepciones).
