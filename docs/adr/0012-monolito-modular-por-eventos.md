# ADR 0012 — Arquitectura definitiva: monolito modular orientado a eventos

Fecha: 2026-10-06 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) ·
Paso: 14

## Contexto

El prompt del paso 14 pide fijar la arquitectura definitiva antes de seguir programando:

- **basada en eventos**, con el pipeline Market Data → Normalization → Feature Engine → Strategy Engine →
  Portfolio/Risk Engine → Execution Engine → Exchange Adapter;
- **módulos paralelos:** Historical Data, Backtesting/Replay, Persistence, Analytics (con el régimen de
  mercado por volatilidad), Monitoring, Strategy Registry, Experiment Registry y el capguard en un proceso
  independiente;
- **módulos futuros** con la interfaz prevista: on-chain, noticias, macro y microestructura avanzada;
- **preferencia** por un monolito modular en un solo proceso, más el capguard, salvo que la evidencia diga lo
  contrario.

Punto de partida:

- **El código previo es plano.** `engine.ts` llama directamente al broker (trading-risk §10), y de los límites
  arquitectónicos solo muerde la regla de ccxt.
- **Las reglas ya existen, pero no tienen dónde vivir.** Los skills fijan el flujo con token, el estado
  UNKNOWN, persistir antes de actuar y los datos point-in-time; faltaba la estructura que los aloje.
- **La carga es mínima:** tendencia con velas de 4 h, unas 12 operaciones al año y pocos símbolos
  (`docs/research/02`).

El detalle está en [ARCHITECTURE.md](../../ARCHITECTURE.md). Este ADR registra las decisiones.

## Decisión

1. **Procesos.**
   - Un proceso principal (monolito modular) y el capguard aparte.
   - El backtest, la captura de datos, la investigación y los informes son comandos del mismo código, que se
     ejecutan y terminan.
   - Una sola instancia del proceso principal por máquina. La captura no arranca si esa instancia está activa
     en la misma máquina, porque comparten el límite de peticiones por IP.
2. **Módulos y carpetas** (ARCHITECTURE.md §4):
   - pipeline: `src/marketdata/` (Market Data y Normalization), `src/features/`, `src/strategy/`,
     `src/portfolio/` y `src/risk/`, `src/execution/` y `src/exchange/`;
   - módulos paralelos: `src/historical/`, `src/backtest/`, `src/persistence/`, `src/analytics/`,
     `src/monitoring/`, `src/registry/` (Strategy Registry), `src/research/` (Experiment Registry) y
     `capguard/`;
   - transversales: `src/kernel/`, `src/shared/`, `src/config/` y `src/app/`;
   - futuros: `src/intel/` (`onchain/`, `news/` y `macro/`) y `src/features/microstructure/`.
3. **Kernel por eventos en un hilo.**
   - Una cola FIFO y handlers síncronos, llamados en el orden en que se registran.
   - La E/S solo la hacen los adaptadores: sus resultados vuelven como eventos, y ningún callback asíncrono
     toca estado.
   - Las lecturas en memoria se hacen por vistas de solo lectura.
   - Los temporizadores los dispara el reloj, y un vigilante mide el retraso del bucle.
4. **Eventos.**
   - Cada uno lleva `event_time` (cuándo ocurrió en origen) y `received_time` (cuándo lo tuvo el sistema).
   - El catálogo es cerrado (ARCHITECTURE.md §6), con un solo productor por tipo en cada run.
   - Los eventos son inmutables y se apuntan en el diario antes de despacharlos, salvo los de alta frecuencia
     (libro de órdenes).
5. **Un dueño por dato** (ARCHITECTURE.md §7). Cada tabla de SQLite la escribe un solo módulo, a través de la
   única conexión, que tiene `src/persistence/`. Los rechazos de todas las capas los registra Risk, dueño de
   `risk_decisions`.
6. **Un solo writer por cuenta:** instancia única, cola de órdenes serializada en Execution con prioridades, y
   el capguard como único poseedor de la clave de trading (ARCHITECTURE.md §9).
7. **Persistencia.**
   - Una base SQLite por modo, con las tablas de auditoría solo de inserción, decimales como `TEXT` y tiempos
     como enteros UTC.
   - El histórico de mercado, aparte (formato en el paso 18).
   - Los registros de experimentos y de estrategias, en JSONL versionado.
8. **Recuperación.**
   - Arranque *fail closed* en el orden de ARCHITECTURE.md §11, siempre en UNKNOWN.
   - **Invariante rota:** si se puede, se persiste el kill switch; después se lanza un CRITICAL y el proceso
     sale con código distinto de 0 para que el supervisor lo reinicie (*crash-only*).
   - **Bucle de caídas:** con 3 salidas no limpias en 60 min, el arranque activa el kill switch. Es un valor
     provisional, que se fija con el supervisor en el paso 39.
9. **Observabilidad.**
   - Los mismos niveles para alertas y log: INFO, WARNING y CRITICAL.
   - Las alertas las deriva `monitoring/` de los hechos.
   - Correlación por `intent_id`.
   - Métricas como eventos `HealthSnapshot`.
   - Latido externo con cada `CycleCompleted`.
10. **Errores:** la tabla de ARCHITECTURE.md §13. Lo que ya tratan los skills (`INTERNAL_ERROR`, UNKNOWN) se
    trata como dicen ellos, y solo lo que escapa de esos caminos es una invariante rota.
11. **Régimen de mercado en `analytics/`** (ARCHITECTURE.md §4.4). Clasifica la volatilidad (`BAJA`, `NORMAL`,
    `ALTA` o `EXTREMA`) y la tendencia con datos solo del pasado. Sus parámetros se pre-registran como
    parámetros de investigación, y en riesgo solo puede apretar.
12. **Interfaces** de ARCHITECTURE.md §16 y §17 como contrato de partida. Cambiar un contrato entre módulos
    exige un ADR.
13. **Conceptos adoptados de los sistemas de referencia** (ARCHITECTURE.md §20, sin copiar código):
    - la separación entre decisión y gestión de la orden con Risk en medio (Hummingbot V2);
    - la captura de datos como tarea independiente con registro (Quants Lab);
    - abortar ante una invariante rota con un supervisor externo (NautilusTrader);
    - el calentamiento declarado por la estrategia (Freqtrade).

## Alternativas descartadas

- **Un proceso por módulo o microservicios.** Exigen colas entre procesos, bloqueos distribuidos para el writer
  único y gestión de fallos parciales, para una carga de unas operaciones al año. La única separación que
  compensa es la de seguridad: el capguard.
- **Broker de mensajes externo (Redis Streams, Kafka, NATS).** Añade un servicio que operar, asegurar y
  respaldar, y un punto de fallo más. El bus en memoria más el diario en SQLite dan el orden y la auditoría
  que hacen falta.
- **Hilos de trabajo (`worker_threads`) para el pipeline.** Rompen el orden determinista y obligan a
  sincronizar el estado. Lo pesado va a los comandos, fuera del proceso principal.
- **Llamadas directas entre módulos, sin bus**, como el `engine.ts` actual. Esconden el orden de los cambios de
  estado, no dejan un diario reproducible y dificultan que el backtest use el mismo camino.
- **Event sourcing completo** (reconstruir todo el estado desde el diario). El exchange es la fuente de verdad
  (exchange-execution §1), y cada dueño persiste su estado. El diario sirve para auditar y para reproducir, no
  como única fuente.
- **Handlers asíncronos.** Intercalarían cambios de estado en cada `await` y harían falta locks.
- **Varios productores por tipo de evento.** Diluirían la propiedad del estado. Cada hecho lo publica su dueño,
  y cada módulo decide sobre los hechos que le llegan.

## Consecuencias

- **El refactor sigue el orden de ARCHITECTURE.md §19:** el tramo 1 construye en sus carpetas definitivas lo que
  necesita el backtest, y el tramo 2 lo completa.
- **Compromisos nuevos** (en `PROGRESS.md`):
  - regla de ESLint contra el reloj y el azar propios en el dominio, al crear `src/kernel/`;
  - prueba de determinismo del diario;
  - prueba de la composición de `app/`;
  - prueba de contrato del protocolo con el capguard;
  - niveles del log al mover `log.ts`;
  - volver a ejecutar el backtest en el paso 35.
- **`CLAUDE.md` §1 y §5** apuntan a `ARCHITECTURE.md`, que ya existe.
- **[REFERENCE_SYSTEMS.md](../REFERENCE_SYSTEMS.md) §9** marca como adoptados los conceptos de la decisión 13.
- **Riesgos:**
  - la indirección de un sistema por eventos;
  - un cálculo largo bloquea el único hilo (lo detecta el vigilante);
  - `node:sqlite` sigue siendo candidata a estable;
  - el saludo con el capguard solo lo protegen los permisos del sistema operativo (ARCHITECTURE.md §21).

## Fuentes

- [REFERENCE_SYSTEMS.md](../REFERENCE_SYSTEMS.md): fichas del 2026-10-02.
- Página de arquitectura de NautilusTrader, consultada el 2026-10-06:
  https://nautilustrader.io/docs/latest/concepts/architecture/
- Versiones comprobadas el 2026-10-06 en la API de GitHub. Freqtrade 2026.9 y Hummingbot v2.17.0, sin cambios.
  NautilusTrader publicó la candidata v2.0.0rc6 (2026-10-05), sin cambio de estable.
- `docs/research/02` (frecuencia de la estrategia) y `docs/research/05` §4.8 y §7.2 (`node:sqlite`).
