# Checklist de experimento cuantitativo

Copiar en el informe de cada experimento. Cada casilla sin marcar se justifica en el informe. Una casilla
obligatoria sin marcar lleva a `NO CONCLUYENTE` o `RECHAZADA` (SKILL.md §9 y §11).

## Antes de tocar datos reales

- [ ] Hipótesis en una frase y mecanismo económico que la justificaría
- [ ] Una sola métrica primaria, definida
- [ ] Criterios de aceptación escritos (como mínimo, los de SKILL.md §9)
- [ ] Familia identificada y `n_familia` calculado a partir del registro
- [ ] Espacio de parámetros completo y rejilla escritos
- [ ] Línea de pre-registro (`estado: "registrado"`) añadida al registry
- [ ] Código en un commit limpio y hash anotado

## Datos

- [ ] Decisión con la vela cerrada y ejecución en la apertura siguiente
- [ ] Última vela abierta descartada
- [ ] Calentamiento de indicadores ≥ 3–5× su periodo, igual que en real
- [ ] Universo point-in-time, con filtros calculados solo con datos pasados
- [ ] Listings: ningún activo antes de su primera vela
- [ ] Delistings incluidos, con la regla de cierre aplicada
- [ ] Fuente de datos con activos deslistados nombrada (no `fetchMarkets()` de hoy)
- [ ] Ninguna normalización ni selección ajustada fuera de `train`
- [ ] Huecos detectados y excluidos, no rellenados
- [ ] Anualización con 365 días
- [ ] Fuente, rango, timeframe y hash de los datos registrados

## Particiones

- [ ] Cortes estrictamente temporales: `train` → `validation` → `test`
- [ ] Walk-forward con ≥ 3 tramos. El resultado es la concatenación de los tramos fuera de muestra
- [ ] Purging de `h` velas al final de cada `train`
- [ ] Embargo `e ≥ h` tras cada tramo de evaluación
- [ ] Test final sin cargar, ni directa ni indirectamente
- [ ] Ningún periodo ya examinado usado como test final

## Costes

- [ ] Comisión taker real, como mínimo 0,10 % por lado
- [ ] Medio spread por lado
- [ ] Slippage, como mínimo 0,05 % por lado y estimado según la liquidez
- [ ] Repetido con costes ×2 y ×3
- [ ] Resultados bruto y neto informados
- [ ] Supuesto pesimista cuando dentro de una vela no se sabe qué ocurrió antes

## Controles

- [ ] Benchmark de buy-and-hold de BTC, con costes
- [ ] Benchmark de buy-and-hold equiponderado del universo point-in-time, si hay varios activos
- [ ] Control aleatorio con ≥ 1000 simulaciones (mismas operaciones, duración, tamaño y costes), semilla
      registrada
- [ ] Percentil de la estrategia en el control aleatorio
- [ ] Prueba de humo: resultado nulo con la señal desplazada y con un paseo aleatorio

## Robustez

- [ ] Desglose por año, por tramo, por activo y por régimen
- [ ] Repetido sin el mejor año y sin el mejor activo
- [ ] Sensibilidad: ±25 % y ±50 % en cada parámetro; ¿meseta o pico?
- [ ] Ablación de cada componente; los que no aportan, eliminados
- [ ] Universo alternativo no usado en el diseño

## Estadística

- [ ] `N` total de la familia según el registry, incluidas las pruebas fallidas y abortadas
- [ ] Deflated Sharpe Ratio calculado con ese `N`
- [ ] PBO (CSCV) si se compararon varias configuraciones
- [ ] IC al 95 % con bootstrap estacionario por bloques (≥ 10 000 remuestreos, longitud de bloque
      justificada)
- [ ] Muestra mínima: ≥ 100 operaciones fuera de muestra, `MinTRL` cumplido y al menos un mercado bajista
      completo
- [ ] Parámetros libres contados. Ante evidencia comparable, gana la variante más simple

## Features de LLM (si las hay)

- [ ] Generadas en tiempo real con registro solo de inserción, o con un modelo de corte anterior al
      periodo evaluado y sin información posterior
- [ ] Modelo, corte de conocimiento y versión del prompt registrados
- [ ] Hipótesis propuestas por un LLM señaladas como contaminadas para el periodo que conoce

## Cierre

- [ ] Línea de cierre en el registry (`completado`, `fallido`, `abortado` o `invalidado`), aunque el resultado
      sea malo
- [ ] Informe en `docs/research/experiments/EXP-NNNN.md` con la plantilla
- [ ] Veredicto de SKILL.md §11, sin las palabras "rentable", "validada", "ganadora" ni "funciona"
- [ ] El resumen lleva el veredicto, `N`, el DSR y el PBO, no solo el P&L
