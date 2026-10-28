// Cada línea marcada con «✗» tiene exactamente una infracción de inversor/no-float; las demás, ninguna.
export function bad(price: number, text: string, side: 1 | 2, values: number[]): number {
  let total = 0;
  const a = parseFloat(text); // ✗
  const b = parseInt(text, 10); // ✗
  const c = Number(text); // ✗
  const d = Number.parseFloat(text); // ✗
  const e = Math.round(price); // ✗
  const f = +text; // ✗
  const g = price * 2; // ✗
  const h = price - a; // ✗
  const i = side + b; // ✗
  const j = `${text}` + c; // ✗
  total += d; // ✗
  total++; // ✗
  const k = -price; // ✗
  const l = price % 3; // ✗
  const m = values.length / 2; // ✗
  return [e, f, g, h, i, j, k, l, m].length > 0 ? total : 0;
}
