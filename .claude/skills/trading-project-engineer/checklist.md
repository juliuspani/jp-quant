# Checklist de ingeniería

Se repasa antes de dar un paso por cerrado. Cada casilla sin marcar se explica en el resumen del paso
(SKILL.md §8). Las de «Dependencias» y «Subagentes» solo aplican si el paso los usa.

## Antes de empezar

- [ ] `PROGRESS.md`, `git status` y `git log -5` leídos; sin cambios sin confirmar que no aparezcan en `PROGRESS.md`
- [ ] Alcance escrito en una frase, con la lista de archivos que se van a tocar
- [ ] Skill de dominio cargado si el cambio toca research, riesgo o ejecución
- [ ] Estimado si la tarea cabe en una sesión; si no, partida en subpasos y anotada en `PROGRESS.md`

## Durante el cambio

- [ ] Solo se tocan los archivos necesarios; nada de reformatear ni renombrar fuera del alcance
- [ ] Ningún módulo no relacionado refactorizado; lo que esté fuera de alcance, anotado o preguntado
- [ ] Ninguna carpeta, configuración, script ni abstracción que el paso no necesite hoy
- [ ] Archivos leídos por tramos y con búsquedas dirigidas, no volcados enteros
- [ ] Sin `any`, `@ts-ignore`, `@ts-expect-error` sin justificar ni `catch` vacíos
- [ ] Ninguna entrada nueva en las listas de excepciones de lint o de límites
- [ ] Ninguna regla de ESLint, de límites o del hook relajada

## Tests

- [ ] Todo cambio de comportamiento con su test
- [ ] Error corregido con un test que lo reproducía y fallaba antes del arreglo
- [ ] Tests sin red, sin exchange real y sin `.env`
- [ ] Ningún test borrado ni debilitado para que pase

## Dependencias

- [ ] Cumple las cinco condiciones de aprobación automática (SKILL.md §9); si no, alternativa buscada y,
      solo si no la hay, aprobación expresa de la persona antes de instalar
- [ ] Motivo escrito
- [ ] Alternativa nativa de Node evaluada y descartada por escrito
- [ ] Mantenimiento comprobado: última versión, mantenedores e issues de seguridad
- [ ] Scripts de instalación revisados (`preinstall`, `install`, `postinstall`)
- [ ] Licencia MIT, Apache-2.0, BSD o ISC
- [ ] Publicada hace al menos 7 días
- [ ] Tamaño instalado y dependencias transitivas medidos
- [ ] Paquete y motivo en `docs/DEPENDENCIES.md` (y ADR si es importante)
- [ ] Versión exacta, instalada con `--ignore-scripts`, y `package-lock.json` versionado

## Subagentes

- [ ] Autorización explícita en el prompt
- [ ] Alcance exacto y reglas del proyecto pasados al subagente
- [ ] El subagente no lanza otros subagentes ni hace commits
- [ ] Resultado revisado antes de usarlo

## Antes del commit

- [ ] `npm run check:all` en PASS, con el resultado real de cada check anotado
- [ ] `npm run secrets` sin hallazgos
- [ ] Ningún secreto, clave ni valor de `.env` en el diff
- [ ] Documentos afectados actualizados en el mismo commit
- [ ] ADR para cada decisión no trivial
- [ ] `PROGRESS.md` actualizado
- [ ] Un solo cambio con sentido propio en el commit, sin mezclar comportamiento y formato
- [ ] Mensaje con `git commit -F`, sin `--no-verify`

## Cierre

- [ ] Resumen con qué cambió y por qué, archivos, checks reales, decisiones, riesgos y dudas
- [ ] Hash del commit anotado en `PROGRESS.md`
- [ ] Parado a la espera de aprobación antes del paso siguiente

