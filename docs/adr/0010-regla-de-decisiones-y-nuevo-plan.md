# ADR 0010 — Regla de decisiones y nuevo plan en dos tramos

Fecha: 2026-10-05 · Estado: aceptado (decisión 1 sustituida por el ADR 0011) · Paso: 12 (regla y plan decididos por la persona en el prompt del paso)

## Contexto

Hasta el paso 11 no había una regla escrita sobre qué puede decidir Claude solo y qué tiene que preguntar,
y los pasos terminaban con preguntas de todo tipo, también de nombres, formato o erratas. El plan tenía 60
pasos en un solo bloque, sin un punto donde decidir si sigue adelante. La persona decidió ambas cosas en el
prompt del paso 12; este ADR las registra.

## Decisión

1. **Regla de decisiones** en `CLAUDE.md` §7: Claude decide lo editorial y los detalles de implementación
   dentro del alcance, y lo anota en `PROGRESS.md` («Decisiones tomadas por Claude»). La persona decide
   siempre dinero, riesgo y sus umbrales, seguridad, secretos, alcance, dependencias nuevas, coste,
   infraestructura, datos del test final y cualquier cosa irreversible. Las preguntas van en un solo bloque al
   final del paso, como máximo 5 y con recomendación. Lo que tiene una respuesta claramente segura y
   reversible se aplica como «decidido provisionalmente» sin preguntar. Al empezar un paso se revisan sus
   compromisos en `PROGRESS.md`.
2. **Plan en dos tramos.** Tramo 1, pasos 12 a 31, hasta el punto de decisión. Tramo 2, pasos 32 a 48, solo si
   el paso 31 aprueba alguna estrategia.
3. **Renumeración** con la tabla de `docs/progress/PLAN_MAP.md` (registro de trabajo privado, no publicado). Los pasos 1 a 11 no
   cambian. Se pospone lo que no hace falta para decidir: on-chain, news, ablation, el dashboard completo, los
   datos macro y el order-book imbalance.
4. **Ajustes de compromisos:** el tipo decimal y la regla «nunca float» pasan al paso 18, el primero que
   maneja precios; los parámetros de conectividad del ADR 0005, al 32; el test de columnas `REAL`, `FLOAT` o
   `DOUBLE`, al 33. Hasta el paso 33, ningún almacenamiento del tramo 1 usa float para precios ni cantidades.
5. **Las referencias se actualizan** en `PROGRESS.md`, `CLAUDE.md`, los skills, los ADRs, `docs/` y los tests
   de texto que citan números de paso. Solo cambian los números; en los ADRs aceptados es una corrección
   editorial anotada al final. `docs/progress/HISTORY.md` conserva la numeración anterior, con una nota que
   remite al mapa.

## Alternativas descartadas

- **Seguir preguntando todo.** Más lento y mezcla lo importante con lo editorial.
- **Mantener la numeración y marcar pasos como pospuestos.** Deja huecos y obliga a recordar qué número está
  vivo.
- **Reescribir los números en `HISTORY.md`.** Cambiaría el registro de lo que se dijo en cada relevo, que
  `trading-project-engineer` §6 pide no editar.

## Consecuencias

- Menos preguntas por paso; las decisiones de Claude quedan a la vista en `PROGRESS.md` y la persona puede
  revertirlas.
- El juicio de qué es «claramente seguro y reversible» lo hace Claude; ante duda, se pregunta.
- La regla de ESLint «nunca float» y el tipo decimal llegan antes (paso 18) que el test de columnas (paso 33):
  entre medias, que el almacenamiento no use float depende de la revisión y de esta regla escrita.
- Los tests de `exchange-execution` y `trading-risk` comprueban los números nuevos.
- Leer un relevo antiguo exige traducir sus números con `PLAN_MAP.md`.
