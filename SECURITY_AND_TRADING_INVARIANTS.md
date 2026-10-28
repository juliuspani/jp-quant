# Invariantes de seguridad y trading

> **Copia pública (paso 49).** Las menciones a `PROGRESS.md` y `docs/progress/` se refieren al registro de trabajo
> privado del proyecto, que no se publica. Guía en inglés de la documentación: [docs/README.md](docs/README.md).

Lo que tiene que ser verdad siempre, en cualquier modo y en cualquier versión del código. Cada invariante se
convierte en uno o varios **controles**, y cada control es una de estas tres cosas:

| Tipo | Qué es | Quién lo hace cumplir |
|---|---|---|
| `auto` | Una prueba que se ejecuta con `npm test` (y, por tanto, en el `pre-commit`) | `check:all` |
| `manual` | Un procedimiento escrito para una persona, porque ninguna prueba lo puede ver (el exchange, el VPS, una clave) | Quien lo ejecuta, con el checklist de §3 |
| `pendiente` | Una prueba que no se puede escribir hasta que exista el módulo. Lleva el paso en que se escribe | `test/invariants/registry.test.ts`: falla cuando ese paso se cierra y el control sigue pendiente |

Decisiones en [ADR 0016](docs/adr/0016-invariantes-como-pruebas.md). Desarrolla `CLAUDE.md` §2 y los skills
`trading-risk` y `exchange-execution`, sin sustituirlos.

## 1. Principio general: FAIL CLOSED

Ante duda, error, dato que falta, configuración incompleta o estado desconocido, **no se opera**. Un control
que no se puede evaluar cuenta como fallido, no como superado. Las pruebas de este documento siguen la misma
regla: si no pueden leer lo que comprueban (git, un archivo, `PROGRESS.md`), fallan.

## 2. Reglas de este documento

- **Cambiar o quitar un invariante, o relajar un control, es una parada obligatoria** (`CLAUDE.md` §7): lo
  aprueba una persona y queda en un ADR. Añadir controles o pasar uno de `pendiente` a `auto` no lo es.
- Un control `pendiente` se convierte en `auto` en su paso. Retrasar su paso también es relajarlo.
- Cada fila de la matriz (§3) apunta a algo que existe: un archivo y un texto que contiene (`auto`), un
  procedimiento de §5 (`manual`) o un paso futuro (`pendiente`). Lo comprueba `test/invariants/registry.test.ts`.
- Las pruebas nuevas de invariantes van en `test/invariants/` y su nombre empieza por el código del control
  (`INV-01a: …`).

**Estado del código previo.** `src/` es la implementación recuperada (`PRE-REFACTOR-RECOVERY`) y no cumple
varios invariantes (INV-06 a INV-09). **No se opera en real** hasta que todos los controles hasta el paso 46
estén en `auto` o `manual` y en verde (`PROGRESS.md`, «Riesgos vigentes»).

## 3. Matriz de controles

| Control | Tipo | Dónde | Qué comprueba |
|---|---|---|---|
| INV-00a | auto | `test/src/config.test.ts` «una clave desconocida detiene el arranque» | Una errata en `config.json` no deja un valor por defecto en silencio: no arranca |
| INV-00b | auto | `test/src/config.test.ts` «un valor de otro tipo detiene el arranque» | Un valor de otro tipo no arranca |
| INV-00c | auto | `test/enforcement/claude-guard.test.ts` «una entrada ilegible se bloquea (fail closed)» | El hook de Claude bloquea lo que no entiende |
| INV-00e | auto | `test/src/config/startup.test.ts` «el apalancamiento activado no arranca, en ningún entorno» | `exchange.leverage` distinto de 1, `exchange.margin` o un `marketType` que no sea `spot` impiden arrancar |
| INV-00f | auto | `test/src/config/startup.test.ts` «entorno ambiguo: sin declarar, con un valor que no es exacto o con declaraciones que se contradicen» | Sin `APP_ENV` ni `environment`, con un valor inexacto o con `APP_ENV`, `config.json` y `NODE_ENV` en desacuerdo, no arranca |
| INV-00d | auto | `test/invariants/risk-execution.test.ts` «INV-00d:» | El Risk Engine rechaza con `INTERNAL_ERROR` si un control lanza o recibe un valor no finito, y con `DECISION_LOG_UNAVAILABLE` si no puede persistir la decisión |
| INV-01a | auto | `test/invariants/live.test.ts` «INV-01a:» | Solo la frase exacta confirma `LIVE_TRADING`; `true`, `1` o la frase en minúsculas no |
| INV-01b | auto | `test/invariants/live.test.ts` «INV-01b:» | La configuración por defecto y la versionada son `paper` |
| INV-01c | auto | `test/invariants/live.test.ts` «INV-01c:» | `src/main.ts` en production sale con error antes de conectar si falta la confirmación o las claves |
| INV-01d | auto | `test/invariants/live.test.ts` «INV-01d:» | Ningún archivo de configuración, script ni hook trae la frase de confirmación |
| INV-01f | auto | `test/src/config/startup.test.ts` «LIVE=true fuera de production no arranca» | `LIVE_TRADING` con cualquier valor salvo vacío o `false` fuera de production impide arrancar, aunque traiga la frase |
| INV-01g | auto | `test/src/config/startup.test.ts` «el modo live con dinero real fuera de production no arranca» | El modo live sin sandbox solo se admite en production |
| INV-01e | pendiente | paso 32 | Solo `app/` construye `LiveVenue` y solo con la confirmación; `LiveVenue` la vuelve a comprobar y rechaza con `LIVE_TRADING_DISABLED` |
| INV-02a | auto | `test/invariants/sin-retiros.test.ts` «INV-02a:» | Ningún archivo de `src/`, `capguard/`, `scripts/` ni `.githooks/` llama a retiros o transferencias |
| INV-02b | auto | `test/invariants/sin-retiros.test.ts` «INV-02b:» | ESLint rechaza un acceso a `withdraw*` en `.js` y tiene la regla activa en `.ts` |
| INV-02c | auto | `test/enforcement/claude-guard.test.ts` «sapi/v1/capital/withdraw/apply» | El hook bloquea comandos y código de Claude que llamen a un retiro |
| INV-02d | auto | `test/docs/ccxt.test.ts` «la lista de métodos permitidos no incluye ninguno prohibido» | La lista de métodos de ccxt permitidos no tiene retiros ni transferencias |
| INV-02e | pendiente | paso 32 | `exchange/` solo expone los métodos permitidos de `docs/CCXT.md`: el adaptador no tiene `withdraw` ni `transfer` y una llamada por nombre construido falla |
| INV-02g | auto | `test/src/config/startup.test.ts` «una clave con permiso de retiro detectado no arranca, en ningún entorno» | Si los permisos leídos de la clave incluyen retiros, no arranca |
| INV-02f | manual | M-05 | La clave del exchange no tiene permiso de retiro (capa física) |
| INV-03a | auto | `test/enforcement/claude-guard.test.ts` «LIVE_TRADING=SI_ENTIENDO_EL_RIESGO npm start» | Claude no puede fijar `LIVE_TRADING` ni escribir la frase en un comando |
| INV-03b | auto | `test/enforcement/claude-guard.test.ts` «la frase que bloquea el hook es la confirmación de src/config.ts» | La frase que bloquea el hook es la misma que acepta el bot |
| INV-03c | auto | `test/enforcement/claude-guard.test.ts` «file_path: '.env', content: 'KEY=1'» | Claude no puede escribir `.env`, donde vive la confirmación |
| INV-03d | manual | M-03 | Activar el modo real lo hace una persona, con el checklist completo |
| INV-03e | pendiente | paso 32 | `app/` solo arranca live con las tres condiciones del ADR 0013 (confirmación, estrategia aprobada para live con su hash, capguard disponible) |
| INV-04a | auto | `test/enforcement/boundaries.test.ts` «capguard-no-importa-src <- capguard/uses-src.ts» | El capguard no importa nada de `src/` |
| INV-04b | auto | `test/enforcement/boundaries.test.ts` «src-no-importa-capguard <- src/engine/uses-capguard.ts» | `src/` no importa nada del capguard |
| INV-04c | pendiente | paso 39 | El capguard rechaza con `CAP_*` cada tope de trading-risk §3 y no sale ninguna orden si no responde (`CAP_UNAVAILABLE`) |
| INV-04d | pendiente | paso 39 | El proceso principal solo recibe la clave de lectura; la de trading solo la carga el capguard |
| INV-04f | auto | `test/src/config/startup.test.ts` «el capital cap ausente no arranca, en ningún entorno» | Sin `capital.capQuote` no se arranca |
| INV-04g | auto | `test/src/config/startup.test.ts` «un capital cap superior al máximo, no positivo o menor que el capital inicial no arranca» | `capital.capQuote` por encima de `MAX_CAPITAL_CAP_QUOTE`, no positivo o por debajo de `startingQuote` impide arrancar |
| INV-04e | manual | M-04 | Cuenta dedicada solo al bot, con solo su capital y sin transferencias automáticas |
| INV-05a | manual | M-05 | Claves solo de lectura y de trading spot, sin retiros ni transferencias, con lista blanca de IP |
| INV-05c | auto | `test/src/config/startup.test.ts` «una clave con transferencias, margen, futuros o sin restricción de IP no arranca en production» | La guarda de arranque rechaza esos permisos cuando se le entregan |
| INV-05d | auto | `test/src/config/startup.test.ts` «sin poder leer los permisos de la clave, shadow y production no arrancan» | Permisos sin leer cuentan como peligrosos (fail closed) |
| INV-05b | pendiente | paso 32 | Al arrancar en real, el bot lee las restricciones de la clave y no arranca (`CONFIG_INVALID`) si permite retiros, margen o futuros, o no tiene restricción de IP |
| INV-06a | auto | `test/enforcement/boundaries.test.ts` «strategy-no-execution-ni-exchange <- src/strategy/uses-execution.ts» | Strategy no importa Execution ni el exchange |
| INV-06b | auto | `test/enforcement/boundaries.test.ts` «solo-risk-usa-el-firmante <- src/strategy/uses-signer.ts» | Solo `risk/` usa el firmante de las aprobaciones |
| INV-06c | auto | `test/invariants/risk-execution.test.ts` «INV-06c:» | Execution rechaza una orden sin token, con firma inválida, caducada, reutilizada o distinta de lo aprobado (`APPROVAL_*`), también en las ventas |
| INV-06d | pendiente | paso 32 | Prueba de la composición: `app/` nunca entrega a Strategy, Analytics ni Monitoring un objeto que pueda enviar órdenes |
| INV-06e | auto | `test/invariants/risk-execution.test.ts` «INV-06e:» | Cada rechazo de Risk y de Execution se guarda antes de responder, con un `reason_code` del catálogo cerrado de trading-risk §9.2 |
| INV-06f | auto | `test/invariants/strategy-risk.test.ts` «INV-06f:» | En el sistema compuesto, toda orden y todo fill vuelven a una intención, una decisión aprobada de Risk y su token; una decisión forjada por la estrategia (cantidad, aprobación u origen) no cambia nada, un stop inválido se rechaza (`STOP_INVALID`) y la estrategia no puede escribir en lo que recibe |
| INV-07a | pendiente | paso 35 | El kill switch interno rechaza toda intención (`KILL_SWITCH_ACTIVE`), se activa con `data/KILL`, sobrevive a un reinicio y solo lo desactiva una persona |
| INV-07b | auto | `test/invariants/risk-execution.test.ts` «INV-07b:» | Con el kill switch activo, Execution cancela las órdenes pendientes y mantiene los stops nativos |
| INV-07c | manual | M-07 | Kill switch externo: revocar la clave en el exchange, con simulacro de menos de 5 min |
| INV-07d | auto | `test/invariants/risk-execution.test.ts` «INV-07d:» | El kill switch interno bloquea todo: Risk rechaza cualquier intención (`KILL_SWITCH_ACTIVE`) y Execution no envía ni un token firmado antes de activarlo |
| INV-08a | pendiente | paso 35 | Precio de más de 60 s, señal de más de 20 min, reloj desfasado más de 1 s o marca de tiempo ausente: rechazo (`STALE_DATA`, `SIGNAL_TOO_OLD`, `CLOCK_SKEW`) |
| INV-08b | auto | `test/invariants/risk-execution.test.ts` «INV-08b:» | Precio o valoración de la cartera de más de 60 s, precio que falta o señal de más de 20 min: rechazo de la entrada (`STALE_DATA`, `SIGNAL_TOO_OLD`) |
| INV-09a | pendiente | paso 35 | Saldos o posiciones sin reconciliar en 10 min: rechazo de entradas y salidas (`STATE_UNRECONCILED`) |
| INV-09b | auto | `test/invariants/risk-execution.test.ts` «INV-09b:» | En modo UNKNOWN, Execution no envía órdenes nuevas (`EXEC_STATE_UNKNOWN`) hasta reconciliar |
| INV-10a | auto | `test/invariants/secrets.test.ts` «INV-10a:» | `.gitignore` ignora `.env*`, claves, certificados, datos y registros, y deja versionar `.env.example` |
| INV-10b | auto | `test/invariants/secrets.test.ts` «INV-10b:» | Ningún archivo del repositorio es un archivo de secretos, datos o registros |
| INV-10c | auto | `test/src/config.test.ts` «tacha de los logs todos los secretos que carga» | Todo valor que carga `loadSecrets` se tacha de los logs |
| INV-10d | auto | `test/invariants/live.test.ts` «INV-10d:» | Al negarse a arrancar, el bot no escribe sus claves en la salida |
| INV-10e | auto | `test/src/log.test.ts` «tacha un secreto registrado en la consola y en el sink» | El logger tacha los secretos en la consola y en la base de datos |
| INV-10f | auto | `test/enforcement/claude-guard.test.ts` «command: 'cat .env'» | Claude no puede leer `.env` |
| INV-10g | auto | `test/invariants/secrets.test.ts` «INV-10g:» | El `pre-commit` escanea los secretos antes que nada, también en ramas `wip/*` |
| INV-10j | auto | `test/src/config/secrets.test.ts` «en production un archivo de secretos en disco impide arrancar» | En production un `.env*` en la carpeta de trabajo (salvo `.env.example`) impide arrancar |
| INV-10k | auto | `test/src/config/secrets.test.ts` «en production una clave en una variable de entorno impide arrancar» | En production los secretos solo vienen del gestor de secretos |
| INV-10h | manual | M-10 | Si un secreto llega a Git o a un log, se revoca |
| INV-10i | auto | `test/src/log.test.ts` «tacha sin registrarlos los secretos con forma conocida» | El logger tacha por sí solo tokens de Telegram, claves `sk-`, cabeceras `Bearer`, contraseñas en URLs y pares `clave=valor` con nombre de secreto |
| INV-11a | auto | `test/enforcement/boundaries.test.ts` «llm-y-news-no-execution-ni-exchange <- src/llm/uses-execution.ts» | `llm/` y `news/` no importan Execution ni el exchange |
| INV-11b | auto | `test/invariants/llm.test.ts` «INV-11b:» | La salida de un LLM, aunque sea hostil, solo da un multiplicador entre 0 y 1 o un bloqueo |
| INV-11c | auto | `test/invariants/llm.test.ts` «INV-11c:» | Solo la configuración y la inteligencia nombran un LLM, y no importan código de órdenes |
| INV-11d | pendiente | paso 35 | El Risk Engine aplica un `RiskBrake` solo para reducir: nunca relaja un límite ni crea una intención |
| INV-12a | auto | `test/invariants/modes.test.ts` «INV-12a:» | Fuera de `app/` y `config/` nadie pregunta por el modo, salvo el código previo listado (la lista solo encoge) |
| INV-12b | auto | `test/invariants/modes.test.ts` «INV-12b:» | Las pruebas nunca cargan `.env` |
| INV-12c | pendiente | paso 32 | Una base de datos por modo (`paper.db`, `shadow.db`, `live.db`) y una sola instancia por máquina |
| INV-12d | pendiente | paso 32 | `ShadowVenue` nunca transmite: toda orden termina en `NOT_SENT`, y no recibe la clave de trading |
| INV-12f | auto | `test/src/config/startup.test.ts` «cada entorno solo admite sus modos» | development: paper o testnet; test y paper: paper; shadow: shadow; production: live |
| INV-12e | manual | M-12 | La clave de trading y la confirmación solo existen en el VPS, nunca en la máquina de desarrollo |
| INV-13a | auto | `test/enforcement/claude-guard.test.ts` «command: 'cat config/holdout.lock'» | El hook impide a Claude leer o escribir el test final |
| INV-13b | auto | `test/invariants/test-final.test.ts` «INV-13b:» | `permissions.deny` niega el test final y el hook vigila todas las herramientas que leen o escriben |
| INV-13c | auto | `test/invariants/test-final.test.ts` «INV-13c:» | Ningún código nombra el test final salvo el hook que lo protege |
| INV-13d | auto | `test/invariants/test-final.test.ts` «INV-13d:» | Los datos del test final no se versionan; su candado sí |
| INV-13e | auto | `test/invariants/test-final.test.ts` «INV-13e:» | `config/holdout.lock` existe (solo se comprueba su existencia) |
| INV-13f | auto | `test/invariants/test-final.test.ts` «INV-13f:» | La guarda de `historical/` rechaza cargar un rango que toque el test final sin el flag humano, y también si falta el candado |
| INV-13g | manual | M-13 | Crear y desbloquear el candado lo hace una persona |
| INV-13h | auto | `test/invariants/test-final.test.ts` «INV-13h:» | La guarda no deja leer ni descargar un fichero bruto cuyo periodo pasa, aunque sea en parte, del fin de los datos de investigación sin el flag humano |
| INV-14a | auto | `test/invariants/backtest-registry.test.ts` «INV-14a:» | En `src/` solo el ejecutor de experimentos llama a `runBacktest`, solo el modo backtest monta el replay y el comando de backtest ejecuta por `runExperiment` |
| INV-14b | auto | `test/invariants/backtest-registry.test.ts` «INV-14b:» | Por debajo de los costes mínimos (comisión, medio spread y slippage) el modelo de ejecución no se construye y el backtest no empieza |
| INV-14c | auto | `test/invariants/backtest-registry.test.ts` «INV-14c:» | El comando de backtest se niega, antes de tocar el registro, a una rejilla de más de 20 puntos (paso 28, ADR 0032); cada punto de una rejilla cuenta en N |

## 4. Invariantes

### INV-00 Fail closed

Es el principio de §1 aplicado a cada módulo. Configuración desconocida o mal tipada, entrada que no se
entiende o control que no se puede evaluar: no se opera. Ningún `catch` vacío (`CLAUDE.md` §2, ESLint).
Desde el paso 16, una configuración peligrosa o un entorno ambiguo detienen el arranque con `CONFIG_INVALID`
(`src/config/startup.ts`, ADR 0017). Controles: INV-00a a INV-00f.

### INV-01 LIVE desactivado por defecto

`LIVE_TRADING=false` por defecto. El bot opera en papel salvo que la configuración pida live **y** el entorno
traiga la frase exacta de `LIVE_CONFIRMATION` (`src/config/environment.ts`). Cualquier otro valor, incluido `true`,
cuenta como no confirmado. Desde el paso 16 solo el entorno production admite live, y fuera de él cualquier valor
de `LIVE_TRADING` que no sea vacío o `false` impide arrancar. Hoy lo aplica `src/main.ts` con la guarda de
`src/config/`; en el refactor, `app/` y `LiveVenue` (ADR 0013).
Controles: INV-01a a INV-01g.

### INV-02 Retiros imposibles

No existe código que llame a endpoints de retiro ni de transferencia entre cuentas, y la clave del exchange no
tiene ese permiso. Hay cuatro barreras de código (búsqueda en el repositorio, ESLint, hook de Claude y lista
de métodos de ccxt) y una física (la clave, M-05), que es la única que aguanta código comprometido.

**Límite.** La búsqueda compara texto: un nombre construido en tiempo de ejecución (`ex['with' + 'draw']`) no
lo ve. Lo cubren el adaptador de `exchange/` con su lista cerrada (INV-02e) y, sobre todo, la clave sin permiso.
Controles: INV-02a a INV-02g.

### INV-03 Aprobación humana para operar en real

Activar dinero real es una parada obligatoria (`CLAUDE.md` §7). La confirmación la escribe una persona en la
unidad del servicio del VPS (en production no se lee `.env`, ADR 0017), fuera del alcance de Claude. Desde el paso 15, Claude tampoco puede fijar la variable
en un comando (ADR 0016).

**Límite.** El hook compara texto: un script escrito por Claude que construya el nombre de la variable no se
detecta. La barrera física es INV-12e: en la máquina donde trabaja Claude no hay clave de trading.
Controles: INV-03a a INV-03e.

### INV-04 Tope de capital independiente y cuenta dedicada como límite físico

Tres capas (trading-risk §3): la cuenta del exchange dedicada al bot, con solo el capital asignado, es el límite que
aguanta un bot roto; el capguard, proceso aparte que no comparte código con `src/`, es el tope independiente;
el Risk Engine es la capa más débil. Una capa nunca justifica relajar otra.
Desde el paso 16, el bot no arranca sin `capital.capQuote` ni con uno por encima de `MAX_CAPITAL_CAP_QUOTE`
(ADR 0017); es un tope de configuración, no una capa más. Controles: INV-04a a INV-04g.

### INV-05 Claves API solo de trading, sin retiros y con lista blanca de IP

Dos claves: una de lectura para el proceso principal y una de trading spot para el capguard. Ninguna permite
retiros, transferencias, margen ni futuros, y las dos solo funcionan desde la IP fija del VPS.
La guarda de arranque rechaza esos permisos si se le entregan, y en shadow y production no arranca sin
leerlos; leerlos del exchange es de `exchange/` (INV-05b, paso 32). Controles: INV-05a a INV-05d, INV-02f e INV-02g.

### INV-06 Risk obligatorio

Strategy → Risk → Execution, siempre. Strategy produce intenciones; solo Risk firma aprobaciones; Execution
solo envía lo firmado (trading-risk §2). Desde el paso 20, `src/risk/` firma y `src/execution/` exige el token
(ADR 0023), y las pruebas los ejercitan unidos. **Brecha conocida:** el bot que arranca hoy sigue siendo el código
previo, donde `engine.ts` llama al broker directamente y las ventas no pasan por Risk. Se cierra en el refactor
(pasos 32 a 36), al componer `app/` con los módulos nuevos.
Controles: INV-06a a INV-06f.

### INV-07 Kill switch interno y externo

El interno para todo, persiste y solo lo desactiva una persona (trading-risk §6). El externo es revocar la
clave en el exchange y no depende del bot, del VPS ni de nuestro código (trading-risk §7). Desde el paso 20, el
interno existe en `src/risk/` y lo respeta `src/execution/`. Se guarda con el puerto de Risk, hoy en el almacén en
memoria de cada run. Faltan el archivo centinela, la persistencia en SQLite y la desactivación por una persona
(INV-07a, paso 35). El código previo solo tiene la pausa de Telegram, que bloquea entradas.
Controles: INV-07a a INV-07d.

### INV-08 Datos obsoletos bloquean el trading

Un precio, una señal o un reloj fuera de plazo, o una marca de tiempo que falta, rechazan la intención
(trading-risk §4.6). Desde el paso 20, `src/risk/` rechaza el precio, la valoración y la señal fuera de plazo
(INV-08b). El reloj desfasado (`CLOCK_SKEW`) llega con el exchange: INV-08a sigue pendiente hasta el paso 35.
Controles: INV-08a y INV-08b.

### INV-09 Estado desconocido bloquea el trading

Sin saber qué se tiene, no se opera: ni entradas ni salidas (trading-risk §8, exchange-execution §3). Desde el
paso 20, `src/execution/` arranca en UNKNOWN, entra en él ante cualquier duda y no envía hasta reconciliar
(INV-09b). En ese modo, `src/risk/` rechaza entradas y salidas con `STATE_UNRECONCILED`. Falta el plazo de 10 min
desde la última reconciliación (INV-09a, paso 35). El código previo solo pausa las entradas si la cuenta no cuadra
al arrancar.
Controles: INV-09a y INV-09b.

### INV-10 Secretos fuera de Git y de los logs

Fuera de production los secretos viven en `.env` (ignorado); en production, solo en el gestor de secretos del VPS
(credenciales de systemd, ADR 0017). Todo valor de `loadSecrets` y todo texto con forma de secreto se tacha de
los logs, el
`pre-commit` escanea con secretlint lo que se confirma y `npm run secrets` todo lo versionado.
Controles: INV-10a a INV-10k.

### INV-11 LLM sin autoridad de ejecución

Un LLM solo produce un freno (reduce el tamaño o bloquea entradas) y nunca una intención ni un cambio de
límites. El código que habla con un LLM no puede importar nada que acerque a una orden.
Controles: INV-11a a INV-11d.

### INV-12 Dev, Test, Paper, Shadow y Live completamente diferenciados

| Entorno | Dónde | Claves | Ejecución | Datos |
|---|---|---|---|---|
| Dev | Máquina de desarrollo (donde trabaja Claude) | Ninguna de trading. Como mucho, la de lectura | Backtest y paper | `data/` local |
| Test | `npm test` | Ninguna: las pruebas no cargan `.env` ni usan red real | Simulada | Carpetas temporales |
| Paper | Dev o VPS | Ninguna o la de lectura | `SimulatedVenue`, dinero ficticio | `data/paper.db` |
| Shadow | VPS | Solo la de lectura | `ShadowVenue`: nunca transmite | `data/shadow.db` |
| Live | VPS | Lectura en el proceso principal y trading en el capguard | `LiveVenue`, vía capguard | `data/live.db` |

Solo `app/` sabe el modo; el resto del código es el mismo en todos (ARCHITECTURE.md §14, ADR 0013).
Cada entorno (`APP_ENV`) admite solo sus modos y, si es ambiguo, no se arranca (ADR 0017).
Controles: INV-12a a INV-12f.

### INV-13 Test final bloqueado por `config/holdout.lock`

El periodo del test final está en `config/holdout.lock` (lo creó la persona el 2026-10-07; periodo y etapas en el
ADR 0019). Sus datos no se versionan,
Claude no puede leerlos ni editarlos, y ningún código de research puede cargarlos sin un flag humano explícito.
Desde el paso 18 el flag es `HOLDOUT_UNLOCK`, un token Ed25519 firmado por la persona que la guarda de
`src/historical/guard.ts` comprueba junto con la etapa y el `dataHash` del candado (ADR 0020).
Desbloquearlo es una parada obligatoria (`CLAUDE.md` §7).
Desde el paso 19B la guarda vigila también los ficheros brutos (ADR 0022, decisión 14): uno cuyo periodo pasa de
`researchDataEndUtc` no se lee ni se descarga sin ese flag. Además, `test/enforcement/data-paths.test.ts` falla si un
código distinto de la guarda nombra rutas de `data/`; compara texto, así que no ve una ruta que llega en tiempo de
ejecución.
Controles: INV-13a a INV-13h.

### INV-14 Todo backtest pasa por el registro, con costes

Aprobado por la persona en el paso 23. Ningún resultado de backtest existe fuera del Experiment Registry
(quant-research §10, ADR 0024): el único que lanza un backtest es el ejecutor de experimentos, al que solo llama
`runExperiment`, y el comando de backtest no tiene otro camino. Y ningún backtest corre sin costes: por debajo de la
comisión taker, el medio spread y el slippage mínimos (ADR 0026) el modelo de ejecución no se construye
(`CLAUDE.md` §2). Desde el paso 28 (ADR 0032; la persona aprobó el 2026-10-16 sustituir INV-14c, que rechazaba todo
barrido), un barrido pasa por el registro con cada punto en N, como mucho 20 por estrategia y solo con la rejilla de la
literatura declarada en la biblioteca; el ejecutor elige en train. Controles: INV-14a a INV-14c.

## 5. Procedimientos manuales

Cada procedimiento se ejecuta antes del primer arranque en real y después con la periodicidad indicada. Se
anota en `PROGRESS.md` la fecha y quién lo hizo, nunca los valores de las claves.

### M-03 Activar el modo real

Lo hace una persona. Es una parada obligatoria (`CLAUDE.md` §7).

1. Comprobar que `npm run check:all` pasa en el commit que se va a desplegar y que ningún control hasta el
   paso 46 sigue `pendiente`. Comprobar que el PRE-LIVE GATE (`docs/PRE_LIVE_GATE.md`, ADR 0030) está en PASS
   para ese commit y vigente.
2. Repasar el checklist de `trading-risk` (`.claude/skills/trading-risk/checklist.md`) y ejecutar M-04, M-05,
   M-07 y M-12.
3. En el VPS (ADR 0017): las claves están en el gestor de secretos (credenciales de systemd, un archivo por
   nombre en `$CREDENTIALS_DIRECTORY`), no hay ningún `.env*` en la carpeta del bot, `config.json` tiene
   `capital.capQuote` y la unidad del servicio fija `APP_ENV=production`. Editar a mano la unidad y escribir la
   frase de `LIVE_CONFIRMATION` en `LIVE_TRADING`.
4. Arrancar y comprobar en el primer aviso que el modo es REAL y la cuenta cuadra.
5. Anotar en `PROGRESS.md` la fecha, el commit y el capital asignado. Para volver atrás, borrar la línea de la
   unidad y reiniciar.

### M-04 Cuenta dedicada y capital asignado

Antes del primer arranque en real y cada mes.

1. La cuenta del bot en el exchange está dedicada solo al bot: en ella solo hay el dinero del bot. Bitvavo no da
   subcuentas a particulares ni admite una segunda cuenta personal (ADR 0018), así que el resto del dinero y la
   cripto de la persona están en otra entidad o en su monedero.
2. No hay transferencias automáticas hacia la cuenta del bot. Las recargas las hace una persona, a mano.
3. La cuenta del bot tiene segundo factor (no SMS), código antiphishing y lista blanca de direcciones de
   retiro.
4. El saldo de la cuenta del bot coincide con el capital anotado en `PROGRESS.md`.

### M-05 Claves del exchange

Al crear una clave y cada 3 meses.

1. Hay dos claves de la cuenta del bot: lectura (proceso principal) y trading spot (capguard), con nombres
   reconocibles (`inversor-jp-read`, `inversor-jp-live`).
2. En la gestión de API del exchange, ninguna tiene permiso de retiro, transferencia, margen ni futuros.
3. Las dos tienen lista blanca con solo la IP fija del VPS.
4. Ninguna está en la máquina de desarrollo ni en el repositorio (M-12, INV-10).
5. Anotar la revisión en `PROGRESS.md` sin copiar ningún valor.

### M-07 Simulacro del kill switch externo

Antes del primer arranque en real, cada 3 meses y siempre que cambie el exchange o su app.

1. Con una clave de testnet o de solo lectura, seguir trading-risk §7.1, pasos 1 a 3, cronometrando.
2. El objetivo es menos de 5 min. Si se supera, corregir el runbook (trading-risk §7.2) y repetir.
3. Anotar fecha y tiempo en `PROGRESS.md`.

### M-10 Secreto filtrado

En cuanto se detecte un secreto en un commit, un log, un aviso o una captura.

1. Revocar el secreto en su origen (exchange, Telegram, proveedor de LLM, vigilante). Borrarlo de Git no basta.
2. Crear uno nuevo siguiendo M-05 si es una clave del exchange.
3. Registrar el incidente en `docs/incidents/AAAA-MM-DD-<resumen>.md`.

### M-12 Separación de entornos

Antes del primer arranque en real y cada 3 meses.

1. En la máquina de desarrollo no hay clave de trading ni la frase de confirmación en ningún `.env`.
2. El modo real solo corre en el VPS, con un único proceso principal por máquina.
3. Paper, shadow y live usan bases de datos distintas; shadow y live no corren a la vez.

### M-13 Candado del test final

Lo hace una persona: el hook impide a Claude escribir `config/holdout.lock`.

1. En el paso 17, escribir en `config/holdout.lock` el periodo decidido y versionarlo.
2. Desbloquear el test final (darle el flag humano a un research) es una parada obligatoria: se decide en el
   chat, se anota en un ADR y se usa una sola vez por estrategia candidata.

## 6. Qué no cubren estas pruebas

- **Comparan texto o estructura**, no la intención: un nombre construido en tiempo de ejecución o un objeto
  inyectado escapan a la búsqueda. Por eso existen las capas físicas (clave sin retiros, cuenta dedicada, VPS).
- **El hook frena a Claude, no a una persona** en su terminal, y los hooks de git se saltan con `--no-verify`
  (`docs/enforcement.md`).
- **Los controles manuales dependen de que se hagan.** Las pruebas no pueden ver el exchange ni el VPS.
- **Los controles pendientes no protegen nada hasta su paso.** Mientras tanto, no se opera en real.
- **Los controles de `src/risk/` y `src/execution/` (paso 20) prueban esos módulos, no el bot que arranca hoy**, que
  sigue siendo el código previo hasta que `app/` los componga (pasos 32 a 36). Tampoco ven el almacén real: el de
  investigación está en memoria y la base de datos llega en el paso 33.
