// project-create-skills.selftest.mjs — checks herméticos de la integración del
// creador de proyectos con la pool de skills (plan 2026-10-18-skill-pool, F3):
// `create --skills a,b|none`, el defecto por plantilla, el fallo de `link` que
// no aborta la creación y el subcomando `skills` que consume el asistente.
//
// Cada test monta su propio workspace temporal: raíces, registro, tableros,
// sesiones de investigación y una pool (ULTRON_SKILL_POOL_ROOT) cuyas entradas
// salen de un remoto git local clonado por file://. Nunca toca el cockpit ni
// la pool reales.
//
// Uso: node scripts/project-create-skills.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ULTRON = join(import.meta.dirname, '..');
const CREATE_CLI = join(import.meta.dirname, 'project-create.mjs');
const POOL_CLI = join(import.meta.dirname, 'skill-pool.mjs');
const GIT_ID = ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Remoto de prueba con una skill en skills/demo; se comparte entre tests. */
function makeRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'pc-skills-remote-'));
  git(['init', '--quiet', '-b', 'main'], dir);
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: skill de prueba\n---\nCuerpo.\n');
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'uno'], dir);
  return { dir, url: pathToFileURL(dir).href, sha: git(['rev-parse', 'HEAD'], dir) };
}

const REMOTE = makeRemote();
process.on('exit', () => rmSync(REMOTE.dir, { recursive: true, force: true, maxRetries: 3 }));

function spawnCli(cli, args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: ULTRON, env, timeout: 60_000 });
}

function poolOk(ws, args) {
  const r = spawnCli(POOL_CLI, args, ws.env);
  assert.equal(r.status, 0, `skill-pool ${args.join(' ')}: ${r.stdout}${r.stderr}`);
}

function create(ws, args) {
  const r = spawnCli(CREATE_CLI, [...args, '--json'], ws.env);
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* json = null */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json };
}

/**
 * Workspace con raíz "personal" y una pool de tres entradas:
 *   demo     skill revisada, sugerida por "vacio"
 *   cruda    skill SIN revisar, sugerida por "vacio" (su link falla)
 *   libpy    python-lib (nunca se enlaza al crear)
 */
function makeWorkspace({ seedPool = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-skills-selftest-'));
  const personalDir = join(dir, 'PERSONAL');
  mkdirSync(personalDir, { recursive: true });
  const env = {
    ...process.env,
    ULTRON_PROJECT_ROOTS_OVERRIDE: join(dir, 'project-roots.json'),
    ULTRON_PROJECTS_JSON_OVERRIDE: join(dir, 'projects.json'),
    ULTRON_BOARDS_DIR_OVERRIDE: join(dir, 'boards'),
    RESEARCH_ROOT_OVERRIDE: join(dir, 'research'),
    ULTRON_SKILL_POOL_ROOT: join(dir, 'pool'),
  };
  delete env.ULTRON_PROJECTS_JSON;
  const ws = { dir, personalDir, env };
  const roots = create(ws, ['roots', 'set', '--id', 'personal', '--label', 'Personal', '--path', personalDir, '--kind', 'personal']);
  assert.equal(roots.status, 0, roots.out);
  if (seedPool) {
    poolOk(ws, ['add', REMOTE.url, '--name', 'demo', '--kind', 'skill', '--sha', REMOTE.sha, '--path', 'skills/demo', '--license', 'MIT', '--templates', 'vacio']);
    poolOk(ws, ['review', 'demo', '--notes', 'APTA. Revisada en el selftest sin red ni scripts.']);
    poolOk(ws, ['add', REMOTE.url, '--name', 'cruda', '--kind', 'skill', '--sha', REMOTE.sha, '--path', 'skills/demo', '--license', 'MIT', '--templates', 'vacio']);
    poolOk(ws, ['add', '--name', 'libpy', '--kind', 'python-lib', '--version', '1.0.0', '--license', 'MIT']);
  }
  return ws;
}

function wsTest(name, fn, opts) {
  test(name, () => {
    const ws = makeWorkspace(opts);
    try {
      fn(ws);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

const linkPath = (projectPath, name) => join(projectPath, '.claude', 'skills', name);
const registry = (ws) => JSON.parse(readFileSync(join(ws.dir, 'projects.json'), 'utf8'));
const baseArgs = (name) => ['create', '--root', 'personal', '--name', name, '--template', 'vacio', '--no-git'];

// --- subcomando skills -----------------------------------------------------------

wsTest('skills: solo kind skill, sugeridas por plantilla, revisión y condiciones', (ws) => {
  const r = create(ws, ['skills', '--template', 'vacio']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.skills.map((s) => s.name), ['demo', 'cruda'], 'libpy (python-lib) no aparece');
  const demo = r.json.skills.find((s) => s.name === 'demo');
  assert.equal(demo.suggested, true);
  assert.equal(demo.reviewed, true);
  assert.equal(demo.license, 'MIT');
  assert.match(demo.conditions, /^APTA\. Revisada/);
  assert.equal(r.json.skills.find((s) => s.name === 'cruda').reviewed, false);

  const other = create(ws, ['skills', '--template', 'python-uv']);
  assert.ok(other.json.skills.every((s) => !s.suggested), 'otra plantilla no sugiere nada');
});

wsTest('skills: pool inexistente = lista vacía (el asistente oculta la sección)', (ws) => {
  const r = create(ws, ['skills']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.skills, []);
}, { seedPool: false });

// --- create --skills ---------------------------------------------------------------

wsTest('create --skills explícito: enlaza la skill tras registrar el proyecto', (ws) => {
  const r = create(ws, [...baseArgs('ConSkill'), '--skills', 'demo']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.skills.map((s) => [s.name, s.ok]), [['demo', true]]);
  assert.ok(existsSync(join(linkPath(r.json.projectPath, 'demo'), 'SKILL.md')), 'junction a la skill');
  assert.ok(r.json.steps.find((s) => s.step === 'skill:demo').ok);
});

wsTest('create sin --skills: usa las sugeridas por la plantilla y omite las sin revisar', (ws) => {
  const r = create(ws, baseArgs('PorDefecto'));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.skills.map((s) => s.name), ['demo']);
  assert.ok(existsSync(linkPath(r.json.projectPath, 'demo')));
  assert.equal(existsSync(linkPath(r.json.projectPath, 'cruda')), false);
  assert.match(r.json.steps.find((s) => s.step === 'skills').message, /sin revisar, no se enlazan: cruda/);
});

wsTest('create --skills none: no enlaza nada aunque la plantilla sugiera', (ws) => {
  const r = create(ws, [...baseArgs('SinSkills'), '--skills', 'none']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.skills, []);
  assert.equal(existsSync(join(r.json.projectPath, '.claude', 'skills')), false);
});

wsTest('create: un link que falla no aborta la creación y queda en la salida', (ws) => {
  const r = create(ws, [...baseArgs('LinkRoto'), '--skills', 'demo,cruda']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.json.ok, true);
  assert.ok(existsSync(r.json.projectPath), 'el proyecto existe');
  assert.ok(registry(ws).projects.some((p) => p.id === r.json.projectId), 'el proyecto está registrado');
  const cruda = r.json.skills.find((s) => s.name === 'cruda');
  assert.equal(cruda.ok, false);
  assert.match(cruda.message, /skill-pool link falló/);
  assert.equal(r.json.steps.find((s) => s.step === 'skill:cruda').ok, false);
  assert.ok(r.json.skills.find((s) => s.name === 'demo').ok, 'la otra skill sí se enlaza');
});

wsTest('create --dry-run: lista las skills que enlazaría sin crear nada', (ws) => {
  const r = create(ws, [...baseArgs('Fantasma'), '--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.json.skills.map((s) => s.name), ['demo']);
  assert.match(r.json.steps.find((s) => s.step === 'skills').message, /^se enlazarían .*demo/);
  assert.equal(existsSync(r.json.projectPath), false);
});

// --- casos negativos: abortan ANTES de tocar el disco -------------------------------

wsTest('create --skills con un nombre fuera de la pool: BAD_ARGS sin crear la carpeta', (ws) => {
  const r = create(ws, [...baseArgs('Typo'), '--skills', 'demo,inexistente']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.match(r.json.error.message, /inexistente/);
  assert.equal(existsSync(join(ws.personalDir, 'Typo')), false);
});

wsTest('create --skills con una python-lib: BAD_ARGS (solo kind skill al crear)', (ws) => {
  const r = create(ws, [...baseArgs('ConLib'), '--skills', 'libpy']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'BAD_ARGS');
  assert.match(r.json.error.message, /libpy \(python-lib\)/);
  assert.equal(existsSync(join(ws.personalDir, 'ConLib')), false);
});
