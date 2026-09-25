#!/usr/bin/env node
// scripts/bitacora-sweep.selftest.mjs — barrido periodico de bitacoras
// pendientes (scripts/bitacora-sweep.mjs). Hermetico: HOME/USERPROFILE
// apuntan a un directorio temporal (projects.json, transcripts, locks, log
// heredan de ahi via los mismos seams que usa session-summarize-previous.js),
// y el resumidor real se sustituye por un stub que nunca llama a `claude -p`
// ni a un `claude` de verdad -- mismo patron que
// hooks/scripts/session-end-bitacora.selftest.mjs.
//
// Uso: node scripts/bitacora-sweep.selftest.mjs   (exit 0 = verde)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SWEEP = join(__dirname, 'bitacora-sweep.mjs');
// Solo para cwdToSlug() (pura, sin IO) -- calcula donde debe vivir cada
// transcript fixture con el MISMO criterio que usa el sweep real.
const { cwdToSlug } = require(join(__dirname, '..', 'hooks', 'scripts', 'session-summarize-previous.js'));

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function userTurn(text, ts) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: ts };
}
function assistantTurn(text, ts) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts };
}
/** Transcript con sustancia de sobra (>= MIN_USER_PROMPTS=2). */
function substantialTranscript() {
  return [
    userTurn('primer encargo real', '2026-09-20T10:00:00.000Z'),
    assistantTurn('trabajando en ello', '2026-09-20T10:00:05.000Z'),
    userTurn('segundo encargo', '2026-09-20T10:05:00.000Z'),
    assistantTurn('listo', '2026-09-20T10:05:10.000Z'),
  ];
}

/** Workspace temporal aislado por caso: HOME propio + stub summarizer propio. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'bitacora-sweep-'));
  const stub = join(root, 'stub-summarizer.js');
  const stubLog = join(root, 'stub-invocations.jsonl');
  const failSessionsFile = join(root, 'fail-sessions.json');
  // El stub: registra su invocacion y, salvo que la sesion este en
  // fail-sessions.json, escribe summary.md con la MISMA convencion de rutas
  // que lib/last-session.js (requerido dentro del propio stub, ya con el HOME
  // ya seteado por el proceso que lo invoca).
  writeFileSync(
    stub,
    `
    const fs = require('fs');
    const path = require('path');
    const lastSession = require(${JSON.stringify(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'last-session.js'))});
    const args = process.argv.slice(2);
    const at = (flag) => args[args.indexOf(flag) + 1];
    const project = at('--project');
    const session = at('--target-session');
    const rec = { project, session, args };
    fs.appendFileSync(${JSON.stringify(stubLog)}, JSON.stringify(rec) + '\\n');
    let failSessions = [];
    try { failSessions = JSON.parse(fs.readFileSync(${JSON.stringify(failSessionsFile)}, 'utf8')); } catch {}
    if (failSessions.includes(session)) process.exit(1);
    fs.mkdirSync(lastSession.summaryDir(project, session), { recursive: true });
    fs.writeFileSync(lastSession.summaryPath(project, session), '## Temas\\n- stub\\n## Decisiones\\n(nada relevante)\\n## Pendientes\\n(nada relevante)\\n## Ficheros/commits relevantes\\n(nada relevante)\\n## Cierres propuestos\\n(nada relevante)\\n');
    process.exit(0);
    `,
    'utf8'
  );
  return { root, stub, stubLog, failSessionsFile };
}

function writeProjects(root, projects) {
  const cockpit = join(root, '.ultron', 'cockpit');
  mkdirSync(cockpit, { recursive: true });
  writeFileSync(join(cockpit, 'projects.json'), JSON.stringify({ projects }));
}

/** Escribe un transcript .jsonl y ajusta su mtime a `ageMin` minutos atras. */
function writeTranscript(root, cwd, sessionId, turns, ageMin) {
  const dir = join(root, '.claude', 'projects', cwdToSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, turns.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');
  const mtime = new Date(Date.now() - ageMin * 60 * 1000);
  utimesSync(file, mtime, mtime);
  return file;
}

function readStubLog(stubLog) {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readSweepLog(root) {
  const file = join(root, '.ultron', 'logs', 'session-summary.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function fire(root, stub, args = []) {
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    BITACORA_SWEEP_SUMMARIZER: stub,
  };
  return spawnSync(process.execPath, [SWEEP, ...args], { encoding: 'utf8', env, timeout: 30_000 });
}

// ---------------------------------------------------------------------------

run('resume la sesion inactiva (>=20 min) sin summary.md y escribe trigger:"sweep" en el log', () => {
  const { root, stub, stubLog } = makeWorkspace();
  const cwd = 'C:\\proyectos\\demo-a';
  writeProjects(root, [{ id: 'demo-a', path: cwd }]);
  writeTranscript(root, cwd, 'sess-vieja', substantialTranscript(), 30);

  const r = fire(root, stub);
  assert.equal(r.status, 0, r.stderr);

  const invocations = readStubLog(stubLog);
  assert.equal(invocations.length, 1, 'el resumidor se invoca exactamente una vez');
  assert.equal(invocations[0].project, 'demo-a');
  assert.equal(invocations[0].session, 'sess-vieja');

  const log = readSweepLog(root);
  const rec = log.find((l) => l.session_id === 'sess-vieja');
  assert.ok(rec, 'debe quedar rastro en logs/session-summary.jsonl');
  assert.equal(rec.trigger, 'sweep');
  assert.equal(rec.ok, true);
  assert.equal(rec.project, 'demo-a');
});

run('CASO NEGATIVO: sesion activa hace < 20 min NO se toca todavia', () => {
  const { root, stub, stubLog } = makeWorkspace();
  const cwd = 'C:\\proyectos\\demo-b';
  writeProjects(root, [{ id: 'demo-b', path: cwd }]);
  writeTranscript(root, cwd, 'sess-activa', substantialTranscript(), 5); // 5 min: sigue activa

  const r = fire(root, stub);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readStubLog(stubLog).length, 0, 'nada se resume mientras la sesion sigue activa');
});

run('CASO NEGATIVO: sesion con summary.md que YA cubre el transcript no se re-resume', () => {
  const { root, stub, stubLog } = makeWorkspace();
  const cwd = 'C:\\proyectos\\demo-c';
  writeProjects(root, [{ id: 'demo-c', path: cwd }]);
  const transcriptFile = writeTranscript(root, cwd, 'sess-cubierta', substantialTranscript(), 30);
  const summaryDir = join(root, '.ultron', 'cockpit', 'projects', 'demo-c', 'sessions', 'sess-cubierta');
  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, 'summary.md'), '## Temas\n- ya resumida\n');
  // el resumen debe ser MAS NUEVO que el transcript para "cubrirlo".
  const summaryMtime = new Date(require('fs').statSync(transcriptFile).mtimeMs + 5 * 60 * 1000);
  utimesSync(join(summaryDir, 'summary.md'), summaryMtime, summaryMtime);

  const r = fire(root, stub);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readStubLog(stubLog).length, 0, 'ya tiene resumen que la cubre: no se re-resume');
});

run('limite por pasada: con 4 pendientes y --max 2, solo se resumen las 2 MAS ANTIGUAS (mas urgentes)', () => {
  const { root, stub, stubLog } = makeWorkspace();
  writeProjects(root, [
    { id: 'proj-x', path: 'C:\\proyectos\\proj-x' },
    { id: 'proj-y', path: 'C:\\proyectos\\proj-y' },
  ]);
  writeTranscript(root, 'C:\\proyectos\\proj-x', 'sess-1', substantialTranscript(), 120); // la mas vieja
  writeTranscript(root, 'C:\\proyectos\\proj-x', 'sess-2', substantialTranscript(), 90);
  writeTranscript(root, 'C:\\proyectos\\proj-y', 'sess-3', substantialTranscript(), 60);
  writeTranscript(root, 'C:\\proyectos\\proj-y', 'sess-4', substantialTranscript(), 30); // la mas reciente

  const r = fire(root, stub, ['--max', '2']);
  assert.equal(r.status, 0, r.stderr);

  const invoked = readStubLog(stubLog).map((i) => i.session);
  assert.deepEqual(invoked.sort(), ['sess-1', 'sess-2'], 'solo las 2 sesiones que mas tiempo llevan esperando');
});

run('CASO NEGATIVO: si el resumidor falla, queda ok:false en el log y el proceso no revienta', () => {
  const { root, stub, stubLog, failSessionsFile } = makeWorkspace();
  const cwd = 'C:\\proyectos\\demo-fail';
  writeProjects(root, [{ id: 'demo-fail', path: cwd }]);
  writeTranscript(root, cwd, 'sess-rota', substantialTranscript(), 30);
  writeFileSync(failSessionsFile, JSON.stringify(['sess-rota']));

  const r = fire(root, stub);
  assert.equal(r.status, 1, 'sale con codigo de error cuando TODO lo intentado fallo, pero no lanza excepcion');
  assert.equal(readStubLog(stubLog).length, 1, 'lo intento igualmente');
  const rec = readSweepLog(root).find((l) => l.session_id === 'sess-rota');
  assert.ok(rec && rec.ok === false, 'queda registrado el fallo, no se pierde silencioso');
});

run('--dry-run cuenta pero no invoca al resumidor', () => {
  const { root, stub, stubLog } = makeWorkspace();
  const cwd = 'C:\\proyectos\\demo-dry';
  writeProjects(root, [{ id: 'demo-dry', path: cwd }]);
  writeTranscript(root, cwd, 'sess-dry', substantialTranscript(), 30);

  const r = fire(root, stub, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readStubLog(stubLog).length, 0, 'dry-run no invoca nada');
  assert.match(r.stdout, /se resumirian/);
});

run('lock single-flight: una pasada ya en marcha bloquea a la siguiente (no se solapan)', () => {
  const { root, stub, stubLog } = makeWorkspace();
  const cwd = 'C:\\proyectos\\demo-lock';
  writeProjects(root, [{ id: 'demo-lock', path: cwd }]);
  writeTranscript(root, cwd, 'sess-lock', substantialTranscript(), 30);

  // Toma el lock desde un proceso propio VIVO durante la prueba (acquireLock
  // solo respeta un lock cuyo pid siga vivo -- uno huerfano se reclama, ver
  // gotcha-drains-solapados-duplicados). Reusa el mecanismo real de
  // session-summarize-previous.js con el MISMO id que usa el sweep.
  const holder = join(root, 'holder.js');
  const holderReady = join(root, 'holder-ready.txt');
  writeFileSync(
    holder,
    `
    const fs = require('fs');
    const s = require(${JSON.stringify(join(__dirname, '..', 'hooks', 'scripts', 'session-summarize-previous.js'))});
    const lock = s.acquireLock('__bitacora_sweep__');
    if (!lock) { process.exit(2); }
    fs.writeFileSync(${JSON.stringify(holderReady)}, lock);
    setTimeout(() => {}, 10000); // se mantiene vivo (pid vivo = lock NO huerfano) hasta que el test lo mate
    `,
    'utf8'
  );
  // Se lanza en background (no spawnSync: necesitamos que siga vivo mientras
  // el sweep corre) y se sondea de forma SINCRONA (fs.existsSync) hasta ver
  // el fichero que confirma que ya tiene el lock.
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [holder], {
    env: { ...process.env, HOME: root, USERPROFILE: root },
    stdio: 'ignore',
  });
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const deadline = Date.now() + 5000;
  while (!existsSync(holderReady) && Date.now() < deadline) sleepSync(20);
  assert.ok(existsSync(holderReady), 'el holder debe haber tomado el lock');

  try {
    const r = fire(root, stub);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lock ocupado/);
    assert.equal(readStubLog(stubLog).length, 0, 'con el lock tomado, el sweep no procesa nada');
  } finally {
    try { child.kill(); } catch { /* best effort */ }
  }
});

console.log('');
if (failed === 0) {
  console.log(`PASS  bitacora-sweep (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  bitacora-sweep (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
