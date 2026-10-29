// Sello exportado para los README (2026-10-29): docs/assets/seal.svg es el de la cabecera de la demo, sin fondo, y
// docs/assets/seal-512.png es su imagen de 512 × 512 con transparencia.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { sealFile } from '../../src/app/seal-command.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('docs/assets/seal.svg es exactamente el sello de la cabecera, sin fondo', () => {
  assert.equal(readFileSync(resolve(ROOT, 'docs', 'assets', 'seal.svg'), 'utf8'), sealFile(false, true));
});

test('docs/assets/seal-512.png mide 512 × 512, tiene canal alfa y la esquina es transparente', () => {
  const png = readFileSync(resolve(ROOT, 'docs', 'assets', 'seal-512.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[24], 8, '8 bits por canal');
  assert.equal(png[25], 6, 'RGBA');
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  // El primer píxel de la primera fila no depende de ningún vecino con ningún filtro: su alfa es el byte tal cual.
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw[1 + 3], 0, 'la esquina superior izquierda es transparente');
});
