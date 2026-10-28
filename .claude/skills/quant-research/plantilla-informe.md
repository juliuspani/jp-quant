# EXP-NNNN — <título corto>

<!-- Plantilla del skill quant-research. Copiar a docs/research/experiments/EXP-NNNN.md y rellenar.
     Ninguna sección se borra: si no aplica, se escribe "no aplica" y por qué. -->

| Campo | Valor |
|---|---|
| Veredicto | `RECHAZADA` / `NO CONCLUYENTE` / `CANDIDATA A TEST FINAL` / `CANDIDATA A PAPER` |
| Familia | |
| `N` de la familia (esta incluida) | |
| DSR | |
| PBO | |
| Métrica primaria fuera de muestra (IC 95 %) | |
| Fecha (UTC) | |
| Autor | |
| Commit | |
| Línea de pre-registro | fecha y `id` en `registry.jsonl` |

**Resumen en una frase.** <Veredicto, N, DSR y PBO. Nunca solo el P&L.>

## 1. Hipótesis

- **Hipótesis:**
- **Mecanismo económico:**
- **Métrica primaria:**
- **Criterios de aceptación** (copiados del pre-registro, sin cambios):

## 2. Datos

| Campo | Valor |
|---|---|
| Fuente (con activos deslistados) | |
| Universo y regla point-in-time | |
| Listings y delistings en el periodo | |
| Regla de cierre en un delisting | |
| Timeframe | |
| Rango total | |
| Calentamiento | |
| Huecos detectados y excluidos | |
| Hash de los datos | |

## 3. Particiones

| Tramo | `train` | `validation` | Purging (`h`) | Embargo (`e`) |
|---|---|---|---|---|
| 1 | | | | |

- **Test final:** no cargado. <Si se abrió: quién lo autorizó, cuándo y por qué es la única vez.>
- **Periodos ya examinados excluidos del test final:**

## 4. Costes

| Partida | Supuesto | Fuente |
|---|---|---|
| Comisión (por lado) | | |
| Spread (por lado) | | |
| Slippage (por lado) | | |

## 5. Parámetros

- **Espacio explorado y rejilla:**
- **Parámetros libres contados** (numéricos, discretos y filtros):
- **Valores elegidos y tramo donde se eligieron:**

## 6. Resultados fuera de muestra

Todas las cifras son netas de costes y salen de la concatenación de los tramos fuera de muestra.

| Métrica | Estrategia | IC 95 % | Buy-and-hold BTC | Buy-and-hold universo | Aleatorio (mediana) |
|---|---|---|---|---|---|
| Métrica primaria | | | | | |
| CAGR | | | | | |
| Drawdown máximo | | | | | |
| Sharpe anualizado (365) | | | | | |
| Operaciones cerradas | | — | — | — | |
| Exposición media | | — | | | |

- **Percentil en el control aleatorio:**
- **Prueba de humo** (señal desplazada y paseo aleatorio):
- **Bruto frente a neto:**
- **Dentro de muestra**, solo informativo y sin decidir nada:

## 7. Estadística

| Prueba | Valor | Umbral | ¿Pasa? |
|---|---|---|---|
| Operaciones fuera de muestra | | ≥ 100 | |
| Tramos walk-forward | | ≥ 3 | |
| `MinTRL` (95 %) frente a historia disponible | | historia ≥ `MinTRL` | |
| Mercado bajista completo incluido | | sí | |
| DSR (`N` = …) | | ≥ 0,95 | |
| PBO (CSCV, `S` = …) | | < 0,20 | |
| Límite inferior del IC 95 % de la métrica primaria | | > 0 | |

**Bootstrap:** método, longitud media de bloque y su justificación, número de remuestreos y semilla.

## 8. Robustez

| Prueba | Resultado | Umbral | ¿Pasa? |
|---|---|---|---|
| Costes ×2 | | métrica primaria > 0 | |
| Costes ×3 | | se informa | — |
| Sin el mejor año | | métrica primaria > 0 | |
| Sin el mejor activo | | métrica primaria > 0 | |
| Sensibilidad ±50 % (peor caso) | | sin cambio de signo, ≥ 50 % | |
| Universo alternativo | | | |

**Desglose por año, tramo, activo y régimen:** <tabla>

**Ablación:**

| Componente quitado | Métrica primaria | Diferencia | ¿Se mantiene? |
|---|---|---|---|
| | | | |

## 9. Features de LLM

<"No aplica", o bien: modelo, corte de conocimiento, si se generaron en tiempo real o a posteriori, versión
del prompt y registro de origen. Señalar también las hipótesis contaminadas.>

## 10. Veredicto

- **Veredicto:**
- **Criterios que fallan o que no se pudieron medir:**
- **Qué no demuestra este experimento:**
- **Siguiente paso propuesto** (requiere aprobación humana):

## 11. Checklist

<Pegar aquí `.claude/skills/quant-research/checklist.md` marcada.>
