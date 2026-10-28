// Límites arquitectónicos de CLAUDE.md §2 («Arquitectura y flujo») y de ARCHITECTURE.md §15, comprobados por
// dependency-cruiser. Las rutas son relativas al directorio desde el que se ejecuta (la raíz del repositorio, o
// la raíz de un árbol de prueba en test/fixtures/boundaries/). Las infracciones del código previo al paso 4
// están en .dependency-cruiser-known-violations.json (ver docs/enforcement.md).

const CCXT = '(^|/)node_modules/ccxt(/|$)';
const BIG_JS = '(^|/)node_modules/big\\.js(/|$)';

// Matriz de dependencias de ARCHITECTURE.md §15.1 (ADR 0015): lo que cada módulo puede importar de src/, además
// de sí mismo. Todo lo demás de src/ está prohibido, también los archivos de la raíz. app/ es la composición y
// puede importarlo todo; config/ tiene su regla aparte. test/enforcement/layout.test.ts rechaza una carpeta de
// src/ que no sea un módulo.
const MATRIX = {
  shared: [],
  kernel: ['shared'],
  marketdata: ['shared', 'kernel'],
  features: ['shared', 'kernel'],
  analytics: ['shared', 'kernel', 'features'],
  strategy: ['shared', 'kernel', 'features'],
  portfolio: ['shared', 'kernel'],
  risk: ['shared', 'kernel'],
  execution: ['shared', 'kernel'],
  exchange: ['shared', 'kernel'],
  historical: ['shared', 'kernel'],
  backtest: ['shared', 'kernel'],
  persistence: ['shared', 'kernel'],
  monitoring: ['shared', 'kernel', 'analytics'],
  registry: ['shared', 'kernel'],
  research: ['shared', 'kernel', 'analytics', 'registry'],
  intel: ['shared', 'kernel'],
};

// Archivos sueltos que un módulo puede importar además de los de su fila.
const EXTRA_FILES = {
  // Execution solo usa de risk/ el tipo y la verificación del token (trading-risk §2.3).
  execution: ['risk/approval.ts'],
  // Transitorio (ADR 0015): src/strategy/trend.ts, del código previo, usa estos archivos de la raíz. Se quitan
  // cuando trend.ts lea el FeatureVector en lugar de indicators.ts (ADR 0025), al mover types.ts a shared/ y kernel/,
  // y config.ts a config/.
  strategy: ['config.ts', 'indicators.ts', 'types.ts'],
};

// Transitorio (ADR 0015): archivos del código previo a los que todavía no se aplica la regla de su módulo. Vacío desde
// el paso 23, que quitó src/backtest/sim.ts; solo puede volver a crecer con un ADR.
const EXEMPT = {};

// Dominio (ARCHITECTURE.md §15.1): sin E/S propia y sin paquetes de npm. La E/S la hacen los adaptadores.
const DOMAIN = ['shared', 'kernel', 'marketdata', 'features', 'analytics', 'strategy', 'portfolio', 'risk', 'execution'];
const NODE_IO =
  '^(node:)?(fs|fs/promises|net|http|https|http2|child_process|dgram|tls|dns|dns/promises|cluster|worker_threads|sqlite|readline|repl|inspector)$';
const NPM = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown'];

const anyOf = (items) => items.map((item) => item.replaceAll('.', '\\.')).join('|');

const matrixRules = Object.entries(MATRIX).map(([module, allowed]) => {
  const files = EXTRA_FILES[module] ?? [];
  const exempt = EXEMPT[module] ?? [];
  const folders = `(${anyOf([module, ...allowed])})/`;
  const what = [...allowed.map((m) => `${m}/`), ...files.map((f) => `src/${f}`)];
  return {
    name: `${module}-solo-importa-lo-permitido`,
    comment:
      what.length > 0
        ? `${module}/ solo puede importar de src/ ${what.join(', ')} (ARCHITECTURE.md §15.1).`
        : `${module}/ no puede importar nada de src/ fuera de sí mismo (ARCHITECTURE.md §15.1).`,
    severity: 'error',
    from: exempt.length > 0 ? { path: `^src/${module}/`, pathNot: `^src/(${anyOf(exempt)})$` } : { path: `^src/${module}/` },
    to: { path: '^src/', pathNot: files.length > 0 ? `^src/(${folders}|(${anyOf(files)})$)` : `^src/${folders}` },
  };
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'strategy-no-execution-ni-exchange',
      comment: 'Strategy solo produce decisiones: no puede importar execution/ ni exchange/.',
      severity: 'error',
      from: { path: '^src/strategy/' },
      to: { path: '^src/(execution|exchange)/' },
    },
    {
      name: 'strategy-no-ccxt',
      comment: 'Strategy no habla con el exchange: no puede importar ccxt.',
      severity: 'error',
      from: { path: '^src/strategy/' },
      to: { path: CCXT },
    },
    {
      name: 'features-no-execution-ni-risk',
      comment: 'features/ no puede importar execution/ ni risk/.',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/(execution|risk)/' },
    },
    {
      name: 'features-sin-contratos-de-ordenes',
      comment:
        'Las features no emiten órdenes: features/ no importa los contratos de órdenes, ejecución y stores del ' +
        'kernel, aunque la matriz le deje importar kernel/ (ADR 0025).',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/kernel/(orders|execution|stores)\\.ts$' },
    },
    {
      name: 'solo-exchange-importa-ccxt',
      comment: 'ccxt solo se importa desde exchange/ (también los import type).',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/exchange/' },
      to: { path: CCXT },
    },
    {
      name: 'solo-decimal-importa-big-js',
      comment:
        'big.js solo se importa desde los envoltorios del tipo decimal: src/shared/decimal.ts y capguard/decimal.ts ' +
        '(ADR 0014). Así se puede cambiar de biblioteca tocando un archivo.',
      severity: 'error',
      from: { pathNot: '^(src/shared|capguard)/decimal\\.ts$' },
      to: { path: BIG_JS },
    },
    {
      name: 'llm-y-news-no-execution-ni-exchange',
      comment: 'Ningún LLM ni fuente de noticias puede llegar a execution/ ni a exchange/.',
      severity: 'error',
      // A cualquier profundidad: src/llm/, src/intel/news/… Solo se analiza src/.
      from: { path: '/(llm|news)/' },
      to: { path: '^src/(execution|exchange)/' },
    },
    {
      name: 'solo-risk-usa-el-firmante',
      comment: 'El firmante de aprobaciones (src/risk/signer) solo se importa desde src/risk/ (ADR 0003).',
      severity: 'error',
      from: { pathNot: '^src/risk/' },
      to: { path: '^src/risk/signer(/|\\.ts$)' },
    },
    {
      name: 'capguard-no-importa-src',
      comment: 'El capguard no comparte código con el bot: no puede importar nada de src/ (ADR 0003).',
      severity: 'error',
      from: { path: '^capguard/' },
      to: { path: '^src/' },
    },
    {
      name: 'src-no-importa-capguard',
      comment: 'El bot no puede importar el capguard: se comunican por IPC, no por código (ADR 0003).',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^capguard/' },
    },
    ...matrixRules,
    {
      name: 'config-solo-importa-lo-permitido',
      comment: 'config/ puede importar los tipos de la sección de cada módulo, pero no app/ (ARCHITECTURE.md §15.1).',
      severity: 'error',
      from: { path: '^src/config/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'solo-persistence-usa-sqlite',
      comment:
        'Solo persistence/ abre la base de datos: una conexión y un escritor (ARCHITECTURE.md §9). Transitorio: ' +
        'src/store.ts, del código previo, hasta el paso 33.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(persistence/|store\\.ts$)' },
      to: { dependencyTypes: ['core'], path: '^(node:)?sqlite$' },
    },
    {
      name: 'dominio-sin-entrada-salida',
      comment: 'El dominio no hace E/S: la hacen los adaptadores y el resultado llega como evento (ARCHITECTURE.md §5.2).',
      severity: 'error',
      from: { path: `^src/(${anyOf(DOMAIN)})/` },
      to: { dependencyTypes: ['core'], path: NODE_IO },
    },
    {
      name: 'dominio-sin-paquetes-npm',
      comment:
        'El dominio no importa paquetes de npm. Única excepción: src/shared/decimal.ts, que envuelve la ' +
        'biblioteca decimal (ADR 0014).',
      severity: 'error',
      from: { path: `^src/(${anyOf(DOMAIN)})/`, pathNot: '^src/shared/decimal\\.ts$' },
      to: { dependencyTypes: NPM },
    },
  ],
  options: {
    // Los import type también cuentan como dependencia.
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
