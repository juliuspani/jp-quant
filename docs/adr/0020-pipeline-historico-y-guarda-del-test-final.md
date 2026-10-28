# ADR 0020 — Pipeline de datos históricos y guarda del test final

Fecha: 2026-10-08 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso; las
dependencias y el plan del test final los aprobó en el paso) · Paso: 18

## Contexto

El paso 18 pide un pipeline de datos históricos con datasets versionados, UTC, procedencia, checksums,
deduplicación, detección de huecos, validación de calidad, altas y bajas de pares y universo point-in-time;
almacenamiento en Parquet/DuckDB sin float para precios ni cantidades, con un test sobre el esquema; los datos
del test final separados en `data/holdout/`, su hash en `config/holdout.lock` y un lector que se niega a servirlos
sin el flag `HOLDOUT_UNLOCK` firmado por la persona; y tests contra look-ahead y contra el acceso al test final.

Restricciones que ya existían: Claude no lee ni escribe el candado ni `data/holdout/` (hook, `permissions.deny`,
M-13 y ADR 0019); el test final va hacia delante, del 2026-10-01 al 2027-10-01, y sus datos solo se descargan
cuando una persona abre una etapa (`DATA.md` §4); descargar es una acción con permiso.

## Decisión

1. **Formato.** Un dataset es `<raíz>/<dataset>/<versión>/candles.parquet` y `manifest.json`. La raíz de
   investigación es `data/historical/` y la del test final, `data/holdout/`; las dos las ignora git.
   - **Esquema:** `symbol` y `timeframe` en `VARCHAR`; `open_time`, `close_time` y `received_time` en `BIGINT`
     (milisegundos UTC); `open`, `high`, `low`, `close` y `volume` en `DECIMAL(38,18)`. Un valor con más de 18
     decimales o más de 20 cifras enteras se rechaza: nunca se redondea en silencio. DuckDB recibe el texto
     canónico de `Decimal` y lo convierte con `CAST`; al leer, se devuelve como texto y se vuelve a `Decimal`.
   - **Versión = contenido.** La versión son los 16 primeros caracteres del SHA-256 de la serialización canónica
     de las velas. Una versión que existe no se reescribe; se construye en `.tmp-<versión>` y se mueve entera.
   - **Manifiesto:** procedencia (proveedor, URL, fecha de descarga, SHA-256 del original y términos), timeframe,
     latencia, símbolos, rango UTC, filas, SHA-256 del contenido y del archivo, e informe de calidad. La lectura
     comprueba el SHA-256 del archivo, el esquema sin float y el SHA-256 del contenido.
   - **DuckDB sin red:** `autoinstall_known_extensions`, `autoload_known_extensions` y
     `allow_community_extensions` a `false`; Parquet viene en el binario. Base en memoria por operación.
2. **UTC.** Las fechas solo se aceptan en ISO 8601 con `Z` o como epoch en texto de dígitos; se rechazan los
   desfases y las fechas imposibles (`src/shared/time.ts`). Las velas deben estar alineadas con su marco en UTC.
3. **`received_time`** de una vela histórica = cierre + latencia mínima de la fuente (ARCHITECTURE.md §5.1). Cada
   dataset declara su latencia en el manifiesto; la captura la fija y nunca es negativa. Ningún lector entrega un
   dato antes de su `received_time`, y la calidad excluye una vela cuyo `received_time` sea anterior al cierre.
4. **Calidad.** Se excluyen con su motivo las velas con precio no positivo, volumen negativo, `high` o `low`
   incoherentes, mal alineadas o con cierre incorrecto. De los duplicados idénticos se queda una copia; si las
   copias discrepan, se excluyen todas (no se elige una) y el hueco queda a la vista. Los huecos se informan y no se
   rellenan nunca (`quant-research` §3).
5. **Universo point-in-time.** Altas y bajas salen de una fuente que incluye los pares deslistados (el ZIP de
   Kraken): alta = apertura de la primera vela; baja = cierre de la última, si el par ya no figura al final de la
   cobertura. **Una historia sin ningún par deslistado no responde por ninguna fecha** (`SurvivorshipBiasError`):
   así no se puede reconstruir el pasado con los supervivientes de hoy. La alternativa con el sesgo declarado de
   `DATA.md` §2.4 no se implementa; si hiciera falta, va con otro ADR.
6. **Separación física del test final.** Una vela pertenece al test final si su `received_time` es igual o
   posterior al inicio del periodo del candado (2026-10-01T00:00:00Z): la de 1d del 2026-09-30 se conoce el 1 de
   octubre y no entra en investigación. La escritura de investigación rechaza cualquier vela del periodo, y la
   lectura de investigación se niega a abrir un dataset cuyo rango llegue al periodo o que esté bajo
   `data/holdout/`. Los datos del periodo solo se escriben bajo `data/holdout/`.
7. **Guarda del test final** (`src/historical/guard.ts`, el único archivo del código que nombra el test final
   además del hook). Fail closed: sin candado legible, no carga nada, ni siquiera investigación. El inicio del
   periodo está fijado también en el código: un candado con otro inicio se rechaza. Para abrir datos del periodo
   exige todo esto:
   - `dataHash` del candado distinto de `null` e igual a la huella de `data/holdout/` (SHA-256 de la lista ordenada
     de rutas relativas y SHA-256 de cada archivo);
   - `unlockPublicKey` en el candado: clave pública Ed25519 (SPKI DER en base64);
   - la variable `HOLDOUT_UNLOCK` con un token `v1.<payload>.<firma>` en base64url, firmado con la clave privada
     de la persona. El payload lleva el propósito, la etapa, el SHA-256 del candado, la emisión y la caducidad;
   - firma válida, propósito correcto, SHA-256 del candado igual al actual (cambiar el candado invalida los
     tokens), emitido y no caducado, validez máxima de 24 horas;
   - una etapa del candado con `opensTestData: true` cuya `notBeforeUtc` ya haya pasado (etapa 2 desde el
     2027-01-01, etapa 3 desde el 2027-10-01).
   Con la etapa 2 solo se ven los datos con `received_time` anterior o igual a la emisión del token; con la 3, el
   periodo completo.
8. **Lo que hace la persona** (M-13; Claude no puede escribir el candado). Ahora, nada. Al abrir una etapa, la
   captura y la lectura van separadas (aprobado por la persona el 2026-10-08, en la revisión del paso 19B):
   1. **modo captura:** descarga los datos del periodo solo a su carpeta protegida bajo `data/holdout/` (brutos y
      datasets) y calcula el `dataHash`. Ningún código de investigación los lee: el modo captura solo escribe en esa
      carpeta y da la huella, y la guarda de brutos (ADR 0022, decisión 14) sigue negando su lectura hasta el
      desbloqueo completo. Se implementa en el paso 42, antes del 2027-01-01 (apertura de la etapa 2);
   2. `node scripts/test-final-keygen.ts <ruta fuera del repositorio>`: crea el par Ed25519 y escribe la clave privada
      con permisos de solo dueño; muestra la pública;
   3. `node scripts/hash-dataset.ts data/holdout`: comprueba la huella que dio el modo captura;
   4. poner `dataHash` y `unlockPublicKey` en el candado;
   5. `node scripts/test-final-sign.ts <clave privada> config/holdout.lock <etapa> [horas]`: muestra el token, que la
      persona exporta en `HOLDOUT_UNLOCK` solo para esa ejecución. **Solo entonces se permite leerlos** (`authorize`,
      `loadTestFinal` y `rawFileForReading`).
9. **Campo nuevo del candado:** `unlockPublicKey` (cadena o `null`). Mientras falte o sea `null`, nada se abre.

## Alternativas descartadas

| Opción | Por qué no |
|---|---|
| HMAC con un secreto compartido | El código que verifica tendría el secreto y podría firmar; con Ed25519 el repositorio solo tiene la clave pública |
| Flag sin firma (`HOLDOUT_UNLOCK=1`) | Cualquiera, también Claude en un script, podría ponerlo; el prompt pide que lo firme la persona |
| Calcular ahora el hash de `data/holdout/` y escribirlo en el candado | No hay datos del periodo (va hacia delante y se descargan al abrir una etapa) y Claude no puede escribir el candado; decidido con la persona el 2026-10-08 |
| `DOUBLE` en Parquet, o `VARCHAR` para los precios | `DOUBLE` es float; `VARCHAR` impide calcular en DuckDB y no valida la escala |
| Versión correlativa (v1, v2…) | Depende del orden de escritura; el hash del contenido identifica la versión y detecta duplicados |
| Elegir una de las copias que discrepan | Sería inventar el dato; se excluyen y el hueco queda a la vista |
| hyparquet o parquet-wasm en lugar de DuckDB | Sin soporte comprobado de `DECIMAL` al escribir, o con binarios igualmente; DuckDB además permite consultar |

## Consecuencias

- `@duckdb/node-api` entra como dependencia de runtime con un binario nativo de 38 a 71 MB por plataforma.
- La regla «nunca float» se aplica a `src/historical/`: el tiempo usa `src/shared/time.ts`.
- La guarda protege del acceso accidental desde el código de investigación. No impide que un script lea
  `data/holdout/` directamente con `node:fs`: eso lo vigilan INV-13c (ningún código nombra el test final salvo la
  guarda y el hook) y el hook, que compara texto.
- La captura real (descarga del ZIP de Kraken, la API de Bitvavo y la foto diaria de mercados) no se hace en este
  paso: descargar necesita permiso y queda para el paso que la use (`DATA.md` §4).
- El candado cambia de forma cuando la persona añade `unlockPublicKey` y `dataHash`; el anexo A del ADR 0019 sigue
  valiendo con esos dos campos a `null`.

## Nota posterior (2026-10-22, paso 31)

La persona pasa el modo captura (decisión 8, paso 1) al paso 53, que se ejecuta después del 2027-10-01: es trabajo
previo de la comprobación hacia delante de A (ADR 0043). El resto de la decisión no cambia.
