# ADR 0046 — Rediseño del dashboard local

Fecha: 2026-10-23 · Estado: **aceptado**, decisión de Claude en modo autónomo (paso 41C), pendiente de la aprobación del
paso. La decisión 1 («sin JavaScript») la sustituye el ADR 0047 (consola con animaciones y un script fijo por su hash);
la paleta de la decisión 8, también (negros y grises).

## Contexto

- **La petición.** Paso 41C: rediseñar el dashboard del paso 41B (ADR 0045) con los mismos datos y el mismo contrato
  del diario, sin tocar criterios, invariantes ni lógica de trading. Se pide un tema oscuro sobrio con identidad propia,
  que alguien sin conocimientos de trading entienda en 10 segundos cómo va: un resumen arriba con una frase, cuatro
  cifras y un estado con texto; secciones explicadas; términos técnicos en lenguaje claro; fechas en hora de Madrid; el
  significado nunca solo en el color; una curva en base 100 frente a comprar y mantener BTC y la caída desde el máximo;
  y el modo en una franja fija, un borde fino y el título de la pestaña. Si los datos son sintéticos, una marca de agua.
- **Lo que no cambia:** la página sigue autocontenida, con todo texto escapado y una CSP que bloquea cualquier carga
  externa (ADR 0045, decisión 4). No hay dependencias nuevas.

## Decisión

1. **Sin JavaScript.** Las ayudas al pasar el ratón son atributos `title` y elementos `<title>` del SVG (una franja
   invisible por punto de la curva). Así la CSP sigue sin `script-src`, y la página se ve igual con o sin JavaScript.
2. **Dos lienzos por gráfico.** Cada gráfico se genera dos veces, uno estrecho (360 de ancho) y otro ancho (1000), y
   una media consulta CSS muestra uno u otro. Un único SVG escalado deja ilegibles los rótulos en el móvil o los hace
   enormes en el escritorio. La página pesa más, pero sigue siendo un archivo local.
3. **Lo que requiere atención lo decide el estado, no la página.** `monitoring/dashboard.ts` añade `attention`: una
   lista en lenguaje claro, derivada de lo que la página ya mostraba (parada, kill switch, modo de Execution,
   reconciliación, feeds retrasados o con huecos y posiciones sin stop). CRITICAL si el sistema no opera como debe y
   WARNING si hay que mirarlo. Sin elementos, «Todo en orden».
4. **Marca de datos sintéticos obligatoria en la ficha.** La ficha lleva `"datos": "sinteticos"` o `"reales"`, sin
   valor por defecto: si falta, no hay página. Así la marca de agua no aparece ni falta por un olvido.
5. **Traducciones en `Map`.** Lados, tipos, estados de orden, capas y decisiones se traducen con `Map`, nunca con
   objetos literales: un código como `constructor` se muestra tal cual, sin heredar de `Object.prototype` (la lección de
   SEC-01). El código original queda en el `title`.
6. **Hora de Madrid con `Intl.DateTimeFormat`** (zona `Europe/Madrid`, ICU de Node) y meses escritos por el propio
   código, para no depender del idioma que traiga ICU. La UTC va en el `title` de cada fecha.
7. **Cifras en float solo donde ya lo eran.** La frase del resumen, la diferencia frente a BTC y las curvas usan la
   curva y el benchmark en float, que solo se pintan (ADR 0045). Los importes de las tarjetas siguen saliendo de los
   `Decimal` del estado.
8. **Paleta en variables CSS**, la del prompt sin cambios: un único acento (`#5EEAD4`) y los colores de ganancia,
   pérdida y aviso solo para datos. Cada modo tiene su propio color (REPLAY violeta, PAPER azul, SHADOW naranja, LIVE
   rojo), que se ve en la franja y el borde. El texto de la franja va en oscuro sobre el color del modo: contraste AA.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Un poco de JavaScript para los tooltips | Obliga a abrir `script-src` en la CSP. `title` basta para ver un valor |
| Un SVG escalado con `preserveAspectRatio` | Los rótulos no se leen en el móvil, o son enormes en el escritorio |
| Calcular «requiere atención» en la página | Mezcla reglas con presentación y no se prueba sin HTML |
| Deducir que los datos son sintéticos de la etiqueta | Un texto libre no puede decidir una marca de seguridad |
| Fuentes web o una librería de gráficos | Rompen la CSP o añaden dependencias. Pila del sistema y SVG propio |

## Consecuencias

- La página pesa unos 56 KB con el diario de demostración, con los dos lienzos y las franjas de ayuda. Con diarios
  largos sigue pendiente SEC-05 (ADR 0045): reducir puntos antes de pintar.
- Los títulos de sección cambian, y las pruebas de la página se reescriben con ellos. Las de escape, SEC-01, SEC-02 y
  ausencia de recursos externos se mantienen y se amplían.
- Una ficha antigua sin `datos` deja de valer: hay que añadirlo.
