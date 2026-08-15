#!/usr/bin/env node
// project-new.mjs — registra un proyecto en el Control Center desde CLI.
//
// Por que existe: el flujo "Home" (sesion de Claude Code abierta en el home
// del usuario) crea el scaffold del proyecto y a veces su tablero kanban,
// pero nunca escribia la entrada en cockpit/projects.json. Resultado: el
// proyecto existia en disco y en el kanban, pero NO aparecia en la pestana
// Projects de la app. Este script cierra ese hueco sin depender de que
// ULTRON este abierto.
//
// Uso:
//   node scripts/project-new.mjs --name "Mi Proyecto" \
//        --path "C:\\ruta\\al\\proyecto" [--id mi-proyecto] \
//        [--color "#38bdf8"] [--tags app,android] [--provider claude] \
//        [--card "Titulo de tarjeta"] [--card "Otra"] [--dry-run]
//
// Idempotente: si el id ya existe, actualiza los campos que se pasen y deja
// el resto intacto (no duplica ni borra). Escritura atomica (tmp + rename)
// con backup previo en projects.json.bak.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
const REGISTRY = join(ULTRON, 'cockpit', 'projects.json');
const BOARDS = join(ULTRON, 'cockpit', 'projects');

const COLUMN_ROLES = [
  { id: 1, name: 'Backlog', role: 'todo' },
  { id: 2, name: 'In Progress', role: 'doing' },
  { id: 3, name: 'Blocked', role: 'blocked' },
  { id: 4, name: 'Done', role: 'done' },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function fail(msg) {
  console.error(`[project-new] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { cards: [], tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} necesita un valor`);
      return v;
    };
    switch (a) {
      case '--name': out.name = next(); break;
      case '--path': out.path = next(); break;
      case '--id': out.id = next(); break;
      case '--color': out.color = next(); break;
      case '--provider': out.provider = next(); break;
      case '--notes': out.notes = next(); break;
      case '--tags': out.tags.push(...next().split(',').map((t) => t.trim()).filter(Boolean)); break;
      case '--card': out.cards.push(next()); break;
      case '--dry-run': out.dryRun = true; break;
      case '--help': case '-h': out.help = true; break;
      default: fail(`flag desconocido: ${a}`);
    }
  }
  return out;
}

function slugify(text) {
  return text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function loadRegistry() {
  if (!existsSync(REGISTRY)) return { projects: [] };
  const raw = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  if (!Array.isArray(raw.projects)) fail(`${REGISTRY} no tiene un array "projects"`);
  return raw;
}

function buildEntry(args, id) {
  return {
    auto_tags: [],
    deadline: '',
    default_provider: args.provider || 'claude',
    default_shell: null,
    executables: null,
    id,
    ide: '',
    items: [],
    language: '',
    last_active: nowIso(),
    name: args.name,
    notes: args.notes ?? null,
    parent_folder_override: null,
    path: resolve(args.path),
    status: 'manual',
    tags: args.tags,
    type: '',
    ...(args.color ? { color: args.color } : {}),
  };
}

function ensureBoard(id, cards, dryRun) {
  const dir = join(BOARDS, id);
  const boardPath = join(dir, 'kanban.json');
  if (existsSync(boardPath)) {
    if (!cards.length) return { created: false, added: 0 };
    const board = JSON.parse(readFileSync(boardPath, 'utf8'));
    const todo = board.columns.find((c) => c.role === 'todo') || board.columns[0];
    const added = cards.map((title) => makeCard(id, todo.id, title));
    if (!dryRun) {
      board.cards.push(...added);
      writeJsonAtomic(boardPath, board);
    }
    return { created: false, added: added.length };
  }
  const columns = COLUMN_ROLES.map((c, i) => ({
    id: `col-${id}-${c.id}`, name: c.name, order: i, role: c.role,
  }));
  const todoId = columns[0].id;
  const board = {
    project_id: id,
    columns,
    cards: cards.map((title) => makeCard(id, todoId, title)),
  };
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(boardPath, board);
  }
  return { created: true, added: board.cards.length };
}

function makeCard(id, columnId, title) {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    id: `card-${Date.now()}-${rand}`,
    column_id: columnId,
    title,
    description: '',
    tags: [],
    created_at: nowIso(),
    updated_at: nowIso(),
    project_id: id,
  };
}

// --- main -------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.name && !args.id)) {
  console.log(`Uso: node scripts/project-new.mjs --name "Nombre" --path "C:\\\\ruta" [opciones]

Opciones:
  --id <slug>        id del proyecto (por defecto: slug del nombre)
  --color "#rrggbb"  color del proyecto (tinte de tarjeta + tema de Claude)
  --tags a,b,c       etiquetas
  --provider claude|codex
  --notes "texto"
  --card "Titulo"    tarjeta inicial en Backlog (repetible)
  --dry-run          no escribe nada, solo muestra el plan
`);
  process.exit(args.help ? 0 : 1);
}

if (!args.path) fail('--path es obligatorio');
if (!existsSync(args.path)) fail(`la ruta no existe en disco: ${args.path}`);
if (args.color && !HEX_RE.test(args.color)) fail(`--color debe ser hex #rrggbb, recibido: ${args.color}`);
if (args.provider && !['claude', 'codex'].includes(args.provider)) {
  fail(`--provider debe ser claude o codex, recibido: ${args.provider}`);
}

const id = args.id || slugify(args.name);
if (!id) fail('no se pudo derivar un id del nombre; pasa --id');

const registry = loadRegistry();
const existing = registry.projects.find((p) => p.id === id);
const clash = registry.projects.find((p) => p.id !== id && p.path && resolve(p.path) === resolve(args.path));
if (clash) {
  console.warn(`[project-new] AVISO: "${clash.id}" ya apunta a esa misma ruta.`);
}

if (existing) {
  if (args.name) existing.name = args.name;
  existing.path = resolve(args.path);
  if (args.color) existing.color = args.color;
  if (args.tags.length) existing.tags = args.tags;
  if (args.provider) existing.default_provider = args.provider;
  if (args.notes !== undefined) existing.notes = args.notes;
  existing.last_active = nowIso();
} else {
  registry.projects.push(buildEntry(args, id));
}

const board = ensureBoard(id, args.cards, args.dryRun);

if (args.dryRun) {
  console.log(`[project-new] DRY RUN — ${existing ? 'actualizaria' : 'crearia'} "${id}"`);
  console.log(`[project-new] tablero: ${board.created ? 'se crearia' : 'ya existe'}, tarjetas nuevas: ${board.added}`);
  process.exit(0);
}

if (existsSync(REGISTRY)) copyFileSync(REGISTRY, `${REGISTRY}.bak`);
writeJsonAtomic(REGISTRY, registry);

console.log(`[project-new] ${existing ? 'actualizado' : 'registrado'}: ${id} -> ${resolve(args.path)}`);
console.log(`[project-new] tablero: ${board.created ? 'creado' : 'existente'}${board.added ? `, +${board.added} tarjeta(s)` : ''}`);
console.log('[project-new] si ULTRON esta abierto, recarga la pestana Projects para verlo.');
