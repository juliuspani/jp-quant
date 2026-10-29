// Exporta el sello del proyecto (paso 41C) a un archivo .svg, para el README y la imagen de vista previa del paso 49.
// No sobrescribe: si el archivo ya existe, falla sin tocarlo (la lección de SEC-04 del ADR 0045).
//
// Uso: npm run sello -- --salida <sello.svg> [--pequeno] [--transparente]
// Con --transparente, sin el fondo: el sello tal cual se ve en la cabecera de la demo (docs/assets/seal.svg).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sealSvg } from '../monitoring/seal.ts';

const USAGE = 'Uso: npm run sello -- --salida <sello.svg> [--pequeno] [--transparente]\n';

export class SealCommandError extends Error {
  override readonly name = 'SealCommandError';
}

/** El texto del archivo: el SVG autocontenido, con el acento fijo y con fondo salvo que sea transparente. */
export function sealFile(small: boolean, transparent = false): string {
  return `${sealSvg({ small, standalone: true, transparent })}\n`;
}

function main(): void {
  const { values } = parseArgs({ options: { salida: { type: 'string' }, pequeno: { type: 'boolean', default: false }, transparente: { type: 'boolean', default: false } } });
  if (values.salida === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!values.salida.toLowerCase().endsWith('.svg')) throw new SealCommandError('la salida debe ser un archivo .svg');
  writeFileSync(values.salida, sealFile(values.pequeno, values.transparente), { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`sello: ${values.salida}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`sello: ${message.replace(/\p{Cc}/gu, '?')}\n`);
    process.exitCode = 1;
  }
}
