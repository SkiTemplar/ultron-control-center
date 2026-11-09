// testkit.mjs — utilidades del selftest de skill-pool (scripts/skill-pool.selftest.mjs).
//
// Cada workspace es un directorio temporal con su pool (ULTRON_SKILL_POOL_ROOT),
// su registro de proyectos (ULTRON_PROJECTS_JSON) y un home falso
// (USERPROFILE/HOME). El remoto es un repo git local clonado por file://.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = join(import.meta.dirname, '..', 'skill-pool.mjs');
const GIT_ID = ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false'];

export function git(args, cwd) {
  const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Remoto de prueba: dos commits; el segundo cambia un fichero de la skill. */
export function makeRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'skill-pool-remote-'));
  git(['init', '--quiet', '-b', 'main'], dir);
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: skill de prueba\n---\nCuerpo de demo.\n');
  writeFileSync(join(dir, 'skills', 'demo', 'ref.md'), 'v1\n');
  writeFileSync(join(dir, 'README.md'), 'remoto de prueba\n');
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', 'uno'], dir);
  const sha1 = git(['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'skills', 'demo', 'ref.md'), 'v2\n');
  git(['commit', '--quiet', '-am', 'dos'], dir);
  const sha2 = git(['rev-parse', 'HEAD'], dir);
  return { dir, url: pathToFileURL(dir).href, sha1, sha2 };
}

function makeWorkspace(remote) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-pool-selftest-'));
  const ws = {
    dir,
    remote,
    poolRoot: join(dir, 'pool'),
    project: join(dir, 'proyecto'),
    home: join(dir, 'home'),
    otherHome: join(dir, 'otro-home'),
    registry: join(dir, 'projects.json'),
  };
  for (const d of [ws.project, ws.home, ws.otherHome]) mkdirSync(d, { recursive: true });
  ws.projects = [
    { id: 'demo-proj', path: ws.project },
    { id: '__home', path: ws.otherHome },
    { id: 'home-path', path: ws.home },
  ];
  writeFileSync(ws.registry, JSON.stringify({ version: 1, projects: ws.projects }));
  ws.env = {
    ...process.env,
    ULTRON_SKILL_POOL_ROOT: ws.poolRoot,
    ULTRON_PROJECTS_JSON: ws.registry,
    USERPROFILE: ws.home,
    HOME: ws.home,
  };
  ws.link = join(ws.project, '.claude', 'skills', 'demo');
  ws.clone = join(ws.poolRoot, 'repos', `demo@${remote.sha1.slice(0, 7)}`);
  return ws;
}

/** Test con workspace propio; el directorio temporal se borra pase lo que pase. */
export function wsTest(remote, name, fn) {
  test(name, () => {
    const ws = makeWorkspace(remote);
    try {
      fn(ws);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

/** Añade un proyecto al registro del workspace. */
export function registerProject(ws, id, path) {
  ws.projects.push({ id, path });
  writeFileSync(ws.registry, JSON.stringify({ version: 1, projects: ws.projects }));
}

export function run(ws, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: ws.env, timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

export function ok(ws, args) {
  const r = run(ws, args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.out}`);
  return r;
}

export function rejected(ws, args, pattern) {
  const r = run(ws, args);
  assert.equal(r.status, 1, `${args.join(' ')} debería fallar: ${r.out}`);
  assert.match(r.out, pattern);
  return r;
}

export function addDemo(ws, { name = 'demo', review = true } = {}) {
  ok(ws, ['add', ws.remote.url, '--name', name, '--kind', 'skill', '--sha', ws.remote.sha1, '--path', 'skills/demo', '--license', 'MIT']);
  if (review) ok(ws, ['review', name, '--notes', 'revisada en el selftest']);
}

export const readPool = (ws) => JSON.parse(readFileSync(join(ws.poolRoot, 'pool.json'), 'utf8'));
export const readGitignore = (ws) => readFileSync(join(ws.project, '.gitignore'), 'utf8');
export const isLink = (p) => existsSync(p) && lstatSync(p).isSymbolicLink();
