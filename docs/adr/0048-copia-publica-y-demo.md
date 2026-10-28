# ADR 0048: copia pública del proyecto y demo ejecutable (paso 49)

Estado: propuesto (paso 49; pendiente de la aprobación de la persona antes de publicar)

## Contexto

El paso 31 no aprobó ninguna estrategia y el proyecto siguió por el plan B. El paso 49 prepara una versión pública como
escaparate: una copia limpia, sin el historial ni los datos del repositorio privado, con una demo que cualquiera pueda
ejecutar sin claves, sin red y sin dinero. El repositorio privado no se toca ni se publica. Crear el repositorio público y
hacer el primer push es una parada obligatoria (acción irreversible fuera del repositorio).

## Decisiones

1. **Copia limpia en una carpeta aparte, con historial nuevo.** Se exportan los archivos versionados de `HEAD` del
   repositorio privado (`git archive`), sin `.git`. El trabajo del paso se hace con commits de trabajo y, antes de
   publicar, se aplasta en un único commit inicial firmado con el email privado de GitHub (`…@users.noreply.github.com`).
2. **Nombre `jp-quant`** (lo decide Claude, por delegación de la persona). El paquete pasa a `jp-quant` 1.0.0. Los
   identificadores de formato (`inversor-replay/1`, `inversor-controles/1`, `inversor-datasets/1`, el propósito del
   desbloqueo) conservan el nombre anterior: forman parte de huellas y registros ya guardados y cambiarlos los rompería.
3. **Fuera de la copia:** `PROGRESS.md` y `docs/progress/` (registro de trabajo privado), `.claude/commands/` (el flujo de
   sesión de la persona, que enlaza con sus notas personales) y la primera línea de `CLAUDE.md`, que importaba esas notas.
   Las referencias que quedan a esos archivos se declaran como registro privado no publicado. Las pruebas que los leían
   se adaptan:
   - el último paso cerrado se lee de `CHANGELOG.md`;
   - la huella de los criterios congelados se comprueba solo en el ADR 0030;
   - la tabla de renumeración no se comprueba;
   - el sello comprueba el hash del primer commit original y la identidad de autor del repositorio actual.
4. **Sin datos de mercado.** Los términos de Kraken (EEA, §11) no permiten redistribuir sus datos, así que no hay muestra
   real: la demo usa precios sintéticos con semilla. Quien quiera repetir la investigación los descarga con
   `scripts/download-kraken.ts` y `scripts/capture-kraken.ts`. Se publican las salidas de los experimentos (métricas y
   series de rendimiento de las estrategias, derivadas de los datos); el CONSULTOR SECURITY revisa si eso es aceptable.
5. **Demo fuera de `src/`.** `demo/` contiene el replay sintético (antes en `test/`), la investigación sintética y el
   comando `npm run demo`. Va fuera de `src/` porque INV-14a solo permite al ejecutor de experimentos lanzar backtests
   en `src/`: la demo no es un resultado de investigación. Los datos de la demo pasan a `demo/fixtures/`. La demo pública
   usa un tope de exposición del 10 % (`PUBLIC_DEMO_LIMITS`) para que se vea actuar a Risk; las pruebas siguen con el
   escenario y las cifras del paso 41B.
6. **Servidor de la demo solo en `127.0.0.1`.** Da la página en `GET /` con la CSP también en la cabecera; nada más (ni
   archivos del disco, ni formularios, ni API). `--static <carpeta>` escribe la versión de GitHub Pages.
7. **Tarjeta «Replay en marcha».** El dashboard añade a la vista Resumen una reproducción de la curva con las operaciones
   y las órdenes frenadas por Risk. El script fijo de la página (ADR 0046) la anima leyendo atributos y escribiendo con
   `textContent` y `setAttribute`; la CSP no cambia de forma (solo su hash). Sin script o con movimiento reducido se ve el
   estado final.
8. **GIF y vista previa solo de la demo sintética.** `scripts/record-demo.ts` los graba con un navegador sin ventana por
   el DevTools Protocol y ffmpeg, y falla si el GIF pasa de 5 MB. Es una herramienta manual, fuera de `check:all`.
9. **CI y GitHub Pages.** `check:all` y el escaneo de secretos en cada push y pull request; la demo estática en Pages.
   Acciones fijadas por SHA, versiones publicadas hace más de 7 días, permisos mínimos y `npm ci --ignore-scripts`.
10. **Bot de plan B (DCA y rebalanceo) en paper, como ejemplo del sistema de ejecución** (`demo/dca/`, `npm run demo:dca`).
    El contrato de estrategia solo admite entrar una vez y salir del todo, así que un DCA no cabe en él. Cambiarlo tocaría
    `strategy/`, `risk/` y los invariantes, así que el bot va aparte. Compone lo mismo que `app/trading-system.ts`
    (normalizador, cartera, Risk y Execution) y sigue un plan en lugar de una estrategia:
    - compras periódicas de importe fijo, con sizing «quantity» y un stop declarado;
    - una revisión del reparto cada cuatro semanas, con banda;
    - un stop de protección de toda la posición, que se sustituye con un `stop_update` o una venta aprobados por Risk antes
      de cancelar el que espera. Execution no cancela un stop de protección sin esa aprobación.

    Va en paper sobre los precios sintéticos de la demo, con los límites por defecto: Risk reduce las compras que pasan de
    su riesgo por operación. El reparto (24 % BTC, 16 % ETH, 60 % EUR) es un ejemplo, no una recomendación. No hay forma
    de conectarlo a un exchange real.

## Alternativas

- **Publicar el repositorio privado con el historial reescrito:** descartada; el historial lleva el email privado, el
  registro de trabajo y referencias personales, y reescribirlo es más arriesgado que copiar.
- **Una muestra pequeña de velas reales:** descartada; la licencia no lo permite.
- **Renombrar también los formatos:** descartada (decisión 2).
- **Reproducir el replay en vivo con un servidor que emita eventos:** descartada; añade superficie de red a una página
  que hoy es estática y de solo lectura.

## Consecuencias

- El trabajo nuevo de este paso (demo, tarjeta de reproducción, CI) vive en la copia pública. Si el repositorio privado
  sigue, hay que traerlo de vuelta a mano.
- `npm run reproduce` no puede reproducir en la copia pública los experimentos del registro: sus commits son del
  historial privado. La reproducibilidad de EXP-0027 se comprobó en ese historial (EXP-0030).
- Nada de esto activa dinero real: el modo por defecto sigue siendo paper, `LIVE_TRADING=false` y el capguard no existe
  todavía, así que no hay camino al exchange real.

## Revisión del CONSULTOR SECURITY (paso 49)

Sobre la copia, de solo lectura: 0 Critical, 3 High, 2 Medium y 4 Low.

- **Corregidos:**
  - SEC-01: nombre del equipo, cuenta y rutas en `docs/research/05`.
  - SEC-04: zod `4.6.7` y `undici` `7.30.1` por `overrides`; `npm audit` sin avisos.
  - SEC-05: la demo no puede importar ccxt ni el bot previo (prueba).
  - SEC-06: en CI, los secretos se escanean antes de `check:all`.
  - SEC-07: una prueba falla con rutas del ordenador, nombres de equipo o correos que no sean de ejemplo o noreply.
- **Decididos por la persona (2026-10-28):**
  - **SEC-02, reducir.** Las salidas publicadas no llevan `tramos[].curva`, `tramos[].operaciones` ni `series_rejilla`, que
    dejaban despejar precios de Kraken. Quedan las métricas, los criterios, la selección y la serie de rendimientos en
    proporción. `test/docs/forward-check.test.ts` comprueba el hash de la salida reducida de EXP-0027 y conserva el de su
    cierre como dato del ADR 0043, que no cambia. Consecuencia: `npm run pbo-ronda` no funciona en la copia pública,
    porque necesita las series de la rejilla y el hash de cada cierre.
  - **SEC-03, endurecer.** En `.claude/settings.json`, `git push` pasa a preguntar, `npm ci` solo con `--ignore-scripts`,
    sin WebFetch ni WebSearch en la lista de permitidos y con `defaultMode` «default». CONTRIBUTING avisa de que el hook
    ejecuta código del repositorio.
  - **SEC-08, se deja.** El país de residencia en el ADR 0018 y la hora de Madrid en la página.
- **Riesgo documentado:** SEC-09, el puerto de depuración de `scripts/record-demo.ts` mientras graba (herramienta
  manual, perfil temporal, página sintética).
