// Código previo: la configuración vive en src/config/ (paso 16, ADR 0017). Este archivo solo reexporta para los
// módulos de la raíz que aún la importan desde aquí; desaparece al llevarlos a sus módulos (ARCHITECTURE.md §18).
export { ConfigError, ENVIRONMENTS, LIVE_CONFIRMATION, resolveEnvironment } from './config/environment.ts';
export type { Environment } from './config/environment.ts';
export { ConfigSchema, loadConfig, parseConfig, validate } from './config/schema.ts';
export type { Config, IntelConfig, RiskConfig, ScoutConfig, TrendParams } from './config/schema.ts';
export { NO_SECRETS, SECRET_NAMES, loadSecrets } from './config/secrets.ts';
export type { SecretOptions, Secrets } from './config/secrets.ts';
export { MAX_CAPITAL_CAP_QUOTE, assertSafeStartup, startupProblems } from './config/startup.ts';
export type { KeyPermissions, StartupInput } from './config/startup.ts';
