// Carga de secretos (ADR 0017). Fuera de production vienen de las variables de entorno y de .env; en
// production solo del gestor de secretos (credenciales de systemd en $CREDENTIALS_DIRECTORY), nunca de un .env
// en disco ni de una variable de entorno. Todo valor cargado se tacha de los logs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { registerSecret } from '../log.ts';
import { ConfigError, LIVE_CONFIRMATION } from './environment.ts';
import type { Environment } from './environment.ts';

/** Nombre de cada secreto: variable de entorno fuera de production, archivo de credencial en production. */
export const SECRET_NAMES = {
  apiKey: 'EXCHANGE_API_KEY',
  apiSecret: 'EXCHANGE_API_SECRET',
  apiPassword: 'EXCHANGE_API_PASSWORD',
  telegramToken: 'TELEGRAM_BOT_TOKEN',
  telegramChatId: 'TELEGRAM_CHAT_ID',
  dashboardPassword: 'DASHBOARD_PASSWORD',
  anthropicKey: 'ANTHROPIC_API_KEY',
  healthcheckUrl: 'HEALTHCHECK_URL',
} as const;

type SecretField = keyof typeof SECRET_NAMES;

export type Secrets = { [K in SecretField]?: string } & {
  /** LIVE_TRADING trae exactamente la frase de confirmación. */
  liveConfirmed: boolean;
  /** LIVE_TRADING trae cualquier valor que no sea vacío ni `false`: alguien pide operar en real. */
  liveRequested: boolean;
};

/** Para lo que no necesita claves (el backtest lee datos públicos). */
export const NO_SECRETS: Secrets = { liveConfirmed: false, liveRequested: false };

export interface SecretOptions {
  environment: Environment;
  /** Variables de entorno del proceso. Por defecto, process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Archivo de secretos fuera de production. En production, que exista basta para no arrancar. */
  envFile?: string;
}

const LIVE_VAR = 'LIVE_TRADING';
// .env, .env.local, .env.production…; .env.example solo lleva nombres (lo vigila el hook de Claude).
const ENV_FILE_NAME = /^\.env(\..+)?$/;

function clean(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Archivos .env* junto a envFile, sin contar .env.example. */
function envFilesOnDisk(envFile: string): string[] {
  const dir = dirname(envFile);
  const found = existsSync(dir) ? readdirSync(dir).filter((f) => ENV_FILE_NAME.test(f) && f !== '.env.example') : [];
  return existsSync(envFile) && !found.includes(basename(envFile)) ? [...found, basename(envFile)] : found;
}

function fromEnvironmentAndFile(env: Readonly<Record<string, string | undefined>>, envFile: string): Record<string, string | undefined> {
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  if (clean(file['APP_ENV']) !== undefined) {
    throw new ConfigError(`entorno ambiguo: ${envFile} no puede declarar APP_ENV; el entorno lo fija el proceso o config.json`);
  }
  // Como process.loadEnvFile: lo que ya trae el entorno manda sobre el archivo.
  return { ...file, ...env };
}

function fromSecretManager(env: Readonly<Record<string, string | undefined>>, envFile: string): Record<string, string | undefined> {
  const onDisk = envFilesOnDisk(envFile);
  if (onDisk.length > 0) {
    throw new ConfigError(`en production los secretos no se leen de un .env en disco: retira ${onDisk.join(', ')} y usa el gestor de secretos`);
  }
  const inEnv = Object.values(SECRET_NAMES).filter((name) => clean(env[name]) !== undefined);
  if (inEnv.length > 0) {
    throw new ConfigError(`en production ${inEnv.join(', ')} no puede venir de una variable de entorno: usa el gestor de secretos`);
  }
  const dir = env['CREDENTIALS_DIRECTORY'];
  if (dir === undefined || !isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ConfigError('en production falta el gestor de secretos: CREDENTIALS_DIRECTORY no es una carpeta absoluta que exista');
  }
  const values: Record<string, string | undefined> = { [LIVE_VAR]: env[LIVE_VAR] };
  for (const name of Object.values(SECRET_NAMES)) {
    const path = join(dir, name);
    if (existsSync(path)) values[name] = readFileSync(path, 'utf8');
  }
  return values;
}

export function loadSecrets(options: SecretOptions): Secrets {
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? '.env';
  const raw = options.environment === 'production' ? fromSecretManager(env, envFile) : fromEnvironmentAndFile(env, envFile);
  const live = clean(raw[LIVE_VAR]);
  const secrets: Secrets = { liveConfirmed: live === LIVE_CONFIRMATION, liveRequested: live !== undefined && live !== 'false' };
  for (const [field, name] of Object.entries(SECRET_NAMES) as [SecretField, string][]) {
    const value = clean(raw[name]);
    if (value === undefined) continue;
    secrets[field] = value;
    // Se tacha todo, también la URL del latido (lleva su token) y el chat de Telegram: ante la duda, es secreto.
    registerSecret(value);
  }
  return secrets;
}
