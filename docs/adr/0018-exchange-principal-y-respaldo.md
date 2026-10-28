# ADR 0018 — Exchange principal y de respaldo

Fecha: 2026-10-07 · Estado: **aceptado** por la persona el 2026-10-07: Bitvavo con cuenta dedicada solo al bot y OKX EEA
de respaldo · Paso: 17

## Contexto

- El usuario reside en España. Desde el 2026-07-01 solo puede operar con un exchange autorizado como CASP bajo
  MiCA. Binance, el exchange del código previo y de `config.json`, no tiene esa autorización y no admite nuevos
  usuarios de la UE.
- USDT no se puede negociar en el EEE desde la misma fecha. La cotización del bot tiene que ser EUR o USDC.
- El capital máximo es de 1.000 USDT (ADR 0017). Con ese capital el bot nunca sube de nivel de comisiones: cuenta
  la tarifa base.
- `exchange-execution` exige dead-man switch o cancel-on-disconnect, stops nativos, secuencia en el WebSocket,
  idempotencia y reconciliación. `trading-risk` exige subcuenta, clave sin retiros y lista blanca de IP.
- Comparativa completa, con fuentes y grado de verificación, en
  [docs/research/06-exchanges-mica.md](../research/06-exchanges-mica.md).

## Decisión

1. **Principal: Bitvavo.** Autorizado por la AFM (Países Bajos) y nacido en la UE. Opera en EUR, la moneda en
   que tributa el usuario. Cobra 0,15 % maker y 0,25 % taker. Tiene cancel-on-disconnect por grupo
   (`cancelOrdersAfter`, mínimo 10 s), stops nativos (`stopLoss`, `stopLossLimit`), `nonce` secuencial en el
   libro, permisos ver/operar/retirar, lista blanca de IP y 1.000 puntos de peso por minuto. Está en ccxt
   (`bitvavo`). No se han encontrado sanciones en esta búsqueda.
2. **Respaldo: OKX EEA** (`my.okx.com`, ccxt `myokx`). Autorizado por la MFSA (Malta). Es el más barato en cuenta
   solo spot (0,10 % / 0,20 %) y tiene la API más completa: demo trading, `seqId`, `cancel-all-after` en spot,
   subcuentas y hasta 20 IP por clave. Queda como respaldo y no como principal por su historial regulatorio: se
   declaró culpable ante el DOJ en 2025 (504 M$) y lo han sancionado la FIAU (Malta) y el DNB (Países Bajos).
3. **Kraken no se usa para operar, sino como fuente de datos de research**: tiene historia en EUR desde antes de
   2018 y descarga gratuita de todos los trades de cada par (ver [DATA.md](../../DATA.md)). Para operar, sus
   comisiones (0,40 % / 0,80 %) cuadruplican las de los otros dos y sus subcuentas son solo institucionales.
4. **Cotización en EUR.** Los pares USDC solo entran si el research lo justifica.
5. **Capital máximo en EUR y bajo.** La persona propone unos 100 EUR. Se fija con un ADR en el paso 32.

## Subcuentas (condición de la aprobación, verificada el 2026-10-07)

- **Bitvavo no da subcuentas a particulares.** Su documentación oficial (docs.bitvavo.com, «Institutional APIs →
  Introduction») exige «a Bitvavo corporate account» para crearlas. Además, su contrato prohíbe tener más de una
  cuenta personal (support.bitvavo.com, «Can I create a second account?», art. 2.7 del User Agreement): no se
  puede abrir una segunda cuenta solo para el bot.
- **OKX EEA sí las da.** Según su ayuda oficial (okx.com/en-eu/help/what-is-sub-account), un usuario normal puede
  crear hasta 5 subcuentas. Una subcuenta estándar no puede retirar fondos, y cada una tiene sus propias claves de
  API (`POST /api/v5/users/subaccount/create-subaccount`). La página avisa de que puede no aplicarse a todos los
  clientes: se comprueba con la cuenta abierta.

**Decisión (aprobada): Bitvavo como principal, con su única cuenta personal dedicada solo al bot.** La persona no
guarda en Bitvavo nada más que el capital del bot (unos 100 EUR); el resto de su cripto está en otra entidad o en
su monedero. Las recargas las hace a mano. La clave del bot no tiene permiso de retiro y lleva lista blanca de IP.

- **Por qué:** con unos 100 EUR, lo que expone una cuenta dedicada es lo mismo que expondría una subcuenta, y se
  conserva el exchange con mejor historial regulatorio. Una subcuenta añade que ni siquiera la cuenta puede
  retirar, pero la clave del bot ya no tiene ese permiso.
- **M-04 cambiado** (aprobado por la persona): de «subcuenta» a «cuenta dedicada», con la regla de que en esa cuenta
  solo hay el dinero del bot (`SECURITY_AND_TRADING_INVARIANTS.md`).
- **Alternativa descartada: OKX EEA como principal, con una subcuenta estándar,** y Bitvavo como respaldo. Cumple M-04 tal
  como está escrito, es más barato y tiene demo. A cambio, el capital queda en el exchange con peor historial de
  los candidatos (ver «Alternativas»).

## Alternativas

| Opción | Por qué no |
|---|---|
| OKX como principal | La mejor API y las comisiones más bajas, pero el historial regulatorio más grave de los candidatos. El capital está en el exchange: el riesgo de contraparte no lo arregla el código |
| Kraken como principal | El mejor historial y los mejores datos, pero una ida y vuelta taker cuesta 1,60 %, cuatro veces más que Bitvavo. No tiene subcuentas para particulares, su testnet spot es solo bajo petición y el libro no lleva secuencia |
| Coinbase Advanced | 0,40 % / 0,60 % y sin dead-man switch en spot |
| Bybit EU | Su dead-man switch (DCP) es solo para cuentas institucionales y tiene historia desde 2025 |
| Bitstamp | ccxt no implementa sus stops ni el dead-man switch |
| Bit2Me (CNMV) | No está en ccxt |
| Binance | Sin autorización MiCA |

## Consecuencias

- **Sin testnet en el principal** (decidido por la persona): en `development` solo queda el modo paper. Las pruebas
  de transmisión se hacen con el servidor falso (el exchange simulado de las pruebas) y, al inicio de micro-live
  (paso 46, no antes del 2027-01-01 según el ADR 0019), con órdenes del tamaño mínimo que admita el exchange.
- **Coste en el research:** comisión mínima del exchange elegido, 0,25 % por lado si se usa taker (más medio
  spread y 0,05 % de slippage, `quant-research` §5). Las cifras de `docs/research/02` usaban 0,10 %.
- **Cambios pendientes en el código** (paso 32, con `exchange/`): `exchange.id` y la cotización de `config.json`
  y del esquema (hoy `binance` y `USDT`), y el capital máximo en EUR (unos 100 EUR, con su ADR).
- **Marcas [verificar]** de `exchange-execution` y del ADR 0005 (escritas para Binance): se revisan con la
  documentación de Bitvavo en los pasos 32 y 36.
- **Verificar antes de abrir cuenta:** la exportación fiscal de Bitvavo. Abrir cuentas y crear claves es una
  parada obligatoria.
- Si la persona elige otro exchange, este ADR se reescribe antes de cerrar el paso 17 y [DATA.md](../../DATA.md)
  se ajusta.

## Anexo — Texto para `trading-risk` (lo pega la persona)

`.claude/` solo lo edita la persona. Para que `trading-risk` §3 diga lo mismo que M-04, sustituir en
`.claude/skills/trading-risk/SKILL.md` el punto «**Subcuenta dedicada** con solo el capital asignado al bot. El
resto del dinero está en otra cuenta, sin transferencias automáticas. Las recargas las hace un humano, a mano.» por:

```markdown
- **Subcuenta o cuenta dedicada solo al bot** con solo el capital asignado. Si el exchange no da subcuentas a
  particulares (Bitvavo, ADR 0018), la cuenta entera es del bot y el resto del dinero está en otra entidad, sin
  transferencias automáticas. Las recargas las hace un humano, a mano.
```

La prueba del skill exige la palabra «subcuenta», y este texto la conserva. Las menciones a «la subcuenta» en
`exchange-execution` (§14.2) valen igual para la cuenta dedicada y no hace falta cambiarlas.
