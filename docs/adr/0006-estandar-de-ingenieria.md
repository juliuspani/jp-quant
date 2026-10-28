# ADR 0006 — Estándar de ingeniería del repositorio

Fecha: 2026-10-01 · Estado: aceptado · Paso: 8 (decisión), aprobada el 2026-10-01 con cambios en las
decisiones 2, 3 y 4 (paso 8B)

## Contexto

`CLAUDE.md` fija las reglas de calidad (§2) y el cierre de cada paso (§3), pero en pocas líneas, porque se
carga en cada sesión. Faltaba el detalle operativo: qué es un cambio pequeño, qué se exige a una
dependencia nueva, qué hacer con un subagente o cómo partir una tarea que no cabe en una sesión. Además, el
contexto de cada sesión es limitado, y leer archivos enteros sin necesidad lo agota antes de terminar.

## Decisión

1. **El estándar va en el Project Skill `trading-project-engineer`** (`.claude/skills/trading-project-engineer/`),
   con su checklist. `CLAUDE.md` no cambia. Si chocan, manda `CLAUDE.md`, y en su terreno mandan los skills
   de dominio.
2. **Cambio pequeño, con tamaño orientativo.** Unas 300 líneas por cambio. No cuentan los tests, los
   archivos generados ni los lockfiles. Si un cambio necesita más, se justifica. Es una guía, no un check
   automático.
3. **Toda dependencia nueva necesita aprobación expresa de la persona**, también las de desarrollo. Se
   pide con el motivo, la alternativa nativa, el mantenimiento, los scripts de instalación, la licencia y
   el tamaño. MIT, Apache-2.0, BSD e ISC no requieren consulta de licencia; cualquier otra sí. Una
   licencia permisiva no exime de la aprobación. La justificación va en un ADR.
4. **Registro de dependencias en un archivo propio**, [docs/DEPENDENCIES.md](../DEPENDENCIES.md), para que
   este ADR no cambie cada vez que entra una dependencia. Un test
   (`test/skills/trading-project-engineer.test.ts`) falla si `package.json` y el registro no coinciden.
   Así, añadir un paquete sin registrarlo rompe `check:all`.
5. **Subagentes.** Manda `CLAUDE.md`: solo con autorización explícita en el prompt. Además, un subagente no
   lanza otros (sin recursión), no hace commits y recibe las mismas reglas. Su resultado se revisa antes de
   usarlo.
6. **Consumo de contexto.** Leer solo lo necesario, por tramos y con búsquedas dirigidas. Si una tarea no
   cabe en una sesión, se parte en subpasos con commit en verde y el plan se anota en `PROGRESS.md`.
7. **Sin enforcement nuevo para el resto.** Scope, tamaño, contexto y subagentes no tienen check
   automático. Las reglas que ya tienen mecanismo (checks, hooks, secretos, excepciones) se citan, no se
   duplican.

## Alternativas descartadas

- **Ampliar `CLAUDE.md`.** Se carga en cada sesión y está pensado para ser corto.
- **Un check automático del tamaño del diff.** Castigaría cambios que necesitan más líneas por buenas
  razones. Queda como guía, con justificación cuando se supera.
- **Una lista blanca de licencias en un script con `license-checker`.** Sería otra dependencia para cubrir
  pocos paquetes; basta el registro y el test.
- **El registro dentro de este ADR** (versión propuesta). El ADR cambiaría con cada dependencia.
- **Prohibir los subagentes del todo.** `CLAUDE.md` ya permite usarlos con autorización explícita; este
  skill no la endurece, solo añade condiciones.

## Consecuencias

- Añadir o quitar una dependencia exige actualizar `docs/DEPENDENCIES.md` en el mismo commit, y
  añadirla exige además la aprobación de la persona y un ADR con la justificación.
- El test de dependencias comprueba el nombre, no la calidad de la justificación: esa la revisa una persona.
- Las reglas de scope, tamaño, contexto y subagentes dependen de la disciplina de la sesión y de la
  revisión humana.
