# ADR 0045 — Dashboard local sobre el diario del replay

Fecha: 2026-10-23 · Estado: **aceptado**, decisión de Claude en modo autónomo (paso 41B), pendiente de la aprobación del
paso.

## Contexto

- **La petición.** Paso 41B del plan B: un dashboard web privado, de solo lectura, pensado primero para el móvil. La
  persona lo acota a una **versión local**: alimentada por el replay, sin servidor, sin acceso remoto y sin kill switch,
  como base de la demo del paso 49.
- **Qué pide mostrar el prompt:** el modo con fondo completo y banner fijo; la salud del sistema, los feeds y la
  reconciliación; el capital, la exposición, las posiciones y las órdenes; el P&L y el drawdown con la curva frente a
  comprar y mantener BTC; las operaciones con su motivo y su coste; los rechazos de Risk con su `reason_code`; las
  estrategias y su estado; las alertas recientes; y, del plan B, las aportaciones, el reparto frente al objetivo y el
  próximo rebalanceo.
- **Las reglas que lo enmarcan:**
  - INV-14a: en `src/` solo el ejecutor de experimentos llama a `runBacktest`, y solo `app/backtest.ts` monta el replay.
    Cambiarlo es una parada obligatoria;
  - `monitoring/` (ARCHITECTURE.md §4.2 y §15.1) da el estado de solo lectura y deriva las alertas de los hechos con
    una tabla fija (§12). Solo puede importar `shared/`, `kernel/` y `analytics/`;
  - solo `app/` sabe el modo (§14), y `test/enforcement/data-paths.test.ts` no deja nombrar rutas de `data/`.

## Decisión

1. **El dashboard lee un diario ya grabado, no lanza un replay.** Su entrada es el diario del motor de replay (formato
   `inversor-replay/1`, un evento por línea) más una ficha del run con lo que el diario no dice: la etiqueta, la
   estrategia con sus parámetros, los costes, la temporalidad, el símbolo de referencia y el plan B. Así no hay un
   segundo camino hacia `runBacktest` e INV-14a no cambia.
2. **El diario de demostración es sintético y sale de las pruebas.** `test/src/monitoring/demo-run.ts` monta un replay de
   dos pares con un paseo aleatorio con semilla y la estrategia de referencia BASELINE, igual que los escenarios
   sintéticos del backtester. No es un resultado de investigación ni usa datos reales, así que no va al Experiment
   Registry. El diario queda en `test/fixtures/dashboard/demo.jsonl`, y una prueba comprueba que es el que sale del
   generador.
3. **Tres piezas:**
   - `src/monitoring/journal.ts` lee el diario. Fail closed: una línea que no se entiende, un diario cortado o desordenado
     y no hay dashboard, porque un estado a medias parecería sano;
   - `src/monitoring/dashboard.ts` lo proyecta en un estado de solo lectura. Los importes salen de los fills en `Decimal`;
     las posiciones y la curva se valoran al cierre de cada vela, sin los costes de vender, con todos los cierres de ese
     instante (Q-01). El benchmark es el de `analytics/benchmark.ts`, con los costes del run por lado. Las alertas salen
     de una tabla fija de tipos de evento y niveles (INFO, WARNING y CRITICAL);
   - `src/monitoring/dashboard-html.ts` lo pinta como una página autocontenida.
4. **La página, sin superficie de ataque:** no lleva JavaScript, formularios, enlaces ni recursos externos. Su CSP
   (`default-src 'none'`) solo admite su hoja de estilos, por su SHA-256. Todo texto del diario se escapa, y nada se
   pinta con atributos `style` ni `on*`.
5. **El modo lo pone `app/`:** `REPLAY` en la versión local, con su propio color, distinto de los de PAPER, SHADOW y
   LIVE, que ya están en la página para la versión remota. La ficha no puede elegir el modo.
6. **El comando `npm run dashboard -- --diario <…> --ficha <…> --salida <….html>`** (`src/app/dashboard-command.ts`) es
   un proceso aparte. Su única relación con el trading es leer el diario: si falla, no escribe la página y sale con
   error. La ruta de salida la da la persona, y debe acabar en `.html`.
7. **Plan B:** las aportaciones son el capital inicial del run, porque el replay no tiene aportaciones periódicas. El
   reparto objetivo y el calendario de rebalanceo vienen de la ficha, y en la demostración son `null`. Los fija la
   persona en los pasos 49 a 52: el proyecto no inventa un objetivo, que se parecería a una recomendación.
8. **Stops a la vista:** una posición sin un stop de protección que ya espere en el exchange se marca «sin stop». En la
   demostración pasa con BTC al final del diario: la salida caduca después de cancelar su stop.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Que el comando del dashboard monte un replay con `runBacktest` | Rompe INV-14a, y cambiarlo es una parada obligatoria |
| Alimentarlo con un experimento del registro | Cada run cuenta en la `N` global y usa datos reales: el dashboard no es investigación |
| Servidor HTTP local | La persona lo excluye en esta versión. Un archivo estático no abre ningún puerto |
| Librería de gráficos o de plantillas | SVG en línea y plantillas de texto bastan, sin dependencias nuevas |
| JavaScript en la página | No hace falta para mostrar un estado, y su ausencia permite una CSP sin `script-src` |

## Consecuencias

- **Pendiente para la versión remota** (fuera de este paso): servidor tras VPN o túnel autenticado, con autenticación
  fuerte; lectura de SQLite con un usuario de solo lectura (paso 33); activación del kill switch con doble confirmación
  y registro en el audit log, siempre por Risk como `OperatorCommandReceived`. Desactivarlo sigue siendo manual.
- **Lo que no ve:** el diario no trae la cotización con que la cartera valora (al bid), así que el patrimonio del
  dashboard puede diferir del de la cartera en el medio spread de lo expuesto. Tampoco trae el precio de referencia de
  cada orden: el coste que se muestra es la comisión, y el spread y el slippage van en el precio.
- **El diario de demostración depende del backtester:** si cambia a propósito el modelo o el formato del diario, hay que
  regenerarlo (`node test/src/monitoring/demo-run.ts`) en el mismo commit.
- **`monitoring/` existe ya** con estos tres archivos. Telegram, el latido y el resumen diario siguen en sus pasos.

## Revisión de seguridad (CONSULTOR SECURITY, 2026-10-23, sobre `c2db5d2`)

0 Critical, 0 High, 2 Medium y 4 Low. El paso pide corregir los Critical y High. Se corrigen además los dos Medium y la
parte de SEC-03 que no toca otros módulos, cada uno con su prueba:

- **SEC-01, corregido.** La tabla de alertas y el objetivo del plan B se consultaban con herencia de `Object.prototype`:
  un evento de tipo `constructor` metía su payload en una alerta, y de ahí, HTML en la página. Ahora solo cuentan las
  claves propias (`Object.hasOwn`), las clases CSS interpoladas se escapan y la ficha solo admite códigos de activo en
  mayúsculas.
- **SEC-02, corregido.** Una orden abierta sin su aprobación en el diario tumbaba la página: ahora se ve con «?», y
  `filled` se valida como decimal.
- **SEC-03, en parte.** Una ficha que no es JSON ya no repite su contenido en la salida de error, y los caracteres de
  control de los mensajes se sustituyen. Pendiente: `src/shared/decimal.ts` repite el valor que no puede leer, fuera del
  alcance de este paso.
- **SEC-04, pendiente (Low).** La página sobrescribe sin avisar, sigue enlaces simbólicos y puede escribirse dentro del
  repositorio. Hoy son datos sintéticos; antes de pintar datos reales, escribir con `wx` o una opción explícita, rechazar
  enlaces y rutas del repositorio.
- **SEC-05, pendiente (Low).** Sin tope de tamaño del diario; `Math.min(...)` sobre la curva y `closeAt` cuadrático. Antes
  de diarios largos: tope de tamaño, bucles y reducción de puntos.
- **SEC-06, requisitos de la versión remota**, que este ADR no cubre y que fijará el suyo, con una prueba por cada uno:
  escuchar solo en `127.0.0.1` tras el túnel; autenticación fuerte (segundo factor o mTLS) y sesiones; CSRF y nueva
  autenticación para el kill switch; límite de peticiones; CSP por cabecera con `frame-ancestors 'none'`,
  `X-Content-Type-Options` y `Cache-Control: no-store`; TLS; un proceso sin la clave de trading ni el token de Telegram;
  lecturas de SQLite que no bloqueen el WAL del trading; dónde viven las páginas con datos reales; y registro de accesos.
- **SEC-01 en la versión remota, High** (la persona, 2026-10-23): con datos externos, el tipo de un evento podría venir de
  fuera. Requisitos de esa versión, con su prueba: los tipos de evento son una lista cerrada que se valida al leer el
  diario (un tipo desconocido no se pinta) y todo texto se escapa.
- **Los Low** (SEC-03 en lo pendiente, SEC-04 y SEC-05) se quedan documentados como están (la persona, 2026-10-23).
- **Respuestas de la persona (2026-10-23).** La «publicación» del dashboard (`CLAUDE.md` §1) es solo la demo con datos
  sintéticos del repo público del paso 49 (GIF y comando de demo); un diario con datos reales nunca se publica y se queda
  en local. Y el tipo de un evento podrá venir de fuera en una versión futura: de ahí el punto anterior sobre SEC-01.
