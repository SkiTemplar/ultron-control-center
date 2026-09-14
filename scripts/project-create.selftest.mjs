// project-create.selftest.mjs — checks herméticos del núcleo del creador de
// proyectos (scripts/project-create.mjs). Cada test usa su propio directorio
// temporal + overrides de entorno (ULTRON_PROJECT_ROOTS_OVERRIDE,
// ULTRON_PROJECTS_JSON_OVERRIDE, ULTRON_BOARDS_DIR_OVERRIDE,
// RESEARCH_ROOT_OVERRIDE): nunca toca el cockpit real del usuario.
//
// Uso: node scripts/project-create.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
const CLI = join(__dirname, 'project-create.mjs');

/** Crea un workspace temporal aislado: raices + registry + boards + research. */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'project-create-selftest-'));
  const asignaturasDir = join(dir, 'ASIGNATURAS');
  const personalDir = join(dir, 'PERSONAL');
  mkdirSync(asignaturasDir, { recursive: true });
  mkdirSync(personalDir, { recursive: true });
  const env = {
    ...process.env,
    ULTRON_PROJECT_ROOTS_OVERRIDE: join(dir, 'project-roots.json'),
    ULTRON_PROJECTS_JSON_OVERRIDE: join(dir, 'projects.json'),
    ULTRON_BOARDS_DIR_OVERRIDE: join(dir, 'boards'),
    RESEARCH_ROOT_OVERRIDE: join(dir, 'research'),
  };
  return {
    dir, asignaturasDir, personalDir, env,
  };
}

/** Ejecuta el CLI como subproceso real (mismo camino que usan la app/el chat/terminal). */
function run(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    encoding: 'utf8', cwd: ULTRON, env, timeout: 60_000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* deja json = null */ }
  return {
    status: r.status, stdout: r.stdout, stderr: r.stderr, json,
  };
}

function seedRoots(env, ws) {
  const a = run(['roots', 'set', '--id', 'asignaturas', '--label', 'Asignaturas', '--path', ws.asignaturasDir, '--kind', 'asignatura'], env);
  assert.equal(a.status, 0, `roots set asignaturas: ${a.stderr}`);
  const p = run(['roots', 'set', '--id', 'personal', '--label', 'Personal', '--path', ws.personalDir, '--kind', 'personal'], env);
  assert.equal(p.status, 0, `roots set personal: ${p.stderr}`);
}

function readRegistry(ws) {
  const p = join(ws.dir, 'projects.json');
  if (!existsSync(p)) return { projects: [] };
  return JSON.parse(readFileSync(p, 'utf8'));
}

// --- roots -------------------------------------------------------------------

test('roots: ROOTS_NOT_CONFIGURED cuando no hay project-roots.json', () => {
  const ws = makeWorkspace();
  const r = run(['roots'], ws.env);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'ROOTS_NOT_CONFIGURED');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('roots set + roots: refleja exists por raiz', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['roots'], ws.env);
  assert.equal(r.status, 0);
  assert.equal(r.json.roots.length, 2);
  const asign = r.json.roots.find((x) => x.id === 'asignaturas');
  assert.equal(asign.exists, true);
  assert.equal(asign.kind, 'asignatura');
  rmSync(ws.dir, { recursive: true, force: true });
});

// --- templates -----------------------------------------------------------

test('templates: incluye las 3 plantillas locales + 3 generadores', () => {
  const ws = makeWorkspace();
  const r = run(['templates'], ws.env);
  assert.equal(r.status, 0);
  const ids = r.json.templates.map((t) => t.id).sort();
  assert.ok(ids.includes('vacio'));
  assert.ok(ids.includes('trabajo-entrega'));
  assert.ok(ids.includes('opengl-cmake-vcpkg'));
  assert.ok(ids.includes('python-uv'));
  assert.ok(ids.includes('web-vite-react-ts'));
  assert.ok(ids.includes('rust-cargo'));
  rmSync(ws.dir, { recursive: true, force: true });
});

// --- create: caso feliz por plantilla local ---------------------------------

test('create: plantilla local "vacio" bajo raiz personal — caso feliz', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['create', '--root', 'personal', '--name', 'MiProyecto', '--template', 'vacio'], ws.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.template, 'vacio');
  const projectPath = r.json.projectPath;
  assert.ok(existsSync(projectPath));
  assert.ok(existsSync(join(projectPath, 'README.md')));
  assert.ok(existsSync(join(projectPath, '.gitignore')));
  assert.ok(existsSync(join(projectPath, 'CLAUDE.md')));
  assert.ok(existsSync(join(projectPath, '.git')));
  const readme = readFileSync(join(projectPath, 'README.md'), 'utf8');
  assert.ok(readme.includes('MiProyecto'), 'sustitucion {{name}} aplicada');
  assert.ok(!readme.includes('{{name}}'), 'no quedan placeholders sin sustituir');

  for (const s of r.json.steps) assert.equal(s.ok, true, `step ${s.step}: ${s.message}`);

  const registry = readRegistry(ws);
  const entry = registry.projects.find((p) => p.id === r.json.projectId);
  assert.ok(entry, 'proyecto registrado en projects.json');
  assert.equal(entry.socratic, undefined, 'raiz personal: NO lleva campo socratic');
  assert.ok(entry.tags.includes('vacio'));

  assert.ok(existsSync(join(ws.dir, 'boards', r.json.projectId, 'kanban.json')), 'kanban creado');
  rmSync(ws.dir, { recursive: true, force: true });
});

// --- subject new -------------------------------------------------------------

test('subject new: crea carpeta con apuntes/codigo/trabajos + registro con socratic=uni', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['subject', 'new', '--root', 'asignaturas', '--code', 'ASIG', '--name', 'Asignatura Ejemplo'], ws.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  const subjectPath = r.json.subjectPath;
  assert.ok(subjectPath.includes('ASIG'));
  assert.ok(existsSync(join(subjectPath, 'apuntes')));
  assert.ok(existsSync(join(subjectPath, 'codigo')));
  assert.ok(existsSync(join(subjectPath, 'trabajos')));

  const registry = readRegistry(ws);
  const entry = registry.projects.find((p) => p.id === r.json.projectId);
  assert.ok(entry, 'asignatura registrada en projects.json');
  assert.equal(entry.socratic, 'uni', 'raiz asignatura: socratic = uni');
  assert.ok(existsSync(join(ws.dir, 'boards', r.json.projectId, 'kanban.json')), 'kanban de la asignatura creado');
  rmSync(ws.dir, { recursive: true, force: true });
});

// --- create: trabajo-entrega (marcador + socratic + research + kanban card) -

test('create: plantilla trabajo-entrega dentro de una asignatura — marcador, socratic=uni, sesion y tarjeta', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const subj = run(['subject', 'new', '--root', 'asignaturas', '--code', 'ASIG', '--name', 'Asignatura Ejemplo'], ws.env);
  assert.equal(subj.status, 0, subj.stdout + subj.stderr);
  const subjectDirName = 'ASIG — Asignatura Ejemplo';

  const r = run([
    'create', '--root', 'asignaturas', '--sub', `${subjectDirName}/trabajos`,
    '--name', 'Practica1', '--template', 'trabajo-entrega', '--due', '2026-12-01',
  ], ws.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const s of r.json.steps) assert.equal(s.ok, true, `step ${s.step}: ${s.message}`);

  const projectPath = r.json.projectPath;
  assert.ok(existsSync(join(projectPath, 'enunciado')));
  assert.ok(existsSync(join(projectPath, 'fuentes')));
  assert.ok(existsSync(join(projectPath, 'borrador')));
  assert.ok(existsSync(join(projectPath, 'entrega')));
  assert.ok(existsSync(join(projectPath, 'CHECKLIST.md')));

  const markerPath = join(projectPath, '.ultron-trabajo.json');
  assert.ok(existsSync(markerPath), 'marcador .ultron-trabajo.json creado');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.equal(marker.version, 1);
  assert.equal(marker.tipo, 'trabajo-entrega');
  assert.deepEqual(marker.protegidas, ['borrador', 'entrega']);
  assert.equal(marker.asignatura, subjectDirName);
  assert.ok(marker.creado);

  const registry = readRegistry(ws);
  const entry = registry.projects.find((p) => p.id === r.json.projectId);
  assert.ok(entry);
  assert.equal(entry.socratic, 'uni', 'trabajo bajo asignatura: socratic = uni');

  assert.ok(existsSync(join(ws.dir, 'research')), 'sesion de investigacion creada');

  const board = JSON.parse(readFileSync(join(ws.dir, 'boards', subj.json.projectId, 'kanban.json'), 'utf8'));
  const card = board.cards.find((c) => c.title.includes('Practica1'));
  assert.ok(card, 'tarjeta anadida al kanban de la asignatura contenedora');
  assert.ok(card.title.includes('2026-12-01'), 'fecha de vencimiento en el titulo');

  rmSync(ws.dir, { recursive: true, force: true });
});

// --- list ----------------------------------------------------------------

test('list: marca isProject/isSubject correctamente', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  run(['subject', 'new', '--root', 'asignaturas', '--code', 'ASIG', '--name', 'Asignatura Ejemplo'], ws.env);
  mkdirSync(join(ws.asignaturasDir, 'CARPETA-SUELTA'), { recursive: true });

  const r = run(['list', '--root', 'asignaturas'], ws.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const subject = r.json.entries.find((e) => e.name.includes('ASIG'));
  assert.ok(subject);
  assert.equal(subject.isProject, true);
  assert.equal(subject.isSubject, true);
  const suelta = r.json.entries.find((e) => e.name === 'CARPETA-SUELTA');
  assert.ok(suelta);
  assert.equal(suelta.isProject, false);
  assert.equal(suelta.isSubject, true);

  const inner = run(['list', '--root', 'asignaturas', '--sub', 'ASIG — Asignatura Ejemplo'], ws.env);
  assert.equal(inner.status, 0, inner.stdout + inner.stderr);
  const apuntes = inner.json.entries.find((e) => e.name === 'apuntes');
  assert.ok(apuntes);
  assert.equal(apuntes.isSubject, false, 'no es top-level, no es asignatura');

  rmSync(ws.dir, { recursive: true, force: true });
});

// --- create --dry-run ------------------------------------------------------

test('create --dry-run: no escribe nada en disco ni registra', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['create', '--root', 'personal', '--name', 'Fantasma', '--template', 'vacio', '--dry-run'], ws.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(existsSync(r.json.projectPath), false, 'dry-run no crea la carpeta');
  assert.deepEqual(r.json.filesCreated, []);
  for (const s of r.json.steps) assert.equal(s.ok, true);

  const registry = readRegistry(ws);
  assert.equal(registry.projects.length, 0, 'dry-run no registra nada');
  rmSync(ws.dir, { recursive: true, force: true });
});

// --- validaciones de seguridad -----------------------------------------------

test('create: rechaza nombre con caracteres invalidos', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['create', '--root', 'personal', '--name', 'mal:nombre', '--template', 'vacio'], ws.env);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'INVALID_NAME');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('create: rechaza metacaracteres de cmd.exe y guion inicial en el nombre (CVE-2024-27980)', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  for (const bad of ['proy & calc.exe', '100%', 'a^b', 'hola!', '-rf']) {
    const r = run(['create', '--root', 'personal', '--name', bad, '--template', 'web-vite-react-ts', '--dry-run'], ws.env);
    assert.equal(r.status, 1, `deberia rechazar ${bad}`);
    assert.equal(r.json.error.code, 'INVALID_NAME', `codigo para ${bad}`);
  }
  const ok = run(['create', '--root', 'personal', '--name', 'Práctica — 7', '--template', 'vacio', '--dry-run'], ws.env);
  assert.equal(ok.json.ok, true, 'tildes y guion largo siguen permitidos');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('create: rechaza segmentos de --sub con caracteres de sistema no permitidos', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['create', '--root', 'personal', '--sub', 'Web/mal:dir', '--name', 'X', '--template', 'vacio', '--dry-run'], ws.env);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'INVALID_NAME');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('create: rechaza traversal fuera de la raiz via --sub', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['create', '--root', 'personal', '--sub', '../../fuera', '--name', 'X', '--template', 'vacio'], ws.env);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'PATH_OUTSIDE_ROOT');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('create: ALREADY_EXISTS si la carpeta ya existe', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  mkdirSync(join(ws.personalDir, 'Repetido'), { recursive: true });
  const r = run(['create', '--root', 'personal', '--name', 'Repetido', '--template', 'vacio'], ws.env);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'ALREADY_EXISTS');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('mkdir: rechaza nombre reservado de Windows', () => {
  const ws = makeWorkspace();
  seedRoots(ws.env, ws);
  const r = run(['mkdir', '--root', 'personal', '--name', 'CON'], ws.env);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'INVALID_NAME');
  rmSync(ws.dir, { recursive: true, force: true });
});
