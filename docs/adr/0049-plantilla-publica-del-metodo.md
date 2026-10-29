# ADR 0049: plantilla pública del método de trabajo con Claude Code (paso 50)

Estado: aceptado y publicado el 2026-10-29 como `juliuspani/from-zero-to-repo` v1.0.0, en el paso 50

## Contexto

El paso 50 del plan B pide empaquetar el método de trabajo usado en este proyecto (constitución, `PROGRESS.md`,
`/arranque` y `/relevo`, consultores de solo lectura, hook de guarda, permisos y plantillas) en un repositorio nuevo e
independiente, reutilizable por cualquiera, sin nada de trading ni del entorno de la persona. Crear el repositorio público
y hacer el primer push es una parada obligatoria (acción irreversible fuera del repositorio), y antes de publicar se pide
una revisión de CONSULTOR SECURITY.

## Decisiones

1. **Repositorio aparte, sin historial común.** Carpeta hermana `claude-code-method`, con `git init` propio. No es una
   exportación de este repositorio (a diferencia de `jp-quant`): no copia código, solo el método reescrito y generalizado.
   Este repositorio no depende de él, y él no nombra este proyecto.
2. **En inglés**, con un resumen en español al final del README. Los comandos conservan sus nombres `/arranque` y
   `/relevo`, como pide el paso; el README explica que se pueden renombrar.
3. **Sin dependencias.** Hook y pruebas en JavaScript plano (`.mjs`, Node ≥ 20) para que funcione en cualquier proyecto
   sin compilar ni instalar. `npm test` comprueba con código lo que la plantilla predica: el comportamiento del hook,
   el límite de 200 líneas, el bloque común idéntico de los consultores, que son de solo lectura, que `settings.json`
   coincide con su copia comentada, la numeración de los ADR y que cada skill dice cuándo usarse.
4. **`settings.json` comentado mediante una copia `settings.jsonc`.** JSON no admite comentarios: la explicación de
   `allow`, `ask` y `deny` vive en la copia, un script la convierte (`npm run settings`) y una prueba detecta la deriva.
5. **Las guardas las edita una persona.** Lección de este proyecto (ADR 0011): el clasificador bloqueó como
   automodificación que Claude editara `.claude/`. La plantilla lo convierte en regla: el hook y `deny` bloquean escribir
   `.claude/settings*` y `.claude/hooks/`; skills, comandos y agentes siguen siendo archivos editables del proyecto.
6. **`git push` en `ask`**, no en `allow`: en una plantilla para cualquiera, salir de la máquina pide un sí.
7. **Sin datos personales.** Licencia MIT a nombre de «The claude-code-method contributors». Antes de publicar se busca en
   local una lista de patrones personales y del dominio. Esa lista no se versiona en la plantilla, porque publicarla ya
   sería filtrarlos.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Exportar con `scripts/export-public.ts` | Arrastraría la estructura de un proyecto de trading; el paso pide algo independiente |
| Plantilla en español | Reduce el alcance de una plantilla pública; el paso pide README en inglés |
| Hook en TypeScript como `claude-guard.ts` | Exige Node ≥ 22 con type stripping; `.mjs` funciona en más proyectos |
| Comentarios en `settings.json` | No es JSON válido |

## Consecuencias

- El hook de ejemplo es un cinturón, no un sandbox: compara texto, como el de este proyecto. El README lo dice.
- La plantilla no tiene hooks de git ni escaneo de secretos propios; el README los nombra como capa del proyecto que la
  adopte.
- Mantenerla es manual: los cambios del método aquí no se propagan solos.

## Revisión (2026-10-29): cambio de enfoque a principiantes (la persona, prompt «Paso 50 — versión final»)

Antes de publicar, la persona cambia el enfoque. El repositorio pasa a llamarse `from-zero-to-repo` y es una puerta de
entrada para principiantes absolutos. Todo lo anterior se conserva intacto como «Level 2 — Training Wheels for your agent»
(opcional), sin debilitar ninguna guarda ni prueba.

1. **Niveles:** Level 0, el glosario (`docs/start-here.md`); Level 1, la primera sesión en 10 pasos con una CLI de tareas
   de ejemplo (`docs/first-session.md`, `examples/todo-cli/`); la cheatsheet; y Level 2 (`docs/level-2.md`, el antiguo README).
2. **Piezas propias:**
   - el Mistakes Museum, con nueve fichas de errores reales, cada una con la prueba que lo demuestra;
   - los patrones de prompt, ocho en total;
   - el doctor (`doctor.mjs`).
3. **Doctor:** 10 comprobaciones de solo lectura que dan una nota y, con `--prompt`, el texto para arreglar cada fallo.
   - Solo pregunta a git `rev-parse`, `ls-files`, `check-ignore` y `config`, con `core.fsmonitor=false` y sin hooks.
   - `test/doctor.test.mjs` lo garantiza: huella de todo el árbol, `.git` incluido, antes y después, también con un
     fsmonitor hostil; análisis estático de sus imports y de sus APIs; nota máxima en el propio repositorio y 0/10 con
     fallos plantados.
4. **Estilo** (la persona): breve antes que completo, enlazar la documentación oficial en lugar de copiarla y sin
   capturas de interfaz.
5. **Autoría:** licencia MIT a nombre de la persona, por decisión suya, que sustituye a la decisión 7. Commits con el
   email noreply. Los enlaces a `jp-quant` son los únicos datos de identidad, también por decisión suya.
6. **Partido en dos sesiones** por contexto:
   - la parte 1 (doctor, museo, niveles, cheatsheet, patrones, Level 2, README y licencia) está confirmada en local;
   - la parte 2 queda pendiente: español, social preview, verificación completa, CONSULTOR SECURITY sobre lo nuevo,
     publicación, enlace cruzado en `jp-quant` y cierre.

## Resultado (2026-10-29, parte 2 de 2)

1. **Dr. Repo.** El doctor pasa a llamarse Dr. Repo (`dr-repo.mjs`, `npm run dr-repo`) para no confundirlo con el
   `/doctor` de Claude Code (la persona). Su salida tiene un toque de personaje: «Dr. Repo's diagnosis».
2. **Español.** Level 0, Level 1, la cheatsheet y el museo están en `docs/es/`, con selector de idioma.
   `test/links.test.mjs` valida cada enlace y cada ancla internos en los dos idiomas, y falló antes de existir `docs/es/`.
3. **Social preview.** `docs/assets/social-preview.png`, de 1280×640, se generó con Edge headless. La persona la sube a
   mano en Settings.
4. **Verificación.** Se siguieron los 10 pasos desde una carpeta limpia, con un `GIT_CONFIG_GLOBAL` temporal y un remoto
   bare local, y salió un fallo real: PowerShell de Windows se niega a ejecutar `npm.ps1` en una instalación nueva. La
   guía da `npm.cmd` como arreglo. El paso 7 lo comprueba la persona, porque `claude` no estaba en el PATH de la sesión.
5. **CONSULTOR SECURITY** sobre lo nuevo de las dos partes:
   - primera ronda: 1 Critical, 4 Medium y 3 Low;
   - segunda ronda, sobre los arreglos: 1 Medium nuevo y 3 Low;
   - cada hallazgo se verificó con una prueba que falló antes del arreglo, y todos quedaron corregidos.
6. **El Critical (S-01).** En un Windows con la configuración por defecto, es decir, sin
   `NoDefaultCurrentDirectoryInExePath`, Node busca el programa primero en la carpeta de trabajo. Un `git.exe` o un
   `git.com` plantados en el proyecto analizado se ejecutaban en lugar del git real. Ahora git se busca solo en carpetas
   absolutas del PATH, fuera del proyecto. Por el Critical, la publicación esperó a una nueva aprobación de la persona.
7. **Lo demás de la revisión:**
   - no se siguen enlaces fuera del proyecto;
   - los nombres que vienen del proyecto se imprimen escapados;
   - se detectan los comodines sobre shells, intérpretes, git e instalaciones, y se revisa `settings.local.json`;
   - si git no puede listar los archivos versionados, las comprobaciones que los necesitan fallan;
   - solo cuenta un `.gitignore` versionado;
   - no se sigue un `.git` que apunta a una carpeta de red;
   - la guía no propone `Set-ExecutionPolicy`.

   Límite declarado: git lee `.git/config`, así que un proyecto ajeno se clona, no se copia.
8. **Publicación** (la persona aprobó el orden):
   - push del repositorio público;
   - CI en verde en Ubuntu y Windows, con 49 pruebas, ninguna saltada, y con enlaces simbólicos reales en Ubuntu;
   - después, la plantilla, la descripción, los topics, Discussions activadas, Wiki y Projects desactivados, y la
     release v1.0.0, con su CI en verde.

   El primer push falló porque el token de `gh` no tenía el permiso `workflow`, y la persona lo añadió.
9. **Enlace cruzado.** Una línea en el punto 3 de «Project story» del README de `jp-quant`, exportada con
   `docs/EXPORT_PUBLIC.md`.

## Pulido final (2026-10-29, después del cierre del paso 50, la persona)

1. **Comandos `/start` y `/handoff`** en `from-zero-to-repo`: antes eran `/arranque` y `/relevo`. Se comprobó con la
   referencia oficial de comandos que ninguno choca con un comando integrado ni con un alias. `docs/es/start-here.md`
   explica la equivalencia una vez, y una prueba impide que vuelvan los nombres antiguos. Este repositorio y `jp-quant`
   siguen con `/arranque` y `/relevo`.
2. **Sello en archivo:** `docs/assets/seal.svg` y `docs/assets/seal-512.png`, el sello de la cabecera de la demo, sin
   fondo. Lo exporta la opción nueva `--transparente` de `npm run sello`, que solo quita el fondo. Las huellas fijadas no
   cambian, y una prueba compara los archivos con el sello de la cabecera. La versión pública de `seal.test.ts` se
   actualizó con su huella.
3. **Logo** centrado de 96 px sobre el título del README de `jp-quant`.
4. **Social previews definitivas:** la carpeta `social-previews` queda fuera de los repositorios, a la espera de las
   imágenes de la persona.
5. **CHANGELOG** de cada repositorio, como «Unreleased», sin etiquetas nuevas.
