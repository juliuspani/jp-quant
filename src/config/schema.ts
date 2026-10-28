// Esquema de config.json con zod (ADR 0017): los tipos salen del esquema, cada campo tiene su valor por defecto
// y una clave desconocida o un valor de otro tipo detienen el arranque (fail closed). Cada objeto es estricto
// (strictObject) y lleva .prefault({}): si falta entero, toma los valores por defecto de sus campos.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError, ENVIRONMENTS } from './environment.ts';

const TrendParamsSchema = z.strictObject({
  emaFast: z.number().default(50),
  emaSlow: z.number().default(200),
  breakoutLookback: z.number().default(20),
  atrPeriod: z.number().default(14),
  atrStopMult: z.number().default(2.5),
  atrTrailMult: z.number().default(3),
}).prefault({});

const RiskSchema = z.strictObject({
  /** % del patrimonio que se pierde si salta el stop de una operación núcleo. */
  riskPerTradePct: z.number().default(0.75),
  maxPositionPct: z.number().default(25),
  maxExposurePct: z.number().default(75),
  maxOpenPositions: z.number().default(6),
  /** Caída del patrimonio en el día (UTC) a partir de la cual no se abren más operaciones hoy. */
  dailyLossLimitPct: z.number().default(2),
  /** Caída desde el máximo histórico que detiene el bot hasta que se reanude a mano. */
  maxDrawdownPct: z.number().default(10),
  cooldownAfterLosses: z.number().default(3),
  cooldownHours: z.number().default(24),
  minOrderQuote: z.number().default(10),
}).prefault({});

const ScoutSchema = z.strictObject({
  enabled: z.boolean().default(true),
  scanMinutes: z.number().default(15),
  /** % máximo del patrimonio para todo el explorador. */
  bucketPct: z.number().default(5),
  positionPct: z.number().default(1),
  maxPositions: z.number().default(4),
  minQuoteVolume: z.number().default(2_000_000),
  maxQuoteVolume: z.number().default(150_000_000),
  maxSpreadPct: z.number().default(0.4),
  minChange24hPct: z.number().default(8),
  maxChange24hPct: z.number().default(60),
  relVolumeMin: z.number().default(3),
  stopPct: z.number().default(10),
  takeProfitPct: z.number().default(20),
  takeProfitFraction: z.number().default(0.5),
  trailPct: z.number().default(12),
  maxHoldHours: z.number().default(72),
  symbolCooldownHours: z.number().default(48),
  exclude: z.array(z.string()).default([]),
}).prefault({});

const IntelSchema = z.strictObject({
  enabled: z.boolean().default(true),
  refreshMinutes: z.number().default(30),
  rssFeeds: z.array(z.string()).default([]),
  /** Por debajo de este valor del índice Fear & Greed se reduce el riesgo. */
  extremeFear: z.number().default(15),
  extremeGreed: z.number().default(85),
  llm: z.strictObject({
    enabled: z.boolean().default(false),
    model: z.string().default('claude-haiku-4-5-20251001'),
    maxHeadlines: z.number().default(40),
  }).prefault({}),
}).prefault({});

export const ConfigSchema = z.strictObject({
  /** Entorno para el que está escrito el archivo. Si lo declara y no coincide con APP_ENV, no arranca. */
  environment: z.enum(ENVIRONMENTS).optional(),
  mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
  exchange: z.strictObject({
    id: z.string().default('binance'),
    sandbox: z.boolean().default(false),
    // Solo spot y sin apalancamiento (CLAUDE.md §2). Se declaran para que un cambio se vea y no arranque.
    marketType: z.string().default('spot'),
    leverage: z.number().default(1),
    margin: z.boolean().default(false),
  }).prefault({}),
  quote: z.string().default('USDT'),
  capital: z.strictObject({
    startingQuote: z.number().default(1000),
    /** Tope de capital del bot en moneda de cotización. Sin valor por defecto: si falta, no arranca. */
    capQuote: z.number().optional(),
  }).prefault({}),
  paper: z.strictObject({ feeRate: z.number().default(0.001), slippageBps: z.number().default(5) }).prefault({}),
  loop: z.strictObject({ tickSeconds: z.number().default(60) }).prefault({}),
  core: z.strictObject({
    enabled: z.boolean().default(true),
    symbols: z.array(z.string()).default(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']),
    timeframe: z.string().default('4h'),
    regime: z.strictObject({ symbol: z.string().default('BTC/USDT'), timeframe: z.string().default('1d'), smaPeriod: z.number().default(200) }).prefault({}),
    strategy: TrendParamsSchema,
    maxSignalAgeMinutes: z.number().default(20),
  }).prefault({}),
  risk: RiskSchema,
  scout: ScoutSchema,
  intel: IntelSchema,
  telegram: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
  dashboard: z.strictObject({ enabled: z.boolean().default(true), host: z.string().default('127.0.0.1'), port: z.number().default(8787) }).prefault({}),
  dataDir: z.string().default('data'),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TrendParams = z.infer<typeof TrendParamsSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;
export type ScoutConfig = z.infer<typeof ScoutSchema>;
export type IntelConfig = z.infer<typeof IntelSchema>;

const KIND: Record<string, string> = { array: 'una lista', object: 'un objeto' };

function describe(issue: z.core.$ZodIssue): string {
  const path = ['config', ...issue.path.map(String)].join('.');
  switch (issue.code) {
    case 'unrecognized_keys':
      return issue.keys.map((k) => `${path}.${k} no es una clave conocida`).join('; ');
    case 'invalid_type':
      return `${path} debe ser ${KIND[issue.expected] ?? `de tipo ${issue.expected}`}`;
    case 'invalid_value':
      return `${path} debe ser uno de ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`;
    default:
      return `${path}: ${issue.message}`;
  }
}

function check(cond: boolean, message: string): void {
  if (!cond) throw new ConfigError(`configuración inválida: ${message}`);
}

/**
 * Topes duros: aunque alguien edite config.json con prisa, el bot no arranca
 * con un riesgo que contradiga el objetivo de "poco pero consistente".
 */
export function validate(c: Config): void {
  check(c.capital.startingQuote > 0, 'capital.startingQuote debe ser positivo');
  check(c.loop.tickSeconds >= 10, 'loop.tickSeconds mínimo 10');
  check(c.core.symbols.every((s) => s.endsWith(`/${c.quote}`)), `todos los símbolos núcleo deben cotizar en ${c.quote}`);
  check(c.risk.riskPerTradePct > 0 && c.risk.riskPerTradePct <= 2, 'risk.riskPerTradePct debe estar en (0, 2]');
  check(c.risk.maxPositionPct > 0 && c.risk.maxPositionPct <= 50, 'risk.maxPositionPct debe estar en (0, 50]');
  check(c.risk.maxExposurePct > 0 && c.risk.maxExposurePct <= 100, 'risk.maxExposurePct debe estar en (0, 100]');
  check(c.risk.dailyLossLimitPct > 0 && c.risk.dailyLossLimitPct <= 10, 'risk.dailyLossLimitPct debe estar en (0, 10]');
  check(c.risk.maxDrawdownPct > 0 && c.risk.maxDrawdownPct <= 30, 'risk.maxDrawdownPct debe estar en (0, 30]');
  check(c.scout.bucketPct >= 0 && c.scout.bucketPct <= 10, 'scout.bucketPct debe estar en [0, 10]');
  check(c.scout.positionPct > 0 && c.scout.positionPct <= 2, 'scout.positionPct debe estar en (0, 2]');
  check(c.scout.stopPct > 0 && c.scout.stopPct <= 25, 'scout.stopPct debe estar en (0, 25]');
  check(c.scout.takeProfitFraction > 0 && c.scout.takeProfitFraction < 1, 'scout.takeProfitFraction debe estar en (0, 1)');
  check(c.core.strategy.emaFast < c.core.strategy.emaSlow, 'emaFast debe ser menor que emaSlow');
}

/** Valida un objeto de configuración ya leído. Lanza ConfigError con todos los problemas encontrados. */
export function parseConfig(input: unknown): Config {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`configuración inválida: ${parsed.error.issues.map(describe).join('; ')}`);
  validate(parsed.data);
  return parsed.data;
}

export function loadConfig(path = 'config.json'): Config {
  return parseConfig(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : {});
}
