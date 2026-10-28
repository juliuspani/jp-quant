// Huella de un árbol de datos (ADR 0020): SHA-256 de la lista ordenada de rutas relativas y SHA-256 de cada archivo.
// Es el valor de dataHash del candado; para los datos del test final lo calcula la persona.
//   node scripts/hash-dataset.ts <carpeta>
import { treeSha256 } from '../src/historical/store.ts';

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  process.stderr.write('uso: node scripts/hash-dataset.ts <carpeta>\n');
  process.exit(1);
}
process.stdout.write(`${treeSha256(dir)}\n`);
