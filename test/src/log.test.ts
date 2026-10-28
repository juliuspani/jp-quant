// El logger tacha los secretos y no deja pasar en silencio un fallo al persistir un evento.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { log, registerSecret, setLogSink } from '../../src/log.ts';

afterEach(() => setLogSink(null));

test('tacha un secreto registrado en la consola y en el sink', (t) => {
  const printed = t.mock.method(console, 'log', () => {});
  const stored: string[] = [];
  setLogSink((_level, _kind, message) => stored.push(message));
  registerSecret('clave-secreta-123');
  log('info', 'prueba', 'fallo con clave-secreta-123');
  assert.match(String(printed.mock.calls[0]?.arguments[0]), /fallo con \*\*\*$/);
  assert.deepEqual(stored, ['fallo con ***']);
});

// Valores inventados con la forma de un secreto real: nadie los registra, y aun así no pueden salir.
test('tacha sin registrarlos los secretos con forma conocida', (t) => {
  const printed = t.mock.method(console, 'log', () => {});
  const stored: string[] = [];
  setLogSink((_level, _kind, message) => stored.push(message));
  const cases: [string, string][] = [
    ['https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ/getUpdates', 'https://api.telegram.org/bot***/getUpdates'],
    ['clave sk-ant-api03-abcdefghijklmnopqrstuvwxyz rechazada', 'clave *** rechazada'],
    ['Authorization: Bearer eyJhbGciOi.payload.firma', 'Authorization: Bearer ***'],
    ['https://usuario:contrasena-falsa@hc-ping.example/uuid', 'https://usuario:***@hc-ping.example/uuid'],
    ['GET /api/v3/order?symbol=BTCUSDT&signature=0a1b2c3d4e5f&apiKey=abcdef123456', 'GET /api/v3/order?symbol=BTCUSDT&signature=***&apiKey=***'],
    ['{"X-MBX-APIKEY":"vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A"}', '{"X-MBX-APIKEY":"***"}'],
    ['EXCHANGE_API_SECRET=valor-falso TELEGRAM_BOT_TOKEN=otro-valor', 'EXCHANGE_API_SECRET=*** TELEGRAM_BOT_TOKEN=***'],
    ['{ password: "hunter2-falso", passphrase: frase-falsa }', '{ password: "***", passphrase: *** }'],
  ];
  for (const [input, expected] of cases) {
    log('info', 'prueba', input);
    assert.equal(stored.at(-1), expected);
    assert.ok(String(printed.mock.calls.at(-1)?.arguments[0]).endsWith(expected), `la consola no tacha: ${input}`);
  }
});

test('no tacha texto normal que solo nombra un secreto', (t) => {
  t.mock.method(console, 'log', () => {});
  const stored: string[] = [];
  setLogSink((_level, _kind, message) => stored.push(message));
  const plain = 'Modo live sin EXCHANGE_API_KEY en el gestor de secretos; tokens usados: 3; precio 64250.5';
  log('info', 'prueba', plain);
  assert.deepEqual(stored, [plain]);
});

test('un sink que falla no lanza, pero se avisa por la salida de errores', (t) => {
  t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  setLogSink(() => {
    throw new Error('base de datos cerrada');
  });
  assert.doesNotThrow(() => log('info', 'prueba', 'evento'));
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /\[ERROR\] log: .*base de datos cerrada/);
});
