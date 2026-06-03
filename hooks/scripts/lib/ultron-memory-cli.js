// hooks/scripts/lib/ultron-memory-cli.js
//
// Locate + run the `ultron-memory` Rust sidecar so the Claude Code hooks reuse
// the canonical memory/orchestrator logic (no JS duplication). Every helper is
// FAIL-SAFE: any error returns null so a hook can degrade to a no-op and NEVER
// break the session.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
 * Run an ultron-memory subcommand. `args` is an array; `stdin` optional string.
 * Returns the parsed JSON object, or null on ANY failure (missing binary,
 * non-zero exit, bad JSON, timeout). Hooks must treat null as "skip".
 */
function runCli(args, stdin) {
  const bin = findBinary();
  if (!bin) return null;
  try {
    const res = spawnSync(bin, args, {
      input: stdin || undefined,
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    if (!res || res.status !== 0 || !res.stdout) return null;
    return JSON.parse(res.stdout.trim());
  } catch {
    return null;
  }
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

module.exports = { findBinary, runCli, projectIdFromCwd };
