// Idioma de la página del dashboard (paso 49, revisión pública): español por defecto, inglés para la demo de GitHub Pages.
// - La página se genera entera en un idioma: withLang fija el idioma mientras dura el render, que es síncrono, y lo
//   devuelve al terminar, también si algo lanza. Fuera de withLang, todo sale en español, como antes.
// - t(es, en) elige el texto. Las cadenas de los dos idiomas están juntas en el código, para que no se desincronicen.
// - El selector de idioma son enlaces entre dos páginas generadas, sin JavaScript: la CSP y el script fijo no cambian.

export type Lang = 'es' | 'en';

let current: Lang = 'es';

export function lang(): Lang {
  return current;
}

export function withLang<T>(next: Lang, render: () => T): T {
  const previous = current;
  current = next;
  try {
    return render();
  } finally {
    current = previous;
  }
}

export function t(es: string, en: string): string {
  return current === 'en' ? en : es;
}

// Motivos que las estrategias de referencia y el bot de plan B escriben en el diario, en español. El diario no cambia: en
// la página inglesa se muestran traducidos los conocidos y el resto tal cual.
const PHRASES: ReadonlyMap<string, string> = new Map([
  ['cierre sobre la EMA', 'close above the EMA'], ['cierre bajo la EMA', 'close below the EMA'], ['sin features', 'no features'],
  ['mantener', 'hold'], ['fuera, al azar', 'out, at random'], ['dentro, al azar', 'in, at random'], ['salida al azar', 'random exit'],
  ['intención anterior sin resolver', 'previous intent unresolved'], ['entrada con la posición ya abierta: se ignora', 'entry with the position already open: ignored'],
  ['salida sin posición: se ignora', 'exit without a position: ignored'], ['fuera del plan', 'outside the plan'],
  ['orden anterior sin resolver', 'previous order unresolved'], ['compra periódica (DCA)', 'periodic purchase (DCA)'], ['objetivo alcanzado', 'target reached'],
  ['por debajo del importe mínimo', 'below the minimum amount'], ['rebalanceo: vender el exceso', 'rebalance: sell the excess'],
  ['stop de protección del plan', 'plan protective stop'], ['stop de protección: la posición cambió', 'protective stop: the position changed'],
]);

export function phrase(text: string): string {
  if (current !== 'en') return text;
  const known = PHRASES.get(text);
  if (known !== undefined) return known;
  const rebalance = /^rebalanceo: (.+) por (encima|debajo) del objetivo$/.exec(text);
  if (rebalance !== null) return `rebalance: ${rebalance[1] ?? ''} ${rebalance[2] === 'encima' ? 'above' : 'below'} target`;
  return text;
}
