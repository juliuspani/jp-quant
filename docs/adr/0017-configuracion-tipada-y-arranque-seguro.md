# ADR 0017 — Configuración tipada por entorno y arranque seguro

Fecha: 2026-10-07 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) ·
Paso: 16

## Contexto

- El paso 16 pide configuración tipada y validada para development, test, paper, shadow y production, con
  `.env.example` sin secretos, redacción automática de secretos en el logger, y que una configuración peligrosa
  impida arrancar: LIVE fuera de production, apalancamiento, capital cap ausente o por encima del máximo, clave
  con permiso de retiro y entorno ambiguo. En production, los secretos salen del gestor de secretos y no de un
  `.env` en disco.
- El código previo (`src/config.ts`) validaba a mano (`merge` y `validate`), solo conocía `paper` y `live`, no
  tenía entorno, leía `.env` con `process.loadEnvFile` (que lo vuelca en `process.env` y lo heredan los procesos
  hijos) y solo tachaba de los logs los valores registrados.
- `ARCHITECTURE.md` §4.2 sitúa la carga y validación de la configuración y los secretos en `src/config/`.
- No existe todavía `exchange/` (paso 32), que es quien puede leer del exchange los permisos de la clave.

## Decisión

1. **Módulo `src/config/`** con cuatro archivos: `environment.ts` (entornos, `LIVE_CONFIRMATION`,
   `ConfigError` y resolución del entorno), `schema.ts` (esquema zod de `config.json`), `secrets.ts` (carga de
   secretos) y `startup.ts` (guarda de arranque). `src/config.ts` queda como reexportación para el código previo
   y desaparece al llevar cada módulo a su sitio. Todo error es `ConfigError` con código `CONFIG_INVALID`
   (trading-risk §9.2).
2. **zod 4.6.5** (aprobada por la persona en el prompt del paso y conforme a la regla automática). Los tipos
   `Config`, `RiskConfig`, etc. salen del esquema. Cada objeto es estricto: una clave desconocida, un valor de otro
   tipo o un modo desconocido detienen el arranque, y se informa de todos los errores juntos. Los topes duros de
   `validate` se conservan sin cambios.
3. **Entorno (`APP_ENV`).** Sale de `APP_ENV` o del campo `environment` de `config.json`. Es ambiguo, y no
   arranca, si falta en los dos, si no es exactamente uno de los cinco (sin mayúsculas ni espacios), si los dos lo
   declaran distinto, si `NODE_ENV` contradice production o test, o si el archivo `.env` declara `APP_ENV`.
4. **Modos por entorno.** development: paper o testnet (live contra el sandbox del exchange); test: paper;
   paper: paper; shadow: shadow; production: live. Live con dinero real solo en production.
5. **LIVE.** Fuera de production, `LIVE_TRADING` con cualquier valor salvo vacío o `false` impide arrancar,
   aunque sea la frase. En production, sin la frase exacta no se arranca: production existe para operar en real
   y un production a medias es ambiguo.
6. **Solo spot, sin apalancamiento.** `exchange.marketType` (por defecto `spot`), `exchange.leverage` (1) y
   `exchange.margin` (`false`) se declaran en el esquema para que cambiarlos sea visible y no arranque. El código
   previo no los lee; `exchange/` los usará en el paso 32.
7. **Capital cap.** `capital.capQuote` no tiene valor por defecto: si falta, no se arranca, en ningún entorno.
   Tiene que ser positivo, no superar `MAX_CAPITAL_CAP_QUOTE` y no ser menor que `capital.startingQuote`.
   **`MAX_CAPITAL_CAP_QUOTE` = 1.000 USDT**, el valor más restrictivo razonable para un capital pequeño (el capital
   inicial por defecto ya era 1.000). Es provisional: subirlo exige un ADR nuevo con aprobación humana. No
   sustituye a las tres capas de trading-risk §3: es un tope de configuración.
8. **Permisos de la clave.** La guarda recibe los permisos leídos del exchange (`KeyPermissions`). Retiro,
   transferencia, margen o futuros impiden arrancar en cualquier entorno; en production, también la falta de
   restricción de IP. En shadow y production, no haber podido leerlos impide arrancar (fail closed). Como el código
   previo no los lee, hoy `src/main.ts` no puede arrancar ni en shadow ni en production: leerlos es de
   `exchange/` (INV-05b, paso 32). Los campos se llaman `fundsOut` y `fundsBetweenAccounts` porque ESLint
   (INV-02b) y la búsqueda de INV-02a rechazan cualquier acceso a una propiedad que nombre retiros o
   transferencias; no se relajan esas barreras.
9. **Secretos.** Fuera de production se leen de las variables de entorno y de `.env`, que se interpreta con
   `util.parseEnv` sin tocar `process.env` (el entorno manda sobre el archivo). **En production solo del gestor de
   secretos: credenciales de systemd** (`LoadCredentialEncrypted=` en la unidad; el proceso las ve como archivos
   en `$CREDENTIALS_DIRECTORY`, un archivo por nombre de variable). En production no se arranca si hay un `.env*`
   en la carpeta (salvo `.env.example`), si una variable de entorno trae un secreto o si falta
   `CREDENTIALS_DIRECTORY`. `APP_ENV` y `LIVE_TRADING` no son secretos y los fija la unidad del servicio.
10. **Logger.** Además de los valores registrados por `loadSecrets`, `redact` tacha por sí solo lo que tiene forma
    de secreto: tokens de bot de Telegram, claves `sk-`, `Bearer`/`Basic`, contraseñas en URLs y pares
    `clave=valor` o `clave: valor` cuyo nombre es de secreto (`api_key`, `secret`, `token`, `password`,
    `signature`…).
11. **La guarda reúne todos los problemas** en un solo `CONFIG_INVALID`, y `src/main.ts` la ejecuta antes de
    tomar el bloqueo, crear la carpeta de datos o conectar.

## Alternativas descartadas

- **Seguir con la validación a mano.** No da tipos derivados y obliga a repetir cada campo en el tipo, en los
  valores por defecto y en la validación.
- **Un gestor de secretos externo** (Vault, Doppler, 1Password, gestor de un proveedor de nube). Exige crear una
  cuenta o contratar un servicio, que es una parada obligatoria, y añade una dependencia de red al arranque.
  systemd es el supervisor previsto en el VPS (`docs/research/05`, unidad `inversor-jp.service`), cifra las
  credenciales en disco y solo las descifra para el proceso del servicio. [verificar en el paso 39] La versión
  de systemd del VPS admite `LoadCredentialEncrypted=` (la documentación oficial lo sitúa en la v250).
- **Leer los secretos de variables de entorno en production.** Una variable se hereda por los procesos hijos, se
  ve en `/proc/<pid>/environ` y suele acabar escrita en un `.env` o en la unidad en claro.
- **Inferir el entorno de `NODE_ENV` o tomar uno por defecto.** Un valor por defecto es justo lo que el paso
  prohíbe: un entorno sin declarar es ambiguo.
- **Permitir production en shadow o sin confirmación.** Haría que el mismo entorno signifique dos cosas.
- **Un tope de capital más alto o por entorno.** Sin datos que lo justifiquen; se revisa con el micro-live
  (paso 46).

## Consecuencias

- Para arrancar en local hay que declarar el entorno: `APP_ENV=paper` en el proceso o `"environment": "paper"`
  en `config.json`. El `config.json` versionado no lo declara, para servir a cualquier entorno, y lleva
  `capital.capQuote` = 1.000.
- `src/main.ts` no puede arrancar en shadow ni en production hasta que `exchange/` lea los permisos de la clave
  (paso 32). El modo shadow no existe en el código previo y se rechaza de forma explícita.
- `npm run backtest` ya no carga secretos: solo lee datos públicos.
- Nuevos controles automáticos en `SECURITY_AND_TRADING_INVARIANTS.md`: INV-00e, INV-00f, INV-01f, INV-01g,
  INV-02g, INV-04f, INV-04g, INV-05c, INV-05d, INV-10i, INV-10j, INV-10k e INV-12f. M-03 explica cómo se activa el
  modo real con la unidad de systemd.
- **Límites.** La redacción por patrones no reconoce un secreto sin forma ni nombre (un valor suelto que nadie
  registró). Los permisos solo protegen si `exchange/` los lee de verdad. La guarda compara la configuración que
  se le da: el código previo no usa `marketType`, `leverage` ni `margin`, así que hoy solo impiden arrancar si
  alguien los cambia. Las credenciales de systemd y la unidad del servicio se preparan en el paso 39.
