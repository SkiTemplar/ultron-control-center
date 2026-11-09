'use strict';
/**
 * lib/project-tracker.js — tracker de tareas de un proyecto.
 *
 * Por defecto las tareas de un proyecto viven en el kanban de ULTRON
 * (cockpit/projects/<id>/kanban.json). Un proyecto puede declarar que su
 * unica lista de tareas esta fuera (un GitHub Project, por ejemplo) con la
 * etiqueta `tracker:<nombre>` en su entrada de cockpit/projects.json:
 *
 *   "tags": ["tracker:github"]
 *
 * Se usa una etiqueta y no una clave nueva porque `tags` es un campo que el
 * Control Center ya conoce y conserva al reescribir el registro.
 *
 * Con tracker externo, el SessionStart no inyecta los pendientes de las
 * bitacoras (lib/project-state.js).
 *
 * Fail-safe: sin registro, con JSON roto o sin etiqueta devuelve ''.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAG_PREFIX = 'tracker:';

function registryPath() {
  if (process.env.PROJECT_TRACKER_REGISTRY_OVERRIDE) return process.env.PROJECT_TRACKER_REGISTRY_OVERRIDE;
  const root = process.env.ULTRON_ROOT || path.join(os.homedir(), '.ultron');
  return path.join(root, 'cockpit', 'projects.json');
}

function readProjects(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : (raw && raw.projects) || [];
}

/** Nombre del tracker externo del proyecto (`github`, ...) o '' si usa el kanban de ULTRON. */
function externalTrackerFor(projectId, file = registryPath()) {
  const id = String(projectId || '').trim().toLowerCase();
  if (!id) return '';
  try {
    const entry = readProjects(file).find((p) => p && String(p.id || '').trim().toLowerCase() === id);
    const tags = entry && Array.isArray(entry.tags) ? entry.tags : [];
    const tag = tags.map((t) => String(t).trim().toLowerCase()).find((t) => t.startsWith(TAG_PREFIX));
    return tag ? tag.slice(TAG_PREFIX.length) : '';
  } catch {
    return '';
  }
}

const MANUAL_KANBAN_TAG = 'kanban:manual';

/**
 * true si el proyecto lleva la etiqueta `kanban:manual`: su tablero lo mueve
 * solo el usuario y lib/kanban-auto.js no lo toca (p. ej., el macro kanban
 * `proyectos`). Fail-safe: sin registro o con JSON roto, false.
 */
function isManualKanban(projectId, file = registryPath()) {
  const id = String(projectId || '').trim().toLowerCase();
  if (!id) return false;
  try {
    const entry = readProjects(file).find((p) => p && String(p.id || '').trim().toLowerCase() === id);
    const tags = entry && Array.isArray(entry.tags) ? entry.tags : [];
    return tags.some((t) => String(t).trim().toLowerCase() === MANUAL_KANBAN_TAG);
  } catch {
    return false;
  }
}

module.exports = { TAG_PREFIX, MANUAL_KANBAN_TAG, registryPath, externalTrackerFor, isManualKanban };
