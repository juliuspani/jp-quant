# Registro de dependencias

Lista de todas las dependencias de `package.json`, runtime y de desarrollo. Las reglas para añadir una
están en el skill `trading-project-engineer` §9, y la decisión en
[ADR 0006](adr/0006-estandar-de-ingenieria.md).

- Modo autónomo (`CLAUDE.md` §7, [ADR 0011](adr/0011-modo-autonomo.md)): una dependencia nueva, también de
  desarrollo, se aprueba automáticamente si tiene licencia MIT, Apache-2.0, BSD o ISC, está mantenida, va
  con versión exacta publicada hace al menos 7 días, no tiene scripts de instalación y se registra aquí con
  su motivo. Si falla alguna condición, se busca una alternativa; solo si no la hay se pregunta a la persona.
  La evaluación (motivo, alternativa nativa, mantenimiento, scripts, licencia y tamaño) queda en esta tabla,
  y en un ADR si la dependencia es importante.
- Las dependencias de abajo son anteriores a esta regla y no todas la cumplen. `ccxt` es una excepción
  aprobada: tiene un `postinstall` con peticiones de red, pero conserva la aprobación expresa del paso 9B
  (ADR 0011, decisión 4; el script se decide en el paso 39). Las de desarrollo usan `^` o `~` hasta que se
  revisen.
- Añadir o quitar un paquete exige actualizar esta tabla en el mismo commit.
  `test/skills/trading-project-engineer.test.ts` falla si `package.json` y esta tabla no coinciden.
- Las dependencias anteriores al paso 8 se registraron sin volver a evaluarlas.

| Paquete | Tipo | Licencia | Para qué | Justificación |
|---|---|---|---|---|
| `ccxt` | runtime | MIT | Acceso a los exchanges | Implementación inicial (`PRE-REFACTOR-RECOVERY`). Versión exacta `4.5.84`, aprobada el 2026-10-02 (paso 9B): ADR 0007 y `docs/CCXT.md` §4. Se revisa en el paso 17 al elegir el exchange  Paso 49: `overrides` de su dependencia `undici` a `7.30.1` (MIT, sin scripts de instalación, publicada el 2026-10-15), parche de seguridad bajo la excepción del ADR 0007: ccxt fija `7.29.1`, afectada por varios avisos High (DoS y validación TLS). La propuesta de npm era bajar ccxt a `4.5.64` (SEC-04). |
| `zod` | runtime | MIT | Esquema tipado y validado de la configuración (`src/config/`) | Paso 16, aprobada por la persona en el prompt y conforme a la regla automática. Versión exacta `4.6.5`, publicada el 2026-09-13. Sin dependencias ni scripts de instalación; 7,7 MB instalada (incluye las variantes `mini` y `v3`). Un solo mantenedor principal (colinhacks), versiones frecuentes y `npm audit` sin avisos el 2026-10-07. Alternativa nativa: la validación a mano del código previo (`merge` y `validate`), que no da tipos derivados del esquema y obliga a repetir cada campo dos veces. ADR 0017  Paso 49: subida a `4.6.7` (publicada el 2026-10-12, sin cambio mayor) por GHSA-mrhx-c7xc-m3w5, que afecta a `< 4.6.6` (CONSULTOR SECURITY, SEC-04). |
| `big.js` | runtime | MIT | Aritmética decimal exacta dentro del tipo `Decimal` (`src/shared/decimal.ts`, el único archivo de `src/` que la importa) | Paso 18, ADR 0014; aprobada por la persona en el paso y conforme a la regla automática. Versión exacta `7.0.1`, publicada el 2025-04-21. Sin dependencias ni scripts de instalación (solo `test`); 58 KB. Un solo mantenedor (MikeMcl) y sin versiones desde abril de 2025: riesgo aceptado en el ADR 0014, porque el envoltorio permite cambiarla tocando un archivo. `npm audit` sin avisos el 2026-10-08. Alternativa nativa: `bigint`, descartada en el ADR 0005 (división y redondeo fáciles de equivocar) |
| `@duckdb/node-api` | runtime | MIT | Escribir y leer el almacén de investigación en Parquet con columnas `DECIMAL(38,18)` (`src/historical/store.ts`) | Paso 18, ADR 0020; aprobada por la persona en el paso y conforme a la regla automática. Versión exacta `1.5.6-r.1`, publicada el 2026-09-28 por DuckDB Labs (versiones mensuales). Sin scripts de instalación, tampoco en sus dependencias: `@duckdb/node-bindings` (MIT), `detect-libc` (Apache-2.0) y el binario nativo de cada plataforma como dependencia opcional (`@duckdb/node-bindings-win32-x64`, 38 MB; en Linux x64, 71 MB). `npm audit` sin avisos el 2026-10-08. Se usa sin descargar extensiones (`autoinstall_known_extensions` y `autoload_known_extensions` a `false`): Parquet viene en el binario. Alternativa nativa: ninguna, Node no lee ni escribe Parquet; `node:sqlite` no tiene tipo decimal |
| `typescript` | desarrollo | Apache-2.0 | `tsc --noEmit` | ADR 0001 y ADR 0004 |
| `@types/big.js` | desarrollo | MIT | Tipos de big.js para el typecheck | Paso 18, ADR 0014; aprobada por la persona y conforme a la regla automática. Versión exacta `7.0.0`, publicada el 2026-05-21 por DefinitelyTyped. Sin dependencias ni scripts; 18 KB. Funciona con `module: NodeNext` y `verbatimModuleSyntax`: el typecheck pasa y Node carga `big.mjs` |
| `@types/node` | desarrollo | MIT | Tipos de Node para el typecheck | Implementación inicial. Fijado en `^24`, la versión de Node del proyecto, aprobado el 2026-10-05 (paso 13): con `^26` el typecheck aceptaba APIs que Node 24 no tiene |
| `eslint` | desarrollo | MIT | Lint | ADR 0001 |
| `typescript-eslint` | desarrollo | MIT | Reglas de ESLint con tipos | ADR 0001 y ADR 0004 |
| `dependency-cruiser` | desarrollo | MIT | Límites arquitectónicos | ADR 0001, decisión 2 |
| `secretlint` | desarrollo | MIT | Escaneo de secretos | ADR 0001, decisión 3 |
| `@secretlint/secretlint-rule-preset-recommend` | desarrollo | MIT | Reglas de secretlint | ADR 0001, decisión 3 |
