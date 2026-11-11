// project-new.selftest.mjs — checks herméticos del flag `--socratic` de
// scripts/project-new.mjs (auditoría 2026-10-17: `--socratic uni` se rechazaba
// aunque `uni` es un modo válido de project-socratic.mjs, y en un proyecto ya
// registrado el flag se ignoraba en silencio). Cada test usa un registro y un
// directorio de tableros temporales por override de entorno: nunca toca el
// cockpit real del usuario.
//
// Uso: node scripts/project-new.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'project-new.mjs');

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'project-new-selftest-'));
  const projectDir = join(dir, 'Demo');
  mkdirSync(projectDir, { recursive: true });
  const registry = join(dir, 'projects.json');
  const env = {
    ...process.env,
    ULTRON_PROJECTS_JSON_OVERRIDE: registry,
    ULTRON_BOARDS_DIR_OVERRIDE: join(dir, 'boards'),
  };
  return { dir, projectDir, registry, env };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });
}

function socraticOf(registry, id) {
  const data = JSON.parse(readFileSync(registry, 'utf8'));
  return data.projects.find((p) => p.id === id)?.socratic;
}

for (const mode of ['strict', 'light', 'off', 'uni']) {
  test(`--socratic ${mode} se acepta y se guarda en el alta`, () => {
    const ws = makeWorkspace();
    try {
      const r = run(['--name', 'Demo', '--path', ws.projectDir, '--socratic', mode], ws.env);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(socraticOf(ws.registry, 'demo'), mode);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
}

test('--socratic con un modo inexistente falla sin escribir el registro', () => {
  const ws = makeWorkspace();
  try {
    const r = run(['--name', 'Demo', '--path', ws.projectDir, '--socratic', 'estricto'], ws.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--socratic admite strict \| light \| off \| uni/);
    assert.throws(() => readFileSync(ws.registry, 'utf8'));
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('--socratic sobre un proyecto ya registrado actualiza el modo (no se ignora)', () => {
  const ws = makeWorkspace();
  try {
    assert.equal(run(['--name', 'Demo', '--path', ws.projectDir], ws.env).status, 0);
    assert.equal(socraticOf(ws.registry, 'demo'), undefined);
    const r = run(['--name', 'Demo', '--path', ws.projectDir, '--socratic', 'uni'], ws.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(socraticOf(ws.registry, 'demo'), 'uni');
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

// --- tablero Portfolio (`proyectos`) ------------------------------------------

function seedPortfolio(ws, cards = []) {
  const dir = join(ws.dir, 'boards', 'proyectos');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'kanban.json');
  const board = {
    project_id: 'proyectos',
    columns: [
      { id: 'col-activo', name: 'Activo', order: 0, role: 'doing' },
      { id: 'col-sin', name: 'Sin clasificar', order: 1, role: 'todo' },
    ],
    cards,
  };
  writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  return file;
}

const portfolioCards = (file) => JSON.parse(readFileSync(file, 'utf8')).cards;

test('el alta añade una tarjeta vinculada al Portfolio en la columna todo, una sola vez', () => {
  const ws = makeWorkspace();
  try {
    const file = seedPortfolio(ws);
    assert.equal(run(['--name', 'Demo', '--path', ws.projectDir], ws.env).status, 0);
    const r = run(['--name', 'Demo', '--path', ws.projectDir], ws.env);
    assert.equal(r.status, 0, r.stderr);
    const cards = portfolioCards(file);
    assert.equal(cards.length, 1, 'el segundo alta no duplica');
    assert.equal(cards[0].project, 'demo');
    assert.equal(cards[0].title, 'Demo');
    assert.equal(cards[0].column_id, 'col-sin');
    assert.equal(cards[0].description, ws.projectDir);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('una tarjeta antigua con la misma ruta se vincula en vez de duplicarse', () => {
  const ws = makeWorkspace();
  try {
    const legacy = { id: 'card-1', column_id: 'col-activo', title: 'Demo', order: 0,
      description: `${ws.projectDir.replace(/\\/g, '/').toUpperCase()} · vite · GitHub: x/demo` };
    const file = seedPortfolio(ws, [legacy]);
    const r = run(['--name', 'Demo', '--path', ws.projectDir], ws.env);
    assert.equal(r.status, 0, r.stderr);
    const cards = portfolioCards(file);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'card-1');
    assert.equal(cards[0].project, 'demo');
    assert.equal(cards[0].column_id, 'col-activo', 'no se mueve de columna');
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('sin tablero Portfolio el alta funciona y no lo crea', () => {
  const ws = makeWorkspace();
  try {
    const r = run(['--name', 'Demo', '--path', ws.projectDir], ws.env);
    assert.equal(r.status, 0, r.stderr);
    assert.throws(() => readFileSync(join(ws.dir, 'boards', 'proyectos', 'kanban.json'), 'utf8'));
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('CASO NEGATIVO: un Portfolio roto solo avisa; el registro se escribe igual', () => {
  const ws = makeWorkspace();
  try {
    const file = seedPortfolio(ws);
    writeFileSync(file, '{ no es json', 'utf8');
    const r = run(['--name', 'Demo', '--path', ws.projectDir], ws.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no se pudo actualizar el tablero Portfolio/);
    const reg = JSON.parse(readFileSync(ws.registry, 'utf8'));
    assert.ok(reg.projects.some((p) => p.id === 'demo'));
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('--dry-run no escribe la tarjeta del Portfolio', () => {
  const ws = makeWorkspace();
  try {
    const file = seedPortfolio(ws);
    const r = run(['--name', 'Demo', '--path', ws.projectDir, '--dry-run'], ws.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /portfolio: se anadiria/);
    assert.equal(portfolioCards(file).length, 0);
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});
