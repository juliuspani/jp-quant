import { randomBytes } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TF_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

export function tfToMs(tf: string): number {
  const ms = TF_MS[tf];
  if (!ms) throw new Error(`Marco temporal no soportado: ${tf}`);
  return ms;
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  retryable?: (e: unknown) => boolean;
}

/** Reintenta con backoff exponencial y jitter. Solo para operaciones idempotentes (lecturas). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 4, baseMs = 500, retryable = () => true } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !retryable(e)) throw e;
      await sleep(baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
    }
  }
}

/** Identificador propio de orden: permite localizarla en el exchange si se pierde la respuesta. */
export function newClientOrderId(bucket: string): string {
  return `jp-${bucket}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Precio con decimales acordes a su magnitud (BTC a 2, una memecoin a 8). */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const decimals = n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return n.toLocaleString('es-ES', { maximumFractionDigits: decimals });
}

export function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n)}%`;
}
