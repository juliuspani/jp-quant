# ADR 0008 — Sistemas de referencia como consultores, sin código

Fecha: 2026-10-02 · Estado: aceptado · Paso: 10 (decisión), aprobada el 2026-10-02 con NautilusTrader como
quinto sistema (paso 10B)

## Contexto

Antes de rediseñar el ExchangeAdapter, el ciclo de órdenes, el Risk Engine y el backtest conviene estudiar
cómo lo resuelven proyectos open-source maduros. Esos proyectos tienen licencias distintas: CCXT es MIT,
Hummingbot y Quants Lab son Apache-2.0, Freqtrade es GPL-3.0 y NautilusTrader es LGPL-3.0. Copiar o traducir
código de un proyecto GPL convertiría el nuestro en obra derivada. Además, cada uno resuelve problemas
distintos de los nuestros (creación de mercado, futuros, optimización masiva), y copiar su diseño sin filtro
importaría decisiones que contradicen nuestros skills. El detalle está en
[docs/REFERENCE_SYSTEMS.md](../REFERENCE_SYSTEMS.md).

## Decisión

1. **Metodología REFERENCE REPOSITORIES:** los sistemas de referencia son consultores arquitectónicos. No
   forman parte del producto, no se instalan, no se ejecutan y no entran en el repositorio (ni dependencia,
   ni submódulo, ni copia). CCXT es dependencia por el ADR 0007; como referencia sigue estas mismas reglas.
2. **No se copia ni se traduce código** de ningún sistema de referencia, sea cual sea su licencia. Se adoptan
   conceptos y se implementan desde nuestra especificación.
3. **Copyleft (GPL, AGPL, LGPL):** se prefiere la documentación al código fuente, y lo que se implemente a
   partir de una idea suya se escribe sin el código ajeno delante.
4. **Lista cerrada:** CCXT, Hummingbot, Hummingbot Quants Lab, Freqtrade y NautilusTrader (LGPL-3.0, solo
   consulta; añadido en el paso 10B). Añadir o quitar uno exige aprobación.
5. **Ficha fija por sistema:** qué resuelve bien, patrón arquitectónico, qué adoptar, qué no copiar, licencia
   y dependencias, y diferencias con nuestra arquitectura, con la versión consultada y sus fuentes.
6. **El documento no decide:** adoptar un concepto se decide en el skill o el ADR del módulo que lo usa, que
   cita la ficha. La ficha se revisa al empezar ese paso.

## Alternativas descartadas

- **Usar Freqtrade o Hummingbot como base del producto.** Ya se valoró en `docs/research/05` §6: Python,
  otra arquitectura y, en Freqtrade, GPL. El proyecto es TypeScript y propio.
- **Permitir copiar código de los proyectos MIT o Apache-2.0 con su aviso de licencia.** Legal, pero traería
  sus supuestos (por ejemplo, órdenes «perdidas» que se dan por fallidas) sin pasar por nuestras reglas.
  Si algún día hace falta, se decide con un ADR propio.
- **Clonar los repositorios dentro del proyecto para consultarlos.** Mezcla código ajeno con el nuestro y
  lo expone al escaneo, al lint y a un `git add` accidental.
- **No documentar las referencias.** Cada sesión volvería a estudiarlas y las ideas adoptadas no tendrían
  origen trazable.

## Consecuencias

- `docs/REFERENCE_SYSTEMS.md` recoge la metodología, las cinco fichas y los candidatos a adoptar (§9),
  ninguno aprobado.
- `test/docs/reference-systems.test.ts` comprueba la estructura de las fichas, que ninguna permita copiar
  código y que ningún sistema de referencia esté dentro del repositorio. No puede comprobar que no se haya
  copiado código: eso depende de la revisión.
- Las fichas envejecen: Hummingbot y Freqtrade publican cada mes.
- Cada concepto que se adopte cuesta una decisión en su módulo, pero queda trazado hasta su origen.
