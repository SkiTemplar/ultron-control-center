// registry-backup.mjs — copia previa de un fichero de registro con retención.
//
// Hallazgo N5 (auditoría 2026-10-23): project-socratic.mjs dejaba un
// `projects.json.bak-<fecha>` por escritura y nadie los borraba (36 copias en
// cockpit/). Los escritores del registro (project-new, project-remove,
// project-socratic) crean ahora la copia con esta función, que conserva las
// `keep` más recientes por fecha de modificación. Cuenta toda copia del
// fichero (`<fichero>.bak` y `<fichero>.bak-*`, también las hechas a mano);
// no toca `.tmp` ni copias de otros ficheros.
//
// Selftest: scripts/lib/registry-backup.selftest.mjs

import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_KEEP = 10;

function isBackupOf(name, base) {
  return name === `${base}.bak` || name.startsWith(`${base}.bak-`);
}

/**
 * Borra las copias de `file` que sobran por encima de `keep` (las más
 * antiguas por mtime). Devuelve lo borrado y lo que no se pudo borrar.
 */
export function pruneBackups(file, keep = DEFAULT_KEEP) {
  const dir = dirname(file);
  const base = basename(file);
  const copies = readdirSync(dir)
    .filter((name) => isBackupOf(name, base))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  const pruned = [];
  const failed = [];
  for (const { name } of copies.slice(Math.max(keep, 0))) {
    try {
      unlinkSync(join(dir, name));
      pruned.push(name);
    } catch (err) {
      failed.push({ name, error: err.message });
    }
  }
  return { pruned, failed };
}

/**
 * Copia `file` a `<file>.bak-<ISO>` y poda las copias antiguas. Si la copia
 * falla lanza la excepción: el llamante no debe escribir el registro sin
 * copia previa. Sin fichero no hace nada.
 */
export function backupWithRetention(file, { keep = DEFAULT_KEEP, now = new Date() } = {}) {
  if (!existsSync(file)) return { backup: null, pruned: [], failed: [] };
  const backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(file, backup);
  return { backup, ...pruneBackups(file, keep) };
}

/** Avisa por stderr de las copias que no se pudieron podar (no aborta). */
export function reportPruneFailures(tag, result) {
  for (const f of result.failed) {
    process.stderr.write(`[${tag}] aviso: no se pudo podar ${f.name}: ${f.error}\n`);
  }
}
