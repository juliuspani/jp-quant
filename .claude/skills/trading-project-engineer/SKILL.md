---
name: trading-project-engineer
description: Estándar de ingeniería obligatorio de Inversor JP para cualquier cambio en el repositorio. Cubre scope mínimo, cambios pequeños, tests, build, typecheck, lint, commits atómicos, documentación, ausencia de secretos, explicación de cambios, no refactorizar módulos no relacionados, añadir dependencias (licencia, mantenimiento, tamaño, alternativa nativa), no crear infraestructura innecesaria, subagentes y consumo de contexto, incluido cómo partir una tarea que no cabe en una sesión. Úsalo antes de escribir o cambiar código, tests, configuración o documentación, antes de instalar un paquete, antes de hacer un commit o cerrar un paso, y antes de lanzar un subagente.
---

# trading-project-engineer

Este estándar es obligatorio para todo cambio en el repositorio, sea código, tests, configuración o
documentación. Desarrolla `CLAUDE.md` §2 («Calidad de código») y §3 («Cierre estándar»), pero no los
sustituye: si algo de aquí choca con `CLAUDE.md`, manda `CLAUDE.md`. En su terreno mandan los skills de
dominio: `quant-research` en el research, `trading-risk` en el riesgo y `exchange-execution` en la conexión
con el exchange. Las decisiones están en [ADR 0006](../../../docs/adr/0006-estandar-de-ingenieria.md).

Archivos de este skill:

- [checklist.md](checklist.md): lista de comprobación que se repasa antes de dar un paso por cerrado.

## 1. Principios

1. **Scope mínimo.** Se hace lo que pide el paso, nada más. Lo que no se pidió no se hace, aunque parezca
   una mejora.
2. **Lo que no se ha comprobado no se da por hecho.** Un check que no se ha ejecutado, o que no existe, se
   declara así. Nunca se resume como PASS.
3. **Visible antes que bonito.** Un error a la vista, un fallo en un test o una duda escrita valen más que
   un resultado limpio que oculta algo.

## 2. Scope mínimo

- Antes de tocar nada, se escribe en una frase qué pide el paso y qué archivos va a tocar.
- Solo se cambian los archivos necesarios para eso. No se reformatean, reordenan imports, renombran ni
  «limpian» líneas que el paso no necesita.
- **No refactorizar módulos no relacionados.** Si aparece un problema fuera del alcance, no se arregla: se
  anota en `PROGRESS.md` («Bloqueos y riesgos») o se pregunta. Es la regla acordada el 2026-10-01: un cambio
  fuera del alcance se pregunta antes de hacerlo, aunque parezca menor.
- Si el paso exige tocar un módulo de otra capa, se dice antes de hacerlo y se explica por qué.

## 3. Cambios pequeños y commits atómicos

- **Una funcionalidad cada vez.** Un commit contiene un solo cambio con sentido propio. Su mensaje lo
  describe en una línea, y el cuerpo explica el porqué.
- **Commits atómicos:** cada commit deja el repositorio con `npm run check:all` en PASS. El `pre-commit` lo
  ejecuta, y no se salta: `--no-verify` está prohibido y el hook de Claude lo bloquea.
- **Tamaño orientativo:** unas 300 líneas por cambio. No cuentan los tests, los archivos generados ni los
  lockfiles. Si un cambio necesita más, o toca más de un módulo, se justifica en el resumen. Es una guía,
  no un check automático.
- No se mezclan en un commit un cambio de comportamiento y un cambio de formato o de nombres.
- El hash del commit del paso se anota en `PROGRESS.md` en un commit aparte, como en los pasos anteriores.
- Para los mensajes de commit se usa `git commit -F <archivo>`, porque el hook de Claude compara texto y
  da falsos positivos.
- Un commit de relevo con checks en rojo solo se admite en una rama `wip/*`, con prefijo `WIP` y el motivo
  en `PROGRESS.md`.

## 4. Tests

- **Pruebas obligatorias.** Todo cambio de comportamiento lleva su test en `test/`, con `node:test`.
- Un error corregido lleva primero un test que lo reproduce y falla, y después el arreglo.
- Los tests no usan red, no llaman al exchange real y no leen `.env`. Los datos de prueba van en
  `test/fixtures/`.
- No se borra ni se debilita un test para que pase. Si un test es incorrecto, se cambia y se explica en el
  resumen.
- Un test que comprueba texto (como los de los skills) se dice así: comprueba lo que está escrito, no lo
  que hace el bot.

## 5. Build, typecheck y lint

Antes de cada commit se ejecuta `npm run check:all`, que lanza en este orden:

| Check | Comando |
|---|---|
| build | `npm run build` |
| typecheck | `npm run typecheck` |
| lint | `npm run lint` |
| límites | `npm run boundaries` |
| tests | `npm test` |

Además, `npm run secrets` escanea todos los archivos versionados.

- Se anota el resultado real de cada uno. Si algo falla, se dice y no se hace commit en `main`.
- **Prohibido ocultar errores** (`CLAUDE.md` §2): nada de `any`, `@ts-ignore`, `@ts-expect-error` sin
  justificar ni `catch` vacíos.
- No se añaden entradas a `eslint-suppressions.json` ni a `.dependency-cruiser-known-violations.json`. Esas
  listas solo pueden bajar (`docs/enforcement.md`).
- No se relaja una regla de ESLint, de límites o del hook para que pase un cambio. Eso es una decisión y va
  a un ADR, con aprobación.

## 6. Documentación

- **`PROGRESS.md` por debajo de 200 líneas** (`CLAUDE.md` §3). Se actualiza en cada paso y solo contiene:
  estado actual (paso, rama, último commit y checks), decisiones pendientes, compromisos para pasos futuros
  (tabla ordenada por paso), los 3 últimos relevos resumidos y riesgos vigentes.
- La tabla de pasos completados, lo que dejó cada paso y el texto completo de los relevos van a
  `docs/progress/HISTORY.md`. Las decisiones resueltas y las reglas de trabajo acordadas van a
  `docs/progress/DECISIONS.md`. Lo que se mueve no se edita ni se pierde.
- **Toda decisión no trivial va a un ADR** en `docs/adr/`, con contexto, decisión, alternativas y
  consecuencias (`CLAUDE.md` §6).
- Si el cambio altera lo que describe un documento (`docs/enforcement.md`, un skill o un ADR), ese
  documento se actualiza en el mismo commit.
- Se documenta el porqué, no lo que el código ya dice. Los comentarios siguen la densidad del archivo.

## 7. Ausencia de secretos

- Nunca se escriben claves, tokens, contraseñas ni valores de `.env` en el código, los tests, los logs, los
  commits ni la documentación.
- Claude no lee `.env` ni ningún otro `.env.*` (el hook y `permissions.deny` lo bloquean). `.env.example`
  solo lleva nombres de variable, sin valores.
- El `pre-commit` escanea con secretlint el contenido preparado. `npm run secrets` escanea todos los
  archivos versionados.
- Si un secreto llega a un commit, no basta con borrarlo en otro: se avisa a la persona para que revoque la
  clave.

## 8. Explicación de cambios

Al cerrar cada paso, el resumen dice, sin adornos:

1. **Qué cambió y por qué**, en pocas líneas.
2. **Archivos tocados**: nuevos y modificados.
3. **Checks**: el resultado real de cada uno. Un check que no existe se declara como tal.
4. **Decisiones** tomadas y ADRs creados o cambiados.
5. **Riesgos**, límites y lo que el cambio no cubre.
6. **Dudas** que necesitan aprobación.

No se afirma nada que no se haya comprobado. Después se espera la aprobación antes del paso siguiente.

## 9. Dependencias

**No añadir dependencias sin justificar.** Rige el modo autónomo de `CLAUDE.md` §7
([ADR 0011](../../../docs/adr/0011-modo-autonomo.md)): **una dependencia nueva, también de desarrollo, se
aprueba automáticamente si cumple todas las condiciones de aprobación automática**. Si falla alguna, se busca
una alternativa que las cumpla, y solo si no la hay se pide la aprobación expresa de la persona antes de
instalarla.

**Condiciones de aprobación automática** (todas):
1. Licencia permisiva: MIT, Apache-2.0, BSD o ISC.
2. Mantenida: versión reciente, mantenedores activos y sin issues de seguridad graves abiertas.
3. Versión fijada (exacta, sin `^` ni `~`) y publicada hace al menos 7 días.
4. Sin scripts de instalación (`preinstall`, `install` o `postinstall`), tampoco en sus dependencias. Se
   instala igualmente con `--ignore-scripts`.
5. Registrada en [docs/DEPENDENCIES.md](../../../docs/DEPENDENCIES.md) con su motivo, en el mismo commit.

Antes de instalar se responde por escrito a estos criterios (en el registro, o en un ADR si la dependencia
es importante):

| Criterio | Qué se comprueba |
|---|---|
| **Motivo** | Qué problema resuelve y por qué hace falta ahora |
| **Alternativa nativa** | Qué ofrece Node ≥ 24 o el código propio, y por qué no basta |
| **Mantenimiento** | Fecha de la última versión, mantenedores activos, issues de seguridad abiertas y uso real |
| **Scripts de instalación** | Si tiene `preinstall`, `install` o `postinstall` (también en sus dependencias), y qué hacen |
| **Licencia** | MIT, Apache-2.0, BSD o ISC. Cualquier otra no entra por la vía automática |
| **Tamaño** | Tamaño instalado y número de dependencias transitivas (`npm ls --all`) |

Antes de buscar fuera se mira lo nativo: `node:test`, `node:sqlite`, `node:crypto`, `fetch`, `WebSocket`,
`util.parseArgs` y `util.styleText`.

- Una licencia permisiva es necesaria pero no suficiente: tienen que cumplirse las cinco condiciones.
- El motivo va en el registro [docs/DEPENDENCIES.md](../../../docs/DEPENDENCIES.md), y en un ADR si la
  dependencia es importante (runtime, dinero, exchange o seguridad). Un test falla si `package.json` declara
  una dependencia que no está en ese registro.
- Se instala con versión exacta (`npm install --save-exact --ignore-scripts`) y se versiona
  `package-lock.json`. Las dependencias anteriores al ADR 0011 conservan su rango hasta que se revisen.
- **Excepción aprobada: `ccxt`.** Su `postinstall` hace peticiones de red, pero conserva la aprobación
  expresa del paso 9B (ADR 0011, decisión 4). El script se decide en el paso 39.
- Quitar una dependencia también se registra: se borra del registro en el mismo commit.

## 10. Sin infraestructura innecesaria

- No se crean carpetas, archivos de configuración, scripts, servicios, CI, contenedores ni capas de
  abstracción que el paso no necesite hoy.
- Lo que `CLAUDE.md` §5 marca como pendiente se crea en su paso, no antes.
- Una abstracción se introduce cuando hay dos usos reales, no por si acaso.
- Un mecanismo nuevo de enforcement (hook, script o regla) se propone con un ADR y se aprueba antes.

## 11. Subagentes

- **`CLAUDE.md` es más estricto que este skill: no se usan subagentes salvo autorización explícita en el
  prompt.** Cuentan como subagentes la herramienta `Agent` y cualquier skill o comando que lance agentes.
- **No generar subagentes recursivamente.** Un subagente autorizado no lanza otros subagentes. Si su tarea
  no cabe, devuelve lo que tiene y dice qué falta.
- El subagente recibe el alcance exacto y las mismas reglas: `CLAUDE.md`, este skill y el skill de dominio
  que toque. Su resultado se revisa antes de usarlo, y su trabajo cuenta como trabajo de la sesión.
- Un subagente nunca hace commits ni ejecuta órdenes.

## 12. Consumo de contexto

- **Leer solo los archivos necesarios.** Antes de abrir un archivo se sabe para qué se abre.
- **No volcar archivos enteros.** Primero se mide (`wc -l`) o se buscan los encabezados. Después se lee el
  tramo que hace falta, con rango de líneas.
- **Preferir búsquedas dirigidas**: `Grep` con un patrón y una ruta concretos, en lugar de recorrer
  carpetas o abrir archivos a ciegas.
- No se repite en la conversación lo que ya está en un archivo o en el historial de git: se cita con su
  ruta y línea.
- Las salidas largas de comandos se filtran (`head`, `grep` o `--quiet`).

### 12.1 Tareas que no caben en una sesión

**Si una tarea no cabe en una sesión, se parte y se deja anotado en `PROGRESS.md`.**

1. Antes de empezar, se estima si cabe. Si no, se parte en subpasos con sentido propio (por ejemplo,
   «Paso 25, parte 1 de 3»), cada uno con su commit en verde.
2. El plan de partes va a `PROGRESS.md` («Paso actual» y «Trabajo a medias»), con la siguiente acción
   concreta.
3. Al cortar, se hace el relevo (`/relevo`): checks, `PROGRESS.md` y commit. Nunca quedan cambios sin
   confirmar.
4. La sesión siguiente empieza con `/arranque` y retoma desde lo anotado, sin releer lo que ya está
   resumido.

## 13. Cómo trabajar

1. **Arranque**: `PROGRESS.md`, `git status` y `git log -5` (`CLAUDE.md` §4).
2. **Alcance**: una frase sobre qué se hace y qué archivos se tocan; dudas antes de empezar.
3. **Skill de dominio**: si el cambio toca research, riesgo o ejecución, se carga ese skill también.
4. **Cambio**: pequeño, con su test.
5. **Checks**: `npm run check:all` y `npm run secrets`, con el resultado real.
6. **Documentación**: `PROGRESS.md`, ADR si hay decisión y documentos afectados.
7. **Commit** atómico con `git commit -F`.
8. **Resumen** según §8, y se espera la aprobación.
