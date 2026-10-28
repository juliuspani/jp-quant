// Lectura del diario del replay para el dashboard (paso 41B, ADR 0045): o se entiende entero, o no hay dashboard.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLAY_FORMAT as ENGINE_FORMAT } from '../../../src/backtest/replay.ts';
import { DashboardError, parseJournal, REPLAY_FORMAT } from '../../../src/monitoring/journal.ts';
import { demoRun } from '../../../demo/replay.ts';

const { result, jsonl } = demoRun();

test('lee el diario del replay: los mismos eventos, en el mismo orden y con el mismo run', () => {
  assert.equal(REPLAY_FORMAT, ENGINE_FORMAT, 'el formato es el del motor de replay');
  const journal = parseJournal(jsonl);
  assert.equal(journal.runId, 'demo-dashboard');
  assert.equal(journal.events.length, result.journal.length);
  assert.deepEqual(journal.events.map((e) => e.type), result.journal.map((e) => e.type));
  assert.ok(Object.isFrozen(journal.events) && Object.isFrozen(journal.events[0]), 'lo leído no se puede cambiar');
});

test('fail closed: un diario cortado, desordenado, de otro formato o con una línea rota no se lee', () => {
  const lines = jsonl.trimEnd().split('\n');
  const cases: readonly [string, string][] = [
    ['sin cierre', `${lines.slice(0, -1).join('\n')}\n`],
    ['cortado', `${[...lines.slice(0, 10), lines.at(-1) ?? ''].join('\n')}\n`],
    ['desordenado', `${[lines[0] ?? '', lines[2] ?? '', lines[1] ?? '', ...lines.slice(3)].join('\n')}\n`],
    ['otro formato', jsonl.replace(REPLAY_FORMAT, 'otro/1')],
    ['línea rota', jsonl.replace(lines[5] ?? '', '{"seq":4,')],
    ['vacío', ''],
  ];
  for (const [name, text] of cases) assert.throws(() => parseJournal(text), DashboardError, name);
});
