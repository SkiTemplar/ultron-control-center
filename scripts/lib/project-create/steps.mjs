// steps.mjs — piezas reusables de la orquestacion de "create": el wrapper
// runStep (dry-run vs ejecucion real) y las integraciones que reusan scripts
// de nivel superior por spawn (alta en ULTRON, modo socratico universitario,
// sesion de investigacion y tarjeta de kanban), mas los helpers de contenido
// (CLAUDE.md, tags) usados por esos pasos.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ULTRON, PROJECT_NEW_CLI, KANBAN_CLI, RESEARCH_CLI, PROJECT_SOCRATIC_CLI,
} from './paths.mjs';

function passthroughEnv() {
  return process.env;
}

export function runStep(steps, name, dryRun, plannedMessage, fn) {
  if (dryRun) {
    steps.push({ step: name, ok: true, message: plannedMessage });
    return;
  }
  try {
    const message = fn();
    steps.push({ step: name, ok: true, message: message ?? 'ok' });
  } catch (e) {
    steps.push({ step: name, ok: false, message: e.message || String(e) });
    throw e;
  }
}

export function runProjectNew(args) {
  const r = spawnSync(process.execPath, [PROJECT_NEW_CLI, ...args], {
    encoding: 'utf8', cwd: ULTRON, env: passthroughEnv(), timeout: 30_000,
  });
  if (r.error) throw new Error(`project-new.mjs no se pudo ejecutar: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`project-new.mjs fallo: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

export function addKanbanCard(projectId, title, description) {
  const r = spawnSync(process.execPath, [KANBAN_CLI, 'add', projectId, 'todo', title, description], {
    encoding: 'utf8', cwd: ULTRON, env: passthroughEnv(), timeout: 30_000,
  });
  if (r.error) throw new Error(`kanban.mjs no se pudo ejecutar: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`kanban.mjs fallo: ${(r.stderr || r.stdout || '').trim()}`);
}

/**
 * Marca un proyecto con `socratic: "uni"` (decision 2026-09-14: todo proyecto
 * creado bajo una raiz de kind "asignatura", incluido `subject new`, entra en
 * modo socratico universitario). Reusa project-socratic.mjs, el escritor
 * canonico de ese campo (backup + escritura atomica ya incluidos).
 */
export function setSocraticUni(projectId) {
  const r = spawnSync(process.execPath, [PROJECT_SOCRATIC_CLI, projectId, 'uni'], {
    encoding: 'utf8', cwd: ULTRON, env: passthroughEnv(), timeout: 30_000,
  });
  if (r.error) throw new Error(`project-socratic.mjs no se pudo ejecutar: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`project-socratic.mjs fallo: ${(r.stderr || r.stdout || '').trim()}`);
}

export function runResearchSessionNew(topic) {
  const r = spawnSync(process.execPath, [RESEARCH_CLI, 'session', 'new', topic], {
    encoding: 'utf8', cwd: ULTRON, env: passthroughEnv(), timeout: 30_000,
  });
  if (r.error) throw new Error(`research.mjs no se pudo ejecutar: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`research.mjs fallo: ${(r.stderr || r.stdout || '').trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { id: null, dir: null };
  }
}

export function buildClaudeMd(name, template) {
  const stack = (template.requires || []).length ? template.requires.join(', ') : 'sin dependencias declaradas';
  return `# CLAUDE.md — ${name}

## Que es

${template.description || template.label || template.id}

## Stack

Plantilla: ${template.id} (${template.source}). Dependencias: ${stack}.

## Como compilar / ejecutar

Ver README.md de este proyecto.

## Tests

Pendiente de definir.
`;
}

export function buildTags(templateId, root, extraTagsCsv) {
  const tags = new Set([templateId]);
  if (root.kind === 'asignatura') tags.add('asignatura');
  if (extraTagsCsv) {
    for (const t of extraTagsCsv.split(',').map((s) => s.trim()).filter(Boolean)) tags.add(t);
  }
  return [...tags];
}

export function findContainingSubjectProject(root, sub, registry) {
  if (root.kind !== 'asignatura' || !sub) return null;
  const firstSeg = sub.split('/')[0];
  const subjectDir = resolve(root.path, firstSeg);
  return registry.projects.find((p) => resolve(p.path) === subjectDir) || null;
}
