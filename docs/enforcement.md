# Enforcement automático

`CLAUDE.md` orienta; lo que sigue obliga. Cada regla tiene un mecanismo que falla solo.
Las decisiones de herramientas están en [ADR 0001](adr/0001-enforcement-automatico.md).

## Qué comprueba cada cosa

| Comando | Qué hace | Configuración |
|---|---|---|
| `npm run build` | `node --check` sobre cada `.ts` de `src/`, `scripts/` y `test/` | `scripts/build.ts` |
| `npm run typecheck` | `tsc --noEmit` | `tsconfig.json` |
| `npm run lint` | ESLint, cero avisos permitidos | `eslint.config.js` |
| `npm run boundaries` | Límites arquitectónicos con dependency-cruiser sobre `src/` y, si existe, `capguard/` | `scripts/boundaries.ts`, `.dependency-cruiser.cjs` |
| `npm test` | Pruebas (`node --test`) | `test/` |
| `npm run check:all` | Los cinco anteriores, en ese orden | `package.json` |
| `npm run secrets` | secretlint sobre todos los archivos versionados | `.secretlintrc.json` |

### Reglas de ESLint

- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/ban-ts-comment`: `@ts-ignore` y `@ts-nocheck` prohibidos; `@ts-expect-error` solo con
  una justificación de al menos 10 caracteres.
- `no-empty`, incluido el `catch` vacío.
- `@typescript-eslint/no-floating-promises`
- `no-console` en todo el código salvo `src/log.ts`, que es el logger.
- `no-restricted-syntax` contra cualquier acceso a un miembro llamado `withdraw*`: nunca retiros por API.
- `noInlineConfig`: un comentario `eslint-disable` no apaga nada.
- `inversor/no-float` (paso 18, ADR 0014), en los módulos de dinero y precios: `src/exchange/`,
  `src/execution/`, `src/risk/`, `src/portfolio/`, `src/historical/`, `src/backtest/` y `capguard/`. Prohíbe
  `parseFloat`, `parseInt`, `Number()`, `Number.parseFloat`, `Number.parseInt`, `new Number`, `Math.*`, el `+`
  unario y toda aritmética con `number` (operadores binarios, asignaciones compuestas, `++`, `--` y `-` unario
  salvo en un literal). Usa los tipos de typescript-eslint y lanza si no los tiene. Solo exceptúa
  `capguard/decimal.ts` (`src/backtest/sim.ts`, del código previo, salió en el paso 23); la lista está en
  `scripts/eslint-no-float.ts` y solo puede encoger. `test/enforcement/no-float.test.ts` lo comprueba con
  `test/fixtures/no-float/` y con la configuración real.
- Sin reloj ni azar propios (paso 19, ADR 0021), en el dominio de `ARCHITECTURE.md` §15.1 y en `src/backtest/`:
  `no-restricted-properties` (`Date.now`, `Math.random`, `performance.now`, `process.hrtime`, `process.uptime`,
  `globalThis.setTimeout` y parecidos, y los `crypto.random*`), `no-restricted-globals` (`setTimeout`,
  `setInterval`, `setImmediate` y `performance`), `no-restricted-imports` (`node:timers`, `node:perf_hooks` y las
  funciones de azar de `node:crypto`) y `no-restricted-syntax` (`new Date()` sin argumentos y `Date()`). La hora,
  los temporizadores y el azar llegan del kernel (`Clock`, `Rng` e `Ids`). Solo exceptúa
  `src/kernel/system-clock.ts`, el reloj de tiempo real; la lista está en `scripts/eslint-wall-clock.ts` y solo
  puede encoger. `test/enforcement/wall-clock.test.ts` lo comprueba con `test/fixtures/wall-clock/` y con la
  configuración real. No ve una función de reloj que llegue por otro nombre ni un adaptador inyectado.

### Límites arquitectónicos

Reglas del paso 4 (ADR 0001 y ADR 0003):

| Regla | Origen | No puede importar |
|---|---|---|
| `strategy-no-execution-ni-exchange` | `src/strategy/` | `src/execution/`, `src/exchange/` |
| `strategy-no-ccxt` | `src/strategy/` | `ccxt` |
| `features-no-execution-ni-risk` | `src/features/` | `src/execution/`, `src/risk/` |
| `solo-exchange-importa-ccxt` | todo `src/` salvo `src/exchange/` | `ccxt` |
| `llm-y-news-no-execution-ni-exchange` | cualquier carpeta `llm/` o `news/` | `src/execution/`, `src/exchange/` |
| `solo-risk-usa-el-firmante` | todo lo que no está en `src/risk/` | `src/risk/signer.ts` (ADR 0003) |
| `capguard-no-importa-src` | `capguard/` | `src/` (ADR 0003) |
| `src-no-importa-capguard` | `src/` | `capguard/` (ADR 0003) |
| `solo-decimal-importa-big-js` (paso 18) | todo salvo `src/shared/decimal.ts` y `capguard/decimal.ts` | `big.js` (ADR 0014) |

Reglas del paso 14 para las carpetas de la arquitectura (`ARCHITECTURE.md` §15, ADR 0015):

| Regla | Origen | No puede importar |
|---|---|---|
| `<módulo>-solo-importa-lo-permitido` (una por módulo, 17) | `src/<módulo>/` | Nada de `src/` fuera de su fila de la matriz (`ARCHITECTURE.md` §15.1), tampoco los archivos de la raíz |
| `config-solo-importa-lo-permitido` | `src/config/` | `src/app/` |
| `solo-persistence-usa-sqlite` | todo `src/` salvo `src/persistence/` | `node:sqlite` |
| `dominio-sin-entrada-salida` | `shared/`, `kernel/`, `marketdata/`, `features/`, `analytics/`, `strategy/`, `portfolio/`, `risk/`, `execution/` | Módulos de E/S de Node: `fs`, `net`, `http`, `https`, `http2`, `child_process`, `dgram`, `tls`, `dns`, `cluster`, `worker_threads`, `sqlite`, `readline`, `repl`, `inspector` |
| `dominio-sin-paquetes-npm` | los mismos, salvo `src/shared/decimal.ts` | Cualquier paquete de npm |

Regla del paso 22 (ADR 0025): las features no emiten órdenes.

| Regla | Origen | No puede importar |
|---|---|---|
| `features-sin-contratos-de-ordenes` | `src/features/` | `src/kernel/orders.ts`, `src/kernel/execution.ts`, `src/kernel/stores.ts` |

**Excepciones transitorias del código previo** (ADR 0015). Están escritas en `.dependency-cruiser.cjs`, no en
la lista de excepciones, y solo se pueden quitar:

- `src/strategy/trend.ts` puede importar `src/config.ts`, `src/indicators.ts` y `src/types.ts`;
- `src/store.ts` puede importar `node:sqlite` hasta el paso 33.

La de `src/backtest/sim.ts` desapareció con ese archivo en el paso 23: `test/fixtures/boundaries/bad/src/backtest/sim.ts`
comprueba que `backtest/` ya no puede importar `strategy/`.

Los `import type` cuentan como import. Las reglas ya están activas aunque las carpetas todavía no existan.
`scripts/boundaries.ts` pasa a dependency-cruiser `src/` y también `capguard/` cuando existe, porque
dependency-cruiser falla con una carpeta inexistente. `test/enforcement/boundaries.test.ts` ejecuta ese mismo
script sobre los árboles de ejemplo de `test/fixtures/boundaries/` y sobre el repositorio real. El árbol `bad/`
tiene un import prohibido por cada regla, y el árbol `ok/`, un import permitido de cada módulo y de cada
excepción.

`test/enforcement/layout.test.ts` comprueba la estructura de `src/`. Falla si:

- una carpeta de primer nivel no es un módulo de `ARCHITECTURE.md` §4;
- aparece en la raíz un archivo que no es del código previo (la lista solo encoge);
- un módulo no tiene su regla de la matriz;
- `ARCHITECTURE.md` no nombra cada módulo o tiene un enlace roto.

## Hooks de git

`npm install` ejecuta `prepare`, que fija `core.hooksPath=.githooks` y `merge.ff=false` en el repositorio
local. En un clon nuevo no hay hooks hasta ejecutar `npm install`.

- **`pre-commit`**: escaneo de secretos sobre el contenido preparado y, después, `check:all`.
  En ramas `wip/*` solo se exige el escaneo de secretos, para permitir commits de relevo.
- **`pre-merge-commit`**: escaneo de secretos y `check:all` sobre el resultado de cualquier fusión. Con
  `merge.ff=false` toda fusión crea un commit, así que una rama `wip/*` no entra en otra sin pasar
  `check:all`.

## Hooks de Claude Code

`.claude/settings.json` ejecuta `scripts/claude-guard.ts` antes de cada uso de `Bash`, `PowerShell`, `Read`,
`Edit`, `Write`, `NotebookEdit`, `Grep` y `Glob`. Bloquea:

- leer o escribir el contenido de `data/holdout/` y `config/holdout.lock`: `Read`, `Grep`, `Edit`, `Write`
  y `NotebookEdit` sobre esas rutas, y cualquier comando de shell que las mencione salvo una lista cerrada de
  comprobaciones de existencia (`ls`, `test -e|-f|-d|-s`, `[ -e … ]`, `Test-Path` y `Get-ChildItem` sin
  `-Recurse` ni `-Depth`), sin tuberías, redirecciones ni sustitución de comandos. `Glob` se permite porque
  solo devuelve nombres, como `ls`. Un `Grep` sobre una carpeta superior (por ejemplo, todo el repositorio)
  no se bloquea y puede devolver líneas de `config/holdout.lock`; `data/` está en `.gitignore` y `Grep` la
  salta por defecto;
- leer o escribir `.env` y cualquier otro `.env.*`;
- escribir en `.env.example` una variable con valor. La plantilla solo lleva nombres (`CLAVE=`) y se puede
  leer y editar con las herramientas de archivos. Desde la shell sigue bloqueada, porque no se puede
  comprobar lo que escribe un comando. Como está versionada, secretlint la escanea en el `pre-commit` y en
  `npm run secrets`;
- `rm -rf` y equivalentes (`Remove-Item -Recurse -Force`, `rmdir /s`), `git push` forzado y
  `git reset --hard`;
- `--no-verify` y cambios de `core.hooksPath`, que dejarían sin efecto los hooks de git;
- comandos que llamen a endpoints de retiro, y escribir en `src/` código que los llame;
- comandos que nombren `LIVE_TRADING` o su frase de confirmación (paso 15, ADR 0016). Así Claude no puede
  activar el modo real para un solo comando (`LIVE_TRADING=… npm start`, `export`, `$env:`, `setx`). Para
  buscar la variable se usa la herramienta `Grep`, que no se bloquea. Un script escrito por Claude que la
  fije con texto construido no se detecta: la barrera física es que la clave de trading no está en la
  máquina de desarrollo (`SECURITY_AND_TRADING_INVARIANTS.md`, INV-12).

Además, `permissions.deny` de `.claude/settings.json` niega a Claude `.env` y las variantes habituales
(`.env.local`, `.env.*.local`, `.env.development`, `.env.production` y `.env.test`). Esa lista no puede
enumerar todos los `.env.*` sin bloquear también `.env.example`. El hook es el que cubre cualquier otro.
También niega leer y editar `config/holdout.lock` y `data/holdout/**`, como segunda capa del hook (paso 13).

El hook es una barrera para Claude, no para una persona en su terminal. Compara texto: un mensaje de commit
que contenga `rm -rf` también se bloquea. En ese caso se usa `git commit -F <archivo>`.

## Invariantes de seguridad y trading

[SECURITY_AND_TRADING_INVARIANTS.md](../SECURITY_AND_TRADING_INVARIANTS.md) reúne lo que tiene que ser verdad
siempre y dice cómo se comprueba cada cosa: prueba automática, procedimiento manual o prueba pendiente de un
paso (ADR 0016). Las pruebas nuevas están en `test/invariants/`. `test/invariants/registry.test.ts` falla si un
control apunta a una prueba o a un procedimiento que no existe, si una prueba `INV-` no figura en el documento,
o si se cierra el paso de un control pendiente sin convertirlo en prueba.

## Rutas de `data/` solo en la guarda

`test/enforcement/data-paths.test.ts` (paso 19B, ADR 0022) falla si un código ejecutable (`src/`, `scripts/`,
`capguard/` y los hooks de git) nombra rutas de `data/` y no es `src/historical/guard.ts` o el hook de Claude. Así,
toda lectura de datos de investigación, de brutos o del test final pasa por la guarda, que decide qué se puede abrir.
No cuentan los comentarios ni el evento `'data'` de un stream. Compara texto: no ve una ruta que llega por argumento
o por la configuración. Su única excepción, que solo puede quitarse, es el valor por defecto de `dataDir` en
`src/config/schema.ts`: la carpeta de SQLite y del bloqueo de `src/main.ts`, que se sustituye en el paso 32.

## Listas de excepciones

Las infracciones del código previo al paso 4 no se corrigieron: se registraron. El paso 13 (saneamiento)
vació la de lint. En la de límites quedan los tres imports de ccxt de `src/broker.ts` y `src/market.ts`
(se quitan al reescribirlos en los pasos 32 y 36) y de `src/main.ts` (en el paso que lo sustituya).

| Lista | Contenido | Se reduce con |
|---|---|---|
| `eslint-suppressions.json` | Infracciones de lint, contadas por archivo y regla | `npx eslint . --prune-suppressions` |
| `.dependency-cruiser-known-violations.json` | Imports prohibidos, uno por entrada | `npx depcruise-baseline src --config .dependency-cruiser.cjs` |

Garantías:

- ESLint cuenta: una infracción más de la registrada en un archivo falla, y una excepción que ya no hace
  falta también falla hasta que se poda.
- `test/enforcement/exceptions.test.ts` falla si la lista de lint tiene alguna entrada, si la de
  límites contiene un archivo que no sea `broker.ts`, `market.ts` o `main.ts`, o si supera el máximo (3). Al
  reescribir esos módulos se baja el máximo.
- El código nuevo no puede tener excepciones. No se añaden entradas a mano ni se regeneran las listas con
  `--suppress-all` o `depcruise-baseline` para tapar una infracción nueva.
