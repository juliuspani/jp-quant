# ADR 0047 — Consola de investigación del dashboard y sello del proyecto

Fecha: 2026-10-27 · Estado: **aceptado**, decisión de Claude en modo autónomo (paso 41C), pendiente de la aprobación del
paso. Sustituye la decisión 1 del ADR 0046 («sin JavaScript») y la parte de la decisión 4 del ADR 0045 que excluía el
JavaScript; el resto de los dos sigue vigente.

## Contexto

- **La petición** (paso 41C, tres ajustes de la persona sobre el rediseño del ADR 0046):
  - estilo de terminal financiero en negros y grises (la persona eligió la variante A, gris neutro);
  - un sello del proyecto generado del primer commit (`902eb0a`), en la cabecera, como favicon y en el pie, con un
    comando para exportarlo a `.svg` (la persona eligió el anillo de marcas radiales);
  - el dashboard como consola de investigación: barra superior fija con un ticker, menú de cuatro vistas (Resumen,
    Investigación, Replay y Criterios) y tres visualizaciones animadas con datos reales del proyecto (núcleo del
    registro, «¿suerte o ventaja?» y embudo de criterios). Sin JavaScript, la página tiene que verse completa.
- **Los límites:** CSP sin recursos externos; todo texto escapado; INV-14a (el dashboard no lanza backtests); solo se lee
  lo guardado; la demo pública usa un registro y curvas sintéticos, y los resultados reales solo se ven en local.

## Decisión

1. **Un solo script, fijo y admitido por su hash.** `src/monitoring/page-script.ts` es un texto constante, sin datos
   interpolados: lee los datos de atributos del SVG y escribe con `textContent`. La CSP pasa a `script-src 'sha256-…'`
   (ningún otro script, ni `unsafe-inline` ni `unsafe-eval`). Solo anima: no pide nada a la red, no guarda nada y no
   escribe HTML; una prueba lo comprueba sobre su texto.
2. **Sin JavaScript se ve todo.** Las vistas cambian con `:target` y enlaces internos (`#resumen`…), y cada visualización
   se genera en el servidor como SVG completo, en su posición inicial. El script añade `.anim` solo si el movimiento
   está permitido; toda animación de la hoja de estilos cuelga de `.anim`, se pausa con la pestaña oculta (`.paused`) y
   se apaga con `prefers-reduced-motion` aunque no haya script.
3. **Rendimiento.** La esfera gira con `requestAnimationFrame` solo mientras está en pantalla y la pestaña visible, y
   actualiza unos cientos de atributos por fotograma (36 puntos y 11 líneas de malla en la demo). El resto son
   animaciones CSS de `transform`, `opacity` y `stroke-dashoffset`.
4. **Los datos de investigación los lee `app/`.** `src/app/research-view.ts` lee el registro con `research/registry.ts`
   (esquema y cadena de hashes, fail closed) y lo entrega como datos planos a `src/monitoring/research.ts`, porque
   `monitoring/` no puede importar `research/`. Un punto por experimento; la N global es la suma de `n_pruebas` de todo
   el registro (como `trialsByFamily`); el embudo cuenta, en el orden de A.3, los que superan ese criterio y todos los
   anteriores; un NO CONCLUYENTE no supera el criterio.
5. **Desenlaces:** `CANDIDATA A …` es aceptado; `RECHAZADA`, rechazado; `NO CONCLUYENTE` o sin veredicto (los que solo
   eligen en train), no concluyente; `fallido`, `abortado` o `invalidado`, «abortado o invalidado»; y sin cierre, en curso.
6. **Curvas del control aleatorio en un archivo aparte** (`inversor-controles/1`, `--controles`, uno o varios): el
   registro solo guarda el percentil, así que los experimentos ya registrados no las tienen, y la página lo dice.
   **Aprobado por la persona (2026-10-27) y hecho, solo para experimentos nuevos:** `src/app/control-curves.ts` rehace las
   colocaciones de A.3.12 con la misma semilla y el mismo flujo (`RANDOM_CONTROL_STREAM`) y las convierte, con el
   simulador, en curvas en base 100: la estrategia, los percentiles 5 y 95 (con todas las colocaciones) y las 48 primeras,
   reducidas a 400 puntos. Si el simulador no es válido para ese run, A.3.12 usa el backtester y no se guardan curvas
   (queda el motivo). El ejecutor pone su SHA-256 en `salida.archivos`, cubierto por el `hash_salida`, y el comando de
   backtest escribe `EXP-NNNN.controles.json` junto a la salida, sin sobrescribir. El percentil es el de la curva que se
   pinta (la réplica del simulador), no el Sharpe del backtester que decide A.3.12; los dos se separan como mucho un 10 %.
   **Diarios de cada tramo** (propuesta 2, aprobada si no rompe INV-14a): el ejecutor entrega el diario de cada tramo con
   su huella en la salida, y `npm run backtest -- --diarios <carpeta>` los escribe con su ficha del dashboard, solo en una
   carpeta que git ignora (llevan datos reales). Solo `research-runner.ts` sigue llamando a `runBacktest`, y el dashboard
   no lanza nada. Los de EXP-0027 no se guardaron: tenerlos exige un experimento nuevo que cuenta en la N, que la persona
   tiene que aprobar antes.
7. **Demo sintética con el mismo camino que la real.** `test/src/monitoring/demo-research.ts` escribe el registro de la
   demo con `register` y `close`, así que cumple el esquema y la cadena de hashes; las familias se llaman `demo-…` y no se
   ejecuta ningún backtest. Una prueba comprueba que los archivos de `test/fixtures/dashboard/` son los del generador.
8. **El sello** (`src/monitoring/seal.ts`): el monograma con trazos y arcos, y 64 marcas cuya longitud sigue un puente
   browniano y cuyo grosor sale de otra mitad del SHA-512 del hash completo. Determinista, fijado por huellas en su
   prueba, sin datos personales (solo «JP» y el hash corto). A 16 px se dibuja con 32 marcas gruesas. El favicon es un
   data URI en base64, así que la CSP admite `img-src data:` y nada más. `npm run sello` exporta sin sobrescribir.
9. **Paleta y anillo, elegidos por la persona (2026-10-27):** paleta A (gris neutro) y anillo de marcas radiales. La
   variante B, el anillo de puntos y las opciones `--paleta` y `--anillo` se borraron.
11. **Nombre: JP Quant** (la persona, 2026-10-27). Cambia el nombre visible (cabecera, título de la página, pie y
    etiqueta del sello) y el de `CLAUDE.md` y `ARCHITECTURE.md`. El repositorio, las carpetas, los paquetes y las rutas
    siguen como «Inversor JP» hasta el paso 49. No hay README todavía: se crea en el paso 49. El sello sigue siendo «JP».
12. **Colores de datos** (los validó la persona para el fondo `#111111`, con contraste ≥ 3:1 y pensando en el
    daltonismo): aceptado `#3A8FDB` (azul), rechazado `#D65A2E` (naranja), no concluyente `#C65FB0` (magenta) y abortado
    como punto hueco con contorno `#8A8A8A`; estrategia `#2E9BC4` (cian, sólida de 2 px), comprar y mantener `#C2822A`
    (ámbar, discontinua de 1,5 px); la caída desde el máximo es de la estrategia y va en su cian al 20 %; el abanico, en
    grises con la banda al 10 %. Las cifras de ganancia y pérdida llevan signo y flecha, y si llevan color, azul y naranja
    (nunca verde y rojo). Los textos y las etiquetas, en los colores de texto. El champán queda solo para la marca: el
    sello y la vista activa del menú. LIVE conserva su rosa apagado (`#C78F8F`), que ya no se usa para datos.
10. **Contraste.** Todo el texto esencial cumple AA. El terciario (`#6B6B6B`, 3,5:1 sobre la superficie) se usa solo en lo
    no esencial: rótulos de los ejes (los valores van en los rótulos finales y en las ayudas), el ticker (repite lo que
    hay en las tablas) y los términos técnicos que acompañan a su nombre en lenguaje claro.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Canvas para la esfera | Sin script no se vería nada; el SVG se pinta completo en el servidor y el script solo lo mueve |
| Una librería de gráficos o de 3D | Rompe la CSP o añade dependencias; la proyección ortográfica son seis líneas |
| Script con los datos en JSON incrustado | Un dato mal escapado se convierte en código; los atributos escapados no |
| Relanzar el control aleatorio desde el dashboard | Rompe INV-14a y cuenta en la N global |
| Leer el registro desde `monitoring/` | `monitoring/` solo puede importar `shared/`, `kernel/` y `analytics/` |

## Consecuencias

- La página pesa unos 640 KB con la demo (las curvas del abanico van dos veces, móvil y escritorio). SEC-05 sigue
  pendiente para diarios y registros largos.
- El aspecto lo revisan las capturas del paso; las pruebas comprueban los datos, la CSP, el escape y las reglas de
  movimiento.
- Con el registro real, la página solo se genera en local (CLAUDE.md §1); el diario de demostración, el registro y las
  curvas sintéticas son lo único publicable.

## Pulido final (la persona, 2026-10-27)

Sin cambiar datos, criterios ni lógica:

- **Móvil:** las tablas pasan a tarjetas apiladas con CSS (cada celda lleva el nombre de su columna en `data-label` y las
  columnas clave van arriba); la barra superior va en dos líneas y esconde el commit y la fecha del diario. Ninguna tabla
  queda con desplazamiento horizontal a 390 px, así que no hace falta el degradado que lo indicaría.
- **«¿Suerte o ventaja?»:** un único gráfico con pestañas (radios y `:has`, sin JavaScript), el experimento más reciente
  con curvas primero y marcado; sin `:has`, se ve el primero. Como mucho 12 pestañas.
- **Experimentos:** sin JavaScript se ven todos; el script recorta a los 10 más recientes y muestra «Ver todos».
- **Embudo:** barras en `#4A4A4A`, con lo que se pierde en cada criterio en naranja tenue al final, y los criterios
  seguidos que no cambian el recuento en una sola fila. **Por qué fallan:** barras de 8 px, naranja y magenta al 70 %, con
  2 px entre las dos partes.
- **Detalles:** sin el título duplicado en Resumen; espacio no separable entre cada cifra y su unidad; «en curso» en
  `#BDBDBD`; la marca de agua al 1,5 % y por debajo de las tarjetas opacas (no pasa por encima de la esfera ni de los
  gráficos); Plan B sin reparto objetivo, en una línea.
- **Solo en la demo:** dos líneas para quien llega de fuera, con un enlace provisional a la metodología: la vista
  Criterios de la propia página, hasta que el paso 49 dé un enlace definitivo.
- **Colores, en comparación (la persona elige):** variante 1, la actual corregida (colores de datos sólidos; «Por qué
  fallan» en barras de 5 px; lo que cae en el embudo, en naranja sólido de 3 px), y variante 2, «monocromo con un acento»
  (clase `pal-mono`: el cian para la estrategia, lo aceptado y lo que supera todo; veredictos por tono y forma; barras
  `#6B6B6B` de 5 px y lo que cae en `#BDBDBD` de 3 px). En las dos, las cifras de ganancia y pérdida van en color de texto
  con su flecha. El campo `variant` de la página solo existe para generar las capturas y se borra con la variante
  descartada. **Replay en el móvil:** operaciones y datos de mercado en líneas compactas (las 5 últimas y «Ver todas» con
  `details`); posiciones y órdenes abiertas, tarjetas solo con los campos clave.

## Elección de color (la persona, 2026-10-27)

**Elegida la variante 2, «monocromo con un acento».** Sustituye los colores de datos de la decisión 12 y la comparación
anterior; la variante 1 y el campo `variant` de la página se borraron.

- **Qué es:** un solo color de datos, el cian `#2E9BC4`, para la estrategia, lo aceptado y la barra de los que superan
  todos los criterios; todo lo demás en grises neutros. BTC en `#9A9A9A` discontinuo. Veredictos por tono y forma:
  aceptado, punto cian; rechazado, punto `#8A8A8A`; no concluyente, anillo `#BDBDBD`; abortado, punto hueco `#5A5A5A`;
  en curso, `#D6D6D6` con un pulso lento (solo con movimiento permitido). Barras `#6B6B6B` de 5 px; lo que cae y lo no
  concluyente, trazo `#BDBDBD` de 3 px. Cifras de ganancia y pérdida en color de texto con su flecha.
- **Motivo** (de la persona): «Elegida por sobriedad y legibilidad: el color se reserva para lo que importa (la
  estrategia y lo que supera los criterios), los fallos se leen por longitud sin que la página parezca una alarma, y los
  veredictos se distinguen por forma además de por tono». El ocre de los avisos y el rosa de LIVE se quedan porque no son
  datos, sino estados de la interfaz.
- **Movimiento** (cierre del paso): el ticker avanza a unos 30 px por segundo, se pausa con el ratón encima, con el foco
  o al tocarlo, se detiene con la pestaña oculta y, con movimiento reducido, queda fijo con el último evento a la vista; la
  esfera da una vuelta cada unos 126 s. En «Por qué fallan», en escritorio la cifra va siempre a la derecha de la barra; en
  el móvil, si no cabe, debajo, dentro de la altura reservada de la fila.
- **Últimos ajustes:** se quita del todo la marca de agua «DATOS DE DEMOSTRACIÓN» (basta la etiqueta DEMO y el bloque
  de bienvenida, y asomaba cortada); en el móvil, la cifra de «Por qué fallan» va debajo de la barra si no cabe al lado,
  la ruta `docs/PROMOTION_CRITERIA.md` junto al título del embudo se oculta y la tabla de experimentos pasa a una línea
  compacta por experimento (id, familia y desenlace) con «Ver todos».
