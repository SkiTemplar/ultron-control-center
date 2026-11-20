// projects-registry-lock.selftest.mjs — exclusión entre procesos de los
// escritores de cockpit/projects.json (hallazgo #12, auditoría 2026-11-08).
//
// El caso central lanza a la vez varios procesos de los CLI reales
// (project-new.mjs con altas distintas, project-socratic.mjs y
// project-remove.mjs) contra un registro temporal, con una pausa entre la
// lectura y la escritura (ULTRON_PROJECTS_RMW_PAUSE_MS) que ensancha la ventana
// de la carrera. Sin el lock projects.json.lock el último rename gana y se
// pierden altas; con él no se pierde ninguna. Además: un lock vivo de otro
// proceso (la app o un CLI) da error explícito sin escribir, y uno huérfano se
// rompe. Hermético: todo en un directorio temporal, sin ficheros personales.
//
// Uso: node scripts/projects-registry-lock.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_NEW = join(__dirname, 'project-new.mjs');
const PROJECT_SOCRATIC = join(__dirname, 'project-socratic.mjs');
const PROJECT_REMOVE = join(__dirname, 'project-remove.mjs');

const NEW_PROJECTS = 5;
// La pausa va dentro del lock: con él, el trabajo serializado (6 escritores ×
// pausa) cabe de sobra en el plazo de 2 s del lock; sin él, las lecturas se
// solapan y los renames se pisan.
const RMW_PAUSE_MS = 150;

function makeWorkspace(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'projects-registry-lock-'));
  const registry = join(dir, 'projects.json');
  writeFileSync(registry, `${JSON.stringify({ version: '1.0', projects: seed }, null, 2)}\n`);
  const env = {
    ...process.env,
    ULTRON_PROJECTS_JSON_OVERRIDE: registry,
    ULTRON_BOARDS_DIR_OVERRIDE: join(dir, 'boards'),
    ULTRON_PROJECTS_RMW_PAUSE_MS: String(RMW_PAUSE_MS),
  };
  return { dir, registry, env };
}

function projectDir(ws, name) {
  const p = join(ws.dir, 'src', name);
  mkdirSync(p, { recursive: true });
  return p;
}

function runAsync(cli, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

function readProjects(registry) {
  return JSON.parse(readFileSync(registry, 'utf8')).projects;
}

test('altas, cambio de modo y baja a la vez desde varios procesos: no se pierde ninguna', async () => {
  const ws = makeWorkspace([
    { id: 'base', name: 'Base', path: join(tmpdir(), 'base') },
    { id: 'viejo', name: 'Viejo', path: join(tmpdir(), 'viejo') },
  ]);
  try {
    const jobs = [];
    for (let i = 0; i < NEW_PROJECTS; i++) {
      const name = `Alta${i}`;
      jobs.push(runAsync(PROJECT_NEW, ['--name', name, '--path', projectDir(ws, name)], ws.env));
    }
    jobs.push(runAsync(PROJECT_SOCRATIC, ['base', 'off'], ws.env));
    jobs.push(runAsync(PROJECT_REMOVE, ['viejo'], ws.env));
    const results = await Promise.all(jobs);
    results.forEach((r, i) => assert.equal(r.status, 0, `proceso ${i}: ${r.stderr}`));

    const projects = readProjects(ws.registry);
    const ids = projects.map((p) => p.id).sort();
    const expected = ['base', ...Array.from({ length: NEW_PROJECTS }, (_, i) => `alta${i}`)].sort();
    assert.deepEqual(ids, expected, 'todas las altas presentes y la baja aplicada');
    assert.equal(projects.find((p) => p.id === 'base').socratic, 'off', 'el cambio de modo no se pierde');
    assert.ok(!existsSync(`${ws.registry}.lock`), 'no queda el lock al terminar');
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('un lock vivo de otro proceso: error explícito y el registro no se toca', () => {
  const ws = makeWorkspace([]);
  try {
    writeFileSync(`${ws.registry}.lock`, JSON.stringify({ pid: 0, token: 'app-rust' }));
    const before = readFileSync(ws.registry, 'utf8');
    const env = { ...ws.env, ULTRON_PROJECTS_RMW_PAUSE_MS: '0' };
    const r = spawnSync(process.execPath, [PROJECT_NEW, '--name', 'Bloqueada', '--path', projectDir(ws, 'Bloqueada')], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /projects\.json bloqueado por otro proceso/);
    assert.equal(readFileSync(ws.registry, 'utf8'), before, 'sin lock no se escribe');
    assert.ok(existsSync(`${ws.registry}.lock`), 'el lock ajeno sigue en disco');
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('un lock huérfano (proceso muerto) se rompe y el alta entra', () => {
  const ws = makeWorkspace([]);
  try {
    const lock = `${ws.registry}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 0, token: 'muerto' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const env = { ...ws.env, ULTRON_PROJECTS_RMW_PAUSE_MS: '0' };
    const r = spawnSync(process.execPath, [PROJECT_NEW, '--name', 'Tras', '--path', projectDir(ws, 'Tras')], {
      env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /lock rancio roto/);
    assert.deepEqual(readProjects(ws.registry).map((p) => p.id), ['tras']);
    assert.ok(!existsSync(lock), 'el lock se libera al terminar');
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});
