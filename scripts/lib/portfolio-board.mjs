// portfolio-board.mjs — tablero Portfolio (`proyectos`): una tarjeta por
// proyecto registrado, enlazada por el campo `project` de la tarjeta (el mismo
// que lee la sección Portfolio de la app, `Card.project` en kanban/types_model.rs).
//
// Lo usan project-new.mjs (tarjeta automática al registrar un proyecto),
// kanban.mjs (`add --project`) y portfolio-link.mjs (migración de las
// tarjetas antiguas). La escritura sigue el camino de kanban.mjs: lock de
// fichero compartido con la app y el hook kanban-auto, y tmp + rename.
//
// ULTRON_BOARDS_DIR_OVERRIDE apunta a un directorio de tableros temporal
// (solo selftests), igual que en kanban.mjs y project-new.mjs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..', '..');
const requireCjs = createRequire(import.meta.url);
const { withBoardLock, renameWithRetry } = requireCjs(
  join(ULTRON, 'hooks', 'scripts', 'lib', 'kanban-lock.js'),
);

export const PORTFOLIO_PROJECT_ID = 'proyectos';

export function boardsDir() {
  return process.env.ULTRON_BOARDS_DIR_OVERRIDE || join(ULTRON, 'cockpit', 'projects');
}

export function boardPathFor(projectId, dir = boardsDir()) {
  return join(dir, projectId, 'kanban.json');
}

/** Ruta comparable: barras normalizadas, minúsculas y sin barra final. */
export function normalizePath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Nombre comparable: sin tildes, minúsculas y solo alfanuméricos. */
export function normalizeName(text) {
  return String(text || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Primer segmento de la descripción («ruta · stack · remoto»). */
export function descriptionPath(description) {
  return normalizePath(String(description || '').split(' · ')[0]);
}

export function readBoard(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Escritura atómica (tmp + rename), mismo formato que kanban.mjs. */
export function writeBoardAtomic(path, board) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n', 'utf8');
  renameWithRetry(tmp, path);
}

export function todoColumn(board) {
  const cols = board.columns || [];
  return cols.find((c) => c.role === 'todo') || null;
}

export function newPortfolioCard({ columnId, title, description, project, order }) {
  const ts = new Date().toISOString();
  return {
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    column_id: columnId,
    title,
    description: description || '',
    agent: null,
    prompt_template: null,
    cwd: null,
    project,
    tags: [],
    order,
    created_at: ts,
    updated_at: ts,
    runs: [],
  };
}

/** Tarjeta sin vínculo cuya descripción empieza por la ruta del proyecto. */
function unlinkedCardForPath(board, projectPath) {
  const want = normalizePath(projectPath);
  if (!want) return null;
  const hits = (board.cards || []).filter((c) => !c.project && descriptionPath(c.description) === want);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Asegura una tarjeta del proyecto en el tablero Portfolio. Idempotente:
 *   - `no-board`: el tablero `proyectos` no existe; no se crea.
 *   - `exists`: ya hay una tarjeta con ese `project`.
 *   - `linked`: había una tarjeta antigua con la misma ruta; se le pone `project`.
 *   - `added`: tarjeta nueva en la columna de rol `todo`.
 * Lanza si el tablero no tiene columna `todo` o no se puede escribir: el
 * llamante decide si es fatal (project-new.mjs solo avisa).
 */
export function ensurePortfolioCard({ id, name, path }, { dir = boardsDir(), dryRun = false } = {}) {
  if (!id || id === PORTFOLIO_PROJECT_ID) return { status: 'skipped' };
  const file = boardPathFor(PORTFOLIO_PROJECT_ID, dir);
  if (!existsSync(file)) return { status: 'no-board' };
  const run = () => {
    const board = readBoard(file);
    board.cards = board.cards || [];
    if (board.cards.some((c) => c.project === id)) return { status: 'exists' };
    const legacy = unlinkedCardForPath(board, path);
    if (legacy) {
      if (!dryRun) {
        legacy.project = id;
        legacy.updated_at = new Date().toISOString();
        writeBoardAtomic(file, board);
      }
      return { status: 'linked', card: legacy };
    }
    const col = todoColumn(board);
    if (!col) throw new Error(`el tablero "${PORTFOLIO_PROJECT_ID}" no tiene columna de rol todo`);
    const order = board.cards.filter((c) => c.column_id === col.id).length;
    const card = newPortfolioCard({ columnId: col.id, title: name || id, description: path, project: id, order });
    if (!dryRun) {
      board.cards.push(card);
      writeBoardAtomic(file, board);
    }
    return { status: 'added', card, column: col.name };
  };
  return dryRun ? run() : withBoardLock(file, run);
}

export { withBoardLock };
