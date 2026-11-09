#!/usr/bin/env node
'use strict';
/**
 * Puente entre los mods de Claude Code y ULTRON.
 *
 * Los mods corren en un entorno sin Node: lo que necesita las librerías de
 * ~/.ultron (identidad de proyecto, detección de tono) lo resuelve este script
 * por `$.process.run` y devuelve JSON por stdout.
 *
 *   node ultron.cjs project <cwd>    -> { id, name, socratic, color, boardPath, ultronHome }
 *   node ultron.cjs tone < prompt    -> { id, isDefault, verbs }
 *   node ultron.cjs boards           -> [{ id, name, boardPath }]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ULTRON_HOME = process.env.ULTRON_HOME || path.join(os.homedir(), '.ultron');
const LIB = path.join(ULTRON_HOME, 'hooks', 'scripts', 'lib');
const PROJECTS_DIR = path.join(ULTRON_HOME, 'cockpit', 'projects');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function registeredProjects() {
  const reg = readJson(path.join(ULTRON_HOME, 'cockpit', 'projects.json'), {});
  return Array.isArray(reg.projects) ? reg.projects : [];
}

function boardPathOf(id) {
  const file = path.join(PROJECTS_DIR, id, 'kanban.json');
  return fs.existsSync(file) ? file : null;
}

function project(cwd) {
  const { resolveProjectId } = require(path.join(LIB, 'project-identity.js'));
  const id = resolveProjectId(cwd);
  const entry = registeredProjects().find((p) => p.id === id) || null;
  return {
    id,
    name: (entry && entry.name) || id,
    socratic: (entry && entry.socratic) || 'strict',
    color: (entry && entry.color) || null,
    boardPath: boardPathOf(id),
    ultronHome: ULTRON_HOME,
  };
}

function boards() {
  const names = new Map(registeredProjects().map((p) => [p.id, p.name || p.id]));
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  return dirs
    .map((d) => ({ id: d.name, name: names.get(d.name) || d.name, boardPath: boardPathOf(d.name) }))
    .filter((b) => b.boardPath !== null);
}

function verbsFor(toneId) {
  const map = readJson(path.join(ULTRON_HOME, 'cockpit', 'tone-status.json'), {});
  const value = toneId ? map[toneId] : undefined;
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.map(String) : [];
}

function tone(prompt) {
  const { detectForPrompt, loadPersonality } = require(path.join(LIB, 'tone-detect.js'));
  const chosen = detectForPrompt(prompt);
  const personality = loadPersonality();
  const id = (chosen && chosen.id) || (personality && personality.default_tone) || null;
  return { id, isDefault: !chosen, verbs: verbsFor(id) };
}

function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === 'project') return project(arg || process.cwd());
  if (command === 'boards') return boards();
  if (command === 'tone') return tone(fs.readFileSync(0, 'utf8'));
  throw new Error(`comando desconocido: ${command || '(ninguno)'}`);
}

try {
  process.stdout.write(JSON.stringify(main()));
} catch (err) {
  process.stderr.write(String((err && err.message) || err));
  process.exit(1);
}
