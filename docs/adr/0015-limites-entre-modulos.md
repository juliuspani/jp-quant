# ADR 0015 — Límites entre módulos: matriz de dependencias y estructura de `src/`

Fecha: 2026-10-06 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) ·
Paso: 14

## Contexto

- **Las reglas del paso 4** ([ADR 0001](0001-enforcement-automatico.md), [ADR 0003](0003-trading-risk.md))
  prohíben algunos imports concretos: Strategy hacia Execution, Exchange o ccxt; features hacia Execution o
  Risk; LLM y noticias hacia Execution o Exchange; el firmante fuera de Risk; y el capguard con `src/`. Son
  listas de lo que no se puede.
- **Las carpetas nuevas quedarían sin regla.** El paso 14 pide actualizar los límites para las carpetas nuevas
  de la arquitectura ([ARCHITECTURE.md](../../ARCHITECTURE.md) §4). Con reglas de lo prohibido, cada carpeta
  nueva y cada import no previsto quedan sin cubrir.
- **Hay un hueco conocido** (docs/CCXT.md §1.2): con el `src/` plano, Strategy podía importar `src/broker.ts` o
  `src/engine.ts` sin que saltara nada.
- **Las listas de excepciones solo pueden encoger** (docs/enforcement.md): no se puede tapar una infracción
  nueva añadiéndola.

## Decisión

1. **Matriz de dependencias.** Cada módulo tiene una regla `<módulo>-solo-importa-lo-permitido`, con lo que
   puede importar dentro de `src/` (ARCHITECTURE.md §15.1). Todo lo demás de `src/` está prohibido, también los
   archivos de la raíz.
   - `app/` es la composición y puede importarlo todo.
   - `config/` puede importar los tipos de cualquier módulo, menos `app/`.
   - Execution solo puede usar de `risk/` el archivo `src/risk/approval.ts`.
2. **Reglas de paquetes y de E/S:**
   - **`solo-persistence-usa-sqlite`:** solo `persistence/` importa `node:sqlite`. Así hay una sola conexión y un
     solo escritor;
   - **`dominio-sin-entrada-salida`:** `shared/`, `kernel/`, `marketdata/`, `features/`, `analytics/`,
     `strategy/`, `portfolio/`, `risk/` y `execution/` no importan módulos de E/S de Node (`fs`, `net`,
     `http`, `https`, `http2`, `child_process`, `dgram`, `tls`, `dns`, `cluster`, `worker_threads`, `sqlite`,
     `readline`, `repl` e `inspector`);
   - **`dominio-sin-paquetes-npm`:** esos mismos módulos no importan paquetes de npm. La única excepción es
     `src/shared/decimal.ts`, que envuelve big.js ([ADR 0014](0014-tipo-decimal-big-js.md)).
3. **Excepciones transitorias del código previo.** Están escritas en la propia configuración, comentadas y
   probadas, y no en la lista de excepciones conocidas:
   - `src/strategy/trend.ts` puede importar `src/config.ts`, `src/indicators.ts` y `src/types.ts`, que hoy usa;
   - `src/backtest/sim.ts` queda fuera de la regla de `backtest/` hasta que se reescriba en el paso 23;
   - `src/store.ts` puede importar `node:sqlite` hasta que lo sustituya `persistence/` en el paso 33.

   Cada una se quita al reescribir o mover esos archivos, y no se añade ninguna otra sin otro ADR.
4. **Prueba de estructura**, en `test/enforcement/layout.test.ts`. Falla si:
   - una carpeta de primer nivel de `src/` no es un módulo de la arquitectura;
   - aparece en la raíz de `src/` un archivo que no es del código previo (esa lista solo encoge);
   - un módulo no tiene su regla de la matriz;
   - `ARCHITECTURE.md` no nombra cada módulo o tiene un enlace roto.
5. **Las reglas anteriores se mantienen**, con sus nombres, porque los citan la documentación y las pruebas. Un
   import puede infringir a la vez una regla antigua y una de la matriz.
6. **Aplazado, con su compromiso:**
   - la regla «solo `src/shared/decimal.ts` y `capguard/decimal.ts` importan big.js», en el paso 18, al instalar
     la dependencia (sin ella instalada, la prueba no compila);
   - la regla de ESLint contra el reloj y el azar propios en el dominio, al crear `src/kernel/`;
   - la prueba de la composición de `app/`, que el análisis de imports no ve;
   - la lista de métodos de ccxt, al crear `src/exchange/` (compromiso anterior del ADR 0007).
7. **Árboles de ejemplo.** `test/fixtures/boundaries/` tiene un import prohibido por cada regla nueva en `bad/`,
   y un import permitido de cada módulo y de cada excepción en `ok/`. El ejemplo correcto de Execution deja de
   importar `exchange/` y `risk/limits.ts`, porque la arquitectura ya no lo permite.

## Alternativas descartadas

- **Seguir solo con reglas de lo prohibido.** Deja sin cubrir las carpetas nuevas y los imports que nadie
  previó, como el hueco de `src/broker.ts`.
- **Crear cada regla cuando aparezca la carpeta.** Una carpeta creada con otro nombre, o antes de tiempo,
  escaparía. El proyecto ya activa las reglas antes de que existan las carpetas (paso 4).
- **Meter las excepciones transitorias en `.dependency-cruiser-known-violations.json`.** Esa lista no admite
  entradas nuevas y solo cubre infracciones del código previo al paso 4.
- **Dejar que los módulos nuevos importen archivos de la raíz.** El código nuevo dependería del previo, por
  ejemplo de `newClientOrderId` de `util.ts`, que no cumple exchange-execution §5.1.
- **Una regla por cada pareja de módulos.** Saldrían cientos de reglas. La matriz dice lo mismo con una regla
  por módulo.

## Consecuencias

- **Se cierra el hueco de Strategy:** ya no puede importar `src/broker.ts` ni `src/engine.ts`.
- **Hay que mover antes de usar.** Para usar `log.ts` o `util.ts` desde un módulo nuevo, primero se pasan a
  `shared/`.
- **Las listas de la prueba de estructura** (archivos de la raíz) y las excepciones transitorias solo pueden
  encoger.
- **Las reglas pasan de 8 a 29.** Un import prohibido puede dar dos avisos, el de la regla antigua y el de la
  matriz.
- **Lo que dependency-cruiser no ve:** los objetos inyectados en tiempo de ejecución. Por eso existen la prueba
  de composición pendiente y la revisión.
- **Cambiar la matriz exige un ADR.**
