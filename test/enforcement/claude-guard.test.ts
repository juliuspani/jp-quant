// El hook de Claude Code (scripts/claude-guard.ts) bloquea lo que CLAUDE.md prohíbe y deja pasar lo demás.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { evaluate } from '../../scripts/claude-guard.ts';
import type { ToolInput } from '../../scripts/claude-guard.ts';
import { LIVE_CONFIRMATION } from '../../src/config.ts';

const GUARD = join(resolve(import.meta.dirname, '..', '..'), 'scripts', 'claude-guard.ts');

type Case = [tool: string, input: ToolInput];

const BLOCKED: Case[] = [
  // Test final intocable
  ['Edit', { file_path: 'C:\\repo\\config\\holdout.lock', new_string: 'x' }],
  ['Write', { file_path: '/repo/data/holdout/btc.csv', content: 'x' }],
  ['NotebookEdit', { notebook_path: 'data/holdout/analisis.ipynb', new_source: 'x' }],
  ['Bash', { command: 'echo 2030-01-01 > config/holdout.lock' }],
  ['PowerShell', { command: 'Set-Content data\\holdout\\btc.csv -Value x' }],
  // …y tampoco se lee su contenido
  ['Read', { file_path: 'config/holdout.lock' }],
  ['Read', { file_path: 'C:\\repo\\data\\holdout\\btc.csv' }],
  ['Grep', { pattern: '20', path: 'config/holdout.lock' }],
  ['Grep', { pattern: 'close', path: '/repo/data/holdout' }],
  ['Grep', { pattern: '20', path: 'config', glob: 'holdout.lock' }],
  ['Bash', { command: 'cat config/holdout.lock' }],
  ['Bash', { command: 'head -5 data/holdout/btc.csv' }],
  ['Bash', { command: 'test -e config/holdout.lock && cat config/holdout.lock' }],
  ['Bash', { command: 'ls data/holdout | xargs cat' }],
  ['Bash', { command: 'ls $(cat config/holdout.lock)' }],
  ['Bash', { command: 'ls data/holdout > config/holdout.lock' }],
  ['Bash', { command: 'test -e config/holdout.lock < config/holdout.lock' }],
  ['Bash', { command: 'cp -r data/holdout /tmp/copia' }],
  ['Bash', { command: 'find data/holdout -exec cat {} +' }],
  ['Bash', { command: 'cd data/holdout' }],
  ['Bash', { command: '[ -e config/holdout.lock' }],
  ['PowerShell', { command: 'Get-Content config\\holdout.lock' }],
  ['PowerShell', { command: 'Get-ChildItem data\\holdout | Get-Content' }],
  ['PowerShell', { command: 'Get-ChildItem data\\holdout -Recurse' }],
  ['PowerShell', { command: '& cat config\\holdout.lock' }],
  // .env*
  ['Read', { file_path: 'C:\\repo\\.env' }],
  ['Read', { file_path: '/repo/.env.local' }],
  ['Read', { file_path: '/repo/.env.example.bak' }],
  ['Read', { file_path: '/repo/.env.examples' }],
  ['Write', { file_path: '.env', content: 'KEY=1' }],
  // .env.example solo con nombres sin valor, y nunca desde la shell
  ['Write', { file_path: '.env.example', content: 'EXCHANGE_API_KEY=\nEXCHANGE_API_SECRET=abc123' }],
  ['Write', { file_path: 'C:\\repo\\.env.example', content: 'export TELEGRAM_BOT_TOKEN="12345:token"' }],
  ['Edit', { file_path: '.env.example', new_string: 'LIVE_TRADING=SI_ENTIENDO_EL_RIESGO' }],
  ['Bash', { command: 'cat .env.example' }],
  ['Bash', { command: 'echo KEY=secreto >> .env.example' }],
  ['PowerShell', { command: 'Get-Content .\\.env.example' }],
  ['Edit', { file_path: 'sub/.env.production', new_string: 'x' }],
  ['Grep', { pattern: 'KEY', path: '.env' }],
  ['Grep', { pattern: 'KEY', glob: '.env*' }],
  ['Glob', { pattern: '**/.env*' }],
  ['Bash', { command: 'cat .env' }],
  ['Bash', { command: 'node --env-file=.env src/main.ts' }],
  ['PowerShell', { command: 'Get-Content .\\.env.local' }],
  // Comandos destructivos
  ['Bash', { command: 'rm -rf data' }],
  ['Bash', { command: 'rm -fr data' }],
  ['Bash', { command: 'rm -r -f data' }],
  ['Bash', { command: 'ls && rm --recursive --force data' }],
  ['PowerShell', { command: 'Remove-Item -Recurse -Force data' }],
  ['PowerShell', { command: 'ri data -r -fo' }],
  ['Bash', { command: 'git push --force' }],
  ['Bash', { command: 'git push -f origin master' }],
  ['Bash', { command: 'git push --force-with-lease origin master' }],
  ['Bash', { command: 'git push origin +master' }],
  ['Bash', { command: 'git reset --hard HEAD~1' }],
  ['Bash', { command: 'git -C . reset --hard' }],
  ['Bash', { command: 'git commit --no-verify -m x' }],
  ['Bash', { command: 'git -c core.hooksPath=/dev/null commit -m x' }],
  // Retiros
  ['Bash', { command: 'curl -X POST https://api.binance.com/sapi/v1/capital/withdraw/apply' }],
  ['Bash', { command: 'node -e "exchange.withdraw(\'BTC\', 1, addr)"' }],
  ['Write', { file_path: 'src/execution/broker.ts', content: "await exchange.withdraw('BTC', 1, addr);" }],
  ['Edit', { file_path: 'C:\\repo\\src\\broker.ts', new_string: 'this.ex.sapiPostCapitalWithdrawApply(p)' }],
  // Operar en real lo activa una persona: desde la shell no se nombra LIVE_TRADING ni su frase
  ['Bash', { command: 'LIVE_TRADING=SI_ENTIENDO_EL_RIESGO npm start' }],
  ['Bash', { command: 'export LIVE_TRADING=x && node src/main.ts' }],
  ['Bash', { command: 'env live_trading=1 npm start' }],
  ['PowerShell', { command: '$env:LIVE_TRADING = "x"; npm start' }],
  ['PowerShell', { command: 'setx LIVE_TRADING x' }],
  ['Bash', { command: 'node -e "process.env.X = \'si_entiendo_el_riesgo\'"' }],
];

const ALLOWED: Case[] = [
  // Comprobar si el test final existe no lee su contenido
  ['Bash', { command: 'ls data/holdout' }],
  ['Bash', { command: 'ls -la config/holdout.lock' }],
  ['Bash', { command: 'test -e config/holdout.lock' }],
  ['Bash', { command: 'test -d data/holdout && echo existe' }],
  ['Bash', { command: '[ -f "config/holdout.lock" ] || echo falta' }],
  ['PowerShell', { command: 'Test-Path config\\holdout.lock' }],
  ['PowerShell', { command: 'Get-ChildItem data\\holdout -Name' }],
  ['Glob', { pattern: 'data/holdout/**' }],
  ['Read', { file_path: '/repo/.env.example' }],
  ['Read', { file_path: 'C:\\repo\\.ENV.EXAMPLE' }],
  ['Write', { file_path: '.env.example', content: '# Claves del exchange\nEXCHANGE_API_KEY=\nexport LIVE_TRADING=""\nTELEGRAM_BOT_TOKEN= # BotFather\n' }],
  ['Edit', { file_path: '.env.example', new_string: 'DASHBOARD_PASSWORD=' }],
  ['Grep', { pattern: 'KEY', path: '.env.example' }],
  ['Read', { file_path: 'src/config.ts' }],
  ['Write', { file_path: 'src/config.ts', content: 'const key = process.env.API_KEY;' }],
  ['Edit', { file_path: 'docs/environment.md', new_string: 'x' }],
  ['Grep', { pattern: '\\.env', path: 'src' }],
  ['Grep', { pattern: 'LIVE_TRADING', path: 'src' }],
  ['Glob', { pattern: 'src/**/*.ts' }],
  ['Bash', { command: 'node -e "process.stdout.write(String(process.env.PATH))"' }],
  ['PowerShell', { command: '$env:NODE_ENV = "test"; npm test' }],
  ['Bash', { command: 'rm scratch.txt' }],
  ['Bash', { command: 'rm -r scratch' }],
  ['Bash', { command: 'npm run check:all' }],
  ['Bash', { command: 'git push origin master' }],
  ['Bash', { command: 'git reset --soft HEAD~1' }],
  ['Bash', { command: 'git commit -F mensaje.txt' }],
  ['Write', { file_path: 'src/intel.ts', content: 'const ALARM = /halts withdrawals/i;' }],
  ['WebFetch', { url: 'https://example.com' }],
];

for (const [tool, input] of BLOCKED) {
  test(`bloquea ${tool} ${JSON.stringify(input)}`, () => {
    assert.notEqual(evaluate(tool, input), null);
  });
}

for (const [tool, input] of ALLOWED) {
  test(`permite ${tool} ${JSON.stringify(input)}`, () => {
    assert.equal(evaluate(tool, input), null);
  });
}

function runHook(stdin: string): number | null {
  return spawnSync(process.execPath, [GUARD], { input: stdin, encoding: 'utf8' }).status;
}

test('la frase que bloquea el hook es la confirmación de src/config.ts', () => {
  assert.notEqual(evaluate('Bash', { command: `echo ${LIVE_CONFIRMATION}` }), null);
});

test('como proceso: bloquea con código 2 y permite con código 0', () => {
  assert.equal(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } })), 2);
  assert.equal(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } })), 0);
});

test('como proceso: una entrada ilegible se bloquea (fail closed)', () => {
  assert.equal(runHook('esto no es JSON'), 2);
  assert.equal(runHook(JSON.stringify({ tool_input: {} })), 2);
});
