/**
 * kanban-lock.selftest.mjs — lock de fichero entre procesos para kanban.json
 * (lib/kanban-lock.js; auditoria 2026-10-26, L12).
 *
 * Uso: node hooks/scripts/kanban-lock.selftest.mjs   (exit 0 = verde)
 *
 * El caso central lanza varios procesos que hacen leer-modificar-escribir sobre
 * el mismo JSON con una pausa entre la lectura y la escritura:
 *   - sin lock se pierde al menos una actualizacion (caso negativo: demuestra
 *     que la carrera existe y que el test la detecta);
 *   - con lock no se pierde ninguna.
 * Hermetico: todo en un directorio temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lock = require('./lib/kanban-lock.js');
const SELF = fileURLToPath(import.meta.url);
const KANBAN_CLI = path.join(path.dirname(SELF), '..', '..', 'scripts', 'kanban.mjs');

const WORKERS = 4;
const ITERATIONS = 5;
const RMW_PAUSE_MS = 15;
const START_DELAY_MS = 800;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

function incrementOnce(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  sleepSync(RMW_PAUSE_MS); // ensancha la ventana de la carrera
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ counter: data.counter + 1 }));
  fs.renameSync(tmp, file);
}

function writeWithRetry(fn) {
  // rename sobre un fichero abierto por otro proceso puede dar EPERM en Windows;
  // se reintenta para que el unico efecto medido sea la actualizacion perdida.
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(2);
    }
  }
}

// --- modo worker -------------------------------------------------------------
if (process.argv[2] === '--worker') {
  const [, , , file, mode, iterations, startAt] = process.argv;
  // Barrera de arranque: todos empiezan a la vez aunque el SO los lance escalonados.
  const wait = Number(startAt) - Date.now();
  if (wait > 0) sleepSync(wait);
  // El lock no es justo (sin cola): con la maquina cargada un worker puede
  // esperar mas de los 2 s de produccion. Aqui se mide la exclusion mutua, no
  // el plazo (que tiene su propio caso), asi que el plazo de los workers es amplio.
  const lockOpts = { timeoutMs: 20_000 };
  for (let i = 0; i < Number(iterations); i++) {
    if (mode === 'lock') lock.withBoardLock(file, () => writeWithRetry(() => incrementOnce(file)), lockOpts);
    else writeWithRetry(() => incrementOnce(file));
  }
  process.exit(0);
}

// --- modo test ---------------------------------------------------------------
let fail = 0;
const A = (cond, name, detail = '') => {
  console.log(cond ? `  ok    ${name}` : `  FALLO ${name}${detail ? ` -> ${detail}` : ''}`);
  if (!cond) fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-lock-selftest-'));

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, err }));
  });
}

async function race(mode) {
  const file = path.join(TMP, `counter-${mode}.json`);
  fs.writeFileSync(file, JSON.stringify({ counter: 0 }));
  const startAt = String(Date.now() + START_DELAY_MS);
  const runs = await Promise.all(
    Array.from({ length: WORKERS }, () => runNode([SELF, '--worker', file, mode, String(ITERATIONS), startAt])),
  );
  const failed = runs.filter((r) => r.code !== 0);
  return { counter: JSON.parse(fs.readFileSync(file, 'utf8')).counter, failed, lockLeft: fs.existsSync(lock.lockPathFor(file)) };
}

try {
  const expected = WORKERS * ITERATIONS;

  // 1. Caso negativo: sin lock, la carrera pierde actualizaciones.
  const unlocked = await race('nolock');
  A(unlocked.failed.length === 0, 'sin lock: los workers terminan', unlocked.failed.map((r) => r.err).join(' | '));
  A(unlocked.counter < expected, `sin lock: se pierde al menos una actualizacion (${unlocked.counter}/${expected})`);

  // 2. Con lock: ninguna se pierde y el lock no queda en disco.
  const locked = await race('lock');
  A(locked.failed.length === 0, 'con lock: los workers terminan', locked.failed.map((r) => r.err).join(' | '));
  A(locked.counter === expected, `con lock: no se pierde ninguna (${locked.counter}/${expected})`);
  A(!locked.lockLeft, 'con lock: el .lock se borra al terminar');

  // 3. Un lock vivo de otro proceso agota la espera con error explicito.
  const board = path.join(TMP, 'kanban.json');
  fs.writeFileSync(board, '{}');
  const lockFile = lock.lockPathFor(board);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, token: 'ajeno' }));
  let timeoutError = null;
  const t0 = Date.now();
  try {
    lock.withBoardLock(board, () => null, { timeoutMs: 200 });
  } catch (e) {
    timeoutError = e;
  }
  const waited = Date.now() - t0;
  A(timeoutError && /bloqueado/.test(timeoutError.message), 'lock vivo ajeno: error explicito', String(timeoutError));
  A(waited >= 180 && waited < 3000, `lock vivo ajeno: espera el plazo con backoff (${waited} ms)`);
  A(fs.existsSync(lockFile), 'lock vivo ajeno: no se borra');

  // 4. Un lock rancio (> 10 s) se rompe con aviso.
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lockFile, old, old);
  const staleSeen = [];
  const out = lock.withBoardLock(board, () => 'dentro', { onStale: (p, age) => staleSeen.push(age) });
  A(out === 'dentro' && staleSeen.length === 1 && staleSeen[0] > 10_000, 'lock rancio: se rompe con aviso y se adquiere');
  A(!fs.existsSync(lockFile), 'lock rancio: el lock propio se libera al salir');

  // 5. Solo el dueno borra el lock: si otro lo rompio y creo el suyo, release no lo toca.
  const release = lock.acquireBoardLock(board);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, token: 'otro-dueno' }));
  release();
  A(fs.existsSync(lockFile), 'release: no borra un lock que ya no es suyo');
  fs.rmSync(lockFile, { force: true });

  // 5b. Carrera al romper un rancio (revision 2026-10-26, LOW): entre ver el
  // lock rancio y romperlo, otro proceso (simulado en onStale) lo rompe y crea
  // uno nuevo. Romper por ruta borraba ese lock nuevo y entraban los dos.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, token: 'muerto' }));
  fs.utimesSync(lockFile, old, old);
  const otroProceso = () => {
    fs.unlinkSync(lockFile);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, token: 'nuevo-de-A' }), { flag: 'wx' });
  };
  let raceError = null;
  try {
    lock.withBoardLock(board, () => null, { timeoutMs: 200, onStale: otroProceso });
  } catch (e) {
    raceError = e;
  }
  const tokenFinal = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')).token : null;
  A(raceError && /bloqueado/.test(raceError.message), 'rancio en carrera: no entra con el lock nuevo de otro', String(raceError));
  A(tokenFinal === 'nuevo-de-A', `rancio en carrera: el lock nuevo sigue en disco (${tokenFinal})`);
  A(fs.readdirSync(TMP).every((n) => !n.includes('.stale-')), 'rancio en carrera: no quedan ficheros .stale-');
  fs.rmSync(lockFile, { force: true });

  // 5c. renameWithRetry: reintenta los bloqueos transitorios de Windows y
  // relanza cualquier otro error (caso negativo).
  const realRename = fs.renameSync;
  const src = path.join(TMP, 'rename-src.json');
  const dst = path.join(TMP, 'rename-dst.json');
  try {
    fs.writeFileSync(src, '{"ok":1}');
    let calls = 0;
    fs.renameSync = (...args) => {
      calls++;
      if (calls <= 3) throw Object.assign(new Error('simulado'), { code: 'EPERM' });
      return realRename(...args);
    };
    lock.renameWithRetry(src, dst);
    A(calls === 4 && fs.existsSync(dst), `renameWithRetry: 3 EPERM y luego entra (${calls} intentos)`);
    fs.writeFileSync(src, '{"ok":2}');
    calls = 0;
    fs.renameSync = () => {
      calls++;
      throw Object.assign(new Error('simulado'), { code: 'ENOSPC' });
    };
    let thrown = null;
    try { lock.renameWithRetry(src, dst); } catch (e) { thrown = e; }
    A(thrown && thrown.code === 'ENOSPC' && calls === 1, 'renameWithRetry: un error no transitorio sale al primer intento');
  } finally {
    fs.renameSync = realRename;
  }

  // 6. Integracion: altas en paralelo con scripts/kanban.mjs no se pisan.
  const boardsDir = path.join(TMP, 'boards');
  fs.mkdirSync(path.join(boardsDir, 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(boardsDir, 'demo', 'kanban.json'),
    JSON.stringify({ project_id: 'demo', columns: [{ id: 'c1', name: 'Backlog', order: 0, role: 'todo' }], cards: [] }),
  );
  const adds = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      runNode([KANBAN_CLI, 'add', 'demo', 'todo', `Tarjeta paralela ${i}`], { ULTRON_BOARDS_DIR_OVERRIDE: boardsDir }),
    ),
  );
  const cards = JSON.parse(fs.readFileSync(path.join(boardsDir, 'demo', 'kanban.json'), 'utf8')).cards;
  // Solo las lineas utiles de cada alta fallida: el runner recorta la salida y
  // la traza completa de node se perdia (CI 2026-11-02).
  const addErrors = adds
    .filter((r) => r.code !== 0)
    .map((r) => `exit ${r.code}: ` + r.err.split('\n').filter((l) => /Error|code|\bat /.test(l)).slice(0, 4).join(' / '));
  A(addErrors.length === 0, 'kanban.mjs: las 6 altas terminan', addErrors.join(' | '));
  A(cards.length === 6, `kanban.mjs: 6 altas en paralelo, 6 tarjetas (${cards.length})`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'VERDE' : 'ROJO'}: ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
