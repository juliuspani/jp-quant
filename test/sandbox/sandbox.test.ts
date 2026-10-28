// Sandbox de usuarios (paso 49): velas propias validadas con errores claros, estrategias de usuario con el mismo contrato,
// el mismo pipeline que la investigación y, sobre todo, ninguna ejecución toca el registro oficial, su N ni los criterios.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import coinFlip from '../../examples/coin-flip.ts';
import myStrategy from '../../examples/my-strategy.ts';
import { CsvError, parseCandlesCsv } from '../../sandbox/csv.ts';
import { close, defineStrategy, ema, StrategyDefinitionError } from '../../sandbox/define.ts';
import { EXAMPLE_CSV, exampleCsv } from '../../sandbox/example-data.ts';
import { FetchError, krakenToCsv } from '../../sandbox/fetch-candles.ts';
import { LOCAL_REGISTRY, makePartitions, plainVerdict, previousTrials, testStrategy, type CheckResult } from '../../sandbox/pipeline.ts';
import { REPORT_CSP, reportHtml } from '../../sandbox/report.ts';
import { REGISTRY_FILE } from '../../src/research/registry.ts';
import { ROOT } from '../invariants/repo.ts';

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const example = parseCandlesCsv(readFileSync(EXAMPLE_CSV, 'utf8'), 'SYN/EUR');

test('el CSV de ejemplo es el que sale del generador, sin datos reales, y se lee entero', () => {
  assert.equal(readFileSync(EXAMPLE_CSV, 'utf8').replace(/\r\n/g, '\n'), exampleCsv());
  assert.equal(example.timeframe, '1d');
  assert.equal(example.candles.length, 2557);
  assert.equal(example.gaps, 0);
  assert.ok(example.candles.every((c) => c.receivedTime > c.closeTime), 'sin look-ahead: se recibe después del cierre');
});

test('un CSV mal formado se rechaza con la línea y qué hacer', () => {
  const head = 'time,open,high,low,close,volume\n';
  const cases: [string, RegExp][] = [
    ['', /vacío/],
    ['fecha,open,high,low,close,volume\n2024-01-01,1,2,1,1,1\n2024-01-02,1,2,1,1,1\n', /falta la columna «time»/],
    [`${head}2024-01-01,1,2,1,1,1\n2024-01-02,1,2,1,abc,1\n`, /línea 3: close «abc» no es un número decimal/],
    [`${head}2024-01-02,1,2,1,1,1\n2024-01-01,1,2,1,1,1\n`, /línea 3: el instante no es posterior/],
    [`${head}2024-01-01,1,2,1,1,1\n2024-01-01T05:00:00Z,1,2,1,1,1\n2024-01-02,1,2,1,1,1\n`, /no empieza en una marca|intervalo/],
    [`${head}2024-01-01,1,0.5,0.4,1,1\n2024-01-02,1,2,1,1,1\n`, /línea 2: high tiene que ser el máximo/],
    [`${head}2024-01-01,0,2,1,1,1\n2024-01-02,1,2,1,1,1\n`, /mayores que cero/],
    [`${head}01/02/2024,1,2,1,1,1\n2024-01-02,1,2,1,1,1\n`, /no es una fecha en UTC/],
  ];
  for (const [text, message] of cases) assert.throws(() => parseCandlesCsv(text, 'X/EUR'), (error) => error instanceof CsvError && message.test(error.message), String(message));
  const unix = parseCandlesCsv(`${head}1704067200,1,2,1,1,1\n1704153600,1,2,1,1,1\n`, 'X/EUR');
  assert.equal(unix.candles[0]?.openTime, Date.UTC(2024, 0, 1));
});

test('una estrategia mal definida falla al cargarla, con un mensaje que dice qué cambiar', () => {
  const base = { timeframe: '1d' as const, params: { fast: 5, slow: 20 }, features: () => [close()], decide: () => ({ action: 'hold' as const, reason: 'x' }) };
  assert.throws(() => defineStrategy({ ...base, name: 'Mi Estrategia' }), StrategyDefinitionError);
  assert.throws(() => defineStrategy({ ...base, name: 'too-big', grid: { fast: [1, 2, 3, 4, 5], slow: [10, 20, 30, 40, 50] } }), /como mucho 20/);
  assert.throws(() => defineStrategy({ ...base, name: 'bad-grid', grid: { other: [1] } as never }), /no está en params/);
  assert.equal(defineStrategy({ ...base, name: 'ok-grid', features: (p) => [close(), ema(p.fast)], grid: { fast: [5, 10], slow: [20, 50] } }).configurations, 4);
  assert.equal(myStrategy.definition.name, 'my-ema-cross');
});

test('los tramos se arman solos con la mitad final fuera de muestra; con pocas velas, se dice cuántas faltan', () => {
  const parts = makePartitions(example.candles, '1d', 100);
  assert.ok(typeof parts !== 'string');
  assert.equal(parts.tramos.length, 5);
  assert.equal(parts.purging_velas, 100);
  assert.equal(parts.test, null, 'el test final nunca se abre desde el sandbox');
  const short = makePartitions(example.candles.slice(0, 200), '1d', 100);
  assert.ok(typeof short === 'string' && /hacen falta más velas/.test(short));
});

test('el veredicto llano: suerte si falla una prueba de suerte; datos insuficientes con pocas operaciones; ventaja si pasa todas', () => {
  const checks = (statuses: Record<string, CheckResult['status']>): Map<string, CheckResult> => new Map(Object.entries(statuses).map(([id, status]) => [id, { id, name: id, status, value: null }]));
  const allPass = checks({ 'A.3.1': 'PASS', 'A.3.5': 'PASS', 'A.3.6': 'PASS', 'A.3.11': 'PASS', 'A.3.12': 'PASS' });
  assert.equal(plainVerdict(allPass, { dsr: 0.97, configurations: 1, trades: 150, sharpe: 1 }).verdict, 'edge');
  assert.deepEqual(plainVerdict(allPass, { dsr: 0.5, configurations: 1, trades: 150, sharpe: 1 }), { verdict: 'luck', reasons: ['dsr'] });
  assert.equal(plainVerdict(allPass, { dsr: 0.99, configurations: 1, trades: 40, sharpe: 2 }).verdict, 'insufficient');
  const sampleFail = checks({ 'A.3.1': 'FAIL', 'A.3.5': 'FAIL', 'A.3.11': 'FAIL', 'A.3.12': 'FAIL' });
  assert.equal(plainVerdict(sampleFail, { dsr: 0, configurations: 1, trades: 180, sharpe: -1 }).verdict, 'luck', 'perder con muchas operaciones es suerte, no falta de datos');
});

test('una ejecución del sandbox no toca el registro oficial ni su N: va a un registro local que cuenta las pruebas del usuario', async () => {
  const official = join(ROOT, ...REGISTRY_FILE.split('/'));
  const before = sha(official);
  const outputs = join(ROOT, 'docs', 'research', 'experiments', 'salidas');
  const outputsBefore = readdirSync(outputs).sort();
  const dir = mkdtempSync(join(tmpdir(), 'jp-quant-sandbox-'));
  try {
    const first = await testStrategy({ strategy: coinFlip, candles: example.candles, timeframe: '1d', dataLabel: 'ejemplo', dir });
    assert.equal(first.verdict, 'luck', 'una moneda al azar no se distingue de la suerte');
    assert.equal(previousTrials(dir, 'coin-flip'), first.localN);
    const second = await testStrategy({ strategy: coinFlip, candles: example.candles, timeframe: '1d', dataLabel: 'ejemplo', dir, controls: { simulations: 20, shifts: 2 } });
    assert.equal(second.localN, 2 * first.localN, 'repetir suma a la N local');
    assert.equal(readFileSync(join(dir, LOCAL_REGISTRY), 'utf8').trim().split('\n').length, 2);
    const html = reportHtml(first, 'en');
    assert.ok(html.includes('Indistinguishable from luck') && html.includes(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`));
    assert.doesNotMatch(html, /<script|https?:\/\/|<form/i);
    assert.ok(reportHtml(first, 'es').includes('No se distingue de la suerte'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(sha(official), before, 'el registro oficial no cambia');
  assert.deepEqual(readdirSync(outputs).sort(), outputsBefore, 'ninguna salida oficial nueva');
});

test('el código del sandbox no puede escribir en el registro oficial ni lanzar experimentos oficiales', () => {
  for (const file of readdirSync(join(ROOT, 'sandbox')).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(ROOT, 'sandbox', file), 'utf8');
    assert.doesNotMatch(text, /runExperiment|from '[^']*research\/registry\.ts'|appendFileSync\([^)]*REGISTRY_FILE|register\(|criteria\.ts'.*THRESHOLDS/, file);
  }
});

test('las velas de Kraken se convierten a CSV comprobando cada valor, sin red', () => {
  const body = { error: [], result: { XXBTZEUR: [[1704067200, '42000.1', '42500', '41000', '42400.5', '42100', '12.5', 100]], last: 1 } };
  assert.equal(krakenToCsv(body), 'time,open,high,low,close,volume\n1704067200,42000.1,42500,41000,42400.5,12.5\n');
  assert.throws(() => krakenToCsv({ error: ['EQuery:Unknown asset pair'] }), FetchError);
  assert.throws(() => krakenToCsv({ error: [], result: { X: [[1, 'x', '1', '1', '1', '1', '1']] } }), FetchError);
});
