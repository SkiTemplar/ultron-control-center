'use strict';

/**
 * lib/kanban-auto.js — mantiene el kanban del proyecto al dia a partir de la
 * bitacora de cada sesion (summary.md, escrita por session-summarize-previous.js).
 *
 * Por que (2026-10-23): los tableros se pudrian. kanban-update-reminder cerraba
 * por match de commit y casi nunca acertaba (retirado el 2026-10-08), y
 * kanban-closures.js solo avisaba por titulo. Ahora la LLM resumidora recibe la
 * lista de tarjetas abiertas CON su id, devuelve cierres por id y como mucho
 * MAX_NEW tarjetas nuevas, y este modulo los aplica sin preguntar (decision del
 * usuario: automatico con deshacer). Cada lote queda en kanban.auto-log.json;
 * `scripts/kanban.mjs undo <proyecto>` revierte el ultimo y el SessionStart
 * avisa de lo aplicado (renderAutoLines).
 *
 * Fuera: proyectos con tracker externo (`tracker:*`, lib/project-tracker.js) o
 * con la etiqueta `kanban:manual` en cockpit/projects.json.
 *
 * Las funciones de plan/aplicacion son puras e inmutables; la IO esta en
 * applyFromSummary, undoLast y markReported, y cada una hace su
 * leer-modificar-escribir bajo el lock de fichero de kanban.json
 * (lib/kanban-lock.js), compartido con scripts/kanban.mjs y la app.
 */

const fs = require('fs');
const path = require('path');
const { withBoardLock, renameWithRetry } = require('./kanban-lock');

const SECTION_CLOSE = 'cierres propuestos';
const SECTION_NEW = 'tarjetas nuevas';
const LOG_FILE = 'kanban.auto-log.json';
const AUTO_TAG = 'auto';
const MAX_CLOSE = 8;
const MAX_NEW = 3;
const MAX_PROMPT_CARDS = 80;
const MAX_LOG_ENTRIES = 50;
const MIN_TITLE_LEN = 6;
const MAX_TITLE_LEN = 120;
const NEW_ROLES = new Set(['todo', 'doing']);

function columnsOf(board) {
  return Array.isArray(board && board.columns) ? board.columns : [];
}

function cardsOf(board) {
  return Array.isArray(board && board.cards) ? board.cards : [];
}

function columnByRole(board, role) {
  return columnsOf(board).find((c) => c && c.role === role) || null;
}

/** Tarjetas fuera de Done, con su rol: [{id, title, role}]. */
function openCards(board) {
  const roleById = new Map(columnsOf(board).map((c) => [c.id, c.role]));
  return cardsOf(board)
    .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string')
    .map((c) => ({ id: c.id, title: c.title, role: roleById.get(c.column_id) || '' }))
    .filter((c) => c.role !== 'done');
}

/**
 * Bloque de texto con las tarjetas abiertas para el mensaje de la LLM. '' sin
 * tablero o sin tarjetas abiertas (la LLM no debe proponer cierres entonces).
 */
function renderOpenCardsBlock(board) {
  const open = openCards(board).slice(0, MAX_PROMPT_CARDS);
  if (open.length === 0) return '';
  const lines = open.map((c) => `- ${c.id} [${c.role}] ${c.title}`);
  return ['--- TARJETAS ABIERTAS DEL KANBAN ---', ...lines, '--- FIN TARJETAS ---'].join('\n');
}

/** Lineas de la primera seccion `## ...` cuyo titulo contiene `heading`. */
function sectionLines(content, heading) {
  const parts = String(content || '').split(/^(?=## )/m);
  const part = parts.find((p) => {
    const m = p.match(/^## +(.*)$/m);
    return m && m[1].toLowerCase().includes(heading);
  });
  if (!part) return [];
  return part
    .replace(/^## .*$/m, '')
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && !/^\(nada relevante\)$/i.test(l));
}

/** Ids de tarjetas abiertas citados en "## Cierres propuestos" (sin repetir). */
function parseClosures(summary, board) {
  const open = openCards(board);
  const ids = [];
  for (const line of sectionLines(summary, SECTION_CLOSE)) {
    const hit = open.find((c) => line.includes(c.id));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids.slice(0, MAX_CLOSE);
}

/** Tarjetas de "## Tarjetas nuevas" con formato `todo|doing | Titulo` (el tope MAX_NEW lo pone planOps, tras quitar duplicados). */
function parseNewCards(summary) {
  const out = [];
  for (const line of sectionLines(summary, SECTION_NEW)) {
    const m = line.match(/^`?(todo|doing)`?\s*\|\s*(.+)$/i);
    if (!m) continue;
    const role = m[1].toLowerCase();
    const title = m[2].replace(/`/g, '').trim();
    if (!NEW_ROLES.has(role) || title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) continue;
    out.push({ role, title });
  }
  return out;
}

/** Titulo comparable: minusculas, sin tildes ni signos, espacios colapsados. */
function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** true si `title` ya existe en el tablero (igual o contenido, cualquier columna). */
function isDuplicateTitle(title, board) {
  const t = normalizeTitle(title);
  if (!t) return true;
  return cardsOf(board).some((c) => {
    const o = normalizeTitle(c && c.title);
    if (!o) return false;
    if (o === t) return true;
    const shorter = o.length < t.length ? o : t;
    return shorter.length >= 12 && (o.includes(t) || t.includes(o));
  });
}

/** Ids, titulos y numero de altas que esta sesion ya hizo en lotes previos del log. */
function touchedBySession(log, sessionId) {
  const ids = new Set();
  const titles = new Set();
  let added = 0;
  for (const entry of Array.isArray(log) ? log : []) {
    if (!entry || entry.session_id !== sessionId) continue;
    for (const op of entry.ops || []) {
      if (op.op === 'mv') ids.add(op.id);
      if (op.op === 'add') {
        titles.add(normalizeTitle(op.title));
        added++;
      }
    }
  }
  return { ids, titles, added };
}

/**
 * Plan de operaciones para `summary` sobre `board`. Idempotente por sesion: lo
 * que esta sesion ya cerro o creo (aunque se deshiciera) no se repite al
 * re-resumirla.
 * @returns {{close: string[], add: {role: string, title: string}[]}}
 */
function planOps({ board, summary, log, sessionId }) {
  if (!columnByRole(board, 'done')) return { close: [], add: [] };
  const prior = touchedBySession(log, sessionId);
  const close = parseClosures(summary, board).filter((id) => !prior.ids.has(id));
  const add = [];
  for (const card of parseNewCards(summary)) {
    if (prior.added + add.length >= MAX_NEW) break; // tope acumulado por sesion
    if (!columnByRole(board, card.role)) continue;
    if (prior.titles.has(normalizeTitle(card.title))) continue;
    const pending = { cards: [...cardsOf(board), ...add.map((a) => ({ title: a.title }))] };
    if (isDuplicateTitle(card.title, pending)) continue;
    add.push(card);
  }
  return { close, add };
}

/**
 * Aplica el plan sobre una copia del tablero.
 * @returns {{board: object, ops: object[]}}
 */
function applyPlan(board, plan, { now, newId }) {
  const done = columnByRole(board, 'done');
  const ops = [];
  const closing = new Set(plan.close);
  const cards = cardsOf(board).map((c) => {
    if (!closing.has(c.id)) return c;
    ops.push({ op: 'mv', id: c.id, title: c.title, from: c.column_id, to: done.id });
    return { ...c, column_id: done.id, updated_at: now };
  });
  const added = plan.add.map((a) => {
    const col = columnByRole(board, a.role);
    const id = newId();
    ops.push({ op: 'add', id, title: a.title, role: a.role });
    const order = cards.filter((c) => c.column_id === col.id).length;
    return {
      id, column_id: col.id, title: a.title, description: '', agent: null, prompt_template: null,
      cwd: null, tags: [AUTO_TAG], order, created_at: now, updated_at: now, runs: [],
    };
  });
  return { board: { ...board, cards: [...cards, ...added] }, ops };
}

/**
 * Revierte las operaciones de un lote sobre una copia del tablero. Una tarjeta
 * cerrada que ya no esta en Done (alguien la movio) no se toca; una creada se
 * borra si sigue existiendo.
 * @returns {{board: object, reverted: number}}
 */
function revertOps(board, ops) {
  let reverted = 0;
  const addedIds = new Set(ops.filter((o) => o.op === 'add').map((o) => o.id));
  const moves = new Map(ops.filter((o) => o.op === 'mv').map((o) => [o.id, o]));
  const cards = [];
  for (const c of cardsOf(board)) {
    if (addedIds.has(c.id)) { reverted++; continue; }
    const mv = moves.get(c.id);
    if (mv && c.column_id === mv.to) {
      reverted++;
      cards.push({ ...c, column_id: mv.from, updated_at: new Date().toISOString() });
      continue;
    }
    cards.push(c);
  }
  return { board: { ...board, cards }, reverted };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Escritura atomica: tmp + rename en el mismo directorio. */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameWithRetry(tmp, file);
}

function paths(projectsDir, projectId) {
  const dir = path.join(projectsDir, projectId);
  return { board: path.join(dir, 'kanban.json'), log: path.join(dir, LOG_FILE) };
}

function defaultNewId() {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Aplica al kanban lo que propone la bitacora de `sessionId`. Sin tablero, sin
 * cambios o con el proyecto excluido no escribe nada.
 * @returns {{applied: number, skipped?: string}}
 */
function applyFromSummary({ projectsDir, projectId, sessionId, summary, excluded = '', now, newId = defaultNewId }) {
  if (excluded) return { applied: 0, skipped: excluded };
  const p = paths(projectsDir, projectId);
  if (!fs.existsSync(p.board)) return { applied: 0, skipped: 'sin kanban.json' };
  return withBoardLock(p.board, () => applyFromSummaryLocked({ p, sessionId, summary, now, newId }));
}

function applyFromSummaryLocked({ p, sessionId, summary, now, newId }) {
  const board = readJson(p.board, null);
  if (!board) return { applied: 0, skipped: 'sin kanban.json' };
  const log = readJson(p.log, []);
  const plan = planOps({ board, summary, log, sessionId });
  if (plan.close.length === 0 && plan.add.length === 0) return { applied: 0 };
  const at = now || new Date().toISOString();
  const result = applyPlan(board, plan, { now: at, newId });
  writeJsonAtomic(p.board, result.board);
  const entry = { session_id: sessionId, at, ops: result.ops, undone: false, reported: false };
  writeJsonAtomic(p.log, [...(Array.isArray(log) ? log : []), entry].slice(-MAX_LOG_ENTRIES));
  return { applied: result.ops.length };
}

/**
 * Deshace el ultimo lote no deshecho (o el de `sessionId`).
 * @returns {{reverted: number, entry: object|null}}
 */
function undoLast({ projectsDir, projectId, sessionId = '' }) {
  const p = paths(projectsDir, projectId);
  if (!fs.existsSync(p.board)) throw new Error(`kanban.json no existe para el proyecto "${projectId}"`);
  return withBoardLock(p.board, () => undoLastLocked(p, sessionId));
}

function undoLastLocked(p, sessionId) {
  const log = readJson(p.log, []);
  const idx = [...log.keys()].reverse().find((i) => !log[i].undone && (!sessionId || log[i].session_id.startsWith(sessionId)));
  if (idx === undefined) return { reverted: 0, entry: null };
  const board = readJson(p.board, null);
  if (!board) throw new Error(`kanban.json ilegible: ${p.board}`);
  const result = revertOps(board, log[idx].ops);
  writeJsonAtomic(p.board, result.board);
  const updated = log.map((e, i) => (i === idx ? { ...e, undone: true, undone_at: new Date().toISOString() } : e));
  writeJsonAtomic(p.log, updated);
  return { reverted: result.reverted, entry: log[idx] };
}

/** Lotes vigentes que el SessionStart aun no ha anunciado. */
function pendingReports(log) {
  return (Array.isArray(log) ? log : []).filter((e) => e && !e.undone && !e.reported);
}

/** Linea del resume con lo aplicado y el comando para deshacerlo. [] si no hay nada. */
function renderAutoLines(projectId, entries) {
  if (!projectId || !Array.isArray(entries) || entries.length === 0) return [];
  const ops = entries.flatMap((e) => e.ops || []);
  const closed = ops.filter((o) => o.op === 'mv').map((o) => o.title);
  const added = ops.filter((o) => o.op === 'add').map((o) => `${o.title} (${o.role})`);
  const parts = [];
  if (closed.length) parts.push(`a Done: ${closed.join(' | ')}`);
  if (added.length) parts.push(`creadas: ${added.join(' | ')}`);
  if (parts.length === 0) return [];
  return [`kanban actualizado solo desde la bitacora anterior: ${parts.join(' · ')}. Deshacer: node ~/.ultron/scripts/kanban.mjs undo ${projectId}`];
}

/** Marca como anunciados los lotes pendientes. Fail-safe: un fallo no rompe el resume. */
function markReported({ projectsDir, projectId }) {
  const p = paths(projectsDir, projectId);
  // El log tambien lo reescribe applyFromSummary: mismo lock para no perder un lote.
  withBoardLock(p.board, () => {
    const log = readJson(p.log, null);
    if (!Array.isArray(log) || pendingReports(log).length === 0) return;
    writeJsonAtomic(p.log, log.map((e) => (e && !e.undone && !e.reported ? { ...e, reported: true } : e)));
  });
}

module.exports = {
  SECTION_CLOSE,
  SECTION_NEW,
  LOG_FILE,
  AUTO_TAG,
  MAX_CLOSE,
  MAX_NEW,
  MAX_PROMPT_CARDS,
  openCards,
  renderOpenCardsBlock,
  parseClosures,
  parseNewCards,
  normalizeTitle,
  isDuplicateTitle,
  planOps,
  applyPlan,
  revertOps,
  applyFromSummary,
  undoLast,
  pendingReports,
  renderAutoLines,
  markReported,
};
