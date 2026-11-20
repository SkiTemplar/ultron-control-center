// projects-registry.mjs — leer-modificar-escribir de cockpit/projects.json bajo
// el lock de fichero entre procesos.
//
// Hallazgo #12 (auditoría 2026-11-08): la app (projects/write_ops.rs y
// discover.rs) y los CLI project-new, project-socratic y project-remove hacían
// leer-modificar-escribir del registro sin excluirse entre procesos; el último
// rename ganaba y se perdía un alta o un `last_active` sin aviso. Ahora todos
// toman `projects.json.lock` con el protocolo de hooks/scripts/lib/file-lock.js
// (el mismo que control-center/src-tauri/src/file_lock.rs y que el kanban):
// lectura, copia previa, modificación y escritura atómica (tmp + rename) van
// dentro del lock. Si no se consigue en el plazo, `updateRegistry` lanza un
// error y no escribe nada.
//
// Solo para selftests:
//   ULTRON_PROJECTS_JSON_OVERRIDE   ruta de un registro temporal;
//   ULTRON_PROJECTS_RMW_PAUSE_MS    pausa entre la lectura y la escritura, para
//                                   ensanchar la ventana de la carrera.
//
// Selftest: scripts/projects-registry-lock.selftest.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupWithRetention, reportPruneFailures } from './registry-backup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..', '..');
const requireCjs = createRequire(import.meta.url);
const { withFileLock, renameWithRetry, lockPathFor } = requireCjs(
  join(ULTRON, 'hooks', 'scripts', 'lib', 'file-lock.js'),
);

export { lockPathFor };

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Pausa de la seam de test ULTRON_PROJECTS_RMW_PAUSE_MS (0 si no esta). */
function testPause() {
  const ms = Number(process.env.ULTRON_PROJECTS_RMW_PAUSE_MS || 0);
  if (Number.isFinite(ms) && ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

/** Ruta del registro: el override de los selftests o cockpit/projects.json. */
export function registryPath() {
  return process.env.ULTRON_PROJECTS_JSON_OVERRIDE || join(ULTRON, 'cockpit', 'projects.json');
}

/**
 * Lee y parsea el registro. Sin fichero: `{ projects: [] }` si `allowMissing`,
 * error en otro caso. No valida la forma: cada CLI exige la suya.
 */
export function readRegistry(file, { allowMissing = false } = {}) {
  if (!existsSync(file)) {
    if (allowMissing) return { projects: [] };
    throw new Error(`no existe ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeRegistryAtomic(file, doc) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameWithRetry(tmp, file);
}

/**
 * Leer-modificar-escribir del registro con `projects.json.lock` tomado.
 *
 * `mutate(actual)` devuelve el documento nuevo o `null` para no escribir. Antes
 * de escribir se hace la copia `.bak-<fecha>` con retención (registry-backup).
 * Si `mutate` llama a process.exit, file-lock.js libera el lock en 'exit'.
 *
 * @param {string} file  ruta de projects.json
 * @param {(actual: any) => any} mutate
 * @param {{tag: string, allowMissing?: boolean, lockOptions?: object}} opts
 *   tag = prefijo de los avisos; lockOptions = plazos de file-lock (selftests)
 * @returns {{doc: any, written: boolean}}
 * @throws {Error} si el lock no llega en el plazo (no se escribe nada)
 */
export function updateRegistry(file, mutate, { tag, allowMissing = false, lockOptions } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(
    file,
    () => {
      const current = readRegistry(file, { allowMissing });
      testPause();
      const next = mutate(current);
      if (next === null || next === undefined) return { doc: null, written: false };
      reportPruneFailures(tag || 'projects-registry', backupWithRetention(file));
      writeRegistryAtomic(file, next);
      return { doc: next, written: true };
    },
    lockOptions,
  );
}
