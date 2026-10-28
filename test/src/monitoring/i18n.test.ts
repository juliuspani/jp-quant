// Idioma de la página (paso 49, revisión pública): español por defecto, inglés dentro de withLang, que siempre restaura.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { day, grouped, money } from '../../../src/monitoring/html-kit.ts';
import { lang, phrase, t, withLang } from '../../../src/monitoring/i18n.ts';
import type { UtcMillis } from '../../../src/shared/time.ts';

test('español por defecto; withLang cambia el idioma solo mientras dura y lo restaura aunque algo lance', () => {
  assert.equal(lang(), 'es');
  assert.equal(withLang('en', () => t('hola', 'hello')), 'hello');
  assert.equal(t('hola', 'hello'), 'hola');
  assert.throws(() => withLang('en', () => {
    throw new Error('x');
  }));
  assert.equal(lang(), 'es');
});

test('cifras y fechas en el formato de cada idioma', () => {
  assert.equal(grouped('-1234567.5'), '−1.234.567,5');
  assert.equal(withLang('en', () => grouped('-1234567.5')), '−1,234,567.5');
  assert.equal(money('10213.554'), '10.213,55');
  assert.equal(withLang('en', () => money('10213.554')), '10,213.55');
  const at = Date.UTC(2024, 0, 21, 12) as UtcMillis;
  assert.equal(day(at), '21 ene 2024');
  assert.equal(withLang('en', () => day(at)), '21 Jan 2024');
});

test('los motivos conocidos del diario se traducen en inglés; los demás, tal cual', () => {
  assert.equal(phrase('cierre sobre la EMA'), 'cierre sobre la EMA');
  assert.equal(withLang('en', () => phrase('cierre sobre la EMA')), 'close above the EMA');
  assert.equal(withLang('en', () => phrase('rebalanceo: 3.2 % por encima del objetivo')), 'rebalance: 3.2 % above target');
  assert.equal(withLang('en', () => phrase('un motivo nuevo')), 'un motivo nuevo');
});
