# DATA — datos para investigar

Fecha: 2026-10-07 (paso 17, parte C); comprobaciones de la primera descarga, 2026-10-08 (paso 19B, §5). Depende del exchange que apruebe la persona en el
[ADR 0018](docs/adr/0018-exchange-principal-y-respaldo.md) (Bitvavo, aceptado) y del periodo del test final del
[ADR 0019](docs/adr/0019-periodo-del-test-final.md). Si cambia alguno de los dos, este documento se revisa.

Convenciones: **[DOC]** documentación oficial consultada el 2026-10-07; **[API]** comprobado con una petición
pública de solo lectura ese día; **[verificar]** se comprueba al descargar; **[19B]** comprobado en la primera
descarga (§5).

## 1. Qué necesita el research

Según `quant-research` §3 a §5 y la estrategia de tendencia en 4h y 1d de `docs/research/02`:

1. **Velas OHLCV** de 1h, 4h y 1d en EUR, con al menos un mercado bajista completo (2018 o 2022) y datos hasta el
   2026-09-30 (el test final empieza el 2026-10-01).
2. **Universo point-in-time:** qué pares existían en cada fecha, cuándo se listaron y cuándo se deslistaron.
   Sin eso hay sesgo de supervivencia.
3. **Costes:** comisión del exchange, medio spread y slippage (`quant-research` §5).
4. **Huecos y calidad:** detectar velas que faltan, sin rellenarlas (`quant-research` §3).
5. **Huella:** fuente, rango, timeframe y hash de cada conjunto de datos.

## 2. El exchange principal no ofrece histórico de pares deslistados

**Bitvavo no da histórico de pares deslistados.** Comprobado el 2026-10-07 [API]:

- `GET /v2/markets` devuelve solo los 438 mercados en negociación (427 en EUR y 11 en USDC). Un universo construido
  con esa lista tiene sesgo de supervivencia por construcción.
- Las velas de mercados deslistados (`ANT-EUR`, `VTC-EUR`, `LTO-EUR`, `KMD-EUR`) devuelven el error 205
  («market parameter is invalid»). Sus anuncios de deslistado sí siguen publicados (bitvavo.com/en/news).
- Las velas de BTC-EUR empiezan el 2019-03-08: cubren el mercado bajista de 2022, pero no el de 2018.

**Cómo se evita el sesgo de supervivencia:**

1. **El histórico de research sale de Kraken**, que publica todos los trades de cada par desde su primer trade
   [DOC]. Si el ZIP incluye los pares ya deslistados (pares que no estén en `AssetPairs` de hoy), las fechas de
   listado y deslistado salen del primer y el último trade de cada par. [19B: los incluye solo desde 2023; §5.]
2. **Universo por tramos:** al inicio de cada tramo walk-forward, solo entran los pares en EUR con al menos 365
   días de trades antes de esa fecha, ordenados por volumen en EUR de los 90 días anteriores. Nada se elige con
   datos posteriores al inicio del tramo.
3. **Un par que se deslista dentro del tramo sigue en el universo:** se sale al último precio negociado y, si no
   hay salida posible, la posición vale 0.
4. **Si Kraken no incluyera los deslistados:** el universo se limita a pares que ya existían al inicio de cada
   periodo y que siguen listados, y entre ellos se aplica la regla del punto 2 con el tamaño fijado en el pre-registro.
   Una lista elegida a mano no es una regla, y antes de registrar se comprueba contra los manifiestos (ADR 0040; hasta
   el 2026-10-21 decía «se empieza por BTC y ETH»). El informe declara el sesgo restante; no se oculta.
5. **De Kraken a Bitvavo:** la estrategia solo opera pares que existan en Bitvavo en el momento de decidir. Con los
   pares activos en ambos, se compara el precio de Kraken con el de Bitvavo de 2019-03 a 2026-09 para comprobar
   que el resultado se traslada.
6. **A partir de ahora, registro propio:** una foto diaria de `GET /v2/markets` de Bitvavo da el listado
   point-in-time que el exchange no publica.

## 3. Fuentes y clasificación

| Fuente | Qué da | Coste y licencia | Clase | Por qué |
|---|---|---|---|---|
| **Kraken, ZIP de OHLCVT** [DOC] | Velas de 1, 5, 15, 30, 60, 240, 720 y 1.440 minutos de cada par, desde su inicio hasta el 2026-06-30. Actualización trimestral. Solo intervalos con trades | Gratis. Sin licencia explícita en la página: rigen los términos EEA de Kraken, §11 (uso propio, sin redistribuir) [19B] | **REQUIRED** | Es la única fuente gratuita en EUR con 2018 y 2022 |
| **Kraken, ZIP de trades** [DOC] | Todos los trades públicos de cada par desde el primero hasta el 2026-06-30 (`timestamp, price, volume, type, order_type, misc, trade_id`), en partes de unos 2 GB con `MANIFEST.json` | Gratis; como arriba | **REQUIRED** | Listados, deslistados y huecos. Permite rehacer las velas y comprobar el ZIP de OHLCVT |
| **Kraken, API REST** (`OHLC`, `Trades`) | Del 2026-07-01 al 2026-09-30, que aún no está en los ZIP. `OHLC` devuelve solo las últimas 720 velas; `Trades` pagina toda la historia con `since` | Gratis | **REQUIRED** | Completar hasta el fin de los datos de research. Alternativa: el ZIP trimestral del tercer trimestre de 2026 |
| **Bitvavo, velas por API** [API] | Velas de los mercados activos desde 2019-03, hasta 1.440 por petición | Gratis, con 1.000 puntos de peso por minuto | **REQUIRED** | Precios del exchange donde se opera: comparar con Kraken y, más adelante, paper y live |
| **Bitvavo, foto diaria de mercados** (registro propio) | Listado point-in-time a partir de hoy | Gratis | **REQUIRED** | El exchange no publica histórico de listados (§2) |
| **Spread estimado** (registro propio del mejor bid y ask de Bitvavo, y estimadores sobre OHLC) | Medio spread por par y franja horaria | Gratis | **REQUIRED** | `quant-research` §5 obliga a cobrar medio spread. `docs/research/02` solo tenía una foto del libro |
| **Comisiones vigentes** (páginas oficiales de comisiones) | 0,15 % / 0,25 % en Bitvavo; 0,40 % / 0,80 % en Kraken [DOC] | Gratis | **REQUIRED** | Se aplica la comisión base vigente del exchange principal a toda la historia, nunca menos del 0,10 % de `quant-research` §5, y se prueba con costes ×2 |
| **Comisiones históricas** (copias de esas páginas en web.archive.org) | Cómo cambiaron | Gratis | NICE-TO-HAVE | Con capital pequeño cuenta la tarifa base de hoy, y la prueba con costes ×2 cubre la duda |
| **Bitvavo, trades por API** [DOC] | Trades por ventanas de hasta 24 horas | Gratis | NICE-TO-HAVE | Estimar slippage. Para 4h y 1d con órdenes de 1.000 EUR basta con el spread |
| **Libro de órdenes propio** (WebSocket de Bitvavo, a partir del paso 32) | Profundidad real desde ese momento | Gratis | NICE-TO-HAVE | Útil para el slippage en live, no para el research histórico |
| **Binance public data** (data.binance.vision) | Velas, trades y aggTrades spot en USDT desde 2017-08, ficheros diarios y mensuales con `.CHECKSUM` | Gratis. Repositorio MIT y términos aparte para los datos [verificar] | NICE-TO-HAVE | Comprobar la robustez en otro mercado y con más pares. No se puede operar allí (sin autorización MiCA) y si incluye los deslistados no está confirmado |
| **OKX, descarga histórica** [DOC] | Trades desde 2021-09 y velas desde 2023-07 (OKX global) | Gratis | NOT JUSTIFIED | Solo el exchange de respaldo. Se revisa si OKX pasa a principal |
| **Capitalización histórica** (CoinGecko y similares) | Top por capitalización en cada fecha | Gratis con historia limitada, o de pago | NOT JUSTIFIED | El universo se ordena por volumen en el propio exchange (§2) |
| **Proveedores de pago** (Tardis.dev, Kaiko, CoinAPI) | Libro L2 y trades normalizados de muchos exchanges | De pago. No se evaluaron coste ni licencia | NOT JUSTIFIED | Las fuentes gratuitas cubren todo lo imprescindible. El L2 histórico no cambia nada en 4h y 1d con órdenes de 1.000 EUR. Si un paso futuro lo necesita, se evalúa con coste y licencia, y contratar es una parada obligatoria |

## 4. Reglas al descargar y guardar (pasos 18 y 19)

El formato del almacén (Parquet con `DECIMAL(38,18)`, versiones inmutables y manifiesto), la separación del test
final y su guarda están en el [ADR 0020](docs/adr/0020-pipeline-historico-y-guarda-del-test-final.md) (paso 18). En
el paso 18 no se descargó nada; la primera descarga es del paso 19B (ADR 0022) y sus comprobaciones están en §5.

- **Descargar es una acción con permiso:** se pide con el nombre, el origen y el tamaño de cada fichero. El ZIP de
  trades de Kraken ocupa varias partes de unos 2 GB.
- **Nunca float** para precios ni cantidades (regla del tramo 1; el paso 18 lo comprueba en el esquema de
  Parquet/DuckDB). Los CSV se leen como texto decimal.
- **Nada posterior al 2026-09-30T23:59:59Z** entra en los datos de research. Lo posterior pertenece al test final y
  solo se descarga cuando una persona abre una de sus etapas, en una carpeta que no se versiona (INV-13d y ADR 0019).
  Desde el paso 19B lo aplica la guarda también a los ficheros brutos: uno cuyo periodo pasa de esa fecha, aunque sea
  en parte, no se lee ni se descarga sin el desbloqueo del ADR 0020 (ADR 0022, decisión 14). El ZIP trimestral 2026Q4
  y los siguientes son del test final.
- **Huella:** cada conjunto de datos registra la fuente, la URL, la fecha de descarga, el rango, el timeframe y el
  SHA-256 del fichero original.
- **Comprobaciones al descargar** [19B, §5]: si hay pares deslistados en el ZIP de Kraken, cuántos huecos tiene
  cada par, la zona horaria de los timestamps, que las velas rehechas desde los trades coinciden con el OHLCVT, y
  los términos de uso de cada fuente.

## 5. Primera descarga (paso 19B, 2026-10-08)

Detalle de fuentes, decisiones y SHA-256 en el [ADR 0022](docs/adr/0022-primera-descarga-de-kraken.md); informes
completos en `data/provenance/` (fuera de Git).

- **Qué hay:** ZIP completo de OHLCVT 2026Q2 (verificado con el SHA-256 publicado) y ZIP trimestral 2026Q3, ya
  publicado, que sustituye a la API de velas. Pares en EUR en 1h, 4h y 1d: 648 pares y 1.944 datasets del completo
  (11.538.312 velas, de 2013-09-10 a 2026-07-01) y 535 pares y 1.605 datasets del trimestral (830.423 velas, hasta
  el cierre de 2026-09-30T23:00Z). Ninguna fila rechazada, inválida, duplicada ni en conflicto.
- **Test final:** 1.014 velas del trimestral (como mucho una por dataset: la que cierra en el inicio, con 60 s de
  latencia) se contaron y se descartaron. Ninguna vela de octubre en los ZIP.
- **Deslistados [19B]:** sí, pero **solo desde 2023**. 112 pares en EUR del ZIP no están hoy en `AssetPairs`; el
  primero dejó de negociarse el 2023-01-01 (TRIBE) y el resto entre 2024 y 2026 (57 el 2026-01-01). Faltan
  deslistados antiguos conocidos (BSV en 2019, ICN): **antes de 2023 el universo tiene sesgo de supervivencia**.
  Desde el paso 23, `universeAt` no responde antes del 2023-01-01 (`KRAKEN_DELISTINGS_FROM_UTC`); antes solo cabe un
  universo limitado con el sesgo declarado (`limitedUniverseAt`, §2 punto 4).
  Un par ausente de `AssetPairs` puede estar renombrado, no deslistado (LUNA, LUNA2, REPV2). Decidido en el paso 23 con
  los rangos de los manifiestos: LUNA/EUR es un único mercado continuo (Terra y, desde mayo de 2022, Terra Classic) que
  sigue al final; LUNA2/EUR es otro activo, sin velas desde el 2025-07-01; REP/EUR y REPV2/EUR son dos tokens que
  cotizaron a la vez desde 2020 y ninguno tiene velas en 2026Q3. Ninguno se une con otro.
- **Bajas al final [23]:** salen de las velas y no de `AssetPairs` (del 2026-10-08, periodo del test final): un par sigue
  listado si tiene una vela que cierra después del 2026-09-29T00:00Z; si no, se da de baja al cierre de su última vela.
- **Unión por par [23]:** el completo (hasta el 2026-07-01) y el trimestral 2026Q3 se concatenan; si se solapan, son de
  otro par o les falta una fila, la unión falla (`joinParts`). 10 pares en EUR listados hoy no están en el completo (listados después del 2026-06-30).
- **Huecos:** 1.743.853 en el completo y 163.401 en el trimestral. Kraken omite los intervalos sin trades, así que
  casi todos son de pares poco líquidos; nunca se rellenan. BTC/EUR: 4 huecos en 1d (el mayor, 2 velas), 62 en 4h
  y 272 en 1h. Antes de 2018 solo hay 13 pares en EUR con velas diarias.
- **Zona horaria [19B]:** segundos Unix de la apertura, en UTC (README del ZIP; las velas de 1d validan alineadas a
  medianoche UTC).
- **Velas desde trades [19B]:** un día de trades de XBT/EUR (2026-06-15, 37.527 trades) da las mismas 24 velas de 1h:
  OHLC y número de trades exactos. El volumen del OHLCVT es una suma en float de Kraken (`8.969955389999999`
  frente a 8,96995539): diferencia relativa < 1e-12, y el almacén lo redondea a 18 decimales (4.806 filas).
- **Notación científica:** Kraken escribe así los valores pequeños (`2.333e-07`); se leen de forma exacta.
- **Sumas por partes:** el `OHLCVT_Full_PARTS_SHA256SUMS.txt` publicado es de un juego nuevo sin anunciar
  (`Kraken_OHLCVT_Full.zip.part*`, del 2026-10-06), no de las partes 2026Q2. No se descargó ese juego.

