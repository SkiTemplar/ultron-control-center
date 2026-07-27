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
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;

// Discovery lockfile written by `ultron-memory serve` (the resident daemon that
// keeps E5 warm). Never committed (~/.ultron/run is gitignored).
function daemonLockPath() {
  return path.join(os.homedir(), '.ultron', 'run', 'orchestrate.json');
}

/** Read the daemon lockfile -> { port, token, pid } or null. */
function readDaemonLock() {
  try {
    const v = JSON.parse(fs.readFileSync(daemonLockPath(), 'utf8'));
    if (v && Number.isInteger(v.port) && typeof v.token === 'string') return v;
  } catch {
    /* no/!valid lockfile */
  }
  return null;
}

/**
 * Send one line-delimited JSON request to the orchestrator daemon over TCP
 * loopback. Resolves to the parsed JSON response, or null on ANY failure (no
 * daemon, connect/timeout/socket error, bad JSON). FAIL-SAFE by construction.
 * @param {{cmd: string, prompt?: string, project?: string}} payload
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
function daemonRequest(payload, timeoutMs) {
  return new Promise((resolve) => {
    const lock = readDaemonLock();
    if (!lock) return resolve(null);
    let settled = false;
    let buf = '';
    const sock = net.connect({ host: '127.0.0.1', port: lock.port });
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(val);
    };
    sock.setTimeout(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
    sock.on('connect', () => {
      try {
        sock.write(JSON.stringify({ token: lock.token, ...payload }) + '\n');
      } catch {
        done(null);
      }
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try { done(JSON.parse(buf.slice(0, nl))); } catch { done(null); }
      }
    });
    sock.on('timeout', () => done(null));
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
  });
}

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
    const rec = { cmd: args[0], ms: Date.now() - started, ok: !!(res && res.status === 0) };
    // HOOKS-JS-01: el binario Rust escribe la causa del fallo SOLO a stderr;
    // sin esto un status!=0 quedaba logueado como ok:false a secas (indiagnosticable).
    if (res && res.status !== 0 && res.stderr) {
      rec.stderr = String(res.stderr).replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 300);
    }
    logMs(rec);
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

const { appendJsonl } = require('./jsonl-log');

/** Append a one-line latency record. Best-effort, never throws. */
function logMs(rec) {
  // cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
  appendJsonl(path.join(os.homedir(), '.ultron', 'logs', 'capture.jsonl'), { ts: Date.now(), ...rec });
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

module.exports = {
  findBinary,
  runCli,
  spawnDetached,
  logMs,
  projectIdFromCwd,
  daemonRequest,
  readDaemonLock,
  daemonLockPath,
};
