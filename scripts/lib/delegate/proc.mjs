/**
 * proc.mjs - procesos del delegador: git, motores y checks.
 *
 * `runLogged` lanza un proceso de forma asincrona, vuelca stdout y stderr al
 * log, vigila cada tuberia con `watch` (un buffer de linea por tuberia) y, al
 * agotar el plazo o al ver un fallo terminal, mata el ARBOL entero
 * (`taskkill /T /F` en Windows, grupo de procesos en POSIX). Con spawnSync +
 * shell solo moria cmd.exe y el motor quedaba huerfano.
 *
 * Los motores se lanzan SIN shell (`{ file, args }`, ver launcher.mjs); solo
 * el check, que escribe Opus, va con shell (`{ shellCmd }`). Tras `exit` no se
 * llama a killTree: el PID puede estar ya reutilizado por otro proceso.
 *
 * En Windows, al salir el proceso se recogen sus descendientes huerfanos
 * (`reapOrphans`): servidores de agy u OpenCode que sobreviven al motor y
 * retienen el worktree. `taskkill /T` no sirve con la raiz ya muerta (`no se
 * encontro el proceso`), asi que se leen PID, PPID y hora de creacion de la
 * tabla de procesos y se mata con `taskkill /T /F` cada descendiente. La hora
 * de creacion descarta un PID reutilizado: un hijo directo real nace entre el
 * arranque y la salida del motor.
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolveLauncher } from './launcher.mjs';

export class UsageError extends Error {}

/** Gracia tras `exit` para recoger la salida si un nieto retiene las tuberias. */
const CLOSE_GRACE_MS = 2000;
/** Holgura (ms) al comparar horas de creacion con Date.now(). */
const CLOCK_SLACK_MS = 50;
/** Tabla de procesos de Windows: `PID PPID creacion-ms` por linea. */
const PROCESS_TABLE_PS =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, " +
  '$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) }';
/** Stdout que se guarda para que el adaptador lo interprete (JSON de claude -p). */
const STDOUT_KEEP_BYTES = 4 * 1024 * 1024;

/**
 * Variables que recibe git: lista blanca, no lista negra. Fuera las keys (git
 * ejecuta filtros, alias y `core.fsmonitor` de una config que un motor sin
 * sandbox puede haber tocado) y fuera GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*,
 * GIT_SSH_COMMAND y compania, que cambiarian a que repo o programa apunta.
 */
const GIT_ENV_ALLOWED = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'USERNAME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CONFIG_HOME',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

/** Copia de `base` solo con las variables que git necesita. Pura. */
export function gitEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => GIT_ENV_ALLOWED.has(k.toUpperCase())));
}

/**
 * git con entorno limpio, `core.fsmonitor` anulado (un valor plantado se
 * ejecutaria en cada `status`) y `core.quotePath=false`: sin este ultimo, las
 * rutas no ASCII salen citadas y con octales (`"a\303\261o.ts"`) y no casan con
 * ningun glob de `--scope`. `opts.config`: mas `-c clave=valor` para esta llamada.
 */
export function git(cwd, args, opts = {}) {
  const config = ['core.fsmonitor=', 'core.quotePath=false', ...(opts.config || [])].flatMap((c) => ['-c', c]);
  const r = spawnSync('git', [...config, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv() });
  if (r.status !== 0 && !opts.allowFail) {
    throw new UsageError(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  // raw: sin trim (la primera entrada de `status --porcelain` puede empezar por espacio).
  return opts.raw ? r.stdout || '' : (r.stdout || '').trim();
}

/** Plazos de lo que se lanza dentro del manejador de `exit`: un cuelgue paralizaria la delegacion ya terminada. */
const PROCESS_TABLE_TIMEOUT_MS = 15_000;
const TASKKILL_TIMEOUT_MS = 10_000;
const REAP_BUDGET_MS = 30_000;

/** spawnSync con plazo: mata al hijo al agotarlo y lo dice en `timedOut`. */
export function boundedSync(file, args, { timeoutMs, capture = false }) {
  const r = spawnSync(file, args, {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL',
    stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore',
  });
  return { status: r.status, stdout: r.stdout || '', timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT') };
}

const killPid = (pid) => boundedSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: TASKKILL_TIMEOUT_MS });

export function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      killPid(child.pid);
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* el proceso ya salio */
  }
}

/**
 * PIDs descendientes de `rootPid` en `rows` ({ pid, ppid, created }). Pura.
 * Primer nivel: hijos nacidos entre `startMs` y `exitMs` (otro proceso que
 * reutilice el PID de la raiz nace despues). Niveles siguientes: hijos de un
 * descendiente nacidos despues que el.
 */
export function descendantsOf(rows, rootPid, { startMs, exitMs }) {
  const found = new Map();
  let frontier = rows.filter((r) => r.pid !== rootPid && r.ppid === rootPid
    && r.created >= startMs - CLOCK_SLACK_MS && r.created <= exitMs + CLOCK_SLACK_MS);
  while (frontier.length) {
    for (const r of frontier) found.set(r.pid, r.created);
    frontier = rows.filter((r) => !found.has(r.pid) && r.pid !== rootPid && found.has(r.ppid) && r.created >= found.get(r.ppid));
  }
  return [...found.keys()];
}

/** Tabla de procesos de Windows, o null si no se pudo leer o no respondio a tiempo. */
function processTable() {
  const r = boundedSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TABLE_PS], { timeoutMs: PROCESS_TABLE_TIMEOUT_MS, capture: true });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isFinite))
    .map(([pid, ppid, created]) => ({ pid, ppid, created }));
}

/**
 * Solo Windows: mata con `taskkill /T /F` los descendientes que sobreviven a
 * `pid` (ya salido). Devuelve los PIDs atacados; un fallo al leer la tabla o
 * agotar el plazo total se avisa por stderr y no rompe el intento. `deps`: seam
 * de test.
 */
export function reapOrphans(pid, { startMs, exitMs }, deps = {}) {
  const { platform = process.platform, table = processTable, kill = killPid, now = Date.now } = deps;
  if (platform !== 'win32' || !pid) return [];
  const deadline = now() + REAP_BUDGET_MS;
  const rows = table();
  if (!rows) {
    console.error(`aviso: no se pudo leer la tabla de procesos; los descendientes de ${pid} pueden seguir vivos`);
    return [];
  }
  const orphans = descendantsOf(rows, pid, { startMs, exitMs });
  const attacked = [];
  for (const o of orphans) {
    if (now() >= deadline) {
      console.error(`aviso: plazo agotado matando descendientes de ${pid}; pueden seguir vivos: ${orphans.filter((x) => !attacked.includes(x)).join(', ')}`);
      break;
    }
    kill(o);
    attacked.push(o);
  }
  return attacked;
}

/** true si `bin` se puede lanzar sin shell (ver launcher.mjs). */
export const onPath = (bin) => resolveLauncher(bin) !== null;

export const tail = (file, n) => {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
};

/** Vigilante por lineas de UNA tuberia: llama a `watch(line, stream)` con cada linea completa. */
function lineScanner(watch, stream, onHit) {
  let rest = '';
  return (text) => {
    if (!watch) return;
    const lines = (rest + text).split(/\r?\n/);
    rest = lines.pop() || '';
    for (const line of lines) {
      const hit = watch(line, stream);
      if (hit) return onHit(hit);
    }
  };
}

function spawnSpec(spec, opts) {
  if (spec.shellCmd) return spawn(spec.shellCmd, { ...opts, shell: true });
  return spawn(spec.file, spec.args, { ...opts, shell: false });
}

/**
 * Ejecuta `spec` en `cwd`: `{ file, args }` sin shell o `{ shellCmd }` con shell
 * (solo el check). `input` null = stdin cerrado.
 * `watch(line, stream)` devuelve un motivo (string) para abortar o null.
 * @returns {Promise<{status:number|null, timedOut:boolean, watchHit:string|null, error:Error|null, stdout:string}>}
 */
export function runLogged(spec, { cwd, input = null, logFile, timeoutS, env, watch = null }) {
  let child;
  const startMs = Date.now();
  try {
    child = spawnSpec(spec, {
      cwd,
      env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    return Promise.resolve({ status: null, timedOut: false, watchHit: null, error: e, stdout: '' });
  }
  const run = superviseChild(child, { fd: openSync(logFile, 'w'), timeoutS, watch, startMs });
  if (child.stdin) {
    child.stdin.on('error', () => {
      /* EPIPE si el motor sale antes de leer todo: lo decide 'exit' */
    });
    child.stdin.end(input, 'utf8');
  }
  return run;
}

/** Vuelca la salida al log, aplica el plazo y el vigilante y resuelve al salir. */
function superviseChild(child, { fd, timeoutS, watch, startMs }) {
  const state = { timedOut: false, watchHit: null, stdout: '', settled: false, exited: false };
  return new Promise((resolveRun) => {
    let grace;
    const timer = setTimeout(() => {
      if (state.exited) return;
      state.timedOut = true;
      killTree(child);
    }, timeoutS * 1000);
    const finish = (status, error = null) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // Un nieto que sobreviva no debe retener el bucle de eventos por las tuberias.
      for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
      child.unref();
      closeSync(fd);
      resolveRun({ status, timedOut: state.timedOut, watchHit: state.watchHit, error, stdout: state.stdout });
    };
    const onHit = (why) => {
      state.watchHit = why;
      if (!state.exited) killTree(child);
    };
    const sink = (stream) => {
      const scan = lineScanner(watch, stream, onHit);
      return (chunk) => {
        if (state.settled) return;
        writeSync(fd, chunk);
        if (stream === 'stdout' && state.stdout.length < STDOUT_KEEP_BYTES) state.stdout += chunk.toString('utf8');
        if (!state.watchHit) scan(chunk.toString('utf8'));
      };
    };
    child.stdout.on('data', sink('stdout'));
    child.stderr.on('data', sink('stderr'));
    child.on('error', (e) => finish(null, e));
    child.on('exit', (code) => {
      state.exited = true;
      clearTimeout(timer);
      // Los nietos que sobreviven retendrian el worktree y las tuberias.
      reapOrphans(child.pid, { startMs, exitMs: Date.now() });
      grace = setTimeout(() => finish(code), CLOSE_GRACE_MS);
      child.once('close', () => finish(code));
    });
  });
}
