# 04 — Módulo "explorador" de low-caps: detección, seguridad y gestión de riesgo

- **Fecha de la investigación:** 2026-09-30 (pruebas de API ejecutadas entre las 10:16 y las 10:30 UTC).
- **Alcance:** bot spot 24/7 (Node 24 + TypeScript + ccxt 4.5.84), capital pequeño, sin apalancamiento.
- **Prioridad:** defensiva. El objetivo es acotar la pérdida máxima y no ser la liquidez de salida de nadie; el beneficio es secundario.

Convención de etiquetas usada en todo el documento:

| Etiqueta | Significado |
|---|---|
| **[OBSERVADO]** | Lo comprobé yo con una petición real el 2026-09-30 (se indica el resultado). |
| **[EVIDENCIA]** | Procede de un artículo académico, un informe o documentación oficial (con URL). |
| **[OPINIÓN]** | Criterio de diseño mío; razonado pero no demostrado ni backtesteado. |

---

## 0. Resumen ejecutivo

1. **Vía recomendada para la v1: solo exchange centralizado (CEX).** El explorador opera únicamente altcoins pequeñas ya listadas en el exchange del bot, a través de ccxt. Nada de DEX, nada de claves privadas de wallet en el servidor. Las fuentes on-chain (DexScreener, GeckoTerminal, RugCheck, GoPlus) quedan como "radar" de solo lectura y sin clave, opcional.
2. **La esperanza matemática de "comprar gainers" en monedas pequeñas no está demostrada y la literatura apunta en contra:** en criptos pequeñas e ilíquidas domina la *reversión* diaria/semanal; el *momentum* aparece en las grandes y líquidas y en horizontes de 1–4 semanas. Los pump-and-dump organizados revierten en torno a 70 segundos y casi desaparecen en una hora. Los nuevos listados en CEX han sido mayoritariamente perdedores en 2024–2025.
3. **Consecuencia de diseño:** el módulo se trata como un presupuesto de lotería con pérdida estrictamente acotada (5 % del capital como techo, 1 % por posición, 3 posiciones), con entrada solo tras confirmación (vela de 1 h cerrada, nunca persiguiendo una vela vertical), stop nativo en el exchange y **modo papel obligatorio** antes de arriesgar dinero.
4. **Hallazgo en vivo relevante:** el 2026-09-30, 4 de las 8 monedas USDT de Binance que subían más de un 15 % en 24 h (MOVR +78 %, GLMR +28 %, GTC +29 %, ARK +18 %) llevaban la etiqueta *Monitoring* (riesgo de exclusión). Un escáner ingenuo de "top gainers" habría comprado precisamente los activos que el exchange tiene en vigilancia para deslistar.

---

## 1. Fuentes de detección por API gratuita

### 1.1 Tabla de pruebas reales (2026-09-30)

| Fuente | Endpoint probado | Resultado |
|---|---|---|
| DexScreener | `GET https://api.dexscreener.com/token-profiles/latest/v1` | 200, 30 elementos, `Cache-Control: max-age=60`, sin cabeceras de límite |
| DexScreener | `GET /token-boosts/latest/v1` y `/token-boosts/top/v1` | 200, 30 elementos |
| DexScreener | `GET /latest/dex/search?q=SOL/USDC` | 200, 30 pares; **el primer resultado era un token basura** (ver 1.2) |
| DexScreener | `GET /tokens/v1/solana/{mint}` y `/token-pairs/v1/solana/{mint}` | 200, array de pares |
| GeckoTerminal | `GET https://api.geckoterminal.com/api/v2/networks/new_pools?page=1` | 200, 20 pools; el primero tenía 70 s de vida, 4,2 k USD de reservas y 2 compras |
| GeckoTerminal | `GET /networks/solana/new_pools?include=base_token` | 200, 20 pools + 18 `included` |
| GeckoTerminal | `GET /networks/trending_pools?page=1` | 200 |
| GeckoTerminal | `GET /networks/solana/tokens/{mint}/info` | 200; incluye `gt_score`, distribución de holders y autoridades |
| GeckoTerminal | `GET /networks/solana/pools/{pool}/ohlcv/hour?aggregate=1&limit=3` | 200, `ohlcv_list` |
| CoinGecko | `GET https://api.coingecko.com/api/v3/search/trending` (sin clave) | 200, 15 monedas |
| CoinGecko | `GET /coins/markets?vs_currency=usd&order=volume_desc&per_page=3&price_change_percentage=1h,24h,7d` (sin clave) | 200 |
| CoinGecko | `GET /coins/top_gainers_losers?vs_currency=usd` (sin clave) | **401**, `error_code 10005`: endpoint exclusivo de planes de pago |
| CoinGecko | `GET /coins/list/new` (sin clave) | **401**, `error_code 10005`: de pago |
| CoinGecko | `GET /onchain/networks/trending_pools` (sin clave) | **401**: exige clave |
| Birdeye | `GET https://public-api.birdeye.so/defi/token_trending?...` (sin clave) | **401** `Unauthorized` |
| Token Sniffer | `GET https://tokensniffer.com/api/v2/tokens/1/{addr}` (sin clave) | **401** `Unauthorized` |
| GoPlus | `GET https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses={PEPE}` | 200, `code 1` |
| GoPlus | `GET /api/v1/solana/token_security?contract_addresses={BONK}` | 200, `code 1` |
| GoPlus | `GET /api/v1/supported_chains` | 200, 46 cadenas (incluye Ethereum, BSC, Base, Solana, Arbitrum, Tron…) |
| honeypot.is | `GET https://api.honeypot.is/v2/IsHoneypot?address={PEPE}` | 200; cabecera `x-ratelimit-limit: 50` |
| RugCheck | `GET https://api.rugcheck.xyz/v1/tokens/{BONK}/report/summary` y `/report` | 200; cabecera `X-Rate-Limit-Limit: 15` |
| RugCheck | `GET /v1/stats/analytics` y `/v1/stats/new_tokens` | 200 (ver sección 6) |
| Binance | `GET https://api.binance.com/api/v3/ticker/24hr` | 200, 3 716 símbolos, `x-mbx-used-weight: 80` |
| Binance | `GET /api/v3/exchangeInfo` | 200; 1 367 símbolos `TRADING`, 2 346 `BREAK`; límite 6 000 de peso/min |
| Binance | `GET /api/v3/klines`, `GET /api/v3/depth` | 200 |
| Binance | `GET /sapi/v1/spot/delist-schedule` (sin clave) | 400, `code -2014`: exige API key |
| MEXC / Gate / KuCoin / Bybit | tickers 24 h públicos | 200 (1 907 / 2 202 / 997 / 530 pares) |
| ccxt 4.5.84 | `fetchTickers()` en binance, kraken, okx | OK (ver 1.6); bitget falló por DNS desde esta máquina |

### 1.2 DexScreener

- **Base:** `https://api.dexscreener.com` — sin clave.
- **Límites [EVIDENCIA]:** 60 peticiones/min para perfiles, boosts, community takeovers, anuncios, órdenes y metas; 300 peticiones/min para pares, búsqueda, `token-pairs` y `tokens`. Fuente: <https://docs.dexscreener.com/api/reference> y <https://coinpaprika.com/education/dexscreener-api-rate-limits-explained/>. No hay cabeceras `ratelimit`/`retry-after` **[OBSERVADO]**, así que hay que limitar en cliente y hacer backoff exponencial ante cualquier respuesta distinta de 200.
- **Endpoints:**
  - `GET /token-profiles/latest/v1` (60/min) — tokens que acaban de crear perfil.
  - `GET /token-boosts/latest/v1`, `GET /token-boosts/top/v1` (60/min) — tokens con promoción pagada.
  - `GET /latest/dex/search?q={texto}` (300/min).
  - `GET /latest/dex/pairs/{chainId}/{pairId}` (300/min).
  - `GET /token-pairs/v1/{chainId}/{tokenAddress}` (300/min).
  - `GET /tokens/v1/{chainId}/{addr1,addr2,…}` (300/min, hasta 30 direcciones por llamada).
  - `GET /orders/v1/{chainId}/{tokenAddress}` (60/min, no probado).
- **Campos clave del objeto par [OBSERVADO]:** `chainId`, `dexId`, `pairAddress`, `baseToken{address,name,symbol}`, `quoteToken`, `priceUsd`, `priceNative`, `txns{m5,h1,h6,h24:{buys,sells}}`, `volume{m5,h1,h6,h24}`, `priceChange{m5,h1,h6,h24}`, `liquidity{usd,base,quote}`, `fdv`, `marketCap`, `pairCreatedAt` (ms), `labels`, `info`, `boosts`.
- **Limitaciones [EVIDENCIA]:** no hay velas OHLCV históricas, ni historial de swaps, ni endpoint de "pares nuevos", ni websocket de precios (coinpaprika, enlace anterior).
- **Avisos [OBSERVADO]/[OPINIÓN]:**
  - La búsqueda por texto está contaminada: al buscar `SOL/USDC` el primer resultado fue un token de la cadena "robinhood" cuyo *nombre* era una lista de ~200 nombres de monedas conocidas (spam de SEO). **Nunca identificar un activo por símbolo o nombre; siempre por dirección de contrato.**
  - "Boost" y "perfil" son promoción pagada por el emisor. No son señal de calidad; como mucho, señal de que alguien está gastando en atraer compradores.

### 1.3 GeckoTerminal

- **Base:** `https://api.geckoterminal.com/api/v2` — sin clave; cabecera `accept: application/json`.
- **Límite [EVIDENCIA, no comprobado empíricamente]:** 30 llamadas/min en la API pública según el FAQ y el soporte de CoinGecko (<https://apiguide.geckoterminal.com/faq>, <https://support.coingecko.com/hc/en-us/articles/23407777579801>); alguna fuente secundaria habla de ~10/min. El FAQ ya redirige a `docs.coingecko.com`. Caché observada: `max-age=30, s-maxage=60`.
- **Endpoints [OBSERVADO]:**
  - `GET /networks/new_pools?page=N` y `GET /networks/{network}/new_pools?include=base_token` — 20 pools por página.
  - `GET /networks/trending_pools?page=N` y `GET /networks/{network}/trending_pools`.
  - `GET /networks/{network}/tokens/{address}/info`.
  - `GET /networks/{network}/pools/{pool}/ohlcv/{day|hour|minute}?aggregate=N&limit=N` → `ohlcv_list: [[ts, o, h, l, c, volumen_usd], …]`.
- **Campos clave de un pool:** `address`, `name`, `pool_created_at`, `base_token_price_usd`, `fdv_usd`, `market_cap_usd`, `reserve_in_usd` (liquidez), `volume_usd{m5,m15,m30,h1,h6,h24}`, `price_change_percentage{m5…h24}`, `transactions{m5…h24:{buys,sells,buyers,sellers}}`.
- **Campos clave de `tokens/{address}/info`:** `gt_score`, `gt_score_details{pool,transaction,creation,info,holders}`, `holders{count, distribution_percentage{top_10,11_20,21_40,rest}}`, `mint_authority`, `freeze_authority`, `is_honeypot` (para BONK devolvió `"unknown"`), `developer_holding_percentage`, `gt_verified`.
- **Valor:** es la única de las gratuitas que da velas OHLCV on-chain y un endpoint de pools nuevos. `buyers`/`sellers` únicos permiten distinguir volumen real de *wash trading* (muchas transacciones, pocos compradores distintos).

### 1.4 CoinGecko

- **Base:** `https://api.coingecko.com/api/v3`.
- **Gratis y útil [OBSERVADO]:**
  - `GET /search/trending` → `coins[].item{id, symbol, market_cap_rank, score, data{price, price_change_percentage_24h{usd,…}, market_cap, total_volume}}`. El 2026-09-30 el nº 1 era MOVR (rango 825, +82,6 % en 24 h).
  - `GET /coins/markets?vs_currency=usd&order=…&per_page=250&page=N&price_change_percentage=1h,24h,7d` → `id, symbol, current_price, market_cap, market_cap_rank, fully_diluted_valuation, total_volume, high_24h, low_24h, price_change_percentage_{1h,24h,7d}_in_currency, circulating_supply, ath, atl`. Sirve para asignar capitalización y rango a cada símbolo del exchange.
- **De pago [OBSERVADO]:** `GET /coins/top_gainers_losers` y `GET /coins/list/new` devuelven 401 (`error_code 10005`). Los *gainers* y las monedas nuevas **no** están en el plan gratuito; los *gainers* se calculan mejor con los tickers del propio exchange.
- **Límites [EVIDENCIA]:** plan Demo gratuito con 10 000 llamadas/mes y 100 llamadas/min según la página de precios (<https://www.coingecko.com/en/api/pricing>, <https://docs.coingecko.com/docs/common-errors-rate-limit>); otras páginas de soporte dicen ~30/min. Sin clave, el límite es compartido por IP y no tiene cifra publicada. El plan de pago más barato (Basic) cuesta 35 USD/mes.
- **Presupuesto sugerido [OPINIÓN]:** trending cada 15 min (≈2 900 llamadas/mes) + `coins/markets` 4 páginas cada 6 h (≈480/mes) cabe holgadamente en 10 000/mes.

### 1.5 Birdeye y Token Sniffer

- **Birdeye:** `https://public-api.birdeye.so` devuelve 401 sin clave **[OBSERVADO]**. Existe un plan gratuito "Standard" y planes de pago desde 39 USD/mes (Lite, 15 rps) **[EVIDENCIA secundaria]** (<https://birdeye.so/data-api/pricing>). No pude leer la cuota exacta del plan gratuito (las páginas de documentación devolvieron 404). Para la v1 no aporta nada que no den DexScreener + GeckoTerminal sin clave.
- **Token Sniffer:** la API devuelve 401 sin clave **[OBSERVADO]**; el plan "Sniffer Pack Pro" cuesta 99 USD/mes por 500 tokens/día **[EVIDENCIA secundaria]** (<https://tokensniffer.readme.io/reference/pricing>). **No es una fuente gratuita por API**; solo la web es gratis.

### 1.6 Tickers del propio exchange vía ccxt (la fuente principal de la v1)

Prueba real con `ccxt 4.5.84` **[OBSERVADO]**:

| Exchange | `has.fetchTickers` | Tickers devueltos | Pares spot USDT activos | Con bid/ask | Tiempo (loadMarkets + fetchTickers) |
|---|---|---|---|---|---|
| binance | true | 3 716 | 496 | 496 | ~15,7 s (primera carga) |
| okx | true | 1 145 | 408 | 407 | ~1,6 s |
| kraken | true | 1 483 | 45 (la mayoría de sus pares son USD/EUR) | 45 | ~2,6 s |

- **Estructura unificada del ticker [OBSERVADO]:** `symbol, timestamp, high, low, bid, bidVolume, ask, askVolume, vwap, open, close, last, previousClose, change, percentage, average, baseVolume, quoteVolume`. Ejemplo real: `MOVR/USDT` con `percentage 80.578`, `quoteVolume 29 650 692`, `bid 1.811`, `ask 1.812`.
- **Cuidado 1:** `fetchTickers()` devuelve también símbolos inactivos (en Binance, 2 346 en estado `BREAK`). Hay que filtrar por `market.active && market.spot`.
- **Cuidado 2:** `market.created` es `undefined` en Binance (OKX sí lo informa). La antigüedad del par se obtiene con la primera vela diaria: `fetchOHLCV(symbol, '1d', 0, 1)`; comprobado con `klines?symbol=MOVRUSDT&interval=1d&startTime=0&limit=1` → primera vela el 2021-11-08.
- **Coste en Binance:** la llamada de todos los tickers consume peso 80 sobre un límite de 6 000/min; escanear cada 5 minutos es irrelevante para el límite.
- **Métricas derivables solo con el exchange:**
  - Volatilidad de rango 24 h: `(high − low) / low`.
  - Spread: `(ask − bid) / mid`.
  - **RVOL** (volumen relativo): volumen de las últimas 24 h entre la mediana del volumen diario de los 7 días previos, con velas de 1 h (`fetchOHLCV(symbol,'1h',undefined,200)`). Cálculo real para MOVR/USDT: 29,6 M USDT frente a una mediana de 1,86 M → **RVOL ≈ 16**.
  - Profundidad: `fetchOrderBook(symbol, 50)`.
- **Distribución real de spreads en Binance, pares USDT activos [OBSERVADO]:**

| Volumen 24 h (USDT) | Nº pares | Spread mediano | Spread p90 | Rango 24 h mediano |
|---|---|---|---|---|
| < 100 k | 23 | 15,0 pb | 44,0 pb | 3,8 % |
| 100 k – 500 k | 184 | 12,9 pb | 27,2 pb | 4,8 % |
| 500 k – 2 M | 141 | 9,4 pb | 25,1 pb | 5,9 % |
| 2 M – 10 M | 84 | 6,0 pb | 17,0 pb | 7,7 % |
| 10 M – 100 M | 56 | 1,7 pb | 8,6 pb | 6,6 % |
| > 100 M | 8 | 0,7 pb | 2,0 pb | 5,8 % |

  De 496 pares activos, 348 mueven menos de 2 M USDT al día: el "universo low-cap dentro del CEX" es grande y con spreads razonables (decenas de puntos básicos, no porcentajes).

### 1.7 Nuevos listados y riesgo de exclusión en el CEX

- **Nuevos listados [OPINIÓN, método robusto]:** comparar periódicamente el conjunto de símbolos de `loadMarkets(true)` con el conjunto guardado; lo que aparece es un listado nuevo. No depende de endpoints de anuncios no oficiales.
- **Calendario de exclusiones (Binance) [EVIDENCIA + OBSERVADO]:** `GET /sapi/v1/spot/delist-schedule` (peso 100) devuelve `[{delistTime, symbols[]}]`; exige API key aunque no firma (<https://developers.binance.com/docs/wallet/asset/spot-delist-schedule>).
- **Etiquetas de riesgo (Binance) [OBSERVADO, endpoint NO oficial]:** `GET https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true` devuelve por símbolo un array `tags`. El 2026-09-30 había 65 productos con `Monitoring`, 516 con `Seed`, 23 con `newListing` y 85 con `bStocks` (acciones tokenizadas). Al ser un endpoint interno de la web puede cambiar sin aviso: usarlo con tolerancia a fallos y, si falla, mantener una lista manual.
- **Por qué importa [EVIDENCIA]:** la etiqueta *Monitoring* señala activos con más volatilidad y riesgo que Binance revisa con más frecuencia y puede excluir; los anuncios provocan caídas inmediatas de un dígito alto o dos dígitos (p. ej. SYS −11,5 % en minutos), y BIFI, MDT, FUN y OXT acabaron excluidos en abril de 2026 (<https://beincrypto.com/binance-monitoring-tag-seven-tokens-delisting/>, <https://finance.yahoo.com/markets/crypto/articles/binance-adds-monitoring-tag-4-090334033.html>).

---

## 2. Señales: qué tiene algo de evidencia y qué es ruido

### 2.1 Qué dice la literatura sobre persistencia frente a reversión

| Resultado | Fuente | Implicación para el explorador |
|---|---|---|
| En más de 3 600 criptoactivos (2015–2021) las monedas con peor rentabilidad del día anterior superan a las de mejor rentabilidad (**reversión diaria**). El efecto es más fuerte en las pequeñas; solo un puñado de las más grandes y negociables muestra momentum diario. | Zaremba et al. (2021), *Int. Review of Financial Analysis* 78 — <https://www.sciencedirect.com/science/article/pii/S1057521921002349> | Comprar el *top gainer* de ayer entre monedas pequeñas tiene, de media, el viento en contra. |
| Las monedas pequeñas e ilíquidas muestran reversión semanal (t = −7,31); las grandes y líquidas, momentum semanal (t = 2,33). La cercanía al máximo de 1 semana predice negativamente en pequeñas (t = −9,03) y positivamente en grandes (t = 4,93). La reversión de las pequeñas se explica sobre todo por su bajo volumen. | Fičura (2023) — <https://wp.ffu.vse.cz/artkey/wps-202301-0003_impact-of-size-and-volume-on-cryptocurrency-momentum-and-reversal.php> | Si se quiere momentum, hay que exigir **volumen y liquidez altos**; en lo ilíquido, una ruptura de máximos es estadísticamente una señal de venta. |
| En las 2 000 mayores criptos (2014–2020) hay momentum en horizontes de hasta 2–4 semanas y reversión significativa más allá de un mes. | Dobrynskaya (2023), *J. of Alternative Investments* — <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3913263> | El horizonte con algo de respaldo es de días a pocas semanas; no "mantener a largo plazo" un low-cap que ya subió. |
| Un factor de tendencia (CTREND) que agrega señales de precio **y volumen** en varios horizontes predice rentabilidades en más de 3 000 monedas, sobrevive a costes de transacción y persiste en monedas grandes y líquidas. | Fieberg et al., *JFQA* — <https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/trend-factor-for-the-cross-section-of-cryptocurrency-returns/4C1509ACBA33D5DCAF0AC24379148178> | Tendencia + volumen combinados es lo más defendible; de nuevo, en lo líquido. |
| El volumen anormal, interpretado como desacuerdo entre inversores, va seguido de rentabilidades **menores** cuando hay restricciones a la venta en corto. | Garfinkel et al. (2025), *Financial Management* — <https://onlinelibrary.wiley.com/doi/10.1111/fima.12491> | Un pico de volumen aislado no es alcista por sí mismo; en low-caps spot (difíciles de vender en corto) puede marcar sobreprecio. |
| Reglas técnicas simples (medias móviles, ruptura de rango) han mostrado capacidad predictiva en criptos en algunos periodos; fuera de muestra se debilita, sobre todo en Bitcoin. | Hudson y Urquhart (2021) — <https://link.springer.com/content/pdf/10.1007/s10479-019-03357-1.pdf>; Grobys et al. (2020) | Evidencia moderada y dependiente del periodo. |
| Efecto MAX: resultados contradictorios en cripto (algunos trabajos hallan relación positiva entre el máximo retorno diario del mes y la rentabilidad futura; otros, negativa). | <https://link.springer.com/article/10.1186/s40854-021-00291-9> | No usar como señal. |

### 2.2 Valoración señal por señal

| Señal | Evidencia | Veredicto |
|---|---|---|
| **Momentum multi-día (7 d positivo) en monedas con volumen alto** | Moderada (Dobrynskaya, CTREND, Fičura para líquidas) | Usar, con filtro de liquidez. |
| **Ruptura de rango de varios días confirmada por volumen** | Moderada y dependiente del régimen (Hudson-Urquhart; CTREND combina precio y volumen) | Usar como disparador, exigiendo cierre de vela de 1 h. |
| **Pico de volumen relativo (RVOL) por sí solo** | Débil o negativa (Garfinkel) | Solo como *condición* junto a tendencia; nunca como disparador único. |
| **Top gainers de 24 h en monedas pequeñas** | Negativa (Zaremba, Fičura) | **No comprar por estar en la lista.** Además, penalizar la sobreextensión. |
| **Nuevos listados en CEX** | Ver 2.3 | No comprar en los primeros 30 días. |
| **Trending de CoinGecko / redes** | Sin evidencia de rentabilidad neta; es atención, que llega tarde | Ruido. Peso mínimo o nulo; útil solo como alerta. |
| **Boosts/perfiles de DexScreener** | Es publicidad pagada | Ruido, o señal negativa. |
| **Subida vertical en minutos con volumen ×20 o más** | Firma de pump-and-dump (2.4) | **Veto de entrada.** |

### 2.3 Efecto de nuevos listados

- **[EVIDENCIA, histórica]** En 327 listados de 180 criptos en 22 exchanges, rentabilidad anormal media de +5,7 % el día del listado y +9,2 % en la ventana [−3, +3]; pero la mayor parte se acumula **antes** del evento y después las rentabilidades son negativas; en algunos exchanges el efecto es nulo o negativo (Ante, 2019 — <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3450301>).
- **[EVIDENCIA, prensa que cita análisis de terceros]** Listados de Binance en 2024: ~98 % en negativo, pérdida media de −54,6 %, 12 tokens con caídas superiores al 90 %. Listados de 2025 hasta el 2 de abril: 24 de 27 en negativo (88,9 %), media −44 % (<https://protos.com/binance-token-listing-no-longer-a-bullish-event-research/>, <https://beincrypto.com/binance-listed-tokens-negative-return/>).
- **Conclusión [OPINIÓN]:** el "efecto listado" favorable lo capturan quienes compran antes del anuncio. Para un bot que ve el símbolo cuando ya cotiza, el sesgo esperado es negativo. La v1 **excluye** pares con menos de 30 días.

### 2.4 Pump-and-dump organizados

- **[EVIDENCIA]** En unos 500 P&D recopilados a mano: en los primeros 70 segundos el precio sube de media un 25 % y el volumen se multiplica por 148; la reversión empieza a los 70 segundos y al cabo de una hora casi todo el efecto ha desaparecido; hay una subida previa de ~5 % con volumen anormal en los cinco minutos anteriores (iniciados); solo quien compra en los primeros 20 segundos gana, y quien compra al minuto suele perder (Li, Shin y Wang — <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3267041>, resumen en <https://clsbluesky.law.columbia.edu/2019/01/07/cryptocurrency-pump-and-dump-schemes/>).
- **[EVIDENCIA]** 412 P&D organizados por Telegram entre junio de 2018 y febrero de 2019, con objetivos de baja capitalización en exchanges centralizados (Xu y Livshits, USENIX Security 2019 — <https://arxiv.org/abs/1811.10109>).
- **Implicación directa:** un bot que escanea cada 5 minutos **siempre llega tarde** a un P&D. La defensa es estructural: exigir que el movimiento tenga más de una hora y siga en pie, y vetar las velas verticales.

---

## 3. Filtros de seguridad

### 3.1 Filtros para la vía CEX (los que aplica la v1)

| Filtro | Umbral por defecto | Origen |
|---|---|---|
| Par spot activo, cotizado en la divisa de la cuenta (USDT/USDC/EUR) | obligatorio | `market.active && market.spot` |
| Excluir stablecoins, tokens envueltos/anclados, tokens apalancados (UP/DOWN/BULL/BEAR), acciones tokenizadas | lista de exclusión | [OPINIÓN]; en Binance había 85 productos `bStocks` [OBSERVADO] |
| Excluir activos con etiqueta *Monitoring* o presentes en el calendario de exclusión | obligatorio | Sección 1.7 |
| Antigüedad del par | ≥ 30 días | Sección 2.3 |
| Volumen 24 h en divisa de cotización | ≥ 1 000 000 | [OPINIÓN], apoyada en Fičura (reversión ligada a bajo volumen) |
| Mediana del volumen diario de los 7 días previos | ≥ 500 000 | [OPINIÓN]: evita pares cuyo único volumen es el pico de hoy |
| Spread | ≤ 0,30 % (30 pb) | Tabla 1.6: p90 de los tramos bajos entre 25 y 44 pb |
| Profundidad de compra dentro del 2 % del precio medio | ≥ 10 × tamaño de la posición | [OPINIÓN] |
| Notional mínimo | posición ≥ 2,2 × `market.limits.cost.min` (5 USDT en Binance [OBSERVADO]); ≥ 3,5 × para la salida en tres tramos | cada tramo de venta debe superar el mínimo (ver 5.1) |
| Sobreextensión | rechazar si +24 h > 40 % | Sección 2.1 |
| Anti-P&D | rechazar si alguna vela de 5 min de la última hora sube > 10 % con volumen > 20 × la mediana | Sección 2.4 |

### 3.2 Filtros para tokens on-chain (referencia para el radar y para una futura v2)

Umbrales de partida **[OPINIÓN]**, heurísticas del sector sin validación propia:

- Liquidez del pool ≥ 100 000 USD; volumen 24 h ≥ 250 000 USD; relación volumen/liquidez no absurda (volumen 24 h > 20 × liquidez sugiere *wash trading*).
- Antigüedad del par ≥ 7 días. Respaldo: tiempo medio hasta el *rug* en pump.fun ≈ 2 251 min (≈ 37,5 h) según `stats/analytics` de RugCheck **[OBSERVADO]**; Chainalysis describe la retirada de liquidez en las primeras semanas.
- Top-10 holders ≤ 30 % del suministro, excluyendo pool, direcciones de quema y exchanges.
- Liquidez bloqueada o quemada ≥ 90 %.
- Solana: `mintAuthority` y `freezeAuthority` nulas; sin `transferFee`; sin *transfer hook*.
- EVM: contrato verificado, sin proxy, sin `hidden_owner`, sin `selfdestruct`, propietario renunciado o con timelock, impuestos de compra y venta ≤ 5 %, simulación de compra y venta correcta.
- Compradores únicos (`buyers`) coherentes con el número de transacciones.

### 3.3 APIs de seguridad: endpoints, límites y fiabilidad

**GoPlus Security** (gratuita, sin clave)
- EVM: `GET https://api.gopluslabs.io/api/v1/token_security/{chain_id}?contract_addresses={addr}`.
- Solana: `GET https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={mint}`.
- Cadenas: `GET /api/v1/supported_chains` (46 cadenas [OBSERVADO]).
- Límite [EVIDENCIA]: 30 llamadas/min; más, solicitando un *access token* (<https://docs.gopluslabs.io/reference/support>).
- Campos EVM [OBSERVADO]: `is_honeypot`, `buy_tax`, `sell_tax`, `transfer_tax`, `cannot_buy`, `is_open_source`, `is_proxy`, `is_mintable`, `hidden_owner`, `can_take_back_ownership`, `selfdestruct`, `external_call`, `is_blacklisted`, `is_whitelisted`, `transfer_pausable`, `trading_cooldown`, `slippage_modifiable`, `personal_slippage_modifiable`, `anti_whale_modifiable`, `owner_address`, `owner_percent`, `creator_address`, `creator_percent`, `honeypot_with_same_creator`, `holder_count`, `holders[{address,percent,is_locked,is_contract}]`, `lp_holders[{percent,is_locked}]`, `lp_total_supply`, `dex[{name,liquidity,pair}]`, `is_in_cex{listed,cex_list}`.
- Campos Solana [OBSERVADO]: `mintable`, `freezable`, `closable`, `balance_mutable_authority`, `transfer_fee`, `transfer_fee_upgradable`, `transfer_hook`, `non_transferable`, `metadata_mutable`, `holders`, `lp_holders`, `dex`, `trusted_token`.
- **Trampas de interpretación [OBSERVADO]:**
  - Para PEPE devolvió `is_blacklisted: "1"`, `transfer_pausable: "1"` y `anti_whale_modifiable: "1"`, pero `owner_address` es la dirección cero (propiedad renunciada). Un "rechazar si cualquier bandera vale 1" da falsos positivos; hay que cruzar con el estado del propietario.
  - `buy_tax` y `sell_tax` llegaron como **cadena vacía**, no como `"0"`. Vacío significa "desconocido", no "cero". Si se convierte a número sin cuidado se acepta como 0 %.
  - Todos los valores son cadenas (`"0"`/`"1"`).
- **Fiabilidad [EVIDENCIA]:** sobre 645 tokens *rug pull* y 1 675 benignos, GoPlus obtuvo precisión del 74,0 %, *recall* del 78,2 % y un **21,4 % de falsos negativos**; en tokens recién desplegados puede tardar más de 5 minutos en dar resultado (RPHunter — <https://arxiv.org/html/2506.18398>). Otro trabajo académico afirma superar a GoPlus en exactitud detectando tokens trampa (<https://arxiv.org/abs/2309.04700>). **Uno de cada cinco *rug pulls* pasa el filtro.**

**honeypot.is** (gratuita, sin clave por ahora)
- `GET https://api.honeypot.is/v2/IsHoneypot?address={token_o_par}&chainID={id}` (`chainID` y `pair` opcionales) — <https://docs.honeypot.is/ishoneypot>.
- Límite: no documentado; cabeceras observadas `x-ratelimit-limit: 50`, `x-ratelimit-remaining`, `x-ratelimit-reset` (el reinicio llegó ~3 s después de la petición, lo que sugiere una ventana corta).
- Campos [OBSERVADO]: `summary{risk, riskLevel, flags}`, `simulationSuccess`, `honeypotResult.isHoneypot`, `simulationResult{buyTax, sellTax, transferTax, buyGas, sellGas}`, `holderAnalysis{holders, successful, failed, siphoned, averageTax, highestTax, highTaxWallets}`, `contractCode{openSource, isProxy, hasProxyCalls}`, `pair{liquidity, createdAtTimestamp}`.
- **Fiabilidad:** simula compra y venta, lo que aporta los impuestos reales que GoPlus dejó vacíos. Límites reconocidos: si no puede comprar (sin liquidez, trading pausado) no puede verificar, y un token limpio ahora puede cambiar después (contratos con funciones modificables). Solo EVM. `holderAnalysis` es especialmente útil: indica cuántos holders reales podrían vender.

**RugCheck** (Solana; lectura gratuita sin clave)
- `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary` → `risks[{name, level, score, description}]`, `score`, `score_normalised`, `lpLockedPct`.
- `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report` → además `topHolders[{pct, owner, insider}]`, `mintAuthority`, `freezeAuthority`, `transferFee`, `markets[].lp{lpLockedPct, lpLockedUSD}`, `totalMarketLiquidity`, `totalLPProviders`, `totalHolders`, `rugged`, `graphInsidersDetected`, `insiderNetworks`, `creatorTokens`, `launchpad`.
- `GET /v1/stats/new_tokens`, `GET /v1/stats/analytics`, `GET /v1/stats/rugs/ticker`. Los endpoints masivos (`POST /v1/bulk/tokens/summary`) exigen autenticación. Swagger: <https://api.rugcheck.xyz/swagger/index.html>.
- Límite: no documentado; cabecera observada `X-Rate-Limit-Limit: 15` (ventana desconocida).
- Ejemplo real (BONK): `score 101`, `score_normalised 7`, `lpLockedPct 14,38`, riesgo "metadatos mutables" de nivel `warn`.
- **Fiabilidad:** no he encontrado una evaluación académica independiente. Su propia estadística agregada contiene un campo absurdo (`rugMarketCapUSD ≈ 2,28 × 10^18`), señal de que los datos agregados no están depurados.

**Token Sniffer:** de pago (99 USD/mes). Descartado. Aviso general: una puntuación alta solo significa que no se detectó un patrón conocido.

**GeckoTerminal `tokens/{addr}/info`:** alternativa gratuita para concentración de holders (`top_10`), autoridades de *mint* y *freeze* y `gt_score`.

**Regla de uso [OPINIÓN]:** estas APIs sirven para **vetar**, nunca para aprobar. Exigir acuerdo de al menos dos fuentes independientes, tratar "desconocido", error o *timeout* como rechazo, y repetir la comprobación justo antes de operar.

---

## 4. Decisión de arquitectura: CEX frente a DEX

### 4.1 Riesgos de operar low-caps en el CEX

- **Contraparte y custodia:** los fondos están en el exchange (insolvencia, congelación de retiradas, bloqueo de cuenta).
- **Exclusiones:** etiqueta *Monitoring* y posterior exclusión, con caídas bruscas en el anuncio (1.7).
- **Manipulación:** los P&D organizados tienen como objetivo precisamente monedas pequeñas de exchanges centralizados (2.4).
- **Listados como evento de salida:** 89–98 % de los listados de Binance de 2024–2025 en negativo (2.3).
- **Desplomes relámpago:** el 10 de octubre de 2025 se liquidaron ~19–20 mil millones de USD; hubo altcoins con caídas del 30–90 %, órdenes congeladas por caídas de API y, según la prensa, el par ATOM en Binance llegó a marcar −99,9 % durante segundos (<https://www.coindesk.com/markets/2025/10/12/altcoins-cratered-in-oct-10-crypto-flash-crash-as-bitcoin-held-up-wiston-capital-says>, <https://www.citationneeded.news/anatomy-of-a-crypto-meltdown/>).
- **Compromiso de la API key:** mitigable con clave solo de trading (sin permiso de retirada) y lista blanca de IP.

**Lo que el CEX sí aporta:** filtro previo de listado (elimina honeypots, impuestos de venta y retiradas de liquidez por diseño), libro de órdenes con spreads de 5–30 pb en low-caps (1.6), **órdenes stop y OCO nativas que siguen vivas aunque el bot se caiga**, comisiones fijas, sin gas, sin MEV, y una única integración (ccxt) ya presente en el proyecto.

### 4.2 Riesgos de operar en DEX

- **Clave privada en caliente en un servidor 24/7.** Si se filtra, la pérdida es total e irreversible. Casos reales:
  - `@solana/web3.js` 1.95.6 y 1.95.7 publicados con una puerta trasera que exfiltraba claves privadas (3 de diciembre de 2024, ventana de unas cinco horas); afectó sobre todo a bots que manejan claves directamente (<https://github.com/solana-labs/solana-web3.js/security/advisories/GHSA-jcxm-7wvp-g6p5>, <https://www.theregister.com/2024/12/05/solana_javascript_sdk_compromised/>).
  - Paquetes npm *typosquat* que vacían hasta el 98 % de la wallet y exfiltran claves por SMTP de Gmail (enero de 2025, <https://thehackernews.com/2025/01/hackers-deploy-malicious-npm-packages.html>).
  - Repositorio de GitHub de un "bot de pump.fun" con una dependencia maliciosa que robaba claves (julio de 2025, SlowMist, <https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89>).
- **El universo es mayoritariamente fraude** (sección 6): 98,6 % de los tokens de pump.fun según Solidus Labs; ~415 000 tokens nuevos en Solana en 7 días [OBSERVADO].
- **Las herramientas de detección fallan:** 21,4 % de falsos negativos en GoPlus (3.3).
- **MEV/sandwich:** entre 370 y 500 millones de USD extraídos en Solana en 16 meses (enero de 2024 – mayo de 2025), sobre 8 500 millones de operaciones analizadas (<https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev>).
- **No hay stops nativos:** la salida es otro swap que el bot debe firmar y enviar en el peor momento (red congestionada, slippage máximo, posible fallo de transacción). Si el bot está caído, no hay stop.
- **Costes fijos por operación** (gas, comisiones de prioridad, comisión del pool, deslizamiento) que pesan mucho en posiciones de 10–50 USD.
- **Superficie de implementación:** RPC, firma, aprobaciones de tokens, rutas, reintentos; todo código nuevo y crítico.

### 4.3 Recomendación

**v1 = solo CEX.** Razones, por orden de importancia:

1. El objetivo es defensivo y el riesgo dominante en DEX (robo de la clave, honeypot, retirada de liquidez) es de **pérdida total**, no acotable con un stop.
2. El stop nativo en el exchange es la única forma de que la protección no dependa de que el bot esté vivo.
3. Las herramientas anti-estafa dejan pasar ~1 de cada 5 *rug pulls*; el filtro de listado del CEX, con todos sus defectos, elimina esa clase de fraude.
4. El proyecto tiene una única dependencia (`ccxt`); añadir SDKs de wallets amplía la superficie de ataque de la cadena de suministro justo donde más duele.
5. Con capital pequeño, los costes fijos on-chain destruyen la expectativa.

**Qué se pierde, con honestidad [OPINIÓN]:** los multiplicadores extremos (×10, ×100) ocurren casi exclusivamente on-chain y antes de cualquier listado. En el CEX, "alta volatilidad" significa movimientos de +20 % a +80 % en un día, no ×50. Es el precio de no jugar a un juego con un 98 % de fraude.

**Radar on-chain opcional (sin claves, solo lectura):** registrar en un log los pools que pasen los filtros de 3.2 para medir, en papel, qué habría ocurrido. Sirve para decidir con datos si una v2 en DEX merece la pena. Si algún día se hace: wallet dedicada con saldo mínimo recargado a mano, clave fuera del repositorio, dependencias fijadas y auditadas, y proceso separado del bot principal.

---

## 5. Gestión de riesgo específica del módulo

Todos los valores son **[OPINIÓN]** de diseño, conservadores a propósito y pendientes de validación en papel.

### 5.1 Límites de capital

| Parámetro | Valor | Justificación |
|---|---|---|
| Presupuesto máximo del módulo | **5 % del patrimonio total** | Techo de pérdida aunque todo falle a la vez. |
| Tamaño por posición | **1 % del patrimonio** (tope duro 1,5 %) | Una posición puede ir a cero (exclusión, suspensión, hack). |
| Posiciones simultáneas | **3** | Máximo desplegado 3 %; las altcoins pequeñas caen juntas, la diversificación entre ellas es ilusoria. |
| Una posición por activo | sí | Sin promediar a la baja, nunca. |
| Tamaño mínimo operable | 3,5 × notional mínimo del exchange (salida en tres tramos) o 2,2 × (salida simplificada en dos) | Cada tramo de venta debe superar por sí solo el notional mínimo. |

**Restricción práctica de las cuentas pequeñas (cálculo):** en Binance el notional mínimo observado es de 5 USDT. El tramo más pequeño de la salida en tres tramos es el 30 % de la posición, así que la posición debe ser ≥ 17,5 USDT; con el 1 % por posición eso exige un patrimonio ≥ ~1 750 USDT. Por debajo se usa la **salida simplificada** (50 % en TP1 y 50 % con *trailing*), que pide posición ≥ 11 USDT, es decir, patrimonio ≥ ~1 100 USDT. **Por debajo de ~1 100 USDT el explorador no debe operar con dinero real** (solo modo papel): subir el porcentaje por posición para "llegar al mínimo" rompería el límite de riesgo, que es lo único que de verdad protege.

### 5.2 Salidas

| Regla | Valor por defecto |
|---|---|
| Stop duro inicial | −10 % desde el precio de entrada, acotado entre −8 % y −15 % según `2 × ATR(14, 1 h)` |
| Tipo de orden del stop | stop-límite nativo en el exchange, disparo en el nivel del stop y límite un 5 % por debajo |
| TP1 | +20 %: vender el 40 %; subir el stop al precio de entrada más comisiones |
| TP2 | +40 %: vender el 30 % |
| Resto (30 %) | *trailing stop* del 15 % desde el máximo alcanzado tras TP2 |
| Stop temporal | cerrar a mercado si a las 48 h no se ha alcanzado TP1 |
| Tiempo máximo absoluto | 7 días |
| Salida forzosa inmediata | aparición de etiqueta *Monitoring* o entrada en el calendario de exclusión; spread > 1 % sostenido 5 min; desaparición del par de `loadMarkets` |

**Aritmética del punto de equilibrio (cálculo, no evidencia):** pérdida típica ≈ −10,5 % (stop más ~0,5 % de costes). Ganancia si solo se alcanza TP1 y el resto sale en el precio de entrada ≈ +8 %. Ganancia si se alcanza TP2 y el resto sale con el *trailing* mínimo (1,40 × 0,85 = 1,19) ≈ +25,7 %. Si todas las ganadoras fueran del primer tipo haría falta un 57 % de aciertos; con un 70 %/30 % entre ambos tipos, ~44 %. Dado el sesgo de reversión de la sección 2, **no hay base para suponer que se alcancen esas cifras**; hay que medirlo.

### 5.3 Enfriamiento y cortacircuitos

| Regla | Valor |
|---|---|
| Enfriamiento por símbolo tras cualquier salida en pérdida | 72 h |
| Enfriamiento por símbolo tras salida en beneficio | 24 h |
| Tras 2 stops consecutivos | sin nuevas entradas durante 24 h |
| Tras 4 pérdidas en 7 días | módulo pausado 7 días |
| Pérdida diaria del módulo | −0,5 % del patrimonio → sin entradas hasta el siguiente día UTC |
| *Kill switch* del módulo | pérdida realizada acumulada de −2 % del patrimonio (40 % del presupuesto) → módulo desactivado hasta revisión manual |
| Filtro de régimen | sin entradas si BTC cae más de un 4 % en 24 h o cotiza por debajo de su EMA(50) de 4 h |

### 5.4 Cómo tratar la iliquidez (el stop no se ejecuta donde se espera)

1. **El tamaño es el verdadero stop.** Se dimensiona asumiendo que la posición puede perder el 100 %: 1 % del patrimonio por posición, 3 % en total.
2. **Stop nativo en el exchange, colocado inmediatamente tras la compra.** Si la orden de stop no queda confirmada en 10 segundos, se cierra la posición a mercado. No se mantiene nunca una posición sin stop residente en el exchange.
3. **El stop tiene prioridad sobre las tomas de beneficio.** En spot, una orden de stop por el 100 % de la posición bloquea todo el saldo, de modo que no se pueden dejar además órdenes límite de TP en el libro. Dos opciones: (a) la única orden residente es el stop y los TP los ejecuta el bot (cancelar stop → vender el tramo → recolocar el stop por el resto, todo en secuencia y con verificación), o (b) órdenes OCO por tramo si el exchange las admite. La v1 usa (a): si el bot se cae, se pierde la toma de beneficios pero nunca la protección.
4. **Stop-límite con banda ancha, no stop a mercado.** Un stop a mercado en un libro vacío vende a cualquier precio (caso del 10 de octubre de 2025). Un stop-límite puede no ejecutarse; por eso lleva un vigilante por software.
5. **Vigilante:** si el precio está por debajo del límite y la orden sigue sin ejecutarse tras 60 s, cancelar y reenviar una orden límite agresiva en el mejor *bid*, bajando en hasta 3 pasos. Excepción: si el precio ha caído más de un 30 % en menos de 5 minutos, esperar 15 minutos antes de vender a mercado en lugar de entregar la posición en el fondo del hueco.
6. **Respetar los filtros del exchange.** En Binance, `PERCENT_PRICE_BY_SIDE` impide poner una venta límite por debajo de 0,8 × el precio medio de 5 minutos, y `TRAILING_DELTA` admite entre 10 y 2 000 puntos básicos **[OBSERVADO en MOVRUSDT]**. El límite del stop debe quedar dentro de esa banda o la orden será rechazada.
7. **Comprobar la profundidad antes de entrar:** suma de *bids* dentro del 2 % ≥ 10 × la posición.
8. **Entrar con orden límite**, nunca a mercado: límite en el *ask* + 0,3 % como máximo, tipo IOC; si no se ejecuta, se descarta la señal.
9. **Registrar el deslizamiento real** de cada stop. Si la mediana supera el 2 %, subir los umbrales de liquidez.
10. **Caída de la API:** al arrancar, el bot reconcilia posiciones y stops antes de hacer cualquier otra cosa; si encuentra una posición sin stop, la cierra.

---

## 6. Estadísticas honestas

### 6.1 Proporción de tokens que acaban en cero o son estafas

| Dato | Fuente |
|---|---|
| El 53,2 % de todas las criptomonedas rastreadas en GeckoTerminal entre julio de 2021 y diciembre de 2025 han dejado de negociarse; 11,56 millones murieron solo en 2025 (86,3 % del total). Excluye los tokens de pump.fun no "graduados", así que infraestima. | CoinGecko Research — <https://www.coingecko.com/research/publications/how-many-cryptocurrencies-failed> |
| El 98,6 % de los ~7 millones de tokens lanzados en pump.fun desde enero de 2024 se clasifican como *rug pull* o pump-and-dump; solo 97 000 (1,4 %) mantuvieron al menos 1 000 USD de liquidez. El 93 % de los pools de Raydium analizados (361 000) muestran rasgos de *soft rug*; mediana por *rug*: 2 800 USD. pump.fun rechaza la clasificación. | Solidus Labs vía CoinDesk — <https://www.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says> |
| Ethereum 2023: 370 066 tokens lanzados, 168 623 listados en DEX; 90 408 cumplen el patrón de P&D (24,4 % de los lanzados, 53,6 % de los listados); beneficio estimado de los manipuladores: 241,6 M USD, media de 2 672 USD por token. | Chainalysis — <https://www.chainalysis.com/blog/crypto-crime-2024-pump-and-dump/> |
| 2024: más de 3 millones de tokens creados, ~1,29 millones listados en DEX; 74 037 (3,59 %) con patrón de P&D; ~94 % de esos pools fueron vaciados por su propio creador; solo el 1,7 % seguía negociándose activamente a los 30 días. | Chainalysis — <https://www.chainalysis.com/blog/crypto-market-manipulation-wash-trading-pump-and-dump-2025/> |
| De 13,55 millones de wallets de pump.fun, solo 55 296 (0,41 %) realizaron más de 10 000 USD de beneficio; más del 60 % perdió dinero. | Dune vía Cointelegraph — <https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data> |
| **[OBSERVADO]** RugCheck `stats/analytics`, ventana de 7 días al 2026-09-30: ~415 000 tokens lanzados en Solana (300 059 en pump.fun); ~44 900 *rug pulls* detectados (31 540 en pump.fun, 10,5 %; 6 694 de 17 402 en Meteora DBC, 38 %); tiempo medio hasta el *rug* en pump.fun: 2 251 min. | `https://api.rugcheck.xyz/v1/stats/analytics` |

Las cifras no son comparables entre sí: RugCheck cuenta retiradas de liquidez detectadas; Solidus incluye cualquier token que se infla y se abandona; Chainalysis usa un criterio estricto (retirada de más del 70 % de la liquidez por una dirección y liquidez final inferior a 300 USD). El orden de magnitud sí es consistente: **en el universo on-chain sin filtrar, la inmensa mayoría de los tokens nuevos vale cero en días o semanas.**

En el CEX no hay una estadística equivalente de "ir a cero", pero sí de pérdida fuerte: 12 de los listados de Binance de 2024 cayeron más de un 90 % (2.3).

### 6.2 Cómo no ser la liquidez de salida

1. **No perseguir velas verticales.** El P&D clásico se agota en 70 segundos; exigir vela de 1 h cerrada y precio sostenido.
2. **No comprar lo que ya subió demasiado.** Veto por encima de +40 % en 24 h.
3. **No comprar lo que el exchange ha marcado.** El 2026-09-30, 4 de los 8 mayores *gainers* de Binance tenían etiqueta *Monitoring* **[OBSERVADO]**.
4. **No comprar listados recientes.** Quien vende ahí es quien recibió los tokens antes.
5. **Desconfiar del volumen sin historia.** Exigir mediana de 7 días, no solo el volumen de hoy.
6. **Ignorar la promoción.** Trending, boosts y canales de señales miden atención comprada o tardía.
7. **Vender por tramos y pronto.** El 40 % en +20 % convierte una operación perdedora potencial en neutra.
8. **No promediar a la baja** y respetar el enfriamiento: los activos "bombeados" suelen bombearse otra vez, y la segunda vez también se pierde.
9. **Nunca seguir un canal de señales** ni automatizar nada que venga de Telegram o Discord: es literalmente el mecanismo de reclutamiento de compradores tardíos.

---

## 7. Especificación propuesta para la v1

### 7.1 Universo

- Pares spot activos del exchange del bot principal, cotizados en la divisa de la cuenta.
- Excluidos: los 30 primeros por volumen de cotización 24 h (pertenecen a la estrategia principal), stablecoins, tokens envueltos o anclados, tokens apalancados, acciones tokenizadas, activos con etiqueta *Monitoring* o en calendario de exclusión, pares con menos de 30 días.
- Si hay clave Demo de CoinGecko: añadir capitalización con `coins/markets` y restringir a rango de capitalización > 100. Ojo: los símbolos colisionan entre monedas; mapear por `id` con tabla revisada a mano, no por símbolo.

### 7.2 Frecuencia

| Tarea | Frecuencia | Llamada |
|---|---|---|
| Escaneo general | cada 5 min | `fetchTickers()` |
| Análisis de candidatos (máx. 20) | al cierre de cada vela de 1 h | `fetchOHLCV(symbol, '1h', undefined, 200)` |
| Libro de órdenes de finalistas (máx. 5) | antes de entrar | `fetchOrderBook(symbol, 50)` |
| Vigilancia de posiciones abiertas | cada 30 s | `fetchTicker(symbol)` o `watchTicker` |
| Nuevos listados | cada hora | `loadMarkets(true)` y comparación con el conjunto guardado |
| Etiquetas y exclusiones | cada hora | `delist-schedule` (con clave) y endpoint de etiquetas (no oficial, tolerante a fallos) |
| Antigüedad del par | una vez por símbolo, en caché | `fetchOHLCV(symbol, '1d', 0, 1)` |
| Trending (solo informativo) | cada 15 min | CoinGecko `/search/trending` |
| Régimen de mercado | cada 15 min | `fetchOHLCV('BTC/USDT', '4h', undefined, 100)` |

### 7.3 Puntuación (0–100)

Definiciones, todas sobre velas de 1 h ya cerradas:

- `RVOL` = volumen de cotización de las últimas 24 h ÷ mediana del volumen diario de los 7 días anteriores.
- `ret24`, `ret7d` = rentabilidad de las últimas 24 h y 7 días.
- `donchian7d` = máximo de los `high` de las 168 velas anteriores a la última.
- `spread_pb` = (ask − bid) ÷ precio medio × 10 000.

Componentes (cada uno en [0, 1]):

```
S_vol = clamp(log2(RVOL) / 3, 0, 1)                   # RVOL 2 → 0,33; 4 → 0,67; 8 → 1
S_brk = 1    si cierre > donchian7d y el cierre está en el 30 % superior de la vela
        0,5  si cierre ≥ 0,98 × donchian7d
        0    en otro caso
S_mom = clamp(ret24 / 0,15, 0, 1)   si ret7d > 0;  0 en otro caso
S_liq = clamp(1 − spread_pb / 30, 0, 1)
S_reg = 1 si BTC está por encima de su EMA(50) de 4 h y su variación 24 h > −2 %; 0 en otro caso
S_ext = clamp((ret24 − 0,25) / 0,15, 0, 1)             # penaliza la sobreextensión desde +25 %

Puntuación = 100 × (0,35·S_vol + 0,25·S_brk + 0,20·S_mom + 0,10·S_liq + 0,10·S_reg) − 30·S_ext
```

Los pesos son **[OPINIÓN]** y no están calibrados. La forma responde a la evidencia: volumen y tendencia juntos (CTREND), liquidez como condición (Fičura) y penalización de la sobreextensión (Zaremba).

### 7.4 Reglas de entrada (todas deben cumplirse)

1. El activo pasa todos los filtros de 3.1.
2. Puntuación ≥ 65.
3. `RVOL` ≥ 3 y `S_brk` = 1.
4. `ret24` ≤ 40 %.
5. Veto anti-P&D superado (ninguna vela de 5 min de la última hora con +10 % y volumen > 20 × la mediana).
6. El precio actual sigue por encima del nivel de ruptura 15 minutos después del cierre de la vela de 1 h que dio la señal.
7. Hay hueco: menos de 3 posiciones abiertas, presupuesto disponible, sin enfriamiento activo, sin cortacircuito activo, filtro de régimen favorable.
8. Orden límite IOC en `ask × 1,003` como máximo. Si no se ejecuta al menos el 80 %, se cancela y se vende lo ejecutado si queda por debajo del tamaño mínimo.
9. Inmediatamente después: orden stop-límite nativa. Sin confirmación en 10 s → cierre.

Si hay varios candidatos, se elige el de mayor puntuación; como máximo una entrada nueva por hora.

### 7.5 Reglas de salida

Las de 5.2 y 5.4, sin excepción. Prioridad: salida forzosa > stop duro > stop temporal > TP1/TP2 > *trailing*.

### 7.6 Parámetros por defecto

```ts
export const EXPLORADOR_V1 = {
  modo: 'papel',                     // 'papel' | 'real'; arrancar SIEMPRE en papel
  // Capital
  presupuestoModuloPct: 0.05,        // 5 % del patrimonio
  posicionPct: 0.01,                 // 1 % del patrimonio
  posicionPctMax: 0.015,
  maxPosiciones: 3,
  notionalMinMultiplo3Tramos: 3.5,   // posición ≥ 3,5 × notional mínimo → salida TP1/TP2/trailing
  notionalMinMultiplo2Tramos: 2.2,   // si no llega: salida simplificada 50 % TP1 + 50 % trailing
                                     // si tampoco llega: solo modo papel
  // Universo y filtros
  excluirTopPorVolumen: 30,
  edadMinDias: 30,
  volumen24hMin: 1_000_000,
  volumenMediana7dMin: 500_000,
  spreadMaxPb: 30,
  profundidadMinMultiplo: 10,        // bids a ±2 % ≥ 10 × posición
  ret24hMax: 0.40,
  antiPump: { velaMin: 5, subidaMax: 0.10, volumenMultiplo: 20 },
  // Señal
  escaneoMin: 5,
  velaSenal: '1h',
  rvolMin: 3,
  donchianVelas: 168,
  puntuacionMin: 65,
  esperaConfirmacionMin: 15,
  maxEntradasPorHora: 1,
  // Ejecución
  deslizamientoEntradaMax: 0.003,
  stopConfirmacionSeg: 10,
  // Salidas
  stopPct: 0.10, stopPctMin: 0.08, stopPctMax: 0.15, stopAtrMultiplo: 2,
  stopLimiteBanda: 0.05,
  tp1: { subida: 0.20, fraccion: 0.40, moverStopAEntrada: true },
  tp2: { subida: 0.40, fraccion: 0.30 },
  trailingPct: 0.15,
  tiempoSinTp1Horas: 48,
  tiempoMaxDias: 7,
  // Enfriamiento y cortacircuitos
  enfriamientoPerdidaHoras: 72,
  enfriamientoGananciaHoras: 24,
  pausaTras2StopsHoras: 24,
  pausaTras4PerdidasEn7dDias: 7,
  perdidaDiariaMaxPct: 0.005,        // 0,5 % del patrimonio
  killSwitchPct: 0.02,               // 2 % del patrimonio acumulado
  regimenBtc: { caida24hMax: 0.04, ema4h: 50 },
} as const;
```

### 7.7 Criterios para pasar de papel a real [OPINIÓN]

- Al menos 4 semanas y 50 señales simuladas, con costes realistas (comisión por lado consultada con `fetchTradingFee`, medio spread y deslizamiento del stop).
- Factor de beneficio neto > 1,2 y caída máxima del módulo < 30 % de su presupuesto.
- Ningún fallo del tipo "posición sin stop" en los registros.
- Si no se cumple, **el módulo no se activa**. Dada la evidencia de la sección 2, que no se cumpla es un resultado plausible y aceptable.

### 7.8 Seguridad operativa

- API key del exchange solo con permiso de trading, sin retiradas, con lista blanca de IP; en `.env` (ya ignorado por git).
- Mantener `ccxt` como única dependencia, versión fijada y `npm ci` con el lockfile.
- Todas las llamadas externas con *timeout*, reintento con backoff y degradación segura: si falta un dato, no se entra.
- El radar on-chain, si se implementa, solo hace peticiones GET sin clave y no comparte proceso ni credenciales con la ejecución.

---

## 8. No verificado

- **Exchange concreto del bot:** no consta en el repositorio (vacío salvo `package.json`). Las pruebas se hicieron sobre todo con Binance; los filtros, comisiones y tipos de orden deben revisarse para el exchange final y su disponibilidad legal en el país del usuario.
- **Ningún parámetro de las secciones 5 y 7 está backtesteado.** Los umbrales y los pesos de la puntuación son criterio de diseño.
- **Límites de GeckoTerminal (30/min):** tomados de documentación y fuentes secundarias; no los forcé. El FAQ original ya redirige a la documentación de CoinGecko y alguna fuente cita ~10/min.
- **Límites de DexScreener (60 y 300/min):** de la documentación; la API no devuelve cabeceras de límite y no los forcé.
- **Plan Demo de CoinGecko:** hay contradicción entre 100/min (página de precios) y ~30/min (soporte). No probé con clave. El nombre de la cabecera de autenticación no lo he comprobado.
- **Birdeye:** cuota del plan gratuito y lista de endpoints accesibles sin verificar (documentación con 404). Solo confirmé que sin clave devuelve 401.
- **Token Sniffer:** precio tomado de un resultado de búsqueda, no de la página.
- **honeypot.is:** cadenas soportadas no confirmadas; la ventana del límite de 50 es una inferencia a partir de una cabecera.
- **RugCheck:** ventana del límite de 15 desconocida; definición exacta de "rug" en sus estadísticas no documentada; un campo agregado es claramente erróneo.
- **Endpoint de etiquetas de Binance (`bapi/.../get-products`):** no oficial y sin documentación; funcionó hoy.
- **`delist-schedule` de Binance:** solo comprobé que exige clave; el formato de respuesta procede de la documentación.
- **Artículos académicos de pago** (Zaremba et al., Garfinkel et al., Dobrynskaya, CTREND, Li-Shin-Wang): leí resúmenes y reseñas, no los textos completos. Las muestras terminan entre 2019 y 2022; la estructura del mercado ha cambiado.
- **Estadísticas de listados de Binance:** proceden de prensa que cita a analistas de X y paneles de Dune, con ventanas de medición distintas y sin auditoría. La cifra de "100 listados en 2025, 93 en negativo, mediana 0,22×" apareció en una sola fuente secundaria y no la he incluido en el cuerpo por eso.
- **Solidus Labs (98,6 %):** cifra citada vía prensa; la definición es amplia y pump.fun la disputa.
- **Extracción por sandwich en Solana:** de una charla de conferencia resumida por un tercero.
- **Detalles del 10 de octubre de 2025** (ATOM −99,9 %, stops que no se dispararon): de prensa, no contrastados con datos del exchange.
- **Observación sobre los *gainers* con etiqueta *Monitoring*:** es la foto de un solo día.
- **Fallo de DNS con Bitget** desde esta máquina: causa no investigada.
- **Costes de gas y comisiones en DEX:** tratados de forma cualitativa, sin cifras medidas.
- **Fiscalidad y regulación** (MiCA, tributación de permutas): fuera del alcance.

---

## 9. Fuentes

**Documentación y APIs**
- DexScreener, referencia de la API: <https://docs.dexscreener.com/api/reference>
- Límites de DexScreener (análisis de terceros): <https://coinpaprika.com/education/dexscreener-api-rate-limits-explained/>
- GeckoTerminal, documentación: <https://api.geckoterminal.com/docs/index.html> · FAQ: <https://apiguide.geckoterminal.com/faq>
- CoinGecko, límites y errores: <https://docs.coingecko.com/docs/common-errors-rate-limit> · precios: <https://www.coingecko.com/en/api/pricing> · *top gainers*: <https://docs.coingecko.com/reference/coins-top-gainers-losers>
- Birdeye, precios: <https://birdeye.so/data-api/pricing>
- GoPlus, soporte y límites: <https://docs.gopluslabs.io/reference/support> · visión general: <https://docs.gopluslabs.io/reference/api-overview>
- honeypot.is: <https://docs.honeypot.is/ishoneypot>
- RugCheck, Swagger: <https://api.rugcheck.xyz/swagger/index.html>
- Token Sniffer, precios: <https://tokensniffer.readme.io/reference/pricing>
- Binance, calendario de exclusiones: <https://developers.binance.com/docs/wallet/asset/spot-delist-schedule>

**Evidencia académica**
- Zaremba, Bilgin, Long, Mercik y Szczygielski (2021): <https://www.sciencedirect.com/science/article/pii/S1057521921002349>
- Fičura (2023): <https://wp.ffu.vse.cz/artkey/wps-202301-0003_impact-of-size-and-volume-on-cryptocurrency-momentum-and-reversal.php>
- Dobrynskaya (2023): <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3913263>
- Fieberg et al., factor de tendencia (JFQA): <https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/trend-factor-for-the-cross-section-of-cryptocurrency-returns/4C1509ACBA33D5DCAF0AC24379148178>
- Garfinkel et al. (2025): <https://onlinelibrary.wiley.com/doi/10.1111/fima.12491>
- Hudson y Urquhart (2021): <https://link.springer.com/content/pdf/10.1007/s10479-019-03357-1.pdf>
- Efecto MAX en cripto: <https://link.springer.com/article/10.1186/s40854-021-00291-9>
- Ante (2019), listados: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3450301>
- Li, Shin y Wang, P&D: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3267041> · reseña: <https://clsbluesky.law.columbia.edu/2019/01/07/cryptocurrency-pump-and-dump-schemes/>
- Xu y Livshits (2019), P&D: <https://arxiv.org/abs/1811.10109>
- RPHunter (evaluación de GoPlus): <https://arxiv.org/html/2506.18398>
- Tokens trampa en Uniswap: <https://arxiv.org/abs/2309.04700>

**Informes y prensa**
- CoinGecko Research, monedas muertas: <https://www.coingecko.com/research/publications/how-many-cryptocurrencies-failed>
- Solidus Labs vía CoinDesk: <https://www.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says>
- Chainalysis, P&D 2023: <https://www.chainalysis.com/blog/crypto-crime-2024-pump-and-dump/>
- Chainalysis, manipulación 2024: <https://www.chainalysis.com/blog/crypto-market-manipulation-wash-trading-pump-and-dump-2025/>
- Beneficios de wallets en pump.fun: <https://cointelegraph.com/news/pump-fun-crypto-traders-majority-do-not-realize-profits-dune-data>
- Listados de Binance: <https://protos.com/binance-token-listing-no-longer-a-bullish-event-research/> · <https://beincrypto.com/binance-listed-tokens-negative-return/>
- Etiqueta *Monitoring*: <https://beincrypto.com/binance-monitoring-tag-seven-tokens-delisting/> · <https://finance.yahoo.com/markets/crypto/articles/binance-adds-monitoring-tag-4-090334033.html>
- MEV en Solana: <https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev>
- Compromiso de `@solana/web3.js`: <https://github.com/solana-labs/solana-web3.js/security/advisories/GHSA-jcxm-7wvp-g6p5> · <https://www.theregister.com/2024/12/05/solana_javascript_sdk_compromised/>
- Paquetes npm maliciosos: <https://thehackernews.com/2025/01/hackers-deploy-malicious-npm-packages.html>
- Bot de trading malicioso (SlowMist): <https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89>
- Desplome del 10 de octubre de 2025: <https://www.coindesk.com/markets/2025/10/12/altcoins-cratered-in-oct-10-crypto-flash-crash-as-bitcoin-held-up-wiston-capital-says> · <https://www.citationneeded.news/anatomy-of-a-crypto-meltdown/>
