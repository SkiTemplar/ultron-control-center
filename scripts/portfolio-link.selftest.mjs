// portfolio-link.selftest.mjs — checks herméticos de scripts/portfolio-link.mjs
// y de su plan (lib/portfolio-link-plan.mjs). El CLI corre contra un registro y
// un directorio de tableros temporales (ULTRON_PROJECTS_JSON_OVERRIDE y
// ULTRON_BOARDS_DIR_OVERRIDE): nunca toca el cockpit real.
//
// Uso: node scripts/portfolio-link.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planLinks } from './lib/portfolio-link-plan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'portfolio-link.mjs');

const REGISTRY = [
  { id: 'arcadia', name: 'Arcadia', path: 'C:\\P\\Arcadia\\Arcadia' },
  { id: 'arcadia-two', name: 'Arcadia Two', path: 'C:\\P\\Arcadia\\ArcadiaTwo' },
  { id: 'wordle', name: 'Wordle', path: 'D:\\juegos\\wordle' },
  { id: 'proyectos', name: 'Proyectos', path: 'C:\\P' },
];

const card = (id, title, description = '', extra = {}) => ({ id, title, description, column_id: 'c1', ...extra });

test('vincula por ruta sin distinguir mayúsculas ni barras', () => {
  const plan = planLinks([card('a', 'X', 'c:/p/arcadia/arcadia · unreal · GitHub: x/y')], REGISTRY);
  assert.deepEqual(plan.linked.map((l) => [l.card.id, l.project, l.by]), [['a', 'arcadia', 'ruta']]);
});

test('una ruta prefijo de otra no casa con la más larga (ArcadiaTwo no es Arcadia)', () => {
  const plan = planLinks([card('a', 'Y', 'notas: C:\\P\\Arcadia\\ArcadiaTwo · algo')], REGISTRY);
  assert.deepEqual(plan.linked.map((l) => l.project), ['arcadia-two']);
});

test('sin ruta cae al nombre normalizado', () => {
  const plan = planLinks([card('w', 'WORDLE', 'sin ruta')], REGISTRY);
  assert.deepEqual(plan.linked.map((l) => [l.project, l.by]), [['wordle', 'nombre']]);
});

test('el propio tablero proyectos nunca es candidato', () => {
  const plan = planLinks([card('p', 'Proyectos', 'C:\\P')], REGISTRY);
  assert.equal(plan.linked.length, 0);
  assert.equal(plan.unmatched.length, 1);
});

test('CASO NEGATIVO: dos tarjetas para el mismo proyecto quedan ambiguas, no se vinculan', () => {
  const plan = planLinks([card('a', 'Wordle'), card('b', 'wordle')], REGISTRY);
  assert.equal(plan.linked.length, 0);
  assert.equal(plan.ambiguous.length, 2);
});

test('CASO NEGATIVO: un proyecto que ya tiene tarjeta no se asigna a otra', () => {
  const plan = planLinks([card('a', 'Otra', '', { project: 'wordle' }), card('b', 'Wordle')], REGISTRY);
  assert.equal(plan.already.length, 1);
  assert.equal(plan.linked.length, 0);
  assert.match(plan.ambiguous[0].reason, /ya tiene tarjeta/);
});

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'portfolio-link-selftest-'));
  const registry = join(dir, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: REGISTRY }), 'utf8');
  const boardDir = join(dir, 'boards', 'proyectos');
  mkdirSync(boardDir, { recursive: true });
  const boardFile = join(boardDir, 'kanban.json');
  const board = {
    project_id: 'proyectos',
    columns: [{ id: 'c1', name: 'Sin clasificar', order: 0, role: 'todo' }],
    cards: [card('a', 'Arcadia', 'C:\\P\\Arcadia\\Arcadia · unreal'), card('z', 'Nada que ver')],
  };
  writeFileSync(boardFile, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  const env = { ...process.env, ULTRON_PROJECTS_JSON_OVERRIDE: registry, ULTRON_BOARDS_DIR_OVERRIDE: join(dir, 'boards') };
  return { dir, boardDir, boardFile, env };
}

const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });

test('el dry run imprime los recuentos y no escribe nada', () => {
  const ws = makeWorkspace();
  try {
    const before = readFileSync(ws.boardFile, 'utf8');
    const r = run([], ws.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /vinculadas: 1 · ambiguas: 0 · sin pareja: 1/);
    assert.match(r.stdout, /DRY RUN/);
    assert.equal(readFileSync(ws.boardFile, 'utf8'), before);
    assert.deepEqual(readdirSync(ws.boardDir), ['kanban.json']);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('--apply escribe el vínculo, deja copia y es idempotente', () => {
  const ws = makeWorkspace();
  try {
    assert.equal(run(['--apply'], ws.env).status, 0);
    const cards = JSON.parse(readFileSync(ws.boardFile, 'utf8')).cards;
    assert.equal(cards.find((c) => c.id === 'a').project, 'arcadia');
    assert.equal('project' in cards.find((c) => c.id === 'z'), false);
    assert.ok(readdirSync(ws.boardDir).some((n) => n.startsWith('kanban.json.bak-')));
    const again = run([], ws.env);
    assert.match(again.stdout, /vinculadas: 0 · ambiguas: 0 · sin pareja: 1 · ya vinculadas: 1/);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CASO NEGATIVO: un flag desconocido falla sin escribir', () => {
  const ws = makeWorkspace();
  try {
    const before = readFileSync(ws.boardFile, 'utf8');
    const r = run(['--aply'], ws.env);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(ws.boardFile, 'utf8'), before);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});
