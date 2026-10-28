// Guarda de arranque (ADR 0017): una configuración peligrosa no arranca. Reúne todos los problemas en un solo
// error CONFIG_INVALID, para que una persona los vea juntos y no de uno en uno.
import { ConfigError } from './environment.ts';
import type { Environment } from './environment.ts';
import type { Config } from './schema.ts';
import type { Secrets } from './secrets.ts';

/**
 * Tope máximo del capital del bot, en moneda de cotización. Provisional y restrictivo (ADR 0017): subirlo exige
 * un ADR nuevo con aprobación humana. El capital real lo limita además la subcuenta (trading-risk §3, capa 1).
 */
export const MAX_CAPITAL_CAP_QUOTE = 1000;

/** Restricciones de la clave del exchange, leídas del exchange por exchange/ (paso 32, INV-05b). */
export interface KeyPermissions {
  /** Permite sacar fondos de la cuenta (retiros). Los nombres evitan las palabras que vigilan ESLint y la búsqueda de INV-02. */
  fundsOut: boolean;
  /** Permite mover fondos entre cuentas o subcuentas (transferencias). */
  fundsBetweenAccounts: boolean;
  margin: boolean;
  futures: boolean;
  ipRestricted: boolean;
}

export interface StartupInput {
  environment: Environment;
  config: Config;
  secrets: Secrets;
  /** Sin valor: no se han podido leer. En shadow y production eso basta para no arrancar. */
  keyPermissions?: KeyPermissions;
}

type EffectiveMode = 'paper' | 'testnet' | 'shadow' | 'live';

// Modos que admite cada entorno. live es dinero real; testnet, el modo live contra el sandbox del exchange.
const ALLOWED_MODES: Record<Environment, readonly EffectiveMode[]> = {
  development: ['paper', 'testnet'],
  test: ['paper'],
  paper: ['paper'],
  shadow: ['shadow'],
  production: ['live'],
};

function effectiveMode(c: Config): EffectiveMode {
  if (c.mode === 'live') return c.exchange.sandbox ? 'testnet' : 'live';
  return c.mode;
}

function capitalProblems(c: Config): string[] {
  const cap = c.capital.capQuote;
  if (cap === undefined) return ['capital cap ausente: falta capital.capQuote en config.json'];
  if (!(cap > 0)) return [`capital.capQuote debe ser positivo (vale ${cap})`];
  const problems: string[] = [];
  if (cap > MAX_CAPITAL_CAP_QUOTE) {
    problems.push(`capital.capQuote (${cap}) supera el máximo permitido (${MAX_CAPITAL_CAP_QUOTE} ${c.quote})`);
  }
  if (c.capital.startingQuote > cap) {
    problems.push(`capital.startingQuote (${c.capital.startingQuote}) supera capital.capQuote (${cap})`);
  }
  return problems;
}

function permissionProblems(environment: Environment, mode: EffectiveMode, p: KeyPermissions | undefined): string[] {
  if (p === undefined) {
    return mode === 'live' || mode === 'shadow' ? ['no se han podido comprobar los permisos de la clave del exchange (fail closed)'] : [];
  }
  const problems: string[] = [];
  if (p.fundsOut) problems.push('la clave del exchange tiene permiso de retiro');
  if (p.fundsBetweenAccounts) problems.push('la clave del exchange tiene permiso de transferencia');
  if (p.margin) problems.push('la clave del exchange tiene permiso de margen');
  if (p.futures) problems.push('la clave del exchange tiene permiso de futuros');
  if (environment === 'production' && !p.ipRestricted) problems.push('la clave del exchange no tiene restricción de IP');
  return problems;
}

/** Lista de motivos por los que no se puede arrancar. Vacía: se puede arrancar. */
export function startupProblems(input: StartupInput): string[] {
  const { environment, config: c, secrets } = input;
  const mode = effectiveMode(c);
  const problems: string[] = [];

  if (!ALLOWED_MODES[environment].includes(mode)) {
    problems.push(`el modo ${mode} no está permitido en el entorno ${environment} (admite: ${ALLOWED_MODES[environment].join(', ')})`);
  }
  if (secrets.liveRequested && environment !== 'production') problems.push(`LIVE_TRADING activado fuera de production (entorno ${environment})`);
  if (environment === 'production' && !secrets.liveConfirmed) {
    problems.push('Para operar con dinero real, una persona fija LIVE_TRADING con la frase de confirmación (M-03). Sin ella, production no arranca.');
  }
  if (mode !== 'paper' && !(secrets.apiKey && secrets.apiSecret)) {
    problems.push(`Modo ${mode} sin EXCHANGE_API_KEY / EXCHANGE_API_SECRET`);
  }

  if (c.exchange.marketType !== 'spot') problems.push(`solo spot: exchange.marketType es ${JSON.stringify(c.exchange.marketType)}`);
  if (c.exchange.leverage !== 1) problems.push(`apalancamiento activado: exchange.leverage es ${c.exchange.leverage}`);
  if (c.exchange.margin) problems.push('apalancamiento activado: exchange.margin es true');

  problems.push(...capitalProblems(c), ...permissionProblems(environment, mode, input.keyPermissions));
  return problems;
}

export function assertSafeStartup(input: StartupInput): void {
  const problems = startupProblems(input);
  if (problems.length > 0) throw new ConfigError(`configuración peligrosa, no se arranca:\n- ${problems.join('\n- ')}`);
}
