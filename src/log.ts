export type Level = 'info' | 'warn' | 'error';

type Sink = (level: Level, kind: string, message: string) => void;

let sink: Sink | null = null;
const secrets: string[] = [];

/** Además de la consola, los eventos se guardan donde diga el sink (la base de datos). */
export function setLogSink(fn: Sink | null): void {
  sink = fn;
}

/** Cualquier valor registrado aquí se tacha de los logs aunque aparezca en un mensaje de error. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.push(value);
}

// Secretos con forma reconocible, que se tachan aunque nadie los haya registrado: un valor que llega por otro
// camino (una cabecera en un error de ccxt, una URL con su token) no debe depender de que alguien se acordara.
const SECRET_PATTERNS: [RegExp, string][] = [
  // Token de bot de Telegram (también dentro de https://api.telegram.org/bot<token>/…).
  [/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, '***'],
  // Claves de Anthropic y de otros proveedores con el prefijo sk-.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],
  // Cabecera Authorization: Bearer <token> o Basic <credenciales>.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // Contraseña dentro de una URL: https://usuario:contraseña@host.
  [/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1***@'],
  // Pares clave=valor o clave: valor con un nombre de secreto (cabeceras, parámetros de URL, JSON, objetos).
  [
    /(?<![A-Za-z0-9])((?:x-mbx-)?api[_-]?key|api[_-]?secret|secret|token|password|passphrase|signature|private[_-]?key)("?\s*[:=]\s*"?)[^\s"'&,;}]{4,}/gi,
    '$1$2***',
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function log(level: Level, kind: string, message: string): void {
  const safe = redact(message);
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${kind}: ${safe}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    sink?.(level, kind, safe);
  } catch (e) {
    // Un fallo al persistir un log no debe tumbar el bot, pero tampoco puede pasar en silencio.
    const reason = redact(e instanceof Error ? e.message : String(e));
    console.error(`${new Date().toISOString()} [ERROR] log: no se pudo guardar el evento anterior: ${reason}`);
  }
}
