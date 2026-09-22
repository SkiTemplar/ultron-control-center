#!/usr/bin/env node
// scripts/redeploy-memory-sidecar.mjs — reconstruye y despliega ultron-memory.exe
// en ~/.ultron/bin/ sin caer en las tres trampas documentadas (memoria
// gotcha-deploy-ultron-memory, 2026-08-31 y 2026-09-06):
//   1. el bin target de cargo se llama `ultron-memory` (guion); `ultron_memory`
//      falla y un `| tail` tapaba el error;
//   2. build.rs cachea el git SHA: sin `touch build.rs` el binario nuevo sigue
//      diciendo el SHA viejo y `version` no sirve para verificar el despliegue;
//   3. para copiar el .exe hay que tumbar TODOS los procesos que lo tengan
//      abierto: shutdown al daemon del lockfile + taskkill a los huerfanos.
//      Un `cp` con el fichero ocupado falla y deja el binario viejo sin aviso.
//
// Uso: node scripts/redeploy-memory-sidecar.mjs [--no-build] [--no-relaunch]
// Sale con 1 si cualquier paso falla o si `version` del binario desplegado no
// coincide con `git rev-parse --short HEAD`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CRATE = path.join(ROOT, 'control-center', 'src-tauri');
const BUILT = path.join(CRATE, 'target', 'release', 'ultron-memory.exe');
const DEPLOYED = path.join(os.homedir(), '.ultron', 'bin', 'ultron-memory.exe');
const cli = require(path.join(ROOT, 'hooks', 'scripts', 'lib', 'ultron-memory-cli.js'));

const args = new Set(process.argv.slice(2));
const log = (m) => console.log(`[redeploy] ${m}`);
const fail = (m) => {
  console.error(`[redeploy] ERROR: ${m}`);
  process.exit(1);
};

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: 'pipe', ...opts });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headSha() {
  const r = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
  return r.status === 0 ? r.out.trim() : null;
}

function sidecarProcesses() {
  // PowerShell 5.1: sin `&&`, sin here-strings; solo pids del binario.
  const r = run('powershell', [
    '-NoProfile',
    '-Command',
    "Get-Process -Name ultron-memory -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
  ]);
  return r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

async function stopEverything() {
  const before = sidecarProcesses();
  if (before.length === 0) return;
  log(`procesos vivos: ${before.join(', ')} — shutdown al daemon y taskkill a los huerfanos`);
  await cli.daemonRequest({ cmd: 'shutdown' }, 3000);
  await sleep(1500);
  for (const pid of sidecarProcesses()) {
    run('taskkill', ['/PID', String(pid), '/F']);
  }
  for (let i = 0; i < 20 && sidecarProcesses().length > 0; i++) await sleep(250);
  const left = sidecarProcesses();
  if (left.length > 0) fail(`siguen vivos tras taskkill: ${left.join(', ')}`);
}

function build() {
  // Trampa 2: cargo cachea el SHA que embebe build.rs.
  const buildRs = path.join(CRATE, 'build.rs');
  const now = new Date();
  fs.utimesSync(buildRs, now, now);
  log('cargo build --release --features qdrant --bin ultron-memory (minutos)');
  // Trampa 1: nombre con guion y sin pipe que tape el exit code.
  const r = spawnSync('cargo', ['build', '--release', '--features', 'qdrant', '--bin', 'ultron-memory'], {
    cwd: CRATE,
    stdio: 'inherit',
  });
  if (r.status !== 0) fail(`cargo build salio con ${r.status}`);
  if (!fs.existsSync(BUILT)) fail(`no existe ${BUILT}`);
}

function deploy() {
  fs.mkdirSync(path.dirname(DEPLOYED), { recursive: true });
  // Trampa 3: copia con el fichero libre; si sigue ocupado, EBUSY sale aqui.
  fs.copyFileSync(BUILT, DEPLOYED);
  const a = fs.statSync(BUILT).size;
  const b = fs.statSync(DEPLOYED).size;
  if (a !== b) fail(`tamano distinto tras copiar (${a} frente a ${b})`);
  log(`desplegado ${DEPLOYED} (${b} bytes)`);
}

function verifyVersion() {
  const r = run(DEPLOYED, ['version']);
  if (r.status !== 0) fail(`version fallo: ${r.out.slice(0, 200)}`);
  const head = headSha();
  const out = r.out.trim();
  log(`version => ${out.slice(0, 160)}`);
  if (head && !out.includes(head)) {
    fail(`el binario desplegado no lleva el HEAD ${head} (build.rs cacheado o copia stale)`);
  }
}

async function relaunch() {
  if (!cli.spawnDetached(['serve'])) fail('no se pudo relanzar `serve`');
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const pong = await cli.daemonRequest({ cmd: 'ping' }, 1000);
    if (pong) {
      log('daemon relanzado y respondiendo');
      return;
    }
  }
  log('aviso: el daemon no respondio al ping en 20 s (arranca en frio; los hooks lo relanzan si hace falta)');
}

(async () => {
  if (!args.has('--no-build')) build();
  await stopEverything();
  deploy();
  verifyVersion();
  if (!args.has('--no-relaunch')) await relaunch();
  log('OK');
})().catch((e) => fail(String((e && e.stack) || e)));
