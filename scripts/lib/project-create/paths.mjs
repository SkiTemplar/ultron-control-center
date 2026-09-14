// paths.mjs — rutas base del creador de proyectos.
//
// Este fichero vive en scripts/lib/project-create/, tres niveles por debajo
// de la raiz de ULTRON (project-create/ -> lib/ -> scripts/ -> ULTRON).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ULTRON = join(__dirname, '..', '..', '..');
export const SCRIPTS_DIR = join(ULTRON, 'scripts');
export const COCKPIT = join(ULTRON, 'cockpit');
export const TEMPLATES_DIR = join(ULTRON, 'templates');

// Scripts de nivel superior reusados via spawn (parsean process.argv y llaman
// a process.exit al cargar: no son seguros de importar como modulo).
export const PROJECT_NEW_CLI = join(SCRIPTS_DIR, 'project-new.mjs');
export const KANBAN_CLI = join(SCRIPTS_DIR, 'kanban.mjs');
export const RESEARCH_CLI = join(SCRIPTS_DIR, 'research.mjs');
export const PROJECT_SOCRATIC_CLI = join(SCRIPTS_DIR, 'project-socratic.mjs');
