// hooks/scripts/lib/ultron-memory-cli.js
//
// Locate + run the `ultron-memory` Rust sidecar so the Claude Code hooks reuse
// the canonical memory/orchestrator logic. FAIL-SAFE: any error returns null.
//
// CHANGES (2026-06-05, memory-reliability sprint):
//   - runCli() acepta opts { stdin, timeoutMs } para que cada hook dimensione su
//     propio presupuesto (antes 8000ms fijo, sin margen bajo timeout 10s). El
//     primer embed E5 en frio tarda 1-2s; verificado: recall en frio = ~2987ms.
//     Back-compat: un string como 2o arg sigue siendo stdin.
//   - spawnDetached(): lanza el binario totalmente detached (no espera) para el
//     warmup de SessionStart sin gastar el presupuesto del hook.
//   - logMs(): una linea JSON por llamada a ~/.ultron/logs/capture.jsonl.

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;

function findBinary() {
  const exe = process.platform === 'win32' ? 'ultron-memory.exe' : 'ultron-memory';
  if (process.env.ULTRON_MEMORY_BIN && fs.existsSync(process.env.ULTRON_MEMORY_BIN)) {
    return process.env.ULTRON_MEMORY_BIN;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.ultron', 'bin', exe),
    path.join(home, '.ultron', 'control-center', 'src-tauri', 'target', 'release', exe),
    path.join(home, '.ultron', 'control-center', 'src-tauri', 'target', 'debug', exe),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * Run an ultron-memory subcommand. `args` array; `opts`: { stdin?, timeoutMs? }.
 * Returns parsed JSON or null on ANY failure. Back-compat: string opts == stdin.
 */
function runCli(args, opts) {
  const bin = findBinary();
  if (!bin) return null;
  let stdin;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof opts === 'string') {
    stdin = opts;
  } else if (opts && typeof opts === 'object') {
    stdin = opts.stdin;
    if (Number.isFinite(opts.timeoutMs)) timeoutMs = opts.timeoutMs;
  }
  const started = Date.now();
  try {
    const res = spawnSync(bin, args, {
      input: stdin || undefined,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    logMs({ cmd: args[0], ms: Date.now() - started, ok: res && res.status === 0 });
    if (!res || res.status !== 0 || !res.stdout) return null;
    return JSON.parse(res.stdout.trim());
  } catch {
    logMs({ cmd: args && args[0], ms: Date.now() - started, ok: false });
    return null;
  }
}

/**
 * Lanza el binario detached: NO espera, ignora stdio, unref para que el hook
 * salga ya. Usado por el warmup de SessionStart. NUNCA lanza; devuelve bool.
 */
function spawnDetached(args) {
  const bin = findBinary();
  if (!bin) return false;
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* best effort */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Append a one-line latency record. Best-effort, never throws. */
function logMs(rec) {
  try {
    const dir = path.join(os.homedir(), '.ultron', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'capture.jsonl'), JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
  } catch { /* ignore */ }
}

/** Normalise a cwd into a project_id (basename, leading dots stripped). */
function projectIdFromCwd(cwd) {
  try {
    const base = path.basename(cwd || process.cwd());
    const p = base.replace(/^\.+/, '');
    return p || null;
  } catch {
    return null;
  }
}

module.exports = { findBinary, runCli, spawnDetached, logMs, projectIdFromCwd };
