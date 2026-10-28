// Azar e ids con semilla (ARCHITECTURE.md §5.3, quant-research §6): la misma semilla da la misma secuencia en
// cualquier máquina y versión de Node, porque solo usa aritmética entera de 32 bits (Math.imul y desplazamientos).
// Generador xoshiro128** (Blackman y Vigna, 2018), sembrado con splitmix32. No es criptográfico: solo para
// backtest, replay e investigación.

export interface Rng {
  next(): number; // [0, 1), con 32 bits de resolución
}
export interface Ids {
  next(): string;
}

const UINT32_RANGE = 4_294_967_296;

export function checkSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
    throw new RangeError(`semilla inválida: ${String(seed)} (entero de 0 a 2^32 - 1)`);
  }
  return seed;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** xoshiro128** sobre un estado de cuatro enteros de 32 bits; devuelve enteros sin signo. Exportado para el test de referencia. */
export function xoshiro128ss(state: readonly [number, number, number, number]): () => number {
  let [s0, s1, s2, s3] = state.map((x) => x >>> 0) as [number, number, number, number];
  if ((s0 | s1 | s2 | s3) === 0) throw new RangeError('xoshiro128** no admite un estado todo a cero');
  return () => {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };
}

// FNV-1a de 32 bits: separa flujos independientes de una misma semilla por su nombre.
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

function uint32Stream(seed: number, stream: string): () => number {
  let state = (checkSeed(seed) ^ fnv1a(stream)) >>> 0;
  const splitmix32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  // splitmix32 no repite valores en 2^32 llamadas: cuatro seguidas nunca son todas cero.
  return xoshiro128ss([splitmix32(), splitmix32(), splitmix32(), splitmix32()]);
}

/** Flujo de azar `stream` de la semilla `seed`. Dos nombres distintos dan secuencias independientes. */
export function seededRng(seed: number, stream: string): Rng {
  const next = uint32Stream(seed, stream);
  return { next: () => next() / UINT32_RANGE };
}

/**
 * Número en [0, 1) que solo depende de `seed` y `key`: sin estado, el mismo par da siempre el mismo valor. Es el azar que
 * puede usar una función pura, como la estrategia aleatoria de control (paso 24), con la clave del instante que decide.
 */
export function seededUnit(seed: number, key: string): number {
  return uint32Stream(seed, `unit:${key}`)() / UINT32_RANGE;
}

/** Ids `prefijo-n-xxxxxxxx`: únicos por el contador y dependientes de la semilla por el sufijo. */
export function seededIds(seed: number, prefix: string): Ids {
  const next = uint32Stream(seed, `ids:${prefix}`);
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-${String(counter)}-${next().toString(16).padStart(8, '0')}`;
    },
  };
}

/**
 * UUID con la forma de la versión 4 (RFC 9562) sacados de la semilla: los approval_id del replay, de los que sale el
 * client order ID (exchange-execution §5.1). En tiempo real, app/ entrega UUID aleatorios con el mismo contrato.
 */
export function seededUuids(seed: number, stream: string): Ids {
  const next = uint32Stream(seed, `uuid:${stream}`);
  return {
    next: () => {
      const words = [next(), next(), next(), next()] as const;
      // Versión 4 en el nibble alto del byte 6 y variante 10xx en el byte 8.
      const w1 = ((words[1] & 0xffff0fff) | 0x00004000) >>> 0;
      const w2 = ((words[2] & 0x3fffffff) | 0x80000000) >>> 0;
      const hex = [words[0], w1, w2, words[3]].map((w) => w.toString(16).padStart(8, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}
