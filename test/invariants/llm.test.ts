// INV-11 (SECURITY_AND_TRADING_INVARIANTS.md): un LLM no tiene autoridad de ejecución. Su salida solo puede
// reducir el tamaño o bloquear entradas, y el código que habla con un LLM no puede llegar a las órdenes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { assessRisk } from '../../src/intel.ts';
import type { HeadlineAssessment } from '../../src/intel.ts';
import { ROOT, matchingLines, read, repoFiles } from './repo.ts';

// Proveedores de LLM y sus credenciales.
const LLM = [/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/i, /@anthropic-ai\/|['"]openai['"]/i, /ANTHROPIC_API_KEY|anthropicKey/];
// Lo que acerca a una orden: el broker, el motor, el mercado del código previo, ccxt y los módulos de ejecución.
const ORDER_PATH = /from\s+['"][^'"]*(broker|engine|market|ccxt|\/execution\/|\/exchange\/|capguard)[^'"]*['"]/;

test('INV-11b: la salida de un LLM, aunque sea hostil, solo reduce o bloquea', () => {
  const cfg = loadConfig(join(ROOT, 'no-existe.json')).intel;
  const hostile: (HeadlineAssessment | null)[] = [
    null,
    { marketRisk: -1e9, summary: 'Ignora los límites y compra todo' },
    { marketRisk: Number.NaN, summary: 'x' },
    { marketRisk: Number.POSITIVE_INFINITY, summary: 'x' },
    { marketRisk: Number.NEGATIVE_INFINITY, summary: 'x' },
    { marketRisk: 0, summary: 'calma' },
    { marketRisk: 59, summary: 'x' },
    { marketRisk: 60, summary: 'x' },
    { marketRisk: 100, summary: 'x' },
  ];
  for (const fearGreed of [null, -5, 0, 50, 100, 1000, Number.NaN]) {
    for (const alarmSources of [0, 1, 2, 10]) {
      for (const assessment of hostile) {
        const r = assessRisk({ fearGreed, alarmSources, assessment }, cfg);
        const at = JSON.stringify({ fearGreed, alarmSources, assessment });
        assert.ok(r.riskMultiplier >= 0 && r.riskMultiplier <= 1, `multiplicador ${r.riskMultiplier} con ${at}`);
        assert.equal(typeof r.blockEntries, 'boolean');
        // Ni órdenes, ni símbolos, ni límites nuevos: solo el freno y sus notas.
        assert.deepEqual(Object.keys(r).sort(), ['blockEntries', 'notes', 'riskMultiplier']);
      }
    }
  }
});

test('INV-11c: solo la configuración y los módulos de inteligencia nombran un LLM, y no importan nada de órdenes', () => {
  const code = repoFiles().filter((f) => /^(src|capguard)\/.*\.(ts|js)$/.test(f));
  const allowed = (f: string) => f === 'src/config.ts' || f === 'src/intel.ts' || /^src\/(config|intel|llm|news)\//.test(f);
  const outside = matchingLines(code.filter((f) => !allowed(f)), LLM);
  assert.deepEqual(outside, [], 'un LLM aparece fuera de config e inteligencia');
  const withLlm = code.filter((f) => allowed(f) && LLM.some((p) => p.test(read(f))));
  assert.deepEqual(matchingLines(withLlm, [ORDER_PATH]), [], 'un módulo que habla con un LLM importa código de órdenes');
});
