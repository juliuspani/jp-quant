# ADR 0007 — CCXT detrás de un ExchangeAdapter propio

Fecha: 2026-10-02 · Estado: aceptado · Paso: 9 (decisión), aprobada el 2026-10-02 con una excepción en la
decisión 5 (paso 9B)

## Contexto

El código previo usa ccxt directamente desde `broker.ts`, `market.ts` y `main.ts` (tres infracciones de la
regla `solo-exchange-importa-ccxt`). exchange-execution (ADR 0005) ya fija que solo `src/exchange/` importa
ccxt, pero no decía qué partes de ccxt se aprovechan, cuáles no se delegan ni cómo se fija y actualiza su
versión. ccxt publica versiones de parche casi cada semana (84 en la rama 4.5 desde 2025-08), no promete
compatibilidad estricta y usa `number` en sus estructuras unificadas. El detalle está en
[docs/CCXT.md](../CCXT.md).

## Decisión

1. **Arquitectura:** Trading System → ExchangeAdapter (nuestro, en `src/exchange/`) → CCXT / CCXT Pro →
   Exchange. El adaptador da hacia dentro tipos propios con valores decimales y traduce las excepciones de
   ccxt. Strategy no lo recibe nunca.
2. **Superficie cerrada:** el adaptador solo llama a los métodos de ccxt que lista docs/CCXT.md §1.1. Quedan
   prohibidos los retiros y transferencias, margen y derivados, las órdenes por WebSocket, `editOrder`,
   `cancelAllOrders`, `OrderRouter` y la API implícita sin ADR.
3. **Se aprovecha de ccxt:** normalización de mercados, precisión y límites, descarga de históricos (con
   paginación propia), CCXT Pro para datos de mercado y canal privado, jerarquía de errores, firma y testnet.
4. **No se delega en ccxt:** idempotencia, máquina de estados, UNKNOWN, reconciliación, rate limiting propio
   (con el de ccxt como capa interior), detección de gaps, reintentos, precisión decimal, reloj y dead-man
   switch. Las reglas siguen en exchange-execution.
5. **Versión exacta** en `package.json`: `4.5.84`, la del lockfile (aplicada en el paso 9B). Se actualiza solo
   en un paso propio, con una versión que lleve al menos 7 días publicada y tras revisar el changelog, el diff
   del exchange elegido y las pruebas de contrato. Revisión al menos cada 3 meses. **Única excepción:** un
   parche de seguridad crítico puede aplicarse antes de los 7 días, revisando igualmente el diff.

## Alternativas descartadas

- **Usar ccxt directamente desde Execution.** Llevaría sus `number`, sus excepciones y sus cambios de versión
  a todo el sistema, y haría imposible cambiar de proveedor.
- **Delegar la ejecución en `OrderRouter.execute` de ccxt.** Envía órdenes por su cuenta, sin token de Risk, y
  su protección contra duplicados no sobrevive a un reinicio.
- **Clientes REST y WebSocket propios sin ccxt.** Más control, pero reimplementa la firma, la normalización y
  la precisión de cada exchange. Se reconsidera si ccxt falla en el exchange elegido.
- **Mantener `^4.5.84`.** Un `npm install` podría subir de versión sin revisión.
- **Seguir siempre la última versión.** Demasiados cambios sin revisar en el camino del dinero.

## Consecuencias

- El refactor tiene que crear `src/exchange/` como única entrada a ccxt y vaciar las tres infracciones de
  límites (paso 13).
- La versión se fijó en un commit aparte (paso 9B), con `package.json`, el lockfile y el registro de
  dependencias.
- Si se ejecuta `npm ci --ignore-scripts` en el VPS, por el `postinstall` con red de ccxt, se decide en el
  paso 39.
- Cada actualización de ccxt cuesta un paso pequeño, pero queda revisada.
- La lista de métodos permitidos aún no tiene un check automático. Se propondrá cuando exista
  `src/exchange/`.
- Las marcas [verificar] de docs/CCXT.md §6 se resuelven en los pasos 17, 32 y 36.

## Corrección editorial (2026-10-05)

Renumeración del plan en el paso 12 ([ADR 0010](0010-regla-de-decisiones-y-nuevo-plan.md)). Solo cambian
los números de paso, con la tabla de `docs/progress/PLAN_MAP.md` (registro de trabajo privado, no publicado); no cambia
ninguna decisión. Cambios:

- 12 → 13 (saneamiento de las excepciones de límites);
- 47 → 39 (`postinstall` en el VPS);
- 16, 17 y 31 → 17, 32 y 36 (marcas [verificar]).
