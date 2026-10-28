# ADR 0014 — Tipo decimal propio sobre big.js

Fecha: 2026-10-06 · Estado: aceptado (modo autónomo, ADR 0011; la persona lo revisa al aprobar el paso) ·
Paso: 14 (decisión); la implementación es del paso 18

## Contexto

exchange-execution §17 y el [ADR 0005](0005-exchange-execution.md) (decisión 14) prohíben el float para
precios, cantidades, balances, comisiones, importes y PnL. Piden un tipo decimal propio que envuelva una
biblioteca madura, para poder sustituirla tocando un solo archivo. La decisión definitiva tocaba en este paso,
y la implementación, al inicio del paso 18. Esos documentos citaban decimal.js como ejemplo. El ADR 0005 ya
descartó escribir la aritmética sobre `bigint`.

Lo que el tipo tiene que garantizar:

- suma, resta y producto exactos, sin redondeos silenciosos;
- división con escala y modo de redondeo explícitos;
- redondeo a un paso de mercado cualquiera (ccxt trabaja con `TICK_SIZE`, [docs/CCXT.md](../CCXT.md) §2), en
  el sentido de exchange-execution §7: la cantidad, siempre a la baja;
- error ante cualquier entrada que no sea un decimal válido, y ningún camino silencioso desde `number`;
- una forma canónica en cadena para SQLite (`TEXT`), JSON, logs y el exchange;
- tipos de TypeScript, ESM y la regla automática de dependencias del ADR 0011.

Candidatas comprobadas el 2026-10-06 en el registro de npm, la API de GitHub y su documentación:

| | big.js | decimal.js | bignumber.js |
|---|---|---|---|
| Última versión | 7.0.1 (2025-04-21) | 10.6.0 (2025-07-06) | 11.1.5 (2026-07-05) |
| Licencia, dependencias y scripts de instalación | MIT, ninguna, ninguno | MIT, ninguna, ninguno | MIT, ninguna, ninguno |
| Suma, resta y producto | Exactos: solo `div`, `sqrt` y `pow` con exponente negativo redondean | Redondeados a `precision` cifras significativas (20 por defecto) | Exactos |
| Entrada `number` | Prohibida con `Big.strict`, que también prohíbe `valueOf` | Admitida | Admitida |
| `NaN` e `Infinity` | No existen: el constructor lanza | Existen | Existen |
| Modos de redondeo | 4: hacia cero, mitad arriba, mitad par y alejándose de cero | 9 | 9 |
| Tipos de TypeScript | `@types/big.js` 7.0.0 (2026-05-21; MIT, sin dependencias ni scripts) | Incluidos (issue abierta #234 sobre los tipos ESM) | Incluidos |
| Cambios incompatibles recientes | 7.0.0 (2025), menores; el API es el de la 6.0 (2020) | Ninguno desde la 10.0 (2018) | 10.0.0 (2026-02-23) y 11.0.0 (2026-04-14) |
| Issues abiertas | 9; ninguna de seguridad ni de resultados incorrectos | 22; #97 y #266: funciones que cambian la configuración y la dejan mal si lanzan | No revisadas |
| Avisos de seguridad en GitHub | Ninguno | Ninguno | No revisados |

## Decisión

1. **Biblioteca: big.js**, con sus tipos `@types/big.js` como dependencia de desarrollo. Las versiones exactas
   se fijan en el paso 18 (hoy serían 7.0.1 y 7.0.0). Entran por la regla automática del ADR 0011: en el
   paso 18 se vuelven a comprobar las cinco condiciones, se instalan con
   `npm install --save-exact --ignore-scripts` y se registran en [docs/DEPENDENCIES.md](../DEPENDENCIES.md).
2. **Tipo propio `Decimal`** en `src/shared/decimal.ts`, el único archivo de `src/` que importa big.js. El
   capguard tiene el suyo, `capguard/decimal.ts`, con el mismo contrato y sin código compartido (ADR 0003).
3. **Contrato.** El objeto es inmutable, y ningún método acepta ni devuelve `number` salvo los dos marcados:

   ```ts
   // src/shared/decimal.ts (paso 18)
   export type Rounding = 'DOWN' | 'UP' | 'HALF_EVEN'; // DOWN: hacia cero; UP: alejándose de cero

   export declare class Decimal {
     static parse(text: string): Decimal; // solo notación decimal normal; si no, lanza
     static parseScientific(text: string): Decimal; // «2.333e-07», exacta; solo para adaptadores (paso 19B, ADR 0022)
     static fromAnalysis(value: number, scale: number, rounding: Rounding): Decimal; // único paso de float a Decimal
     static min(...values: readonly Decimal[]): Decimal;
     static max(...values: readonly Decimal[]): Decimal;
     plus(other: Decimal): Decimal; // exacta
     minus(other: Decimal): Decimal; // exacta
     times(other: Decimal): Decimal; // exacta
     div(other: Decimal, scale: number, rounding: Rounding): Decimal; // escala y redondeo obligatorios
     roundToScale(scale: number, rounding: Rounding): Decimal;
     roundToStep(step: Decimal, rounding: Rounding): Decimal; // múltiplo de step > 0; solo valores ≥ 0
     abs(): Decimal;
     negated(): Decimal;
     cmp(other: Decimal): -1 | 0 | 1;
     eq(other: Decimal): boolean;
     lt(other: Decimal): boolean;
     lte(other: Decimal): boolean;
     gt(other: Decimal): boolean;
     gte(other: Decimal): boolean;
     isZero(): boolean;
     isNegative(): boolean;
     isPositive(): boolean;
     toString(): string; // canónica: notación normal, sin ceros finales y sin «-0»
     toJSON(): string; // igual que toString
     toAnalysis(): number; // única salida a float, solo para análisis
     valueOf(): never; // lanza: impide cualquier coerción implícita a number
   }
   ```

4. **Configuración aislada.** El envoltorio crea su propio constructor llamando a `Big()` sin `new`, con
   `strict = true`, y nunca toca la configuración global de big.js. `DP` y `RM` solo se fijan dentro de `div`,
   y se restauran en un `finally` aunque la división lance (por ejemplo, entre cero).
5. **Entradas.** `parse` solo acepta notación decimal normal (`-?dígitos` con parte decimal opcional): ni
   exponente, ni signo `+`, ni espacios, ni separadores, ni `NaN` o `Infinity`. Si una fuente da otra notación,
   su adaptador la convierte con una función explícita y probada. Qué devuelve ccxt en modo cadena se
   comprueba en el paso 18 (marca [verificar] de exchange-execution §17).
6. **Salidas.** `toString()` da la forma canónica, con `toFixed()` de big.js y nunca en notación exponencial.
   Esa forma va a SQLite, JSON, logs y, ya redondeada al paso del mercado, al exchange.
7. **Del análisis al dinero.** `fromAnalysis` es el único paso de float a `Decimal`: rechaza valores no finitos
   y redondea en el sentido que se le indica. `toAnalysis` es la única salida a float, solo para indicadores y
   estadísticas (exchange-execution §17).
8. **Sin unidades marcadas.** `Price`, `Quantity` y `Notional` son alias de `Decimal` que solo documentan
   (ARCHITECTURE.md §16).
9. **Enforcement, en el paso 18** y con la dependencia instalada:
   - regla de dependency-cruiser «solo `src/shared/decimal.ts` y `capguard/decimal.ts` importan big.js», con su
     prueba;
   - la regla de ESLint «nunca float» en los módulos de dinero, ya comprometida;
   - pruebas del envoltorio: exactitud de suma, resta y producto contra una referencia sobre `bigint` escrita en
     las pruebas, los tres modos de redondeo, pasos no decimales (0,25 y 0,5), cadenas inválidas, `valueOf`,
     la forma canónica y la restauración de `DP` y `RM` tras un error.

## Alternativas descartadas

- **decimal.js**, el ejemplo del ADR 0005. Redondea la suma, la resta y el producto a `precision` cifras
  significativas. Con una precisión alta el error es improbable, pero no imposible, y no se detecta mirando el
  resultado: el redondeo puede dejar ceros finales. Habría que escribir una comprobación propia de exactitud
  justo en el código más delicado. Además admite `number`, `NaN` e `Infinity`, y tiene issues abiertas sobre
  funciones que dejan mal la configuración si lanzan (#97 y #266). Lo que se pierde (tipos incluidos,
  `toNearest` y nueve modos de redondeo) lo cubre el envoltorio.
- **bignumber.js.** Es exacto en suma, resta y producto e incluye sus tipos. Pero publicó dos versiones mayores
  con cambios incompatibles en 2026 y admite `number`.
- **Tipo propio sobre `bigint`.** Descartado en el ADR 0005: la división y los modos de redondeo son fáciles de
  equivocar.
- **Punto fijo con precisión por instrumento**, como NautilusTrader ([REFERENCE_SYSTEMS.md](../REFERENCE_SYSTEMS.md)
  §7). Obliga a llevar la escala de cada instrumento en cada operación y a migrar datos si el exchange la
  cambia. No da más seguridad que un decimal exacto con redondeo explícito en las fronteras. Se adopta solo la
  idea de redondear al paso del mercado en el borde.
- **Unidades marcadas (`Price`, `Quantity`, `Notional`).** Detectarían en compilación que se mezcla un precio
  con una cantidad, pero obligan a convertir después de cada operación. Esas mezclas ya las paran `max_quantity`
  y `max_notional` del token, `APPROVAL_MISMATCH` y los topes del capguard. Se reconsidera si una revisión
  encuentra un error de unidades.
- **Usar la biblioteca directamente en todo el código.** Ya lo descartó el ADR 0005.

## Consecuencias

- En el paso 18 entran una dependencia de runtime (big.js) y una de desarrollo (`@types/big.js`). Si alguna no
  cumple entonces las condiciones automáticas, se busca alternativa y se cambia este ADR. La siguiente sería
  decimal.js con una comprobación de exactitud previa a cada operación.
- Solo hay cuatro modos de redondeo. Si hiciera falta otro, se construye en el envoltorio sobre esos cuatro o se
  cambia de biblioteca sin tocar el resto del código.
- `div` cambia `DP` y `RM` del constructor privado durante la llamada. Es seguro porque el proceso principal
  ejecuta un solo handler a la vez (ARCHITECTURE.md §9).
- big.js no publica desde abril de 2025 y tiene un solo mantenedor. El riesgo se acepta porque el envoltorio
  permite cambiar de biblioteca tocando un archivo.
- exchange-execution §17 y el ADR 0005 siguen citando decimal.js como ejemplo, y manda este ADR. El test del
  skill exige el texto «decimal.js»: si se cambia el ejemplo del skill, hay que cambiar también el test.
- `@types/big.js` funciona con `module: NodeNext` y `verbatimModuleSyntax` al importar el ESM de big.js:
  comprobado en el paso 18 (el typecheck pasa y Node carga `big.mjs`).
- **Paso 18:** versiones exactas 7.0.1 y 7.0.0, aprobadas por la persona. La regla «nunca float» se aplica a
  `exchange/`, `execution/`, `risk/`, `portfolio/`, `historical/`, `backtest/` y `capguard/`
  (`scripts/eslint-no-float.ts`), con excepciones solo para `capguard/decimal.ts` y `src/backtest/sim.ts` (hasta
  el paso 23). Prohíbe `parseFloat`, `parseInt`, `Number()`, `Math.*`, el `+` unario y toda aritmética con
  `number`; el tiempo y los índices van por utilidades de `src/shared/`.

## Fuentes

Consultadas el 2026-10-06: registro de npm (`big.js`, `@types/big.js`, `decimal.js` y `bignumber.js`), API de
GitHub (repositorios, issues abiertas y base de avisos de seguridad), documentación de big.js
(https://mikemcl.github.io/big.js/ y su `README.md`) y los `CHANGELOG.md` de los tres repositorios.
