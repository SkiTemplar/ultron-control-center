// kanban.selftest.mjs — checks herméticos de scripts/kanban.mjs. Cada test usa
// su propio tablero temporal (ULTRON_BOARDS_DIR_OVERRIDE): nunca toca el
// cockpit real. Ejecuta el CLI como subproceso real (mismo camino que usan el
// chat/terminal), igual que scripts/project-create.selftest.mjs.
//
// Uso: node scripts/kanban.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'kanban.mjs');
const PROJ = 'demo';

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-selftest-'));
  const boardsDir = join(dir, 'boards');
  mkdirSync(join(boardsDir, PROJ), { recursive: true });
  const boardPath = join(boardsDir, PROJ, 'kanban.json');
  writeFileSync(
    boardPath,
    JSON.stringify({
      project_id: PROJ,
      columns: [
        { id: 'c-back', name: 'Backlog', order: 0, role: 'todo' },
        { id: 'c-doing', name: 'In Progress', order: 1, role: 'doing' },
        { id: 'c-done', name: 'Done', order: 2, role: 'done' },
      ],
      cards: [
        { id: 'card-1790093849652-b7kug3', column_id: 'c-doing', title: 'Arreglar el bug del resume', order: 0 },
        { id: 'card-1790093849652-aaaaaa', column_id: 'c-back', title: 'Otra tarjeta cualquiera', order: 0 },
      ],
    }, null, 2) + '\n',
    'utf8'
  );
  const env = { ...process.env, ULTRON_BOARDS_DIR_OVERRIDE: boardsDir };
  return { boardPath, env };
}

function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readBoard(boardPath) {
  return JSON.parse(readFileSync(boardPath, 'utf8'));
}

test('mv con id COMPLETO mueve la card (comportamiento previo, no regresiona)', () => {
  const { boardPath, env } = makeBoard();
  const r = run(['mv', PROJ, 'card-1790093849652-b7kug3', 'done'], env);
  assert.equal(r.status, 0, r.stderr);
  const board = readBoard(boardPath);
  const card = board.cards.find((c) => c.id === 'card-1790093849652-b7kug3');
  assert.equal(card.column_id, 'c-done');
});

test('BUG (2026-09-25): mv con SUFIJO del id (substring) mueve la card — antes daba "ninguna card matchea"', () => {
  const { boardPath, env } = makeBoard();
  const r = run(['mv', PROJ, 'b7kug3', 'done'], env);
  assert.equal(r.status, 0, `esperaba exito, salio: ${r.stderr}`);
  const board = readBoard(boardPath);
  const card = board.cards.find((c) => c.id === 'card-1790093849652-b7kug3');
  assert.equal(card.column_id, 'c-done', 'la card con ese sufijo de id debe haberse movido');
});

test('mv con substring de TITULO sigue funcionando (comportamiento previo)', () => {
  const { boardPath, env } = makeBoard();
  const r = run(['mv', PROJ, 'bug del resume', 'done'], env);
  assert.equal(r.status, 0, r.stderr);
  const board = readBoard(boardPath);
  const card = board.cards.find((c) => c.id === 'card-1790093849652-b7kug3');
  assert.equal(card.column_id, 'c-done');
});

test('CASO NEGATIVO: substring de id ambiguo entre dos cards falla con mensaje claro y no mueve nada', () => {
  const { boardPath, env } = makeBoard();
  // ambas cards de fixture comparten el mismo timestamp de id, solo el sufijo diverge
  const r = run(['mv', PROJ, 'card-1790093849652', 'done'], env);
  assert.notEqual(r.status, 0, 'debe fallar: ambiguo');
  assert.match(r.stderr, /ambiguo por id/);
  const board = readBoard(boardPath);
  assert.ok(board.cards.every((c) => c.column_id !== 'c-done'), 'nada se mueve cuando es ambiguo');
});

test('CASO NEGATIVO: needle que no matchea nada falla y no mueve nada', () => {
  const { boardPath, env } = makeBoard();
  const r = run(['mv', PROJ, 'no-existe-esto', 'done'], env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ninguna card matchea/);
  const board = readBoard(boardPath);
  assert.ok(board.cards.every((c) => c.column_id !== 'c-done'));
});
