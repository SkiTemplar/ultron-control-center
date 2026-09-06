'use strict';
/**
 * lib/run-project-tests.js — tests automaticos por proyecto (ULTRON 4, F4.1).
 *
 * Decisiones (usuario, 2026-09-04): suite COMPLETA con tope de tiempo (Q3b,
 * diferido), sin logica por fichero. El comando sale, por este orden, de:
 *   1. una linea `test: <comando>` en el CLAUDE.md del proyecto (explicito);
 *   2. el manifiesto: package.json (scripts.test real), Cargo.toml, pyproject/
 *      pytest, go.mod.
 * Sin comando: se registra `no_command` y el reporter lo dice una vez por
 * sesion (aplicar tests sin que lo pidan empieza por decir que no los hay).
 *
 * Estado por proyecto en RUN_TESTS_STATE_DIR (~/.ultron/.tmp/run-tests/):
 *   <project>.state.json   debounce, lock del runner, dirty, reported_status
 *   <project>.result.json  ultimo resultado (status, fallos, resumen, cola)
 *
 * Overrides (selftest): RUN_TESTS_STATE_DIR, RUN_TESTS_TIME_CAP_MS,
 * RUN_TESTS_DEBOUNCE_MS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const STATE_DIR = process.env.RUN_TESTS_STATE_DIR || path.join(HOME, '.ultron', '.tmp', 'run-tests');
const TIME_CAP_MS = Number(process.env.RUN_TESTS_TIME_CAP_MS) > 0 ? Number(process.env.RUN_TESTS_TIME_CAP_MS) : 120000;
const DEBOUNCE_MS = process.env.RUN_TESTS_DEBOUNCE_MS !== undefined
  ? Math.max(0, Number(process.env.RUN_TESTS_DEBOUNCE_MS) || 0)
  : 60000;
// Un lock mas viejo que el tope + margen es de un runner muerto.
const LOCK_STALE_MS = TIME_CAP_MS + 30000;
const OUTPUT_TAIL_CHARS = 2000;
const MAX_FAILED_NAMES = 12;
const MAX_BUFFER = 8 * 1024 * 1024;

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.rs', '.py', '.go', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.java', '.kt', '.swift', '.rb', '.php',
]);

const NPM_PLACEHOLDER_RE = /no test specified/i;
// `test: <cmd>` o `test: \`<cmd>\` (comentario)`: con backticks se toma solo su
// contenido y se ignora el resto de la linea; sin backticks, la linea entera.
const CLAUDE_MD_TEST_RE = /^[\s\-*>]*(?:tests?|test_cmd|comando de tests?)\s*:\s*(?:`([^`\r\n]+)`.*|([^`\r\n]+?)\s*)$/im;

function isCodeFile(filePath) {
  return CODE_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

function normalizePath(p) {
  if (!p) return '';
  try {
    return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function isUnder(filePath, root) {
  const f = normalizePath(filePath);
  const r = normalizePath(root);
  return !!f && !!r && (f === r || f.startsWith(r + '/'));
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function fromClaudeMd(cwd) {
  for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
    const p = path.join(cwd, rel);
    if (!fileExists(p)) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    const m = CLAUDE_MD_TEST_RE.exec(text);
    const cmd = m ? String(m[1] || m[2] || '').trim() : '';
    if (cmd) return { cmd, source: rel };
  }
  return null;
}

function packageManager(cwd) {
  if (fileExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm test';
  if (fileExists(path.join(cwd, 'yarn.lock'))) return 'yarn test';
  if (fileExists(path.join(cwd, 'bun.lockb')) || fileExists(path.join(cwd, 'bun.lock'))) return 'bun run test';
  return 'npm test --silent';
}

function fromManifest(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()
    && !NPM_PLACEHOLDER_RE.test(pkg.scripts.test)) {
    return { cmd: packageManager(cwd), source: 'package.json' };
  }
  if (fileExists(path.join(cwd, 'Cargo.toml'))) return { cmd: 'cargo test --quiet', source: 'Cargo.toml' };
  if (fileExists(path.join(cwd, 'pyproject.toml')) || fileExists(path.join(cwd, 'pytest.ini'))
    || fileExists(path.join(cwd, 'conftest.py')) || fileExists(path.join(cwd, 'tests'))) {
    return { cmd: 'uv run pytest -q', source: 'pyproject/pytest' };
  }
  if (fileExists(path.join(cwd, 'go.mod'))) return { cmd: 'go test ./...', source: 'go.mod' };
  return null;
}

// { cmd, source } o null.
function detectTestCommand(cwd) {
  if (!cwd) return null;
  return fromClaudeMd(cwd) || fromManifest(cwd);
}

function statePath(project) {
  return path.join(STATE_DIR, `${project}.state.json`);
}

function resultPath(project) {
  return path.join(STATE_DIR, `${project}.result.json`);
}

function readState(project) {
  return readJson(statePath(project)) || {};
}

function writeState(project, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(project), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function readResult(project) {
  return readJson(resultPath(project));
}

function writeResult(project, result) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(resultPath(project), JSON.stringify(result, null, 2) + '\n', 'utf8');
}

function isLockStale(running) {
  if (!running || !running.started_at) return true;
  const age = Date.now() - Date.parse(running.started_at);
  return !Number.isFinite(age) || age > LOCK_STALE_MS;
}

const uniq = (arr) => Array.from(new Set(arr));

// Nombres de tests fallidos y resumen, por familia de runner. Sin patron
// reconocido y exit != 0: lista vacia y resumen con el exit code.
function parseFailures(output, exitCode) {
  const text = String(output || '');
  const failed = [];
  let summary = '';
  for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED\s*$/gm)) failed.push(m[1]);
  const cargoSummary = [...text.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)].pop();
  if (cargoSummary) summary = `cargo: ${cargoSummary[2]} passed, ${cargoSummary[3]} failed`;

  for (const m of text.matchAll(/^\s*[✕×✗]\s+(.+?)(?:\s+\d+\s*ms)?\s*$/gm)) failed.push(m[1].trim());
  for (const m of text.matchAll(/^\s*FAIL\s+(\S+\.[a-z]+)(?:\s*>\s*(.+?))?\s*$/gm)) {
    if (m[2]) failed.push(`${m[1]} > ${m[2].trim()}`);
  }
  const jsSummary = [...text.matchAll(/Tests:?\s+(\d+) failed/g)].pop();
  if (jsSummary && !summary) summary = `${jsSummary[1]} failed`;

  for (const m of text.matchAll(/^FAILED (\S+)/gm)) failed.push(m[1]);
  const pySummary = [...text.matchAll(/=+ .*?(\d+) failed.*? =+/g)].pop();
  if (pySummary && !summary) summary = `pytest: ${pySummary[1]} failed`;

  for (const m of text.matchAll(/^--- FAIL: (\S+)/gm)) failed.push(m[1]);

  const names = uniq(failed);
  if (!summary) summary = names.length ? `${names.length} failed` : (exitCode === 0 ? 'ok' : `exit ${exitCode}`);
  return { failed: names, summary };
}

// Mata el arbol de procesos del comando: con `shell: true` el hijo directo es
// el shell y un `spawnSync` con timeout solo mataria a este, dejando el runner
// real (cargo, vitest...) vivo y comiendo CPU tras el tope.
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* nada */ }
  }
}

// Ejecuta el comando en `cwd` con tope de tiempo. Resuelve
// { status: 'passed'|'failed'|'timeout', exit_code, output, duration_ms }.
function runCommand(cmd, cwd, capMs = TIME_CAP_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let done = false;
    const finish = (status, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, exit_code: code, output, duration_ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      output = String(err && err.message);
      return finish('failed', 1);
    }
    const onData = (chunk) => {
      if (output.length < MAX_BUFFER) output += chunk.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      killTree(child);
      finish('timeout', null);
    }, capMs);
    child.on('error', (err) => {
      output += `\n${String(err && err.message)}`;
      finish('failed', 1);
    });
    child.on('close', (code) => {
      const exit = typeof code === 'number' ? code : 1;
      finish(exit === 0 ? 'passed' : 'failed', exit);
    });
  });
}

function tailOf(text, n = OUTPUT_TAIL_CHARS) {
  const s = String(text || '').replace(/\[[0-9;]*m/g, '');
  return s.length > n ? s.slice(-n) : s;
}

module.exports = {
  STATE_DIR,
  TIME_CAP_MS,
  DEBOUNCE_MS,
  LOCK_STALE_MS,
  MAX_FAILED_NAMES,
  CODE_EXTS,
  isCodeFile,
  isUnder,
  detectTestCommand,
  statePath,
  resultPath,
  readState,
  writeState,
  readResult,
  writeResult,
  isLockStale,
  parseFailures,
  runCommand,
  tailOf,
};
