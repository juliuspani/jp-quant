// Entorno de ejecución (ADR 0017). Cada entorno admite unos modos y una fuente de secretos; si no se sabe en
// qué entorno se corre, no se arranca.

export const ENVIRONMENTS = ['development', 'test', 'paper', 'shadow', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Frase que una persona escribe en LIVE_TRADING para operar con dinero real (M-03). Solo vale en production. */
export const LIVE_CONFIRMATION = 'SI_ENTIENDO_EL_RIESGO';

/** Todo error de configuración detiene el arranque con este código (trading-risk §9.2). */
export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';

  constructor(message: string) {
    super(`CONFIG_INVALID: ${message}`);
    this.name = 'ConfigError';
  }
}

function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Decide el entorno a partir de APP_ENV y del campo `environment` de config.json. Es ambiguo, y no arranca,
 * si no lo declara ninguno, si lo declaran los dos con valores distintos, si el valor no es exactamente uno de
 * ENVIRONMENTS (ni mayúsculas ni espacios) o si NODE_ENV dice otra cosa sobre production o test.
 */
export function resolveEnvironment(env: Readonly<Record<string, string | undefined>>, declared?: Environment): Environment {
  const raw = env['APP_ENV'];
  let fromEnv: Environment | undefined;
  if (raw !== undefined && raw !== '') {
    if (!isEnvironment(raw)) {
      throw new ConfigError(`entorno ambiguo: APP_ENV=${JSON.stringify(raw)} no es uno de ${ENVIRONMENTS.join(', ')}`);
    }
    fromEnv = raw;
  }
  if (fromEnv === undefined && declared === undefined) {
    throw new ConfigError(`entorno ambiguo: falta APP_ENV y config.json no declara environment (${ENVIRONMENTS.join(', ')})`);
  }
  if (fromEnv !== undefined && declared !== undefined && fromEnv !== declared) {
    throw new ConfigError(`entorno ambiguo: APP_ENV=${fromEnv} y config.json declara environment=${declared}`);
  }
  const environment = (fromEnv ?? declared) as Environment;
  const nodeEnv = env['NODE_ENV'];
  if (nodeEnv !== undefined && nodeEnv !== '') {
    const contradicts = (nodeEnv === 'production') !== (environment === 'production') || (nodeEnv === 'test' && environment !== 'test');
    if (contradicts) throw new ConfigError(`entorno ambiguo: NODE_ENV=${JSON.stringify(nodeEnv)} contradice el entorno ${environment}`);
  }
  return environment;
}
