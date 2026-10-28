// Archivos que acompañan a la salida de un experimento (paso 41C, ADR 0047; aprobado por la persona el 2026-10-27):
// - EXP-NNNN.controles.json, junto a la salida en docs/research/experiments/salidas/: las curvas del control aleatorio en
//   formato inversor-controles/1, para la vista «¿suerte o ventaja?» del dashboard. Se versiona como la salida.
// - Con --diarios, el diario de cada tramo (EXP-NNNN.tramo-K.jsonl) y su ficha para el dashboard. Llevan datos reales, así
//   que solo se escriben en una carpeta que git ignora: nunca se versionan ni se publican (CLAUDE.md §1).
// Cada archivo se comprueba contra la huella que el ejecutor puso en la salida (cubierta por el hash_salida) y no se
// sobrescribe nunca. Solo escribe: no ejecuta nada.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Artefacts, ExperimentSpec } from '../research/experiment.ts';
import { canonicalJson, sha256Hex } from '../shared/canonical.ts';
import { LUCK_FORMAT } from './research-view.ts';

export class ArtefactError extends Error {
  override readonly name = 'ArtefactError';
}

interface Prints {
  readonly controls: string | null;
  readonly journals: readonly string[];
}

/** Las huellas que el ejecutor dejó en salida.archivos. */
function printsOf(salida: unknown): Prints {
  const files = typeof salida === 'object' && salida !== null && 'archivos' in salida ? salida.archivos : null;
  if (typeof files !== 'object' || files === null || !('controles' in files) || !('diarios_sha256' in files)) throw new ArtefactError('la salida no trae las huellas de sus archivos');
  const { controles, diarios_sha256: journals } = files;
  const controls = typeof controles === 'object' && controles !== null && 'sha256' in controles ? controles.sha256 : undefined;
  if (controls !== null && typeof controls !== 'string') throw new ArtefactError('salida.archivos.controles.sha256 no es una huella');
  if (!Array.isArray(journals) || !journals.every((h) => typeof h === 'string')) throw new ArtefactError('salida.archivos.diarios_sha256 no es una lista de huellas');
  return { controls, journals };
}

/** El archivo de curvas del control, o null si el ejecutor no las guardó (por ejemplo, simulador no válido). */
export function controlsText(id: string, salida: unknown, artefacts: Artefacts): string | null {
  const prints = printsOf(salida);
  if (artefacts.controles === null) {
    if (prints.controls !== null) throw new ArtefactError(`${id}: la salida espera curvas del control y no hay`);
    return null;
  }
  if (typeof artefacts.controles !== 'object' || sha256Hex(canonicalJson(artefacts.controles)) !== prints.controls) {
    throw new ArtefactError(`${id}: las curvas del control no coinciden con su huella en la salida`);
  }
  return `${canonicalJson({ formato: LUCK_FORMAT, experimentos: [{ id, ...artefacts.controles }] })}\n`;
}

/** La ficha del dashboard de un tramo, con datos reales: la estrategia, los parámetros de ese tramo y los costes. */
export function journalCard(id: string, fold: number, spec: Pick<ExperimentSpec, 'estrategia' | 'costes' | 'datos'>, parametros: Readonly<Record<string, unknown>>): string {
  for (const [key, value] of Object.entries(parametros)) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new ArtefactError(`${id}: el parámetro ${key} no es texto ni número`);
  }
  const { costes } = spec;
  if (costes === null) throw new ArtefactError(`${id}: sin costes`);
  return `${JSON.stringify({
    etiqueta: `${id} · tramo ${String(fold)} · ${spec.estrategia.nombre}@${spec.estrategia.version} (datos reales: solo en local)`,
    datos: 'reales',
    estrategia: { id: spec.estrategia.nombre, version: spec.estrategia.version, parametros },
    temporalidad: spec.datos.timeframe,
    costes: { commission: costes.comision, halfSpread: costes.spread, minSlippage: costes.slippage, multiplier: costes.multiplicador },
    referencia: 'BTC/EUR',
    planB: { objetivo: null, proximoRebalanceo: null },
  }, null, 2)}\n`;
}

/** Escribe el archivo de curvas junto a la salida; null si no hay curvas. Nunca sobrescribe. */
export function writeControls(outputsDir: string, id: string, salida: unknown, artefacts: Artefacts): string | null {
  const text = controlsText(id, salida, artefacts);
  if (text === null) return null;
  const path = join(outputsDir, `${id}.controles.json`);
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
  return path;
}

/**
 * Escribe el diario de cada tramo y su ficha en `dir`, que git tiene que ignorar (`isIgnored`): llevan datos reales.
 * Comprueba cada diario contra su huella en la salida. Nunca sobrescribe.
 */
export function writeJournals(dir: string, isIgnored: (path: string) => boolean, id: string, spec: Pick<ExperimentSpec, 'estrategia' | 'costes' | 'datos'>, salida: unknown, artefacts: Artefacts): string[] {
  const prints = printsOf(salida);
  if (prints.journals.length !== artefacts.diarios.length) throw new ArtefactError(`${id}: ${String(artefacts.diarios.length)} diarios para ${String(prints.journals.length)} huellas`);
  artefacts.diarios.forEach((journal, i) => {
    if (sha256Hex(journal.texto) !== prints.journals[i]) throw new ArtefactError(`${id}: el diario del tramo ${String(i)} no coincide con su huella`);
  });
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `${id}.tramo-0.jsonl`);
  if (!isIgnored(probe)) throw new ArtefactError(`${dir}: los diarios llevan datos reales y solo se escriben en una carpeta que git ignora`);
  return artefacts.diarios.flatMap((journal, i) => {
    const base = join(dir, `${id}.tramo-${String(i)}`);
    writeFileSync(`${base}.jsonl`, journal.texto, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    writeFileSync(`${base}.ficha.json`, journalCard(id, i, spec, journal.parametros), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return [`${base}.jsonl`, `${base}.ficha.json`];
  });
}
