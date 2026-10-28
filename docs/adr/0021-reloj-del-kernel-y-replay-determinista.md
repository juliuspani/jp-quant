# ADR 0021 — Reloj del kernel y replay determinista

Fecha: 2026-10-08 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 19

## Contexto

El paso 19 pide un motor de replay de mercado determinista: con el mismo dataset, la misma configuración y la misma
semilla, el resultado debe ser idéntico byte a byte. Tiene que operar según el tiempo de los eventos, con un reloj
inyectable que tenga la misma interfaz que usará live, y ofrecer pausa, reanudación, velocidad y replay de un
segmento. El determinismo se demuestra con tests que comparan hashes de la salida de varias ejecuciones.

Lo que ya estaba fijado: `ARCHITECTURE.md` §5.3 y §16.2 definen `Clock`, `Ids` y `Rng` en `src/kernel/`, con un
`SystemClock` en tiempo real y un `SimulatedClock` en backtest y replay; §5.1 ordena el replay por `received_time`;
§14 exige que dos ejecuciones con los mismos datos, configuración, commit y semillas den el mismo diario. Al crear
`src/kernel/` había dos compromisos: la regla de ESLint contra el reloj y el azar propios en el dominio, y llevar
allí `Candle`.

## Decisión

1. **Contrato del reloj** (`src/kernel/clock.ts`), el de §16.2 sin cambios: `now()` en milisegundos UTC enteros,
   `monotonic()` para duraciones, `schedule(at, timerId)` y `cancel(timerId)`. Las reglas de los temporizadores
   viven en `TimerTable` y las usan los dos relojes, para que el replay no acepte nada que live rechazaría:
   - un instante anterior a `now()` o un id que ya está pendiente se rechazan con `TimerError` (fail closed: nada
     se reprograma en silencio);
   - `cancel` de un id desconocido o ya vencido no hace nada;
   - vencen por instante y, en empate, por orden de programación.
2. **`SystemClock`** (`src/kernel/system-clock.ts`) es el reloj de live: `Date.now()`, `performance.now()` y
   `setTimeout`, con esperas de más de unos 24,8 días partidas en tramos, porque `setTimeout` haría vencer una
   espera mayor en 1 ms. Entrega los temporizadores vencidos a un `TimerSink`, que con el bus será `TimerFired`.
   `Sleeper` es la espera en tiempo de pared que marca el ritmo de un replay; `systemSleeper` la implementa.
3. **Azar con semilla** (`src/kernel/random.ts`): xoshiro128** sembrado con splitmix32, solo con aritmética entera
   de 32 bits (`Math.imul` y desplazamientos), así que la secuencia no depende de la máquina ni de la versión de
   Node. La semilla es un entero de 0 a 2^32 − 1. Cada uso tiene su flujo, separado por nombre (FNV-1a), para que
   consumir azar en un sitio no mueva la secuencia de otro. Los ids del replay son `prefijo-n-xxxxxxxx`: únicos por
   el contador y dependientes de la semilla por el sufijo. No es azar criptográfico: en tiempo real los ids serán UUID
   aleatorios (§5.3), y se crearán en el archivo exceptuado de la regla.
4. **Regla «sin reloj ni azar propios»** (`scripts/eslint-wall-clock.ts`), con reglas de ESLint de serie, en el
   dominio de §15.1 y en `src/backtest/`: `Date.now`, `new Date()` sin argumentos, `Date()`, `Math.random`,
   `performance.now`, `process.hrtime`, `process.uptime`, los temporizadores globales y de `node:timers`,
   `node:perf_hooks` y las funciones de azar de `node:crypto`. Solo exceptúa `src/kernel/system-clock.ts`.
   `src/historical/` queda fuera: es un adaptador, y fecha sus manifiestos con la hora real.
5. **`Candle` pasa a `src/kernel/market-data.ts`** (§16.3) y `HistoricalCandle` la extiende con `receivedTime`;
   `SymbolId` pasa a `src/shared/symbol.ts` (§16.1).
6. **Motor de replay** (`src/backtest/replay.ts`), en `backtest/` como dice §4.2 («Backtesting/Replay»). Recibe
   registros genéricos (`type`, `source`, `sourceSeq`, `eventTime`, `receivedTime` y un `payload` canónico) y no
   importa `historical/`, porque la matriz de §15.1 no lo permite: la conversión de velas a registros la hará `app/`
   (hoy la hacen las pruebas).
   - **Tiempo de los eventos.** El tiempo lo marcan los datos, nunca el reloj de pared. Cada registro se entrega en
     su `received_time` (`event_time` más la latencia de su fuente, §5.1), con el reloj simulado en ese instante;
     el evento conserva los dos tiempos. Entregarlo en su `event_time` adelantaría cada dato la latencia de su
     fuente: sería look-ahead. Con latencia cero, los dos coinciden. Un registro con `received_time` anterior a su
     `event_time` se rechaza.
   - **Orden total.** Por `received_time`, luego por fuente y por `sourceSeq` (§5.1). Un temporizador se intercala
     en su instante, y en empate con un dato va después: el temporizador de `T` ve todo lo recibido en `T`. El orden
     de la lista de entrada no importa: se ordena antes.
   - **Reloj inyectado.** Los handlers reciben el contrato `Clock` de live (una fachada sobre `SimulatedClock`, que
     no les deja moverlo), un `Rng` y unos `Ids` con semilla, y `output()`, que anota una salida causada por el
     evento en curso. Los handlers son síncronos (§5.2): devolver algo, también una promesa, es un error.
   - **Resultado.** Un diario JSONL canónico (`src/backtest/canonical.ts`: claves ordenadas, `Decimal` como texto
     y rechazo de `undefined`, `NaN`, `Infinity`, `bigint`, fechas y clases) con cabecera (formato, `runId`,
     semilla, segmento y SHA-256 de todos los registros de entrada), un evento por línea y cierre (instante final y
     temporizadores pendientes), y su SHA-256. Los eventos se congelan: un handler no cambia lo que verán los demás.
   - **Pausa, reanudación, pasos y velocidad.** `play()` entrega al ritmo de la velocidad (`'max'` o veces la real)
     esperando con un `Sleeper` inyectado; `pause()` (también desde un handler, como punto de parada), `resume()`,
     `step()` en pausa y `setSpeed()` solo cambian el ritmo: no entran en el resultado. `run()` entrega todo sin
     esperas. Avanzar el replay desde un handler se rechaza.
   - **Segmento.** `[from, to)` por `received_time`: solo esos registros, el reloj empieza en `from` y los
     temporizadores que vencerían en `to` o después quedan pendientes, a la vista en el cierre. Sin segmento, va del
     primer registro al último, ambos incluidos.
   - **Fail closed.** Registros duplicados (misma fuente y `sourceSeq`), tiempos inválidos, datos no canónicos,
     semilla, velocidad o segmento inválidos, y un handler que lanza: el motor queda en `failed` y no sigue.
7. **Prueba del determinismo** (`test/src/backtest/replay.test.ts`): el mismo hash en cinco ejecuciones, en dos
   procesos aparte, con la entrada en otro orden, tras pasar por el almacén Parquet y con pausas, pasos y cambios de
   velocidad; y un hash fijado, para detectar que el replay deja de ser reproducible entre versiones. Otra semilla,
   otro `runId` u otro dato cambian el hash.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| `Math.random` con una semilla global o un paquete de npm (seedrandom) | `Math.random` no admite semilla, y un paquete añade una dependencia para unas 30 líneas con vector de referencia |
| mulberry32 | Más corto, pero con peor calidad estadística; xoshiro128** tiene vector de referencia publicado y el test lo comprueba |
| Reprogramar en silencio un temporizador en el pasado (como `setTimeout` con espera negativa) | Ocultaría un error de quien programa, y el replay y live podrían divergir en el orden |
| Un plugin de ESLint propio, como `inversor/no-float` | Las reglas de serie bastan: no necesitan información de tipos |
| Incluir `src/historical/` en la regla | Es un adaptador con E/S: la hora real de la descarga es un dato de procedencia legítimo |
| Entregar cada dato en su `event_time` | Adelanta la latencia de la fuente: look-ahead. El prompt pide operar según el tiempo de los eventos frente al reloj de pared, y `received_time` también es un tiempo de los datos |
| Que la velocidad o las pausas entren en el resultado | El resultado dependería de cómo se miró el replay; el ritmo queda fuera y una prueba lo comprueba |
| Construir ya el bus y el sobre completo de §16.2 | Infraestructura que el paso no necesita (`trading-project-engineer` §10); el diario del replay usa los campos del sobre que hoy tienen sentido |
| `JSON.stringify` tal cual para el diario | Deja caer `undefined`, convierte `NaN` en `null` y depende del orden de inserción de las claves |
| Que el replay lea `historical/` directamente | La matriz de límites (ADR 0015) no deja a `backtest/` importar `historical/`; lo compone `app/` |

## Consecuencias

- El kernel existe con contratos y sin bus: el bus, el sobre completo de §16.2 y `TimerFired` llegan en el paso que
  reescriba el backtest (paso 23) o antes si otro paso los necesita.
- La regla no ve una función de reloj que llegue con otro nombre (por ejemplo, desde un módulo exceptuado) ni lo que
  haga un adaptador inyectado: la composición la controla `app/` (§15.2).
- `xoshiro128**` tiene 128 bits de estado y 32 bits por número: suficiente para simulación y bootstrap, no para
  criptografía.
- El hash fijado cambia si cambia a propósito el formato del diario, el escenario de prueba o el motor; ese cambio
  se explica en su commit. `REPLAY_FORMAT` sube de versión si cambia el formato.
- Determinismo y no look-ahead son cosas distintas: el motor entrega en orden de `received_time` y no ve el futuro,
  pero si las latencias registradas en el dataset son optimistas, el replay también lo será (`DATA.md` §4, paso que
  fije `receivedLatencyMs` con datos reales).
- Sin calentamiento propio: un segmento empieza en frío. Si una estrategia necesita velas previas, se amplía el
  segmento hacia atrás y se descarta el principio, o se añade cuando el backtest lo necesite (paso 23).
- Con velocidad `'max'`, `play()` no cede el control entre eventos: una pausa externa solo se nota en las esperas.
  Un handler sí puede pausar.
- El diario se guarda en memoria: un replay de muchos años con muchos símbolos puede necesitar escribirlo en
  streaming. Se decide cuando haya datos reales.

## Corrección editorial (2026-10-13, paso 21)

`src/backtest/canonical.ts` pasa a `src/shared/canonical.ts`, sin cambios de comportamiento ni de formato: el
registro de experimentos (`src/research/`, ADR 0024) también lo usa, y `research/` no puede importar `backtest/`
(ARCHITECTURE.md §15.1). ARCHITECTURE.md §4.2 ya situaba el JSON canónico en `shared/`.

## Nota del paso 23 (2026-10-13)

El backtester event-driven (ADR 0026) se construye sobre este motor sin cambiar su formato ni su determinismo. El bus
del kernel no se construye: el replay es la cola de eventos del backtest, y el bus llega cuando lo pidan paper y live
(paso 32). `ReplayEngine.clock` expone la misma fachada `Clock` que reciben los handlers, para componer los módulos
antes de empezar. La prueba de determinismo se extiende al diario del backtest (`test/src/app/backtest.test.ts`): el
mismo hash entre ejecuciones y entre procesos, fijado, sin las firmas de los tokens.
