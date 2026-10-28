# ADR 0016 — Invariantes de seguridad y trading como pruebas

Fecha: 2026-10-06 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) ·
Paso: 15

## Contexto

- **Las reglas de seguridad estaban repartidas** entre `CLAUDE.md` §2, los skills `trading-risk` y
  `exchange-execution`, `ARCHITECTURE.md` y los ADR 0003, 0005 y 0013. Algunas tenían prueba (límites, hook de
  Claude, ESLint) y otras solo texto. No había una lista única de lo que tiene que ser verdad siempre ni de cómo
  se comprueba cada cosa.
- **El paso 15 pide convertir cada regla en una prueba siempre que sea técnicamente posible**, y marcar las demás
  como controles manuales con su procedimiento.
- **Muchos invariantes dependen de módulos que aún no existen** (Risk Engine, capguard, `exchange/`, `app/`).
  Una prueba de un módulo que no existe no se puede escribir, pero tampoco puede quedarse olvidada.
- **Dos huecos encontrados al revisar el código:**
  - `loadSecrets` no tachaba de los logs la URL del latido (lleva su token) ni el chat de Telegram;
  - Claude podía activar el modo real para un solo comando (`LIVE_TRADING=<frase> npm start`) sin tocar `.env`,
    saltándose la aprobación humana.

## Decisión

1. **Un documento, [SECURITY_AND_TRADING_INVARIANTS.md](../../SECURITY_AND_TRADING_INVARIANTS.md)**, con catorce
   invariantes (INV-00 a INV-13). Cada uno tiene controles de tres tipos: `auto` (prueba de `npm test`), `manual`
   (procedimiento M-NN) y `pendiente` (prueba que se escribe en un paso concreto).
2. **El documento se prueba a sí mismo** (`test/invariants/registry.test.ts`):
   - cada control `auto` cita un archivo de prueba y un texto que ese archivo contiene;
   - cada control `manual` tiene su procedimiento;
   - cada prueba cuyo nombre empieza por `INV-` figura en la matriz, en su archivo;
   - la lista de invariantes está fijada en la prueba: quitar uno exige cambiarla;
   - **un control `pendiente` falla cuando su paso se cierra.** El paso cerrado se lee de `PROGRESS.md`
     («**Último paso cerrado:** N»). Si no se encuentra, la prueba falla.
3. **Pruebas nuevas en `test/invariants/`** para lo que ya se puede comprobar: confirmación exacta de
   `LIVE_TRADING` y arranque real rechazado (lanzando `src/main.ts` en una carpeta temporal, sin `.env` y sin
   red), ausencia de código de retiros y transferencias, regla de ESLint, archivos de secretos ignorados y no
   versionados, escaneo de secretos en el `pre-commit`, salida de la inteligencia acotada a un freno, código de
   LLM sin acceso a órdenes, modo consultado solo por la composición y el código previo listado, pruebas sin
   `.env`, y protección del test final.
4. **Arreglos de los dos huecos:** `loadSecrets` registra en el logger todos sus valores, y el hook de Claude
   bloquea cualquier comando de shell que nombre `LIVE_TRADING` o su frase. Para buscar la variable queda la
   herramienta `Grep`. La frase del hook no se importa de `src/config.ts` para que el hook no dependa de `src/`
   (si `src/` no compila, el hook seguiría funcionando); una prueba comprueba que coinciden.
5. **Los pasos de los controles pendientes** siguen el orden de construcción de ARCHITECTURE.md §19: 17 y 18
   para el test final, 32 para `app/` y `exchange/`, 35 para el Risk Engine, 36 para Execution y 39 para el
   capguard, que tiene que existir antes del micro-live.
6. **Cambiar o quitar un invariante, relajar un control o retrasar el paso de uno pendiente es una parada
   obligatoria** (`CLAUDE.md` §7, «los invariantes»). Añadir controles o pasar uno a `auto` no lo es.

## Alternativas descartadas

- **Pruebas `todo` o `skip` de `node:test` para lo pendiente.** No fallan nunca: se olvidarían. El control con
  paso falla solo cuando toca.
- **Escribir ya los módulos que faltan (kill switch, comprobación de datos obsoletos) para poder probarlos.**
  Contradice el orden de construcción y el alcance del paso, y añadiría código al `src/` previo, que se va a
  reescribir.
- **Probar el código previo de esos controles** (pausa, antigüedad de la señal). Ese código no cumple los
  invariantes y se reescribe; fijar su comportamiento con pruebas daría una falsa garantía.
- **Importar la frase de confirmación en el hook.** Un error de compilación en `src/` haría fallar el hook con
  un código distinto de 2, que Claude Code no trata como bloqueo: fallaría abierto.
- **Leer `LIVE_TRADING` solo del archivo `.env` y no del entorno.** Cambia el arranque del código previo y no
  cubre un VPS que use variables de entorno del supervisor. Se reconsidera en el paso 39.

## Consecuencias

- Un control pendiente cuyo paso se cierra sin su prueba rompe `check:all`: el paso no se puede cerrar.
- Si el tramo 2 no llega (paso 31 sin estrategia aprobada), los controles de los pasos 32 a 39 quedan pendientes
  y el modo real sigue sin activarse.
- La prueba depende del formato de `PROGRESS.md`. Si el relevo cambia la línea del último paso cerrado, la prueba
  falla y hay que ajustar una de las dos cosas.
- El hook bloquea también comandos inocentes que nombran la variable (por ejemplo, `git grep LIVE_TRADING`).
- Las pruebas que buscan texto no ven nombres construidos en tiempo de ejecución; lo cubren las capas físicas
  (clave sin retiros, subcuenta, VPS) y los controles manuales.
- `npm test` arranca `src/main.ts` cuatro veces; tarda unos segundos más (la primera carga de ccxt en frío puede
  tardar decenas de segundos).

## Nota del paso 23 (2026-10-14)

La persona aprobó un invariante nuevo, INV-14 «todo backtest pasa por el registro, con costes», con tres controles
`auto` en `test/invariants/backtest-registry.test.ts`. El documento pasa de catorce a quince invariantes.
