# ADR 0033 — Restos en polvo y stops que ya no se pueden colocar

Fecha: 2026-10-17 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) · Paso: 28 (parte 1 de 2)

## Contexto

EXP-0024, el barrido de la tendencia del paso 28 (ADR 0032), falló a los 40 minutos con
`StrategyStateError: BTC/EUR: posición abierta sin el stop de su entrada` y quedó `fallido` en el registro, contando en N.
No se vio ninguna métrica. Pruebas con datos sintéticos de liquidez fina encontraron dos fallos latentes del sistema
compuesto, anteriores al paso 28, que solo aparecen cuando el venue simulado llena una orden en parte (como mucho el 2 %
del volumen de la vela, ADR 0026):

1. **Polvo que vuelve a ser vendible.** Un resto por debajo del mínimo del mercado (5 EUR) es polvo (`ledger.ts`): no se
   puede vender y el Strategy Engine no lo ve como posición. El motor borraba entonces su stop. Si el precio subía y el
   resto volvía a valer más que el mínimo, la posición reaparecía sin stop y el motor lanzaba. Con el código anterior, el
   escenario sintético reproduce exactamente el error de EXP-0024. Es lo más probable en los controles con el backtester
   real, sobre todo en el paseo aleatorio, donde el precio de las velas barajadas se aleja mucho del real y el volumen de
   cada vela se conserva.
2. **Un stop ya cruzado se reintentaba sin fin.** Si el precio cruza el stop antes de que este se coloque (un hueco tras
   la entrada), el exchange lo rechaza (`STOP_WOULD_TRIGGER`). El sistema lo volvía a proponer en cuanto llegaba el
   rechazo, unas 30 veces por vela en el escenario sintético, con miles de eventos y la posición sin proteger. Explica
   probablemente que EXP-0023 llegara a 2,2 GB de memoria; un escenario sintético más largo agotó los 4 GB de Node.

`trading-risk` §2.4 fija que toda posición tiene stop y que un stop disparado que no se llena se trata como salida
urgente a mercado.

## Decisión

### 1. El polvo conserva su stop (`strategy/engine.ts`)

El stop de una posición se olvida solo cuando no queda nada de ella en cartera, no cuando lo que queda es polvo. Si el
resto vuelve a ser vendible, sigue con el stop de su entrada. Una entrada nueva sobre un resto en polvo lleva el resto con
el stop de la entrada nueva. Una posición que aparece sin que el motor haya entrado sigue siendo un estado imposible, y
lanza.

### 2. Un stop que no se puede colocar da una salida urgente (`strategy/engine.ts`)

`protectiveStop` no propone un stop que no se puede colocar: si el precio que conoce ya está en el stop o por debajo, o si
el importe del stop no llega al mínimo del mercado, propone una salida urgente a mercado, de origen `system`,
`reduce_only` y de toda la posición. Pasa por Risk como cualquier salida (trading-risk §2.1) y bloquea el símbolo como una
salida de la estrategia, para que no salgan dos ventas a la vez.

### 3. Un stop rechazado no se repite en el acto (`app/trading-system.ts`)

Tras un stop de protección rechazado por el exchange, el sistema no lo vuelve a proponer hasta la vela siguiente: el
exchange lo rechazaría igual. Con la vela nueva se aplica la decisión 2, así que, si para entonces el precio ya lo ha
cruzado, la posición sale a mercado. Tras un stop que caduca sin liquidez o que se ejecuta en parte, se vuelve a proteger
en el acto, como antes.

### 4. Pruebas

- `test/src/strategy/engine.test.ts`: el polvo de una salida parcial y el de una entrada parcial conservan su stop; una
  entrada nueva sobre polvo lleva el stop nuevo; la salida urgente con el stop cruzado o por debajo del mínimo.
- `test/src/app/thin-liquidity.test.ts`: el sistema compuesto con liquidez fina. Falla con el motor anterior (el error de
  EXP-0024) y con la composición anterior (rechazos repetidos en la misma vela); pasa con los dos arreglos.

## Alternativas

- **Vender el polvo en cuanto vuelve a ser vendible, sin stop.** Más simple, pero cambia la estrategia: cierra una
  posición que su regla mantendría. Conservar el stop deja decidir a la regla y no deja la posición sin protección.
- **Reintentar el stop con espera exponencial.** Acota los eventos, pero deja la posición sin protección mientras el
  precio sigue por debajo del stop; trading-risk §2.4 pide salir.
- **Cambiar el modelo de liquidez del venue para evitar fills parciales.** Ocultaría un caso real: en un mercado fino una
  orden a mercado se llena en parte.

## Consecuencias

- EXP-0024 queda `fallido` y cuenta en N. El barrido se repite como un experimento nuevo con este código.
- En los backtests, una posición cuyo stop se cruza antes de colocarse sale con la vela siguiente, como un stop disparado
  por un hueco, en lugar de quedarse sin stop. Es lo que trading-risk pide en real.
- El cambio alcanza a paper y live cuando se compongan (pasos 32 a 36): la salida urgente es una intención más de Risk. En
  real, el rechazo del exchange llega con su código, y el paso 36 tendrá que tratarlo igual.
- Ningún invariante cambia: se refuerza que toda posición tenga stop.

Checklist de `trading-risk` aplicado: las salidas, también la urgente, pasan por Risk como `reduce_only`; Strategy solo
produce `OrderIntent`; un stop disparado o imposible se trata como salida urgente a mercado (§2.4); ningún límite se relaja.
El resto del checklist (token, capguard, capas de capital) no cambia con este ADR.
