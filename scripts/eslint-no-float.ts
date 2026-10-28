// Regla de ESLint «nunca float» (ADR 0014, exchange-execution §17): en los módulos de dinero y precios no hay
// conversiones a number ni aritmética con number. Precios, cantidades e importes van en Decimal
// (src/shared/decimal.ts); el tiempo y los índices, con las utilidades de src/shared/. Necesita la información de
// tipos de typescript-eslint: sin ella, la regla lanza en lugar de dejar pasar el archivo (fail closed).
import type { Rule } from 'eslint';
import ts from 'typescript';

// Módulos de dinero y precios (exchange-execution §17), en src/, además de capguard/. eslint.config.js les aplica la
// regla y test/enforcement/no-float.test.ts comprueba que llega a cada uno.
export const MONEY_MODULES = ['exchange', 'execution', 'risk', 'portfolio', 'historical', 'backtest'];
// Excepción: el envoltorio decimal del capguard, frontera con el análisis (el de src/shared/ no está en un módulo de
// dinero). El código previo de backtest/ salió en el paso 23. Solo puede quitarse.
export const NO_FLOAT_EXEMPT = ['capguard/decimal.ts'];

interface TypedServices {
  program: ts.Program;
  esTreeNodeToTSNodeMap: { get(node: unknown): ts.Node };
}

const MESSAGE =
  'Nunca float en los módulos de dinero y precios (ADR 0014): {{what}}. Usa Decimal de src/shared/decimal.ts, ' +
  'o las utilidades de src/shared/ para el tiempo.';

const CONVERSIONS = new Set(['parseFloat', 'parseInt', 'Number']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);

function typedServices(context: Rule.RuleContext): TypedServices {
  const services: unknown = context.sourceCode.parserServices;
  if (
    typeof services !== 'object' ||
    services === null ||
    !('program' in services) ||
    !('esTreeNodeToTSNodeMap' in services) ||
    services.program === null
  ) {
    throw new Error(`inversor/no-float necesita la información de tipos de typescript-eslint (${context.filename})`);
  }
  return services as TypedServices;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Prohíbe float (conversiones y aritmética con number) en los módulos de dinero y precios' },
    schema: [],
    messages: { float: MESSAGE },
  },
  create(context) {
    const services = typedServices(context);
    const checker = services.program.getTypeChecker();

    // number, sus literales y enums numéricos; `any` también, porque podría ser un number.
    const isNumberish = (node: unknown): boolean => {
      const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
      const parts = type.isUnion() ? type.types : [type];
      return parts.some((t) => (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any)) !== 0);
    };
    const report = (node: Rule.Node, what: string): void => {
      context.report({ node, messageId: 'float', data: { what } });
    };

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && CONVERSIONS.has(callee.name)) report(node, `${callee.name}()`);
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Number') report(node, 'new Number()');
      },
      MemberExpression(node) {
        const object = node.object;
        if (object.type !== 'Identifier' || node.computed || node.property.type !== 'Identifier') return;
        if (object.name === 'Math') report(node, `Math.${node.property.name}`);
        if (object.name === 'Number' && (node.property.name === 'parseFloat' || node.property.name === 'parseInt')) {
          report(node, `Number.${node.property.name}()`);
        }
      },
      BinaryExpression(node) {
        if (ARITHMETIC.has(node.operator) && (isNumberish(node.left) || isNumberish(node.right))) {
          report(node, `aritmética con number (${node.operator})`);
        }
      },
      AssignmentExpression(node) {
        if (node.operator !== '=' && !/^(&&|\|\||\?\?)=$/.test(node.operator) && isNumberish(node.left)) {
          report(node, `aritmética con number (${node.operator})`);
        }
      },
      UpdateExpression(node) {
        if (isNumberish(node.argument)) report(node, `aritmética con number (${node.operator})`);
      },
      UnaryExpression(node) {
        if (node.operator === '+') report(node, 'conversión a number con + unario');
        // Un literal negativo (`-1`) es un valor, no una operación.
        if ((node.operator === '-' || node.operator === '~') && node.argument.type !== 'Literal' && isNumberish(node.argument)) {
          report(node, `aritmética con number (${node.operator} unario)`);
        }
      },
    };
  },
};

export const noFloatPlugin = { rules: { 'no-float': rule } };
