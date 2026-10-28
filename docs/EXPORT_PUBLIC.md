# Exportación de la copia pública

Este repositorio privado es la **fuente de verdad** (decisión de la persona, 2026-10-28). La copia pública
[`juliuspani/jp-quant`](https://github.com/juliuspani/jp-quant) no se desarrolla directamente: se actualiza en cada versión
con `scripts/export-public.ts` y esta lista, que aplican el mismo filtro de seguridad del paso 49 (ADR 0048).

## Qué hace el script

`node scripts/export-public.ts --destino <carpeta de jp-quant>`:

1. **Exporta HEAD, no el árbol de trabajo.** Lo hace con `git archive` y se niega si hay cambios sin confirmar aquí o en
   el destino.
2. **Deja fuera lo privado** (`EXCLUDED`): `PROGRESS.md`, `docs/progress/`, `.claude/commands/`, archivos locales de
   Claude, `export/` y su propia prueba.
3. **Ajusta los textos de `TRANSFORMED`:**
   - `CLAUDE.md`, sin el import de las notas personales y con la nota de copia pública;
   - los enlaces a `PLAN_MAP.md`;
   - las notas de los documentos principales;
   - los permisos de `.claude/settings.json` (SEC-03).

   Si falta un ancla, se detiene.
4. **Reduce las salidas de los experimentos** (`reduceOutput`, SEC-02): sin curvas, operaciones ni series de la
   rejilla.
5. **Pone las versiones públicas de las pruebas** que leen archivos privados (`export/overlay/`). Se niega si su
   original privado cambió desde que se hicieron (`export/overlay.json`).
6. **Escribe el resultado en el destino**, borrando lo que ya no se exporta. No hace commit ni push.

`test/scripts/export-public.test.ts` comprueba en cada `check:all` de este repositorio que las anclas, las huellas y la
reducción siguen valiendo. `test/docs/public-copy.test.ts` comprueba que lo que se publica no lleva rutas del ordenador,
nombres de equipo ni correos personales.

## Lista de cada versión

1. Aquí: `npm run check:all` y `npm run secrets` en verde, y todo confirmado.
2. Si la versión toca una prueba con versión pública, actualizar `export/overlay/<ruta>.txt` y su huella en
   `export/overlay.json`, y repetir el punto 1.
3. En `jp-quant`, sin cambios pendientes: `node scripts/export-public.ts --destino <carpeta de jp-quant>`.
4. En `jp-quant`: `npm ci --ignore-scripts`, `npm run check:all`, `npm run secrets` y `npm audit --omit=dev`, todos en
   verde.
5. **Revisar el diff entero en `jp-quant`** (`git status` y `git diff`) antes de confirmar: nada de `PROGRESS.md`, del
   registro privado, de datos de mercado, de diarios reales, de rutas ni de correos.
6. Si cambió la demo, volver a grabar el GIF y la vista previa con `scripts/record-demo.ts`. Salen siempre de la demo
   sintética.
7. Actualizar `CHANGELOG.md` aquí (y volver a exportar), con la versión.
8. **Parada obligatoria:** la persona aprueba el push. Después, commit en `jp-quant` con el email noreply, push, la
   etiqueta de la versión y su release con las notas del CHANGELOG.
9. Comprobar que el CI de `main` y el de la etiqueta y Pages terminan en verde, y que la demo publicada carga sin
   errores de consola.

## Qué no hacer

- No editar archivos en `jp-quant` a mano: el cambio se pierde en la siguiente exportación. Se hace aquí y se exporta.
- No hacer force push ni mover etiquetas publicadas.
- No publicar nunca un dashboard generado con diarios reales: solo la demo sintética.
