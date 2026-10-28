# ADR 0022 — Primera descarga: OHLCVT de Kraken al almacén de investigación

Fecha: 2026-10-08 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 19B

## Contexto

El paso 19B hace la primera descarga con el pipeline del paso 18 (ADR 0020): el ZIP de OHLCVT de Kraken y lo que
haga falta de la API, según `DATA.md`. Tiene que separar lo que es del test final según el candado, comprobar si el
ZIP trae pares deslistados (compromiso del 17 y del 18), fijar la latencia de cada fuente y dejar checksums, calidad,
huecos y procedencia. La persona autorizó en el chat, fichero a fichero, las nueve descargas de la tabla de abajo.

Al consultar la página oficial de Kraken (actualizada el 2026-09-16) aparecieron dos cosas que `DATA.md` no preveía:

- **Ya está publicado el ZIP trimestral de 2026Q3** (de julio a septiembre, del 2026-10-06), aunque la página aún no
  lo enlaza. Cubre justo el hueco hasta el fin de los datos de research.
- **Las sumas por partes publicadas no son las de las partes 2026Q2.** `OHLCVT_Full_PARTS_SHA256SUMS.txt` es del
  2026-10-06 y nombra `Kraken_OHLCVT_Full.zip.part0N`, un juego nuevo que la página no anuncia. Las partes 2026Q2 se
  comprueban con el SHA-256 del ZIP unido que publica la página.

## Decisión

1. **Fuentes.** El ZIP completo 2026Q2 (desde el primer trade de cada par hasta el 2026-06-30) y el ZIP trimestral
   2026Q3 (del 2026-07-01 al 2026-09-30). El trimestral sustituye a la API `OHLC`, que solo da las últimas 720 velas.
   El juego nuevo sin anunciar no se descarga: la persona no lo autorizó y la página no lo documenta.
2. **Integridad.** El ZIP unido coincide con el SHA-256 publicado (`fc81b54c…`); el 2026Q3 no tiene suma publicada y
   se registra la suya. Los dos pasan `unzip -t` (CRC de cada entrada). Las partes se borran tras unirlas, con su
   SHA-256 anotado en `data/raw/kraken/Kraken_OHLCVT_Full_2026Q2.parts.sha256`.
3. **Qué se captura.** Solo los pares en EUR, en 1h, 4h y 1d (`DATA.md` §1). Los marcos de 1, 5, 15, 30 y 720
   minutos se ignoran. El ZIP se lee entrada a entrada con `unzip -p`, sin extraerlo a disco.
4. **Un dataset por par, marco y fuente:** `kraken-<altname>-<marco>-<fuente>` (`kraken-xbteur-1h-full2026q2`). El
   manifiesto lleva un único SHA-256 del original (ADR 0020), y así cada dataset nombra el fichero exacto del que
   sale. Además cabe en memoria: se procesa un CSV cada vez (la máquina tiene 16 GB y el `Decimal` ocupa ~1 KB por
   vela). Unir las dos fuentes de un par es trabajo del lector del paso 23.
5. **Latencia del OHLCVT: 60 s** (`KRAKEN_OHLCVT_LATENCY_MS`). `received_time` = cierre + 60 s. Es conservadora:
   retrasa las decisiones del replay, nunca las adelanta. Se revisa con datos del paso 32, cuando haya velas en
   tiempo real del exchange.
6. **Test final.** La captura separa con `TestFinalGuard.partition` antes de calcular nada. Lo recibido desde el
   2026-10-01T00:00:00Z se cuenta y se descarta: no se guarda en investigación ni bajo la carpeta del test final,
   que solo se llena cuando una persona abre una etapa (`DATA.md` §4). Con 60 s de latencia, la última vela del 30 de
   septiembre de cada marco cierra en el inicio y cae de ese lado. `writeResearch` rechaza además cualquier vela con
   `received_time` en el test final.
7. **Volumen.** Kraken suma el volumen en float (`8.969955389999999` frente a 8,96995539 exacto). Se redondea a 18
   decimales (`HALF_EVEN`, la escala de DECIMAL(38,18)) y se cuenta por dataset (`volumeRoundedRows`). Los precios
   no se tocan: uno que no quepa hace fallar la captura.
8. **Notación científica.** Kraken escribe en notación científica los valores pequeños (`2.333e-07`). El primer
   intento con 2026Q3 rechazó 34.165 filas por eso, y se perdían casi enteros los pares de precio muy bajo. Como
   prevé el ADR 0014 §5, el adaptador lo convierte con una función explícita y probada: `Decimal.parseScientific`,
   exacta porque big.js lee el exponente sin float. `Decimal.parse` sigue sin aceptar exponentes. Ese intento se
   apartó a `data/discarded/19b-intento1/` sin borrarlo (el hook prohíbe el borrado recursivo forzado), y la
   captura se repitió desde cero.
9. **Símbolos.** `<base>/EUR` con la base de Kraken, salvo los dos alias propios de Kraken: XBT → BTC y XDG → DOGE.
   El resto de renombres (LUNA/LUNC y similares) se resuelve al comparar con Bitvavo (`DATA.md` §2, punto 5).
10. **Comprobaciones de `DATA.md` §4:**
   - **Velas desde trades:** un día de trades de XBT/EUR (2026-06-15, por la API `Trades`) contra el OHLCVT de 1h,
     con `scripts/verify-kraken-trades.ts`. No se descarga el ZIP de trades, de decenas de GB.
   - **Zona horaria:** las velas de 1d se validan alineadas a medianoche UTC (`cleanCandles`). El README del ZIP
     dice que el timestamp son segundos Unix de la apertura, y la comparación con los trades lo confirma.
   - **Deslistados:** los pares en EUR del ZIP se comparan con `AssetPairs` de hoy.
11. **Procedencia.** Cada dataset lleva su manifiesto (ADR 0020). Cada captura deja un informe en `data/provenance/`
    con el SHA-256 y el tamaño del original, los totales de calidad, los descartes del test final y el listado.
12. **Términos.** Términos EEA de Kraken (en vigor desde el 2026-10-07), §11.1 y §11.5: uso para beneficio propio,
    sin redistribuir ni explotar comercialmente. Los datos no se versionan ni se comparten.
13. **`unzip` del sistema** (Info-ZIP, que lee ZIP64). No es un paquete de npm, así que no va a `DEPENDENCIES.md`;
    lo usan solo los dos scripts de captura.

14. **Brutos y descargas tras la guarda** (pedido por la persona al revisar el 19B). Cada fichero bruto tiene un
    periodo, que sale de su nombre (`krakenRawPeriod`; un nombre sin periodo conocido se rechaza). Si ese periodo
    pasa de `researchDataEndUtc`, aunque sea en parte, el fichero es del test final:
    - `TestFinalGuard.rawFileForReading` no deja leerlo sin el desbloqueo completo del ADR 0020, y con él solo desde
      la carpeta de brutos del test final. Lo de investigación solo se lee desde `data/raw/`.
    - `TestFinalGuard.rawDownloadPath` no da destino a su descarga sin ese desbloqueo, y con él lo da en esa misma
      carpeta, nunca en `data/raw/`. Así se niegan el ZIP trimestral 2026Q4 y los siguientes, una foto de
      `AssetPairs` de hoy y los trades cuya última página podría pasar del 2026-09-30.
    - El descargador (`scripts/download-kraken.ts`) pide el destino a la guarda antes de cualquier petición, y los
      scripts de captura y de verificación abren los brutos solo a través de ella.

    **Chocaba con el ADR 0020, decisión 8, paso 1:** al abrir una etapa, la persona baja y captura los datos antes
    de que existan `dataHash` y el token, y con esta regla no podría hacerlo con estos scripts. Lo resolvió la
    persona el 2026-10-08: captura y lectura van separadas. Un modo captura escribe los datos solo en la carpeta
    protegida del test final y calcula el `dataHash`, sin que nada de investigación los lea, y solo tras firmar el
    token se pueden leer. El ADR 0020 recoge el procedimiento; se implementa en el paso 42, antes del 2027-01-01.
    Además, `test/enforcement/data-paths.test.ts` falla si un código distinto de la guarda nombra rutas de `data/`,
    y el control INV-13h prueba la guarda de brutos.

### Descargas autorizadas

| Fichero | Origen | Bytes | SHA-256 |
|---|---|---|---|
| `OHLCVT_Full_PARTS_SHA256SUMS.txt` | `assets.kraken.com/marketing/institutions/` | 480 | `2b9be0b7…` (no corresponde a 2026Q2) |
| `Kraken_OHLCVT_Full_2026Q2.zip.part00`–`04`, unidas | el mismo | 8.972.380.104 | `fc81b54cba6e12af3e9422dde9416179e6ef76af4831d48d839fbdb43018eaa4` |
| `Kraken_OHLCVT_2026Q3.zip` | el mismo | 576.348.633 | `96daae63c7b3acb522892e1f602f9c564d1a3fb659089d9b0699282f30d41226` |
| `AssetPairs` (2026-10-08T18:27Z) | `api.kraken.com/0/public/AssetPairs` | 678.577 | `87b0bd67…` |
| `Trades` de XBTEUR, 2026-06-15 (38 peticiones) | `api.kraken.com/0/public/Trades` | 2.614.359 | `51219b24…` |

## Alternativas

- **API `OHLC` para julio a septiembre:** solo da 720 velas por marco; en 1h no llega a julio. Descartada.
- **API `Trades` para rehacer julio a septiembre:** miles de peticiones por par. Descartada con el trimestral publicado.
- **Un dataset por marco con todos los pares:** no cabe en memoria y mezclaría dos originales en un SHA-256.
- **Guardar lo del test final bajo su carpeta:** `DATA.md` §4 lo reserva para cuando una persona abre una etapa.
- **Rechazar la fila con volumen de float:** perdería velas buenas por un ruido de 1e-16.
- **Esperar al juego nuevo con sumas por partes:** no está documentado ni autorizado.

## Consecuencias

- El research tiene datos reales: el universo point-in-time y el replay ya no dependen solo de datos sintéticos.
- **El ZIP trae deslistados, pero solo desde 2023** (112 pares en EUR; faltan BSV, de 2019, e ICN): antes de 2023
  el universo tiene sesgo de supervivencia, y `deriveListings` no lo detecta porque `includesDelisted` es cierto.
  Lo resuelve el paso 23 (`DATA.md` §2, punto 4, y §5).
- La foto de `AssetPairs` es de hoy: un par que no aparece puede estar deslistado o renombrado. El universo
  (`deriveListings`) necesita esa distinción antes del paso 23.
- El ZIP 2026Q3 en bruto contiene las velas que cierran en el inicio del test final. Su periodo acaba el
  2026-09-30T23:59:59Z, así que la guarda lo da por investigación, y la captura descarta esas velas: ningún
  manifiesto de 2026Q3 llega al 2026-10-01 (comprobado sobre los 1.605).
- La guarda de brutos es una puerta del código, no del sistema de archivos. `data-paths.test.ts` impide que otro
  código nombre rutas de `data/`, pero no ve una ruta que llega por argumento o por la configuración.
- `data/raw/kraken/AssetPairs_2026-10-08.json` era del periodo del test final: la guarda ya no lo dejaba leer, y la
  persona lo borró el 2026-10-08. Lo que se
  sacó de él (los 112 pares no listados) solo sirvió para comprobar que el ZIP trae deslistados. El universo no lo
  usa: las bajas al final de la historia se fijan a 2026-09-30 en el paso 23.
- La latencia de 60 s y el redondeo del volumen son decisiones revisables, anotadas en cada manifiesto.

## Nota posterior (2026-10-22, paso 31)

La persona pasa el modo captura (decisión 8, paso 1) al paso 53, que se ejecuta después del 2027-10-01: es trabajo
previo de la comprobación hacia delante de A (ADR 0043). El resto de la decisión no cambia.
