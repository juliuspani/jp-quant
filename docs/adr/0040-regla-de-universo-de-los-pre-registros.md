# ADR 0040 — Regla de universo de los pre-registros

Fecha: 2026-10-21 · Estado: aceptado (la persona lo pidió el 2026-10-20; la regla concreta, en modo autónomo, ADR 0011) ·
Auditoría quant, parte 8. Cambia `DATA.md` §2 (punto 4) para los pre-registros futuros.

## Contexto

- EXP-0025 y EXP-0026 registraron como universo de diseño BTC/EUR y ETH/EUR, «los dos pares con más historia y los
  únicos que cubren los bajistas de 2018 y 2022». Los manifiestos lo desmienten (auditoría quant, Q-04):
  - LTC/EUR empieza el 2013-09-14, antes que ETH/EUR (2015-08-07);
  - ETC/EUR (2016-07-27) y ZEC/EUR (2016-10-28) también cubren los dos bajistas y siguen listados.
- La elección salía de `DATA.md` §2, punto 4: sin pares deslistados antiguos, el universo se limita a los pares que
  existían al inicio y siguen listados, «y se empieza por BTC y ETH». Ese final es una elección a mano. La justificación
  se escribió conociendo el periodo (`quant-research` §12) y no se comprobó con los datos.
- La persona decidió que A y B se repitan con su universo tal como se pre-registró, y que la regla se corrija solo para
  los pre-registros futuros.

## Decisión

1. **A y B no cambian de universo al repetirse.** Sus informes llevan una fe de erratas.
2. **Un pre-registro fija el universo con una regla, no con una lista.** La regla se calcula en cada fecha solo con
   datos anteriores (`quant-research` §3) y se escribe antes de mirar resultados.
   - Es la de `DATA.md` §2, punto 2: al inicio de cada tramo, los pares en EUR con al menos 365 días de datos antes, por
     volumen en EUR de los 90 días anteriores, con un tamaño k fijado en el pre-registro.
   - Mientras no haya pares deslistados antes de 2023, se aplica la misma regla entre los pares que existían al inicio
     de cada tramo y siguen listados, con el sesgo de supervivencia declarado (punto 4). Ya no «se empieza por BTC y
     ETH».
3. **Antes de registrar, la regla se comprueba** contra los manifiestos del dataset, y el pre-registro cita la
   comprobación: el comando o el cálculo. Si la justificación escrita no se cumple con los datos, no se registra.

## Alternativas

- **Cambiar el universo de A y B al repetirlas.** Sería una prueba nueva con otro diseño, no la repetición
  pre-registrada que pidió la persona.
- **Dejar la justificación como texto libre.** Es lo que permitió una justificación falsa.
- **Elegir siempre BTC y ETH por ser los más líquidos.** La liquidez se mide en cada fecha con datos anteriores: es la
  regla del punto 2, no una lista fija.

## Consecuencias

- En A y B, los PASS de A.3.2 y de A.3.10 a A.3.13 dependen de un universo elegido a posteriori (Q-04). Sus informes, y
  los de su repetición, lo declaran.
- La segunda ronda (C.1) parte con la regla nueva.
- No hay código nuevo: la comprobación contra los manifiestos se hace con los datos de `data/historical/` antes de cada
  pre-registro, y el pre-registro la cita.
