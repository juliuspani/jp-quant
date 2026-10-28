import { DatabaseSync } from 'node:sqlite';
import type { Bucket, Fill, Position } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  bucket TEXT NOT NULL,
  status TEXT NOT NULL,
  amount REAL NOT NULL,
  cost_basis REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_ts INTEGER NOT NULL,
  stop_price REAL NOT NULL,
  highest_price REAL NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  exit_ts INTEGER,
  exit_reason TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS positions_status ON positions(status);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  position_id INTEGER,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  amount REAL NOT NULL,
  price REAL NOT NULL,
  quote REAL NOT NULL,
  fee REAL NOT NULL,
  client_order_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equity (
  ts INTEGER PRIMARY KEY,
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  exposure REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
`;

export interface FillRow extends Fill {
  id: number;
  mode: string;
  positionId: number | null;
  reason: string;
}

export interface EventRow {
  ts: number;
  level: string;
  kind: string;
  message: string;
}

export interface EquityRow {
  ts: number;
  equity: number;
  cash: number;
  exposure: number;
}

export interface NewPosition {
  symbol: string;
  bucket: Bucket;
  amount: number;
  costBasis: number;
  entryPrice: number;
  entryTs: number;
  stopPrice: number;
  meta?: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function toPosition(r: Row): Position {
  return {
    id: r.id as number,
    symbol: r.symbol as string,
    bucket: r.bucket as Bucket,
    status: r.status as 'open' | 'closed',
    amount: r.amount as number,
    costBasis: r.cost_basis as number,
    entryPrice: r.entry_price as number,
    entryTs: r.entry_ts as number,
    stopPrice: r.stop_price as number,
    highestPrice: r.highest_price as number,
    realizedPnl: r.realized_pnl as number,
    exitTs: (r.exit_ts as number | null) ?? null,
    exitReason: (r.exit_reason as string | null) ?? null,
    meta: JSON.parse(r.meta as string) as Record<string, unknown>,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL aguanta un corte de luz a mitad de escritura sin corromper la base.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Ejecuta `fn` de forma atómica: o se aplica todo o nada. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  openPosition(p: NewPosition): Position {
    const res = this.db
      .prepare(
        `INSERT INTO positions(symbol, bucket, status, amount, cost_basis, entry_price, entry_ts, stop_price, highest_price, meta)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.symbol, p.bucket, p.amount, p.costBasis, p.entryPrice, p.entryTs, p.stopPrice, p.entryPrice, JSON.stringify(p.meta ?? {}));
    return this.position(Number(res.lastInsertRowid))!;
  }

  position(id: number): Position | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as Row | undefined;
    return row ? toPosition(row) : null;
  }

  openPositions(bucket?: Bucket): Position[] {
    const rows = bucket
      ? this.db.prepare("SELECT * FROM positions WHERE status = 'open' AND bucket = ? ORDER BY id").all(bucket)
      : this.db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY id").all();
    return (rows as Row[]).map(toPosition);
  }

  closedPositions(limit: number): Position[] {
    const rows = this.db.prepare("SELECT * FROM positions WHERE status = 'closed' ORDER BY exit_ts DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(toPosition);
  }

  savePosition(p: Position): void {
    this.db
      .prepare(
        `UPDATE positions SET status = ?, amount = ?, cost_basis = ?, stop_price = ?, highest_price = ?,
         realized_pnl = ?, exit_ts = ?, exit_reason = ?, meta = ? WHERE id = ?`,
      )
      .run(p.status, p.amount, p.costBasis, p.stopPrice, p.highestPrice, p.realizedPnl, p.exitTs, p.exitReason, JSON.stringify(p.meta), p.id);
  }

  recordFill(f: Fill, mode: string, positionId: number | null, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO fills(ts, mode, position_id, symbol, side, amount, price, quote, fee, client_order_id, order_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.ts, mode, positionId, f.symbol, f.side, f.amount, f.price, f.quote, f.fee, f.clientOrderId, f.orderId, reason);
  }

  recentFills(limit: number): FillRow[] {
    const rows = this.db.prepare('SELECT * FROM fills ORDER BY id DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      mode: r.mode as string,
      positionId: (r.position_id as number | null) ?? null,
      symbol: r.symbol as string,
      side: r.side as 'buy' | 'sell',
      amount: r.amount as number,
      price: r.price as number,
      quote: r.quote as number,
      fee: r.fee as number,
      clientOrderId: r.client_order_id as string,
      orderId: r.order_id as string,
      reason: r.reason as string,
    }));
  }

  snapshotEquity(row: EquityRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO equity(ts, equity, cash, exposure) VALUES (?, ?, ?, ?)')
      .run(row.ts, row.equity, row.cash, row.exposure);
  }

  equitySince(ts: number): EquityRow[] {
    return this.db.prepare('SELECT ts, equity, cash, exposure FROM equity WHERE ts >= ? ORDER BY ts').all(ts) as unknown as EquityRow[];
  }

  lastEquity(): EquityRow | null {
    const row = this.db.prepare('SELECT ts, equity, cash, exposure FROM equity ORDER BY ts DESC LIMIT 1').get();
    return (row as unknown as EquityRow | undefined) ?? null;
  }

  event(level: string, kind: string, message: string): void {
    this.db.prepare('INSERT INTO events(ts, level, kind, message) VALUES (?, ?, ?, ?)').run(Date.now(), level, kind, message);
  }

  recentEvents(limit: number): EventRow[] {
    return this.db.prepare('SELECT ts, level, kind, message FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as EventRow[];
  }

  /** Las operaciones se conservan siempre; solo se recortan registro y curva de patrimonio. */
  prune(now: number): void {
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - 30 * 86_400_000);
    this.db.prepare('DELETE FROM equity WHERE ts < ?').run(now - 365 * 86_400_000);
  }

  /** Resumen de posiciones cerradas, para el panel y para /estado. */
  stats(): { trades: number; wins: number; realizedPnl: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS trades, COALESCE(SUM(realized_pnl > 0), 0) AS wins, COALESCE(SUM(realized_pnl), 0) AS pnl
         FROM positions WHERE status = 'closed'`,
      )
      .get() as Row;
    return { trades: row.trades as number, wins: row.wins as number, realizedPnl: row.pnl as number };
  }
}
