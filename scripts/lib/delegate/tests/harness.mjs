/**
 * harness.mjs - entorno hermetico de scripts/delegate.selftest.mjs: repo git,
 * configuracion, ledger, delegaciones, cuota y saldo en un directorio
 * temporal; motor falso (ULTRON_DELEGATE_FAKE_ENGINE) sin red ni CLI reales.
 * No es un selftest por si mismo (no termina en .selftest.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPT = join(HERE, '..', '..', '..', 'delegate.mjs');
export const ROOT = mkdtempSync(join(tmpdir(), 'delegate-'));
export const REPO = join(ROOT, 'repo');
export const DELEG = join(ROOT, 'delegations');
export const FAKE = join(ROOT, 'fake-engine.mjs');
export const BRIEF = join(ROOT, 'brief.md');
export const USAGE = join(ROOT, 'usage.json');
export const BALANCE = join(ROOT, 'balance.json');
export const CONFIG = join(ROOT, 'delegation.json');
export const LEDGER = join(ROOT, 'delegations.jsonl');
export const PIDFILE = join(ROOT, 'grandchild.pid');
export const ABSENT_KEY = 'ULTRON_TEST_DELEGATE_ABSENT_KEY_7F3A';

const counts = { passed: 0, failed: 0 };
export const results = () => ({ ...counts });

/** Ejecuta un caso (sincrono o asincrono) y cuenta el resultado. */
export async function run(name, fn) {
  try {
    await fn();
    counts.passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    counts.failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

export const git = (...args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();

// Motor falso: lee el prompt de stdin y actua segun FAKE_MODE, que puede ser un
// modo para todos ("write") o una lista por motor ("codex:fail,*:write").
const FAKE_SOURCE = `
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const prompt = readFileSync(0, 'utf8');
if (!prompt.includes('--- ENCARGO ---')) process.exit(5);
const spec = process.env.FAKE_MODE || 'write';
const map = Object.fromEntries(spec.split(',').map((p) => p.includes(':') ? p.split(':') : ['*', p]));
const mode = map[process.env.DELEGATE_ENGINE] || map['*'] || 'write';
const hang = () => setInterval(() => {}, 1000);
if (mode === 'noop') { console.log('nada que hacer'); process.exit(0); }
if (mode === 'fail') { console.log('no puedo'); process.exit(7); }
if (mode === 'env') writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify(Object.keys(process.env)));
if (mode === 'lock') {
  const gitdir = readFileSync('.git', 'utf8').replace(/^gitdir:\\s*/, '').trim();
  writeFileSync(join(gitdir, 'index.lock'), '');
}
if (mode === 'escape') {
  // Sin sandbox (agy, OpenCode): escribe en el checkout principal (<repo>/.git/worktrees/<wt>).
  const gitdir = readFileSync('.git', 'utf8').replace(/^gitdir:\\s*/, '').trim();
  writeFileSync(join(gitdir, '..', '..', '..', 'escapado.txt'), 'fuera');
}
if (mode === 'escape-same' || mode === 'escape-only') {
  // Escribe en el checkout principal lo mismo que en el worktree, o solo alli.
  const gitdir = readFileSync('.git', 'utf8').replace(/^gitdir:\\s*/, '').trim();
  writeFileSync(join(gitdir, '..', '..', '..', 'hecho.txt'), 'ok\\n');
  if (mode === 'escape-only') process.exit(0);
}
if (mode === 'plant-config' || mode === 'plant-hook') {
  const gitdir = readFileSync('.git', 'utf8').replace(/^gitdir:\\s*/, '').trim();
  const common = join(gitdir, '..', '..');
  if (mode === 'plant-config') appendFileSync(join(common, 'config'), '\\n[alias]\\n\\tplantado = status\\n');
  else writeFileSync(join(common, 'hooks', 'post-commit'), '#!/bin/sh\\nexit 0\\n');
}
if (mode === 'commit-outside') {
  // Un commit propio no debe esconder un fichero del alcance.
  writeFileSync('fuera.md', 'x');
  spawnSync('git', ['add', 'fuera.md']);
  spawnSync('git', ['commit', '-q', '-m', 'del motor']);
}
if (mode === 'rename-outside') {
  mkdirSync('dentro', { recursive: true });
  renameSync('zona/secreto.md', 'dentro/secreto.md');
  process.exit(0);
}
if (mode === 'orphan') {
  // Servidor que sobrevive al motor (detached: sale del Job Object de libuv).
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  g.unref();
  writeFileSync(process.env.FAKE_PIDFILE, String(g.pid));
}
if (mode === 'hang') {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_PIDFILE, String(g.pid));
  hang();
} else if (mode === 'oc-hang') {
  console.error('level=ERROR service=session message="stream error" small=false error.error="AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached"');
  hang();
} else if (mode === 'unicode') {
  writeFileSync('a\\u00f1o.txt', 'ok\\n');
  console.log('He creado a\\u00f1o.txt');
} else {
  writeFileSync(mode === 'outside' ? 'fuera.md' : 'hecho.txt', 'ok\\n');
  if (mode === 'red') writeFileSync('rojo.txt', 'rojo\\n');
  if (mode === 'crash') process.exit(7);
  if (mode === 'claude-ok') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'Hecho por claude', total_cost_usd: 0.0123 }));
  else if (mode === 'claude-err') console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'rate limit', total_cost_usd: 0.001 }));
  else console.log('He creado hecho.txt');
}
`;

export const CONFIG_JSON = {
  version: 1,
  chain: ['codex', 'agy', 'needkey', 'oc'],
  tiers: { complex: { start: 'codex' }, standard: { start: 'agy' }, trivial: { start: 'needkey' } },
  relayOnCheckFail: true,
  engines: {
    codex: { runner: 'codex', model: 'gpt-5.6-terra', tierModels: { complex: 'gpt-5.6-sol' }, enabled: true },
    agy: { runner: 'agy', model: 'gemini-3.8-flash-high', enabled: true },
    needkey: { runner: 'opencode', model: 'deepseek/deepseek-flash', keyEnv: ABSENT_KEY, enabled: true },
    oc: { runner: 'opencode', model: 'opencode/free', enabled: true },
    cl: { runner: 'claude', model: 'claude-x', maxBudgetUsd: 1, enabled: true },
    off: { runner: 'codex', model: 'gpt-5.6-terra', enabled: false },
  },
};

/** Crea el repo de prueba y los ficheros del entorno. */
export function setup() {
  writeFileSync(FAKE, FAKE_SOURCE);
  mkdirSync(REPO);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(REPO, 'README.md'), 'repo de prueba\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  mkdirSync(join(REPO, 'deps'));
  writeFileSync(join(REPO, 'deps', 'lib.txt'), 'dependencia\n');
  writeFileSync(BRIEF, '# Crear hecho.txt\n\nCrea el fichero hecho.txt con el texto ok.\n');
  writeFileSync(USAGE, 'null');
  writeFileSync(BALANCE, 'null');
  writeFileSync(CONFIG, JSON.stringify(CONFIG_JSON));
}

/** Lanza delegate.mjs con el entorno hermetico; `extraEnv` manda sobre todo. */
export function delegate(args, mode = 'write', extraEnv = {}) {
  const env = {
    ...process.env,
    ULTRON_DELEGATE_DIR: DELEG,
    ULTRON_DELEGATE_FAKE_ENGINE: FAKE,
    ULTRON_DELEGATE_USAGE: USAGE,
    ULTRON_DELEGATE_BALANCE: BALANCE,
    ULTRON_DELEGATE_CONFIG: CONFIG,
    ULTRON_DELEGATE_LEDGER: LEDGER,
    ULTRON_DELEGATE_NO_REGISTRY: '1',
    FAKE_MODE: mode,
    FAKE_PIDFILE: PIDFILE,
  };
  delete env[ABSENT_KEY];
  Object.assign(env, extraEnv);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
}

export const idOf = (out) => (out.match(/^delegate (\S+) ·/m) || [])[1];
export const check = (code) => `node -e "process.exit(${code})"`;
export const ledger = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
export const ledgerOf = (id) => ledger().filter((e) => e.id === id);
export const branchExists = (b) => git('branch', '--list', b) !== '';
export const worktreeCount = () => git('worktree', 'list').split('\n').length;
export const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
