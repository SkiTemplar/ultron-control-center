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
// con copia previa en projects.json.bak-<fecha> (se conservan las 10 ultimas,
// lib/registry-backup.mjs), todo con el lock de fichero projects.json.lock
// compartido con la app y los demas CLI (lib/projects-registry.mjs; auditoria
// 2026-11-08, #12): dos altas a la vez ya no se pisan.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, registryPath, updateRegistry } from './lib/projects-registry.mjs';
import { ensurePortfolioCard } from './lib/portfolio-board.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
// Overrides (solo para selftests, mismo patron que RESEARCH_ROOT_OVERRIDE en
// lib/research/session.js): permiten a project-create.mjs y a su selftest
// invocar este script contra un registro/tablero temporal sin tocar el
// cockpit real del usuario.
const REGISTRY = registryPath();
const BOARDS = process.env.ULTRON_BOARDS_DIR_OVERRIDE || join(ULTRON, 'cockpit', 'projects');

const COLUMN_ROLES = [
  { id: 1, name: 'Backlog', role: 'todo' },
  { id: 2, name: 'In Progress', role: 'doing' },
  { id: 3, name: 'Blocked', role: 'blocked' },
  { id: 4, name: 'Done', role: 'done' },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Mismos modos que project-socratic.mjs (el escritor de referencia del campo).
const SOCRATIC_MODES = ['strict', 'light', 'off', 'uni'];

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
      case '--socratic': {
        const v = next();
        if (!SOCRATIC_MODES.includes(v)) fail(`--socratic admite ${SOCRATIC_MODES.join(' | ')}`);
        out.socratic = v;
        break;
      }
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

function checkRegistry(raw) {
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
    // ULTRON 4 F4.3: modo del gate socratico (ausente = strict, decision Q5a).
    ...(args.socratic ? { socratic: args.socratic } : {}),
  };
}

/** Entrada ya registrada con los campos pasados por argumento actualizados. */
function updatedEntry(existing, args) {
  return {
    ...existing,
    ...(args.name ? { name: args.name } : {}),
    path: resolve(args.path),
    ...(args.color ? { color: args.color } : {}),
    ...(args.tags.length ? { tags: args.tags } : {}),
    ...(args.provider ? { default_provider: args.provider } : {}),
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
    ...(args.socratic ? { socratic: args.socratic } : {}),
    last_active: nowIso(),
  };
}

/**
 * Registro nuevo con el alta o la actualizacion de `id` (no muta `registry`).
 * @returns {{registry: object, existing: boolean, entry: object}}
 */
function applyArgs(registry, args, id) {
  const current = registry.projects.find((p) => p.id === id);
  const clash = registry.projects.find((p) => p.id !== id && p.path && resolve(p.path) === resolve(args.path));
  if (clash) {
    console.warn(`[project-new] AVISO: "${clash.id}" ya apunta a esa misma ruta.`);
  }
  const entry = current ? updatedEntry(current, args) : buildEntry(args, id);
  const projects = current
    ? registry.projects.map((p) => (p.id === id ? entry : p))
    : [...registry.projects, entry];
  return { registry: { ...registry, projects }, existing: Boolean(current), entry };
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

// Tarjeta del proyecto en el tablero Portfolio (`proyectos`). Nunca es
// fatal: el registro ya está escrito y un fallo aquí solo se avisa.
function syncPortfolio(entry, dryRun) {
  try {
    const r = ensurePortfolioCard({ id: entry.id, name: entry.name, path: entry.path }, { dryRun });
    const verb = dryRun ? { added: 'se anadiria', linked: 'se vincularia' } : { added: 'tarjeta anadida', linked: 'tarjeta existente vinculada' };
    if (r.status === 'added') console.log(`[project-new] portfolio: ${verb.added} en "${r.column}"`);
    if (r.status === 'linked') console.log(`[project-new] portfolio: ${verb.linked} ("${r.card.title}")`);
  } catch (e) {
    console.warn(`[project-new] AVISO: no se pudo actualizar el tablero Portfolio: ${e.message}`);
  }
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
  --socratic strict|light|off|uni  modo del gate socratico (por defecto strict; off en proyectos personales; uni en asignaturas)
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

if (args.dryRun) {
  const plan = applyArgs(checkRegistry(readRegistry(REGISTRY, { allowMissing: true })), args, id);
  const board = ensureBoard(id, args.cards, true);
  console.log(`[project-new] DRY RUN — ${plan.existing ? 'actualizaria' : 'crearia'} "${id}"`);
  console.log(`[project-new] tablero: ${board.created ? 'se crearia' : 'ya existe'}, tarjetas nuevas: ${board.added}`);
  syncPortfolio({ id, name: plan.entry.name || id, path: resolve(args.path) }, true);
  process.exit(0);
}

// Leer, aplicar, crear el tablero y escribir van dentro del lock del registro:
// el tablero se crea antes de escribir el alta, como antes del lock.
let existing = false;
let entry = null;
let board = null;
try {
  updateRegistry(
    REGISTRY,
    (current) => {
      const plan = applyArgs(checkRegistry(current), args, id);
      existing = plan.existing;
      entry = plan.entry;
      board = ensureBoard(id, args.cards, false);
      return plan.registry;
    },
    { tag: 'project-new', allowMissing: true },
  );
} catch (e) {
  fail(e.message);
}

console.log(`[project-new] ${existing ? 'actualizado' : 'registrado'}: ${id} -> ${resolve(args.path)}`);
console.log(`[project-new] tablero: ${board.created ? 'creado' : 'existente'}${board.added ? `, +${board.added} tarjeta(s)` : ''}`);
syncPortfolio(entry, false);
console.log('[project-new] si ULTRON esta abierto, recarga la pestana Projects para verlo.');
