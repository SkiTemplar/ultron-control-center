#!/usr/bin/env node
'use strict';
/**
 * kanban.mjs - CLI de gestion de cards del Kanban de ULTRON.
 *
 * Fuente de verdad: cockpit/projects/<proyecto>/kanban.json (lo lee el backend
 * Tauri al cargar la zona Kanban). Este script hace CRUD sobre ese JSON con el
 * schema correcto (Card: id, column_id, title, description, tags, order,
 * created_at, updated_at) sin tener que reinventarlo a mano cada vez.
 *
 * Las columnas se referencian por ROL (todo|doing|blocked|done), no por id,
 * porque los ids son largos y volatiles; el rol es estable. El backend
 * normaliza `order` al cargar, asi que no hace falta que sea perfecto.
 *
 * Uso:
 *   node scripts/kanban.mjs list   [proyecto]
 *   node scripts/kanban.mjs add    <proyecto> <todo|doing|blocked|done> "titulo" ["desc"] [--tags a,b]
 *   node scripts/kanban.mjs mv     <proyecto> "<id|substr-titulo>" <todo|doing|blocked|done>
 *   node scripts/kanban.mjs rm     <proyecto> "<id|substr-titulo>"
 *   node scripts/kanban.mjs archive-done <proyecto>   (mueve las Done a archives/<fecha>.json)
 *
 * Proyecto por defecto: "ultron" (el kanban principal del producto).
 * Ejemplos:
 *   node scripts/kanban.mjs add ultron backlog "cat3 2a key Groq" "fallback 11.4%" --tags cat3,blocked
 *   node scripts/kanban.mjs mv  ultron "cat3 2a key" blocked
 *   node scripts/kanban.mjs rm  ultron "card-1712..."
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
const PROJECTS = join(ULTRON, 'cockpit', 'projects');

function boardPath(proj) {
  return join(PROJECTS, proj, 'kanban.json');
}

function loadBoard(proj) {
  const p = boardPath(proj);
  if (!existsSync(p)) {
    fail(`kanban.json no existe para el proyecto "${proj}" (${p})`);
  }
  return { path: p, board: JSON.parse(readFileSync(p, 'utf8')) };
}

function saveBoard(path, board) {
  writeFileSync(path, JSON.stringify(board, null, 2) + '\n', 'utf8');
}

function colByRole(board, role) {
  const col = (board.columns || []).find((c) => c.role === role);
  if (!col) fail(`no hay columna con rol "${role}" (roles: ${(board.columns || []).map((c) => c.role).join(', ')})`);
  return col;
}

function findCard(board, needle) {
  const cards = board.cards || [];
  let hit = cards.find((c) => c.id === needle);
  if (hit) return hit;
  const low = needle.toLowerCase();
  const matches = cards.filter((c) => (c.title || '').toLowerCase().includes(low));
  if (matches.length === 0) fail(`ninguna card matchea "${needle}"`);
  if (matches.length > 1) {
    fail(`"${needle}" es ambiguo (${matches.length} matches):\n` + matches.map((m) => `  - ${m.title}`).join('\n'));
  }
  return matches[0];
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseTags(args) {
  const i = args.indexOf('--tags');
  if (i === -1) return [];
  return (args[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function roleLabel(board, columnId) {
  const c = (board.columns || []).find((x) => x.id === columnId);
  return c ? c.name : '?';
}

function fail(msg) {
  console.error(`[kanban] ERROR: ${msg}`);
  process.exit(1);
}

// --- comandos --------------------------------------------------------------

function cmdList(proj) {
  const { board } = loadBoard(proj);
  const byRole = { todo: [], doing: [], blocked: [], done: [], other: [] };
  for (const c of board.cards || []) {
    const col = (board.columns || []).find((x) => x.id === c.column_id);
    const role = col ? col.role : 'other';
    (byRole[role] || byRole.other).push(c);
  }
  const order = ['doing', 'todo', 'blocked', 'done'];
  for (const role of order) {
    const list = byRole[role];
    if (!list || !list.length) continue;
    const colName = (board.columns.find((c) => c.role === role) || {}).name || role;
    console.log(`\n=== ${colName} (${list.length}) ===`);
    for (const c of list) {
      const tags = (c.tags || []).length ? `  [${c.tags.join(',')}]` : '';
      console.log(`  ${c.id}  ${c.title}${tags}`);
    }
  }
  console.log(`\ntotal: ${(board.cards || []).length} cards en "${proj}"`);
}

function cmdAdd(proj, role, title, desc, tags) {
  const { path, board } = loadBoard(proj);
  const col = colByRole(board, role);
  const ts = nowIso();
  const card = {
    id: newId(),
    column_id: col.id,
    title,
    description: desc || '',
    agent: null,
    prompt_template: null,
    cwd: null,
    tags: tags || [],
    order: (board.cards || []).filter((c) => c.column_id === col.id).length,
    created_at: ts,
    updated_at: ts,
    runs: [],
  };
  board.cards = board.cards || [];
  board.cards.push(card);
  saveBoard(path, board);
  console.log(`[kanban] + ${col.name}: ${title}  (${card.id})`);
}

function cmdMv(proj, needle, role) {
  const { path, board } = loadBoard(proj);
  const card = findCard(board, needle);
  const col = colByRole(board, role);
  const from = roleLabel(board, card.column_id);
  card.column_id = col.id;
  card.updated_at = nowIso();
  saveBoard(path, board);
  console.log(`[kanban] ${card.title}: ${from} -> ${col.name}`);
}

function cmdRm(proj, needle) {
  const { path, board } = loadBoard(proj);
  const card = findCard(board, needle);
  board.cards = (board.cards || []).filter((c) => c.id !== card.id);
  saveBoard(path, board);
  console.log(`[kanban] - eliminada: ${card.title}  (${card.id})`);
}

function cmdArchiveDone(proj) {
  const { path, board } = loadBoard(proj);
  const doneCol = colByRole(board, 'done');
  const done = (board.cards || []).filter((c) => c.column_id === doneCol.id);
  if (!done.length) {
    console.log('[kanban] no hay cards en Done para archivar');
    return;
  }
  const archDir = join(PROJECTS, proj, 'archives');
  if (!existsSync(archDir)) mkdirSync(archDir, { recursive: true });
  const stamp = nowIso().slice(0, 10);
  const archPath = join(archDir, `${stamp}-archive.json`);
  let existing = [];
  if (existsSync(archPath)) {
    try { existing = JSON.parse(readFileSync(archPath, 'utf8')); } catch { existing = []; }
  }
  writeFileSync(archPath, JSON.stringify(existing.concat(done), null, 2) + '\n', 'utf8');
  board.cards = (board.cards || []).filter((c) => c.column_id !== doneCol.id);
  saveBoard(path, board);
  console.log(`[kanban] archivadas ${done.length} cards Done -> ${archPath}`);
}

// --- dispatch --------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const DEFAULT_PROJ = 'ultron';

switch (cmd) {
  case 'list':
    cmdList(rest[0] || DEFAULT_PROJ);
    break;
  case 'add': {
    const [proj, role, title, desc] = rest;
    if (!proj || !role || !title) fail('uso: add <proyecto> <todo|doing|blocked|done> "titulo" ["desc"] [--tags a,b]');
    cmdAdd(proj, role, title, desc && !desc.startsWith('--') ? desc : '', parseTags(rest));
    break;
  }
  case 'mv': {
    const [proj, needle, role] = rest;
    if (!proj || !needle || !role) fail('uso: mv <proyecto> "<id|substr>" <todo|doing|blocked|done>');
    cmdMv(proj, needle, role);
    break;
  }
  case 'rm': {
    const [proj, needle] = rest;
    if (!proj || !needle) fail('uso: rm <proyecto> "<id|substr>"');
    cmdRm(proj, needle);
    break;
  }
  case 'archive-done':
    cmdArchiveDone(rest[0] || DEFAULT_PROJ);
    break;
  default:
    console.log('kanban.mjs - CRUD del Kanban de ULTRON\n');
    console.log('  node scripts/kanban.mjs list   [proyecto]');
    console.log('  node scripts/kanban.mjs add    <proyecto> <todo|doing|blocked|done> "titulo" ["desc"] [--tags a,b]');
    console.log('  node scripts/kanban.mjs mv     <proyecto> "<id|substr>" <todo|doing|blocked|done>');
    console.log('  node scripts/kanban.mjs rm     <proyecto> "<id|substr>"');
    console.log('  node scripts/kanban.mjs archive-done <proyecto>');
    console.log('\n  proyecto por defecto: ultron');
    process.exit(cmd ? 1 : 0);
}
