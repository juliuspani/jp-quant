# 06 · Exchange principal para un residente en España (MiCA)

Fecha de la investigación: **2026-10-07** (paso 17, parte A). Decisión propuesta en
[ADR 0018](../adr/0018-exchange-principal-y-respaldo.md); la decisión final es de la persona.

Convenciones:

- **[DOC]** comprobado en la documentación oficial del exchange durante esta investigación (URL citada).
- **[API]** comprobado con una petición pública de solo lectura a la API del exchange el 2026-10-07.
- **[CCXT]** comprobado en el `ccxt` instalado en el repositorio (4.5.84), con `exchange.has` y `exchange.urls`.
- **[3º]** fuente de terceros; orientativo.
- **[verificar]** no confirmado; se comprueba en el paso indicado antes de depender de ello.

Las comisiones son las del **nivel base** (volumen a 30 días cercano a 0): con un capital máximo de 1.000 USDT
(ADR 0017) el bot nunca subirá de nivel.

## 1. Filtro previo: autorización MiCA

Desde el 1 de julio de 2026 terminó el periodo transitorio de MiCA: un exchange sin autorización CASP no puede
dar servicio en la UE. [3º: casptracker.eu, outrun.at a 2026-09-30; registro de ESMA citado por ambos]

| Exchange | Autorización CASP | Estado para el proyecto |
|---|---|---|
| Binance | **Ninguna.** Retiró su solicitud en Grecia (2026-06-24); desde el 2026-07-01 no admite nuevos usuarios de la UE y las cuentas existentes solo pueden cerrar posiciones y retirar [3º] | **Descartado.** `config.json` usa hoy `binance`: hay que cambiarlo |
| Bitvavo | AFM (Países Bajos) [DOC: bitvavo.com/blog/bitvavo-obtains-mica-licence; lista blanca de la AMF] | Candidato |
| OKX (my.okx.com, EEA) | MFSA (Malta), enero de 2025 [3º] | Candidato |
| Kraken | Central Bank of Ireland [3º] | Candidato |
| Coinbase | CSSF (Luxemburgo) [3º] | Candidato |
| Bitstamp | CSSF (Luxemburgo) [3º] | Candidato |
| Bybit EU | FMA (Austria) [3º] | Candidato |

**USDT no se puede negociar en el EEE.** Tether no tiene autorización como e-money token y, desde el
2026-07-01, un CASP no puede ofrecer sus pares a clientes del EEE. Kraken ya los cerró para el EEE el
2025-03-24. [3º: dlnews, stablecoininsider] USDC y EURC sí están autorizados. **La moneda de cotización del bot
pasa a ser EUR (o USDC)**, no USDT.

## 2. Comparativa

| Criterio | Bitvavo | OKX EEA | Kraken | Coinbase Advanced | Bybit EU | Bitstamp |
|---|---|---|---|---|---|---|
| Spot EUR / USDC / USDT | 427 EUR, 11 USDC, sin USDT [API] | EUR y USDC; USDT no en EEE [API, lista global] | 546 EUR, 47 USDC; USDT no en EEE [API] | EUR y USDC [3º] | EUR y USDC [3º] | EUR y USDC [3º] |
| Maker / taker base | **0,15 % / 0,25 %** [3º citando bitvavo.com/en/fees] | **0,10 % / 0,20 %** en cuenta solo spot desde 2026-09-25 [DOC] | **0,40 % / 0,80 %** [DOC] | 0,40 % / 0,60 % [3º] | 0,10 % / 0,10 % [3º] | [verificar] |
| Subcuentas | **Solo cuentas corporativas** [DOC: Institutional APIs]; una sola cuenta personal por persona [DOC: soporte, art. 2.7] | Particulares: hasta 5; la estándar no puede retirar [DOC: okx.com/en-eu/help/what-is-sub-account] | **Solo clientes institucionales** [3º, citando soporte de Kraken] | Portfolios [DOC] | [verificar] | Sí [3º] |
| Permisos granulares de la clave | Ver, operar, retirar [DOC] | Read, Trade, Withdraw [DOC] | Muy granulares: consultar fondos, crear o modificar órdenes, cancelar, exportar, retirar… [DOC] | view, trade, transfer [DOC] | [verificar] | [verificar] |
| Lista blanca de IP | Sí [DOC] | Hasta 20 IP por clave [DOC] | Sí [DOC] | [verificar] | [verificar] | [verificar] |
| Dead-man switch / cancel-on-disconnect | `cancelOrdersAfter` por grupo, mínimo 10 s, REST y WebSocket; no vale para órdenes a mercado [DOC] | `POST /api/v5/trade/cancel-all-after`, también spot [DOC] | `CancelAllOrdersAfter`, hasta 86.400 s; recomendado: renovar cada 15–30 s con 60 s [DOC] | Solo derivados (Deribit), **no spot** [DOC] | DCP en spot, de 3 a 300 s, **solo cuentas institucionales** [DOC de Bybit global] | No encontrado; ccxt no lo implementa [CCXT] |
| Stop nativo | `stopLoss`, `stopLossLimit`, `takeProfit(Limit)` [DOC] | Órdenes algorítmicas (trigger, conditional) [CCXT] | Sí [CCXT] | `STOP_LIMIT` y bracket [DOC] | Sí [CCXT] | ccxt no lo implementa [CCXT] |
| WebSocket con secuencia | Libro con `nonce` secuencial [DOC] | `seqId` / `prevSeqId` y checksum [3º, docs de nautilus] | Libro solo con **checksum CRC32**, sin número de secuencia [DOC] | `sequence_num` en cada mensaje [DOC] | [verificar] | [verificar] |
| Rate limits | 1.000 puntos de peso por minuto; crear orden 1 punto [DOC] | Por instrumento; subcuenta máx. 1.000 órdenes / 2 s [DOC] | Contador 15–20 con caída de 0,33–1/s; órdenes con otro limitador [DOC] | WebSocket 8/s por IP [DOC] | [verificar] | [verificar] |
| Testnet / sandbox | **No** [CCXT: sin `urls.test`] | Demo trading con cabecera `x-simulated-trading: 1` [DOC]; para cuentas EEA [verificar] | Spot: **solo bajo petición** al gestor de cuenta [DOC] | No en ccxt [CCXT] | `bybiteu` admite sandbox en ccxt [3º] | No [CCXT] |
| Histórico descargable | Solo API. Velas desde 2019-03-08 (BTC-EUR); **los mercados deslistados devuelven error 205** [API] | Página de descarga de OKX global: trades desde 2021-09, velas desde 2023-07 [DOC]; BTC-EUR en EEA desde 2023-11-21 [API] | **ZIP de OHLCVT y de todos los trades de cada par desde su primer trade, hasta 2026-06-30, con actualización trimestral** [DOC] | Solo API [3º] | Solo desde 2025 [3º] | Solo API [3º] |
| ccxt 4.5.84 | `bitvavo`, con `cancelAllOrdersAfter` [CCXT] | `myokx` (host `eea.okx.com`) [CCXT] | `kraken` [CCXT] | `coinbase` [CCXT] | `bybiteu` [CCXT] | `bitstamp`, sin stop ni dead-man [CCXT] |
| Exportación fiscal | Extracto CSV desde la app [verificar] | Extractos de cuenta [verificar] | Permiso `Export Data` y exportación por API (`AddExport`) [DOC] | Informes [3º] | [verificar] | [verificar] |
| Antecedentes regulatorios | Sin sanciones encontradas en esta búsqueda | DOJ (EE. UU.), feb. 2025: culpable y 504 M$ por fallos AML; FIAU (Malta) 1,1 M€; DNB (Países Bajos) 2,25 M€ por operar sin registro (2023–2024) [3º] | Ninguno relevante encontrado en esta búsqueda | — | — | — |

## 3. Lectura

1. **Las comisiones deciden con capital pequeño.** Una ida y vuelta taker cuesta 0,40 % en OKX, 0,50 % en
   Bitvavo, 1,20 % en Coinbase y **1,60 % en Kraken**. `docs/research/02` estimó la tendencia en 4h con 0,10 %
   por lado (más 0,05 % de slippage) y recomienda la variante de menos operaciones si el exchange cobra más de
   0,1 %. Con las comisiones de Kraken o Coinbase es probable que el research rechace todo por costes.
2. **Ninguno tiene todo.** Bitvavo no tiene testnet y no da histórico de deslistados. OKX tiene la mejor API para
   el proyecto (demo, secuencia, dead-man, subcuentas), pero el peor historial regulatorio. Kraken tiene los
   mejores datos y el mejor historial, pero comisiones cuatro veces mayores, subcuentas solo institucionales y un
   libro sin número de secuencia.
3. **Para el research, Kraken es la mejor fuente gratuita** aunque no sea donde se opera: es el único con
   historia en EUR desde antes de 2018 (incluye dos mercados bajistas completos) y descarga masiva de todos los
   pares. Ver [DATA.md](../../DATA.md).
4. **Bit2Me** (CNMV, España) también tiene autorización MiCA, pero no está en ccxt; se descarta por eso.

## 4. Fuentes (consultadas el 2026-10-07)

- Kraken: docs.kraken.com/api/docs/rest-api/cancel-all-orders-after · kraken.com/features/fee-schedule ·
  docs.kraken.com/api/docs/guides/spot-rest-ratelimits · docs.kraken.com/api/docs/websocket-v2/book ·
  docs.kraken.com/exchange/guides/rest/api-keys · docs.kraken.com/home/guides/quickstart ·
  support.kraken.com/articles/360047124832 (OHLCVT) · support.kraken.com/hc/en-us/articles/360047543791 (trades)
- OKX: okx.com/docs-v5/en · okx.com/en-eu/help/what-are-the-new-trading-fees-for-eea-users ·
  okx.com/en-eu/help/important-notice-upcoming-spot-fee-adjustment-eea · okx.com/en-us/historical-data ·
  docs.ccxt.com/docs/comparisons/ccxt-vs-myokx-api
- Bitvavo: docs.bitvavo.com/docs/cancel-on-disconnect · docs.bitvavo.com/docs/rate-limits ·
  docs.bitvavo.com/llms-full.txt · bitvavo.com/en/fees · bitvavo.com/en/news (anuncios de deslistado)
- Coinbase: docs.cdp.coinbase.com (índice `llms.txt`, especificación REST y AsyncAPI de Advanced Trade)
- Bybit: bybit-exchange.github.io/docs/v5/order/dcp · docs.ccxt.com/docs/comparisons/ccxt-vs-bybiteu-api
- MiCA y USDT: casptracker.eu · outrun.at/micar-dashboard · dlnews.com (Kraken retira USDT en Europa) ·
  blockhead.co (2026-10-01, Binance y ESMA)
- Sanciones de OKX: decrypt.co (DOJ) · cointelegraph.com (FIAU, DNB)
