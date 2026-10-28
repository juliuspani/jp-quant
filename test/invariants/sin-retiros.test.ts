// INV-02 (SECURITY_AND_TRADING_INVARIANTS.md): no existe código que llame a endpoints de retiro ni de
// transferencia, y ESLint rechaza el que lo intente.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';
import { ROOT, matchingLines, runnableCode } from './repo.ts';

// Retiros y transferencias entre cuentas (trading-risk §3, capa 1). Llamada, miembro, acceso calculado con un
// texto y ruta REST. Son amplios a propósito: un falso positivo se ve, un falso negativo no.
const FORBIDDEN = [
  /[\w$]*(withdraw|transfer)[\w$]*\s*\(/i,
  /\.\s*[\w$]*(withdraw|transfer)/i,
  /\[\s*['"`][^'"`]*(withdraw|transfer)/i,
  /\/(withdraw|transfer)/i,
  /sapi\w*(withdraw|transfer)/i,
];

// Los dos archivos que definen las barreras contienen los patrones a propósito: el hook de Claude y ESLint.
const BARRIERS = new Set(['scripts/claude-guard.ts', 'eslint.config.js']);

test('INV-02a: los patrones detectan las formas conocidas de retirar o transferir', () => {
  const samples = [
    "await ex.withdraw('BTC', 1, address);",
    "ex['withdraw']('BTC', 1, address);",
    'this.ex.sapiPostCapitalWithdrawApply(params);',
    "fetch('https://api.binance.com/sapi/v1/capital/withdraw/apply');",
    "await ex.transfer('USDT', 10, 'spot', 'funding');",
    'this.ex.privatePostAssetTransfer(params);',
    "fetch(base + '/sapi/v1/sub-account/transfer/subToMaster');",
  ];
  for (const s of samples) assert.ok(FORBIDDEN.some((p) => p.test(s)), `no se detecta: ${s}`);
});

test('INV-02a: no hay código que llame a retiros ni transferencias', () => {
  const files = runnableCode().filter((f) => !BARRIERS.has(f));
  assert.ok(files.includes('src/broker.ts'), 'la lista de archivos no incluye src/: la prueba no comprobaría nada');
  assert.deepEqual(matchingLines(files, FORBIDDEN), []);
});

test('INV-02b: ESLint rechaza un acceso a withdraw* en JavaScript y en TypeScript', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const code = "ex.withdraw('BTC', 1, address);\nex['withdrawAll']();\n";
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, 'scripts', 'inv-02b.js') });
  const hits = (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax' && /withdrawals/.test(m.message));
  assert.equal(hits.length, 2);
  // Los .ts necesitan información de tipos para analizarse; basta con ver que la misma regla está activa.
  const tsConfig = (await eslint.calculateConfigForFile(join(ROOT, 'src', 'inv-02b.ts'))) as { rules?: Record<string, unknown> };
  assert.match(JSON.stringify(tsConfig.rules?.['no-restricted-syntax']), /withdraw/);
});
