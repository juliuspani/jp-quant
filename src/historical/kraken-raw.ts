// Ficheros brutos de Kraken y la guarda (paso 19B, ADR 0022). El periodo de cada fichero sale de su nombre
// (krakenRawPeriod) y la guarda decide: lo que pasa de researchDataEndUtc, como el ZIP trimestral 2026Q4, no se lee ni
// se descarga sin el desbloqueo del ADR 0020. Un nombre sin periodo conocido se rechaza: fail closed.
import { basename, join } from 'node:path';
import type { RawPeriod, TestFinalGuard } from './guard.ts';
import { krakenRawPeriod } from './kraken.ts';

export const KRAKEN_ASSETS_URL = 'https://assets.kraken.com/marketing/institutions/';
export const KRAKEN_API_URL = 'https://api.kraken.com/0/public/';
const KRAKEN_DIR = 'kraken';

function periodOf(fileName: string): RawPeriod {
  const period = krakenRawPeriod(fileName);
  if (period === null) throw new RangeError(`${fileName}: nombre sin periodo conocido; no se lee ni se descarga`);
  return period;
}

/** Destino de una descarga, decidido por la guarda antes de hacer ninguna petición. */
export function krakenDownloadPath(guard: TestFinalGuard, fileName: string): string {
  if (basename(fileName) !== fileName) throw new RangeError(`${fileName}: solo un nombre de fichero, sin carpetas`);
  return guard.rawDownloadPath(join(KRAKEN_DIR, fileName), periodOf(fileName));
}

/** Ruta de un fichero bruto que se va a leer, comprobada por la guarda antes de abrirlo. */
export function krakenRawForReading(guard: TestFinalGuard, path: string): string {
  return guard.rawFileForReading(path, periodOf(basename(path)));
}
