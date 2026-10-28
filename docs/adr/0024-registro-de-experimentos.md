# ADR 0024 — Registro de experimentos: JSONL encadenado en git, no DuckDB

Fecha: 2026-10-13 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 21

## Contexto

El ADR 0002 (decisión 5) aprobó de forma provisional el registro de experimentos como un JSONL versionado en git,
en `docs/research/experiments/registry.jsonl`, y dejó al paso 21 la decisión de migrarlo a una base de datos. El
prompt del paso 21 pide construir el registro antes de ejecutar ningún backtest y decidir con un ADR entre mantener
el JSONL o migrar a DuckDB, que ya es dependencia del almacén histórico (ADR 0020). Requisitos del prompt:

- Cada ejecución guarda la versión de la estrategia, el commit (y aborta si hay cambios sin confirmar), el dataset y
  su hash, el universo, los parámetros, la semilla, el modelo de costes, las fechas, los periodos de train,
  validation y test, las métricas y el hash de la salida.
- Toda ejecución se registra, también las fallidas o descartadas. El registro es solo de inserción.
- Un contador global de pruebas por familia de estrategia, para el Deflated Sharpe.
- Cualquier experimento se reproduce exactamente a partir de su id, con una prueba que lo demuestra.

El paso 21 tiene además un compromiso del paso 17: dar de alta como pruebas previas de su familia lo de
`docs/research/02`, con el inventario del ADR 0019, para que cuenten en el Deflated Sharpe.

## Decisión

### 1. Se mantiene el JSONL en git; no se migra a DuckDB

El registro sigue en `docs/research/experiments/registry.jsonl`, versionado en git, una línea JSON por evento.

| Criterio | JSONL en git | DuckDB |
|---|---|---|
| Solo inserción comprobable | Sí: un diff de git muestra cualquier línea cambiada, y la cadena de hashes (decisión 2) lo detecta al leer | No: un archivo binario no se revisa en un diff, y DuckDB no admite triggers que impidan un `UPDATE` o un `DELETE` |
| Volumen | Cientos o pocos miles de líneas: se lee entero en milisegundos | Pensado para millones de filas: no aporta nada aquí |
| Revisión humana | Se lee con cualquier editor y en GitHub | Necesita un cliente |
| Consultas | Para analizar, DuckDB puede leer el JSONL (`read_json`) sin ser la fuente de verdad | Nativas |
| Reversibilidad | Migrar después a una base de datos es convertir un archivo | Volver de una base binaria a un texto revisable cuesta más |

Es la opción más conservadora y reversible: la integridad del registro es lo que protege el Deflated Sharpe, y un
JSONL en git es lo único de las dos opciones cuya integridad se puede verificar sin confiar en el proceso que escribe.

### 2. Integridad: JSON canónico, cadena de hashes y comprobación completa al leer

- Cada línea es JSON canónico (`src/shared/canonical.ts`: claves ordenadas). Una línea con la misma información
  escrita de otra forma se rechaza.
- Cada línea lleva en `anterior` el SHA-256 de la línea previa (64 ceros en la primera). Editar, borrar o reordenar
  una línea rompe la cadena.
- `parseRegistry` comprueba el archivo entero en cada lectura y en cada escritura: esquema (zod), cadena, ids
  correlativos, ciclo de vida, cuentas por familia y fechas que no retroceden. Cualquier fallo invalida el registro
  entero (fail closed).
- Antes de escribir, la línea nueva se comprueba junto con todo lo anterior: si no pasa, no se escribe. La escritura
  se hace con `fsync` y con un candado de archivo (`registry.jsonl.lock`, creado en exclusiva) para que dos procesos
  no intercalen líneas. Si un proceso muere con el candado puesto, el registro queda bloqueado hasta que una persona
  lo borra: se prefiere un bloqueo visible a una escritura intercalada.
- Una prueba compara el registro del árbol de trabajo con el del último commit: el de HEAD tiene que ser un prefijo
  exacto. Así un cambio en una línea ya confirmada no pasa el `pre-commit`.

### 3. Qué guarda cada ejecución

| Pide el prompt | Campo |
|---|---|
| Versión de la estrategia | `estrategia: { nombre, version }`; con `version` en formato `x.y.z` |
| Commit | `commit`: hash completo de HEAD |
| Dataset y su hash | `datos: { fuente, dataset, version, timeframe, rango, hash }` |
| Universo | `universo: { regla, simbolos }` |
| Parámetros | `parametros`: `{ tipo: 'valores' }` o `{ tipo: 'rejilla' }` con la rejilla completa |
| Semilla | `semilla`: un entero de 32 bits; cada uso deriva su propio flujo con `seededRng(semilla, flujo)` |
| Modelo de costes | `costes: { comision, spread, slippage, multiplicador }`, por lado y en fracción, como texto decimal |
| Fechas | `fecha` en cada línea (pre-registro y cierre), además de los rangos |
| Train, validation y test | `particiones: { tramos: [{ train, validation }], test: null, purging_velas, embargo_velas }` |
| Métricas | `resultado.metricas` en la línea de cierre |
| Hash de la salida | `resultado.hash_salida`: SHA-256 del JSON canónico de `{ metricas, salida }` |

Además de los campos de `quant-research` §10: `formato`, `anterior`, `previa`, `familia_nueva`, `n_pruebas` y,
en los cierres, `referencia` (el hash de la última línea del experimento que cierra o corrige).

Reglas para un experimento nuevo, que el registro comprueba: commit, dataset, versión, hash, semilla, particiones y
costes presentes; comisión ≥ 0,10 % y slippage ≥ 0,05 % por lado (`quant-research` §5); tramos en orden, dentro del
rango de los datos y sin solaparse; embargo ≥ purging; y `n_pruebas` igual al tamaño de la rejilla.

### 4. Toda ejecución queda registrada

`runExperiment` (`src/research/experiment.ts`) sigue siempre este orden:

1. El árbol de trabajo está limpio y se anota el commit. Si no, se aborta **sin escribir**: no se ha cargado ni
   mirado nada, así que no es una prueba.
2. Pre-registro (`registrado`) antes de cargar los datos (`quant-research` §2). El hash de los datos sale del
   manifiesto, sin cargarlos.
3. Carga, comprobación de que el contenido tiene el hash registrado, y ejecución.
4. Cierre `completado` con métricas y hash de salida. Si algo lanza después del pre-registro, cierre `fallido` con
   el motivo, y el error se relanza.

Un experimento que se descarta se cierra como `abortado` si seguía abierto (por ejemplo, porque el proceso murió) o
como `invalidado` si ya estaba cerrado. Los estados son los cinco de `quant-research` §10, sin añadir ninguno: tras
`completado`, `fallido` o `abortado` solo cabe `invalidado`, y tras `invalidado` nada.

### 5. Cambios sin confirmar: solo se admiten los del propio registro

Se aborta ante cualquier cambio sin confirmar, también un archivo nuevo que git no ignora. La única excepción es
`docs/research/experiments/`: el registro y los informes son la salida de los experimentos, y exigir un commit entre
dos ejecuciones no añade seguridad.

### 6. Contador por familia, derivado del archivo

La N del Deflated Sharpe de una familia es la suma de `n_pruebas` de todos sus experimentos, en cualquier estado
(`trialsByFamily` y `trialsInFamily` en `src/research/registry.ts`). No hay un contador aparte que pueda desviarse:
la cuenta se deriva del registro, y `n_familia` de cada pre-registro tiene que coincidir con ella.

- Un barrido cuenta tantas pruebas como configuraciones tiene la rejilla.
- Una familia nueva se declara con `familia_nueva: true`, y una existente con `false`. Así una errata en el nombre no
  abre una familia con N = 1 y un Deflated Sharpe más laxo.

### 7. Reproducción exacta desde el id

`reproduceExperiment(ctx, id)` lee el pre-registro y el cierre `completado`, y vuelve a ejecutar con la misma
entrada. La entrada del ejecutor se construye siempre desde la línea registrada, también en la primera ejecución:
las dos reciben exactamente lo mismo. Exige:

- **El mismo código:** árbol limpio y, entre el commit registrado y HEAD, solo cambios de documentación (`docs/` y
  los `.md` de la raíz). Si cambió algo más, también `package-lock.json` o la configuración, se reproduce en un
  worktree de ese commit (`git worktree add`) pasando la ruta de este registro.
- **Los mismos datos:** el hash del manifiesto y el del contenido cargado coinciden con el registrado.
- **El mismo ejecutor:** el de `estrategia.nombre@version`.
- **La misma salida:** métricas y `hash_salida` idénticos. Si no, `ReproductionError`.

La reproducción no escribe en el registro: no es una prueba nueva, sino la comprobación de una que ya cuenta en N.
Registrarla inflaría N sin haber mirado nada nuevo.

### 8. El test final no se abre desde el registro

`particiones.test` es siempre `null`: el esquema no admite otro valor. Las etapas 2 y 3 del ADR 0019 (pasos 42 y
46) ampliarán el esquema con la autorización humana. Hasta entonces, la guarda de `historical/` (ADR 0020) sigue
siendo la barrera al cargar datos.

### 9. Pruebas previas de `docs/research/02`

Se dan de alta con `previa: true`, sin commit, semilla, costes ni particiones reproducibles, y se cierran como
`invalidado` (`quant-research` §10). Una prueba previa no puede cerrarse de otra forma. Se registra un experimento
por grupo del inventario del ADR 0019, partido por marco temporal cuando el grupo usa varios (20 en total,
`EXP-0001` a `EXP-0020`), con `n_pruebas` igual a su cuenta (el mínimo seguro donde el documento da un rango). El
universo puede quedar vacío solo en una prueba previa cuyo documento no detalla los pares:

| Familia | N |
|---|---|
| `tendencia-donchian-atr` | 48 |
| `regimen-btc-sma200` | 3 |
| `reversion-rsi2` | 7 |
| `ruptura-volatilidad-intradia` | 1 |
| `dca-btc` | 2 |
| `vistazos-descriptivos` | 2 (correlaciones y caídas frente a BTC; movimiento mediano por marco) |

### 10. `canonical.ts` pasa de `backtest/` a `shared/`

`research/` no puede importar `backtest/` (ARCHITECTURE.md §15.1), y ARCHITECTURE.md §4.2 ya situaba el JSON
canónico en `shared/`. Se mueve sin cambios de comportamiento; el hash fijado del replay no cambia.

## Alternativas

| Opción | Por qué no |
|---|---|
| Migrar a DuckDB | Ver decisión 1: binario, sin triggers, sin revisión en git, y sin ventaja con este volumen |
| SQLite (`node:sqlite`) | Ya descartado en el ADR 0002: no se revisa en un diff. Además, solo `persistence/` puede abrirlo |
| Un archivo por experimento | Un borrado no deja rastro en el árbol de trabajo, y la cuenta de N depende de listar una carpeta |
| Un contador de N aparte | Se puede desviar del registro; derivarlo del archivo lo hace imposible |
| Registrar también las reproducciones | Inflaría N con pruebas que no miran nada nuevo |
| Abortar también por cambios en `docs/research/experiments/` | Obliga a un commit entre dos ejecuciones sin proteger nada: el registro se protege con la cadena |

## Consecuencias

- **La cadena detecta, no impide.** Quien reescriba el archivo entero recalculando la cadena pasa la lectura; lo
  frena la prueba que compara con HEAD y, después, el historial de git. Los hooks de git se pueden saltar con
  `--no-verify` (riesgo ya conocido).
- **El puerto de datos real llega en el paso 23.** `DatasetPort` lo implementará la composición con
  `historical/` (manifiesto y `readDataset`, que ya comprueba el SHA-256 del contenido); `research/` no puede
  importar `historical/`. Hasta entonces, el registro solo se ha ejercitado con datos sintéticos en las pruebas.
- **El determinismo es responsabilidad del ejecutor.** El registro no lo garantiza, pero la reproducción lo detecta:
  una prueba demuestra que un ejecutor no determinista falla al reproducirse.
- **`veredicto` queda en `null`** hasta que exista el protocolo de §8 y §9 (DSR, PBO, bootstrap): los pasos 23 a 27.
- **El skill `quant-research` §10 no lista los campos nuevos** (`estrategia`, `previa`, `familia_nueva`,
  `n_pruebas`, `referencia`, `formato`, `anterior`). `.claude/` solo lo edita la persona: queda como propuesta en
  `PROGRESS.md`. El código manda sobre la lista del skill solo en esos añadidos; no contradice nada de él.
- **Un candado huérfano** bloquea el registro hasta que una persona lo borra.

## Nota del paso 23 (2026-10-13)

El puerto de datos real ya existe (`src/app/datasets.ts`, ADR 0026): compone `historical/` desde `app/`, su hash cubre
los manifiestos y cada par se lee por la guarda del test final. Con él llegan el ejecutor del backtester por
`nombre@versión` (`src/app/research-runner.ts`) y el comando de backtest, que solo ejecuta por `runExperiment`. El primer
experimento con datos reales pasa al paso 25, que trae la primera estrategia con parámetros de la literatura (ADR 0026,
decisión 9).

## Nota posterior (2026-10-22, paso 31)

El ADR 0044 añade los experimentos que solo eligen en train (campo `solo_eleccion` del pre-registro). La apertura de
`particiones.test` para la comprobación hacia delante de A pasa al paso 53 (ADR 0043).
