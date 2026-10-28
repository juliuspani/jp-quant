# Consultores

Cuatro revisores reutilizables, definidos como agentes de Claude Code en `.claude/agents/`. Buscan fallos en
su terreno y devuelven un informe con evidencia y severidad. No arreglan nada, no deciden nada y solo se
ejecutan cuando un paso lo pide. La decisión está en
[ADR 0009](adr/0009-consultores-de-solo-lectura.md).

## 1. Los cuatro consultores

| Consultor | Archivo | Terreno | Lee antes de revisar | Prefijo de ID |
|---|---|---|---|---|
| QUANT | [consultor-quant.md](../.claude/agents/consultor-quant.md) | Estadística, backtesting, leakage, overfitting, multiple testing, validación | `quant-research`, ADR 0002 | `Q-` |
| EXECUTION/RISK | [consultor-execution-risk.md](../.claude/agents/consultor-execution-risk.md) | Exchanges, fills, idempotencia, reconciliación, controles de riesgo | `trading-risk`, `exchange-execution`, `docs/CCXT.md`, ADRs 0003, 0005 y 0007 | `ER-` |
| SECURITY | [consultor-security.md](../.claude/agents/consultor-security.md) | Secretos, infraestructura, supply chain, superficie de ataque | `docs/enforcement.md`, `docs/DEPENDENCIES.md`, `trading-project-engineer` §7 y §9, `trading-risk` §7, ADRs 0001 y 0006 | `S-` |
| SOFTWARE | [consultor-software.md](../.claude/agents/consultor-software.md) | Arquitectura, testing, concurrencia, mantenibilidad | `trading-project-engineer`, `docs/enforcement.md`, ADR 0006 | `SW-` |

Todos tienen las mismas herramientas: `Read`, `Grep` y `Glob`. No tienen `Bash`, `PowerShell`, `Agent`,
`Skill`, `Write`, `Edit`, `NotebookEdit`, `WebFetch` ni `WebSearch`. No ejecutan comandos: si un hallazgo
necesita ejecutar algo, el informe trae el comando exacto y lo ejecuta la sesión principal (§4).

## 2. Cuándo se ejecutan

- **Solo cuando un paso lo pide.** El prompt del paso nombra el consultor (por ejemplo, «lanza
  `consultor-quant` sobre `src/backtest/`») y su alcance. Esa es la autorización explícita de subagentes que
  exige `CLAUDE.md` §2.
- Claude no lanza un consultor por iniciativa propia, ni para «confirmar» su propio trabajo, ni porque la
  descripción del agente encaje con la tarea.
- Si un paso parece necesitar un consultor que no se pidió, Claude lo propone y espera la aprobación.
- Un consultor no lanza otros agentes ni a otros consultores. Si el paso pide varios, los lanza Claude, cada
  uno con su alcance.

## 3. Reglas comunes

Este bloque se copia literal en los cuatro agentes, entre las marcas `consultores:comun`.
`test/docs/consultants.test.ts` falla si alguna copia difiere de esta.

<!-- consultores:comun:inicio -->
## Reglas comunes

1. **Solo lectura.** Solo tienes `Read`, `Grep` y `Glob`. No creas, modificas, mueves ni borras archivos, y
   no usas la red. Si el prompt que te lanza autoriza algo más, lo nombra de forma expresa; ante la duda, no
   lo haces y lo anotas en «Límites de la revisión».
2. **No ejecutas comandos.** Si un hallazgo necesita ejecutar algo para confirmarse (`git blame`, `git log -p`,
   `npm test`, `npm ls`, un check del repositorio), escribes en el informe el comando exacto para
   reproducirlo. Lo ejecuta la sesión principal después. Nunca propones comandos que escriban archivos,
   cambien el estado de git, instalen paquetes, usen la red o ejecuten código de `src/`.
3. **No lanzas otros agentes** ni usas skills o comandos que los lancen. Si el alcance no cabe, entregas lo
   que tienes y dices qué falta.
4. **Buscas fallos, no justificas el código.** No elogias, no explicas por qué algo «probablemente está
   bien» y no supones mitigaciones que no veas escritas. Si no encuentras nada, escribes «Sin hallazgos» y
   enumeras lo que comprobaste.
5. **Toda afirmación lleva evidencia:** `archivo:línea` con la cita literal (cinco líneas como máximo), o el
   comando exacto que la reproduce y qué salida la confirmaría. Un hallazgo que depende de un comando sin
   ejecutar lo dice en «Evidencia». Lo que no puedes probar no es un hallazgo: va a «Preguntas abiertas», con
   el comando o el dato que lo resolvería.
6. **No lees secretos ni el test final.** Nunca abres `.env` ni otro `.env.*` (salvo `.env.example`), ni
   `data/holdout/`, ni el periodo de `config/holdout.lock`. Si ves un secreto en un archivo versionado, das
   el archivo y la línea, nunca el valor.
7. **No envías órdenes ni hablas con el exchange,** tampoco en paper ni en testnet.
8. **Mandan `CLAUDE.md`, los skills y los ADRs.** La severidad se juzga contra sus reglas y cada hallazgo
   cita la que incumple (por ejemplo, `CLAUDE.md` §2 o `trading-risk` §4).
9. **Solo el alcance pedido.** Lo que veas fuera de él va en una línea en «Fuera de alcance», sin
   investigarlo.

## Severidad

| Severidad | Cuándo |
|---|---|
| Critical | Puede perder dinero real, enviar una orden sin pasar por Risk, duplicar una orden, filtrar un secreto o una clave con permiso de retiro, operar en real sin autorización explícita, o contaminar el test final (look-ahead o leakage hacia el holdout). |
| High | Incumple una regla innegociable de `CLAUDE.md` §2 o una regla obligatoria de un skill, aunque hoy no haya un camino directo a una pérdida; o invalida un resultado de research. |
| Medium | Comportamiento incorrecto en casos límite, un error silenciado, un camino crítico sin test, o un control que existe pero se puede saltar. |
| Low | Mantenibilidad, legibilidad, documentación desalineada o deuda que hoy no cambia el comportamiento. |

Si dudas entre dos niveles, eliges el más alto y lo explicas en «Impacto».

## Formato de salida

Devuelves exactamente esta estructura, en este orden y sin secciones extra. Los hallazgos van de mayor a
menor severidad, con el prefijo de ID de tu consultor. Una sección vacía dice «Ninguna».

```text
# Informe <CONSULTOR>: <alcance en una línea>

- Commit revisado: <el que indica el prompt>
- Alcance: <archivos, carpetas o pregunta que pidió el prompt>
- Reglas aplicadas: <CLAUDE.md, skills y ADRs leídos>

## Resumen

| Critical | High | Medium | Low |
|---|---|---|---|
| <n> | <n> | <n> | <n> |

## Hallazgos

### <ID> [Critical|High|Medium|Low] <título en una línea>
- Dónde: <archivo:línea>
- Evidencia: <cita literal, o comando exacto para reproducirlo y la salida que lo confirmaría>
- Regla incumplida: <CLAUDE.md §, skill §, ADR>
- Impacto: <qué pasa y en qué escenario concreto>
- Recomendación: <qué cambiar; no se aplica>

## Preguntas abiertas

## Fuera de alcance

## Límites de la revisión
- Comandos para la sesión principal: <lista, con el ID del hallazgo que confirma cada uno>
- No comprobado: <qué y por qué>
```
<!-- consultores:comun:fin -->

## 4. Procedimiento

1. **El paso lo pide.** El prompt nombra el consultor, el alcance y, si las hay, las acciones extra que
   autoriza (normalmente ninguna).
2. **Claude lo lanza** con la herramienta `Agent`, usando esta plantilla:

   ```text
   Consultor: <consultor-...>
   Paso: <número y nombre>
   Commit: <salida de git rev-parse --short HEAD>
   Alcance: <archivos, carpetas o diff; por ejemplo git diff <hash>..HEAD>
   Pregunta: <qué debe buscar, en una o dos frases>
   Autorizaciones extra: ninguna
   ```

3. **Claude verifica el informe** antes de usarlo (`trading-project-engineer` §11): reproduce la evidencia de
   cada hallazgo Critical y High, ejecuta los comandos de «Comandos para la sesión principal» que los
   confirman y descarta lo que no se sostenga, diciendo por qué. Antes de ejecutar un comando del informe
   comprueba que no escribe, no cambia el estado de git, no usa la red y no ejecuta `src/`; si lo hace, no
   lo ejecuta y lo dice. Un hallazgo sin evidencia no se presenta como hallazgo.
4. **Se presenta a la persona** en el resumen del paso: cuántos hallazgos hay por severidad, cuáles se
   verificaron y cuáles se descartaron. El informe del consultor no se guarda en el repositorio salvo que el
   paso lo pida.
5. **No se arregla en el mismo paso** salvo que el prompt lo pida. Cada arreglo es un cambio aparte, con su
   test, y los Critical y High pendientes se anotan en `PROGRESS.md` como riesgo vigente.

## 5. Qué garantiza la herramienta y qué no

| Garantía | Cómo | Límite |
|---|---|---|
| No editan archivos | `tools` solo lista `Read`, `Grep` y `Glob`; `disallowedTools` quita `Write`, `Edit` y `NotebookEdit` | Ninguno |
| No ejecutan comandos | Ni `Bash` ni `PowerShell` están en `tools`, y ambos están en `disallowedTools` | Los comandos que proponen los ejecuta la sesión principal, que los revisa antes (§4.3) |
| No lanzan otros agentes | Ni `Agent` ni `Skill` están en `tools`, y ambos están en `disallowedTools` | Ninguno |
| No leen `.env*` | El hook `scripts/claude-guard.ts` también se aplica a los subagentes y bloquea `Read`, `Grep` y `Glob` cuya ruta o patrón nombra un `.env*` | Un `Grep` sobre una carpeta no nombra el archivo: que no muestre el contenido de `.env` depende de que la búsqueda lo excluya (oculto e ignorado por git) y de la regla 6. [verificar] |
| No leen el test final | Regla 6. Desde el paso 13, el hook bloquea `Read` y `Grep` sobre `data/holdout/` y `config/holdout.lock`, y `permissions.deny` lo repite | Un `Grep` sobre una carpeta superior no nombra el archivo y puede mostrar líneas de `config/holdout.lock`: ahí depende de la regla 6 |
| No se ejecutan sin que el paso lo pida | `CLAUDE.md` §2 y la descripción de cada agente | No hay bloqueo técnico: Claude puede delegar por la descripción. Bloquearlo con `permissions.deny` impediría también lanzarlos cuando un paso lo pide |
| El formato de salida es fijo | Las reglas comunes y la verificación del paso 4.3 | Ningún test valida el informe; solo el texto de los agentes |

Cada consultor empieza sin contexto y lee sus skills: es caro. Se pide con un alcance concreto, no «revisa
todo el repositorio».

## 6. Cambiar un consultor

- Las reglas comunes se cambian aquí (§3) y en los cuatro agentes en el mismo commit; el test compara las
  copias.
- Cambiar herramientas, añadir o quitar un consultor, o cambiar las severidades es una decisión: va a un ADR
  y necesita aprobación.
- La parte propia de cada agente (qué lee y qué busca) se puede afinar en el paso que la use, diciéndolo en el
  resumen.
