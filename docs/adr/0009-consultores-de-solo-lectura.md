# ADR 0009 — Consultores de solo lectura como agentes

Fecha: 2026-10-02 · Estado: aceptado · Paso: 11 (decisión), aprobada el 2026-10-02 sin `Bash` en los
consultores (paso 11B)

## Contexto

El refactor va a tocar research, ejecución, riesgo y seguridad. Una revisión hecha por la misma sesión que
escribió el código tiende a justificarlo. Hace falta una segunda mirada especializada, pero `CLAUDE.md` §2
prohíbe los subagentes salvo autorización explícita, y un revisor con permiso de escritura podría «arreglar»
lo que encuentra sin pasar por Risk, por los tests ni por la aprobación de la persona. El procedimiento está
en [docs/CONSULTANTS.md](../CONSULTANTS.md).

Hechos comprobados en la documentación oficial de los subagentes de Claude Code
(`code.claude.com/docs/en/sub-agents`, consultada el 2026-10-02): `tools` es una lista blanca; un subagente
puede lanzar otros si tiene la herramienta `Agent`; `disallowedTools` con un patrón como `Bash(git push *)`
quita la herramienta entera, así que `Bash` no se puede limitar por comando; los hooks `PreToolUse` de
`settings.json` también se aplican a los subagentes; y Claude delega por la descripción del agente.

## Decisión

1. **Cuatro consultores** en `.claude/agents/`: `consultor-quant`, `consultor-execution-risk`,
   `consultor-security` y `consultor-software`. La lista es cerrada.
2. **Herramientas:** `tools` = `Read`, `Grep` y `Glob`. `disallowedTools` = `Bash`, `PowerShell`, `Agent`,
   `Skill`, `Write`, `Edit`, `NotebookEdit`, `WebFetch` y `WebSearch`, para que añadir una herramienta a
   `tools` por error no les dé shell, escritura, red ni subagentes.
3. **Los consultores no ejecutan comandos** (paso 11B). Si un hallazgo necesita ejecutar algo, el informe trae
   el comando exacto para reproducirlo y lo ejecuta después la sesión principal, que antes comprueba que no
   escribe, no cambia git, no usa la red y no ejecuta `src/`. Así la solo lectura es un bloqueo técnico, no
   una regla del prompt.
4. **Reglas comunes idénticas** en los cuatro: solo lectura salvo autorización expresa del prompt que los
   lanza, sin comandos, no lanzan agentes, buscan fallos sin justificar el código, toda afirmación con
   evidencia (`archivo:línea` o el comando exacto que la reproduce), severidad Critical/High/Medium/Low y
   formato de salida fijo. La fuente es `docs/CONSULTANTS.md` §3 y un test compara las copias.
5. **Solo se ejecutan cuando un paso lo pide**, nombrando el consultor y el alcance. Esa es la autorización de
   subagentes de `CLAUDE.md` §2. Claude verifica la evidencia de los hallazgos Critical y High antes de
   presentarlos, y los arreglos van en cambios aparte.

## Alternativas descartadas

- **Revisores con permiso de escritura que arreglen lo que encuentran.** Mezcla revisión y cambio, se salta el
  scope mínimo y la aprobación de cada paso.
- **`Bash` solo para comandos de inspección** (propuesta del paso 11). `Bash` no se puede limitar por comando:
  la solo lectura dependía de una regla del prompt. Descartada en el paso 11B.
- **Un hook propio que limite `Bash` a una lista de comandos** (campo `hooks` del agente o regla en
  `scripts/claude-guard.ts`). Sería un mecanismo nuevo de enforcement (`trading-project-engineer` §10) y deja
  de hacer falta sin `Bash`. Descartado en el paso 11B.
- **Fijar `permissionMode: plan`.** No hace falta: sin `Bash` ni herramientas de escritura, los consultores ya
  son de solo lectura. Descartado en el paso 11B.
- **Bloquear la delegación automática con `permissions.deny` (`Agent(consultor-...)`).** También impediría
  lanzarlos cuando un paso lo pide; habría que editar `settings.json` en cada uso.
- **Un solo revisor generalista.** Leería los cuatro skills en cada ejecución y su informe mezclaría terrenos.

## Consecuencias

- `docs/CONSULTANTS.md` documenta cuándo se lanzan, la plantilla de prompt, cómo se verifica el informe y
  se ejecutan sus comandos, y qué garantiza la herramienta y qué no. Está en `CLAUDE.md` §5.
- `test/docs/consultants.test.ts` comprueba que solo existen los cuatro agentes, sus herramientas, que su
  descripción limita el uso a cuando un paso lo pide y que las reglas comunes son idénticas a las del
  documento. Comprueba texto: no puede comprobar lo que hace un agente al ejecutarse.
- Los consultores no pueden confirmar por sí mismos lo que necesita ejecución (historial de git, tests,
  `npm ls`): esa evidencia llega como comando pendiente y la confirma la sesión principal.
- Riesgos que quedan: un `Read` de `data/holdout/` no lo bloquea el hook; nada técnico impide que Claude
  delegue en un consultor sin que el paso lo pida; la sesión principal debe revisar cada comando propuesto
  antes de ejecutarlo; cada consultor empieza sin contexto y es caro.
