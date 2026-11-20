#!/usr/bin/env node
'use strict';
/**
 * project-socratic.mjs - modo del gate socratico por proyecto (ULTRON 4, F4.3).
 *
 * Escribe el campo `socratic` (strict | light | off | uni) en la entrada del
 * proyecto de cockpit/projects.json. Ausente = strict (decision Q5a). El hook
 * socratic-gate.js lo lee por el cwd de la sesion; las subcarpetas heredan.
 * `uni` (2026-09-14): lo aplica project-create.mjs a todo proyecto creado
 * bajo una raiz de kind "asignatura" (incluido `subject new`).
 *
 * Uso:
 *   node scripts/project-socratic.mjs <id> <strict|light|off|uni>
 *   node scripts/project-socratic.mjs --list
 *
 * ULTRON_PROJECTS_JSON_OVERRIDE (solo para selftests, mismo mecanismo que en
 * project-new.mjs / kanban.mjs) apunta a un projects.json temporal.
 *
 * La escritura va con el lock de fichero projects.json.lock compartido con la
 * app y con los demas CLI (lib/projects-registry.mjs; auditoria 2026-11-08, #12).
 */

import { existsSync } from 'node:fs';
import { readRegistry, registryPath, updateRegistry } from './lib/projects-registry.mjs';

const REGISTRY = registryPath();
const MODES = new Set(['strict', 'light', 'off', 'uni']);

function fail(msg) {
  console.error(`[project-socratic] ERROR: ${msg}`);
  process.exit(1);
}

const projectsOf = (raw) => (Array.isArray(raw) ? raw : raw.projects || []);

if (!existsSync(REGISTRY)) fail(`no existe ${REGISTRY}`);
const [id, mode] = process.argv.slice(2);

if (id === '--list' || !id) {
  for (const p of projectsOf(readRegistry(REGISTRY))) console.log(`${(p.socratic || 'strict').padEnd(7)} ${p.id}`);
  if (!id) console.log('\nUso: node scripts/project-socratic.mjs <id> <strict|light|off|uni>');
  process.exit(0);
}
if (!MODES.has(mode)) fail(`modo "${mode}" no valido (strict | light | off | uni)`);

try {
  updateRegistry(
    REGISTRY,
    (raw) => {
      const projects = projectsOf(raw);
      if (!projects.some((p) => p.id === id)) {
        fail(`proyecto "${id}" no registrado (ids: ${projects.map((p) => p.id).join(', ')})`);
      }
      const updated = projects.map((p) => (p.id === id ? { ...p, socratic: mode } : p));
      return Array.isArray(raw) ? updated : { ...raw, projects: updated };
    },
    { tag: 'project-socratic' },
  );
} catch (e) {
  fail(e.message);
}
console.log(`[project-socratic] ${id}: socratic = ${mode}`);
