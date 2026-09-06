#!/usr/bin/env node
'use strict';
/**
 * project-socratic.mjs - modo del gate socratico por proyecto (ULTRON 4, F4.3).
 *
 * Escribe el campo `socratic` (strict | light | off) en la entrada del
 * proyecto de cockpit/projects.json. Ausente = strict (decision Q5a). El hook
 * socratic-gate.js lo lee por el cwd de la sesion; las subcarpetas heredan.
 *
 * Uso:
 *   node scripts/project-socratic.mjs <id> <strict|light|off>
 *   node scripts/project-socratic.mjs --list
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(__dirname, '..', 'cockpit', 'projects.json');
const MODES = new Set(['strict', 'light', 'off']);

function fail(msg) {
  console.error(`[project-socratic] ERROR: ${msg}`);
  process.exit(1);
}

if (!existsSync(REGISTRY)) fail(`no existe ${REGISTRY}`);
const raw = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const projects = Array.isArray(raw) ? raw : raw.projects || [];
const [id, mode] = process.argv.slice(2);

if (id === '--list' || !id) {
  for (const p of projects) console.log(`${(p.socratic || 'strict').padEnd(7)} ${p.id}`);
  if (!id) console.log('\nUso: node scripts/project-socratic.mjs <id> <strict|light|off>');
  process.exit(0);
}
if (!MODES.has(mode)) fail(`modo "${mode}" no valido (strict | light | off)`);
const entry = projects.find((p) => p.id === id);
if (!entry) fail(`proyecto "${id}" no registrado (ids: ${projects.map((p) => p.id).join(', ')})`);

const updated = projects.map((p) => (p.id === id ? { ...p, socratic: mode } : p));
const doc = Array.isArray(raw) ? updated : { ...raw, projects: updated };
copyFileSync(REGISTRY, `${REGISTRY}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const tmp = `${REGISTRY}.tmp`;
writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
renameSync(tmp, REGISTRY);
console.log(`[project-socratic] ${id}: socratic = ${mode}`);
