#!/usr/bin/env node
// hooks/scripts/tests/test-session-summarize-previous.js
// session-summarize-previous.js: seleccion de la sesion anterior candidata y
// el ciclo completo con un `claude -p` falso (exito -> summary.md; fallo/
// timeout -> sin summary.md, error registrado, exit 0). Cada bloque incluye
// caso negativo (mandamiento 7). Hermetico: HOME/cockpit/lock/log
// redirigidos a un directorio temporal, y `child_process.spawnSync` se
// intercepta ANTES de requerir el modulo (captura la referencia una sola vez
// al cargar) para nunca invocar un `claude` real.
//
// Uso: node hooks/scripts/tests/test-session-summarize-previous.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-test-'));
const FAKE_BIN = path.join(ROOT, 'fake-claude-marker'); // nunca se ejecuta de verdad

process.env.SESSION_SUMMARY_CLAUDE_BIN = FAKE_BIN;
process.env.SESSION_SUMMARY_LOCK_DIR = path.join(ROOT, 'locks');
process.env.SESSION_SUMMARY_LOG = path.join(ROOT, 'session-summary.jsonl');
process.env.SESSION_SUMMARY_ATTEMPTS_DIR = path.join(ROOT, 'attempts');
process.env.SESSION_SUMMARY_TIMEOUT_MS = '5000';
process.env.LAST_SESSION_PROJECTS_DIR = path.join(ROOT, 'cockpit-projects');
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT; // os.homedir() en Windows lee USERPROFILE

// Intercepta spawnSync ANTES de requerir el modulo bajo test: session-
// summarize-previous.js destructura `{ spawnSync }` de 'child_process' UNA
// vez al cargar, asi que el parcheo tiene que llegar antes de ese require
// (mismo motivo por el que test-orchestrate-recovery.js precarga su stub).
const cp = require('child_process');
let fakeImpl = () => {
  throw new Error('fakeImpl sin configurar para este caso');
};
const realSpawnSync = cp.spawnSync;
cp.spawnSync = function (file, args, opts) {
  if (file === FAKE_BIN) return fakeImpl(file, args, opts);
  return realSpawnSync.call(cp, file, args, opts);
};

const summarizer = require('../session-summarize-previous');
const digest = require('../lib/session-digest');
const lastSession = require('../lib/last-session');

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

let caseCounter = 0;
/** Directorio de transcripts aislado por caso, con N sesiones .jsonl. */
function makeTranscriptsDir(sessions) {
  const dir = path.join(ROOT, `transcripts-${caseCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, turns] of Object.entries(sessions)) {
    const lines = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines);
  }
  return dir;
}

function userTurn(text, ts = '2026-09-10T10:00:00.000Z') {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: ts };
}
function assistantTurn(text, ts = '2026-09-10T10:00:01.000Z') {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts };
}

// ---- 1) selectPreviousSession -----------------------------------------------
run('elige la sesion mas reciente distinta de la actual, con >=2 prompts reales', () => {
  const dir = makeTranscriptsDir({
    vieja: [userTurn('a'), assistantTurn('b'), userTurn('c'), assistantTurn('d')],
    actual: [userTurn('e'), assistantTurn('f'), userTurn('g'), assistantTurn('h')],
  });
  // 'vieja' se toca DESPUES para que quede como mtime mas reciente sin ser la actual.
  fs.utimesSync(path.join(dir, 'vieja.jsonl'), new Date(), new Date());
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-1' });
  assert.ok(target, 'debe encontrar una candidata');
  assert.strictEqual(target.sessionId, 'vieja');
});
run('descarta una sesion con menos de 2 prompts reales', () => {
  const dir = makeTranscriptsDir({
    corta: [userTurn('unico prompt'), assistantTurn('respuesta')],
  });
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'x', projectId: 'demo-2' });
  assert.strictEqual(target, null);
});
run('descarta una sesion que YA tiene summary.md', () => {
  const dir = makeTranscriptsDir({
    conresumen: [userTurn('p1'), assistantTurn('r1'), userTurn('p2'), assistantTurn('r2')],
  });
  fs.mkdirSync(lastSession.summaryDir('demo-3', 'conresumen'), { recursive: true });
  fs.writeFileSync(lastSession.summaryPath('demo-3', 'conresumen'), '## Temas\nya resumida\n');
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'x', projectId: 'demo-3' });
  assert.strictEqual(target, null);
});
run('NEGATIVO: directorio de transcripts inexistente no lanza, devuelve null', () => {
  const target = summarizer.selectPreviousSession({
    transcriptsDir: path.join(ROOT, 'no-existe-nunca'),
    currentSessionId: 'x',
    projectId: 'demo-4',
  });
  assert.strictEqual(target, null);
});

// ---- 2) ciclo completo: claude -p FALSO ----------------------------------
function runMainWithArgs(args) {
  const prevArgv = process.argv;
  process.argv = ['node', 'session-summarize-previous.js', ...args];
  try {
    summarizer.main();
  } finally {
    process.argv = prevArgv;
  }
}

run('exito: claude -p escribe un resultado -> summary.md se crea con cabecera', () => {
  const projectId = 'demo-ok';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeImpl = () => ({
    status: 0,
    stdout: JSON.stringify({ is_error: false, result: '## Temas\n- demo\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n' }),
    stderr: '',
    error: null,
    signal: null,
  });
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  const summary = lastSession.readSummary(projectId, 'previa');
  assert.ok(summary, 'summary.md debe existir');
  assert.ok(summary.content.includes('session_id: previa'), 'cabecera con session_id');
  assert.ok(summary.content.includes('## Temas'), 'cuerpo del resumen del modelo');
});

run('NEGATIVO: claude -p falla (status!=0) -> sin summary.md, error registrado, exit 0', () => {
  const projectId = 'demo-fail';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeImpl = () => ({ status: 1, stdout: '', stderr: 'boom: API no disponible', error: null, signal: null });
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(lastSession.readSummary(projectId, 'previa'), null, 'no debe escribirse summary.md');
  const log = fs.readFileSync(process.env.SESSION_SUMMARY_LOG, 'utf8');
  assert.ok(log.includes('"ok":false') && log.includes('demo-fail'), 'el fallo queda registrado en el log jsonl');
  const errLog = path.join(ROOT, '.ultron', 'logs', 'hook-errors.jsonl');
  assert.ok(fs.existsSync(errLog), 'logHookError debe dejar rastro en hook-errors.jsonl');
});

run('NEGATIVO: claude -p hace timeout (senal) -> sin summary.md, error registrado', () => {
  const projectId = 'demo-timeout';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeImpl = () => ({ status: null, stdout: '', stderr: '', error: null, signal: 'SIGTERM' });
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(lastSession.readSummary(projectId, 'previa'), null, 'no debe escribirse summary.md tras timeout');
});

run('sin candidata: main() no escribe nada y no lanza', () => {
  const projectId = 'demo-nada';
  const dir = makeTranscriptsDir({});
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  assert.doesNotThrow(() => runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva']));
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
});

// ---- 3) hasCheapPendingCandidate: BARATA, nunca lee contenido -------------
run('hasCheapPendingCandidate: true con una candidata sin resumen dentro de la ventana', () => {
  const dir = makeTranscriptsDir({ candidata: [userTurn('a'), assistantTurn('b')] });
  const has = summarizer.hasCheapPendingCandidate({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-cheap-1' });
  assert.strictEqual(has, true);
});
run('hasCheapPendingCandidate: false si la unica sesion es la actual', () => {
  const dir = makeTranscriptsDir({ actual: [userTurn('a'), assistantTurn('b')] });
  const has = summarizer.hasCheapPendingCandidate({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-cheap-2' });
  assert.strictEqual(has, false);
});
run('NEGATIVO: hasCheapPendingCandidate NUNCA lee el contenido del transcript (solo readdir/stat)', () => {
  const dir = makeTranscriptsDir({ candidata: [userTurn('a'), assistantTurn('b')] });
  const realReadFileSync = fs.readFileSync;
  const readPaths = [];
  fs.readFileSync = function (p, ...rest) {
    readPaths.push(String(p));
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    summarizer.hasCheapPendingCandidate({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-cheap-3' });
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  const leyoElTranscript = readPaths.some((p) => p.endsWith('candidata.jsonl'));
  assert.strictEqual(leyoElTranscript, false, `no debia leer el transcript; leyo: ${readPaths.join(', ')}`);
});
run('CONTRASTE: selectPreviousSession (la seleccion FINA, en el proceso desacoplado) SI lee el transcript', () => {
  const dir = makeTranscriptsDir({ candidata: [userTurn('a'), assistantTurn('b'), userTurn('c'), assistantTurn('d')] });
  const realReadFileSync = fs.readFileSync;
  let leyoElTranscript = false;
  fs.readFileSync = function (p, ...rest) {
    if (String(p).endsWith('candidata.jsonl')) leyoElTranscript = true;
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-cheap-4' });
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  assert.strictEqual(leyoElTranscript, true, 'la seleccion fina si necesita leer el transcript para contar prompts reales');
});

// ---- 4) redaccion (hallazgo MEDIUM) ----------------------------------------
const FAKE_SECRET = 'sk-ant-api03-' + 'x'.repeat(40);
run('el digest se redacta ANTES de enviarse a claude -p', () => {
  const projectId = 'demo-redact-out';
  const dir = makeTranscriptsDir({
    previa: [userTurn(`mi clave es ${FAKE_SECRET}`), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  let sentPrompt = null;
  fakeImpl = (_file, args) => {
    sentPrompt = args[args.length - 1]; // el prompt va ultimo (ver runClaude)
    return { status: 0, stdout: JSON.stringify({ is_error: false, result: '## Temas\n- ok\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n' }), stderr: '', error: null, signal: null };
  };
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.ok(sentPrompt, 'debe haberse llamado a claude -p');
  assert.ok(!sentPrompt.includes(FAKE_SECRET), 'el secreto NO debe llegar en claro al prompt');
  assert.ok(sentPrompt.includes('[REDACTED]'), 'el hueco redactado debe quedar marcado');
});
run('NEGATIVO: el resultado del modelo tambien se redacta antes de escribir summary.md', () => {
  const projectId = 'demo-redact-in';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeImpl = () => ({
    status: 0,
    stdout: JSON.stringify({ is_error: false, result: `## Temas\n- clave citada: ${FAKE_SECRET}\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n` }),
    stderr: '',
    error: null,
    signal: null,
  });
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  const summary = lastSession.readSummary(projectId, 'previa');
  assert.ok(summary, 'summary.md debe existir igualmente (redactado, no bloqueado)');
  assert.ok(!summary.content.includes(FAKE_SECRET), 'el secreto no debe quedar en claro en el fichero');
  assert.ok(summary.content.includes('[REDACTED]'), 'el hueco redactado debe quedar marcado en el fichero');
});
run('NEGATIVO: sin security-helpers.js (fail-closed) no se resume nada, en un proceso real', () => {
  const projectId = 'demo-failclosed';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  const logPath = path.join(ROOT, 'failclosed-log.jsonl');
  const res = require('child_process').spawnSync(process.execPath, [
    path.join(__dirname, '..', 'session-summarize-previous.js'),
    '--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa',
  ], {
    env: {
      ...process.env,
      SESSION_SUMMARY_FORCE_NO_REDACTION: '1',
      SESSION_SUMMARY_TRANSCRIPTS_DIR: dir,
      SESSION_SUMMARY_LOG: logPath,
      LAST_SESSION_PROJECTS_DIR: process.env.LAST_SESSION_PROJECTS_DIR,
      HOME: ROOT,
      USERPROFILE: ROOT,
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(res.status, 0, `el proceso debe salir 0: stderr=${res.stderr}`);
  assert.strictEqual(lastSession.readSummary(projectId, 'previa'), null, 'no debe escribirse summary.md sin redaccion real');
  const log = fs.readFileSync(logPath, 'utf8');
  assert.ok(log.includes('fail-closed'), `el log debe explicar el fail-closed: ${log}`);
});

// ---- 5) backoff por sesion objetivo (hallazgo LOW/MEDIUM) ------------------
run('tras 1 fallo, la sesion NO entra en backoff todavia', () => {
  summarizer.recordFailure('backoff-a');
  assert.strictEqual(summarizer.backoffReason('backoff-a'), null);
});
run('tras 2 fallos, la sesion entra en backoff (no reintentar durante 6h)', () => {
  summarizer.recordFailure('backoff-b');
  summarizer.recordFailure('backoff-b');
  const reason = summarizer.backoffReason('backoff-b');
  assert.ok(reason && reason.includes('backoff'), `esperaba backoff: ${reason}`);
});
run('tras 5 fallos, la sesion se abandona', () => {
  for (let i = 0; i < 5; i++) summarizer.recordFailure('backoff-c');
  const reason = summarizer.backoffReason('backoff-c');
  assert.ok(reason && reason.includes('abandonada'), `esperaba abandono: ${reason}`);
});
run('clearAttempts borra el historial tras un exito', () => {
  summarizer.recordFailure('backoff-d');
  summarizer.recordFailure('backoff-d');
  summarizer.clearAttempts('backoff-d');
  assert.strictEqual(summarizer.backoffReason('backoff-d'), null);
});
run('NEGATIVO: selectPreviousSession SALTA una candidata en backoff y prueba la siguiente', () => {
  const dir = makeTranscriptsDir({
    reciente: [userTurn('p1'), assistantTurn('r1'), userTurn('p2'), assistantTurn('r2')],
    antigua: [userTurn('p3'), assistantTurn('r3'), userTurn('p4'), assistantTurn('r4')],
  });
  fs.utimesSync(path.join(dir, 'antigua.jsonl'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  summarizer.recordFailure('reciente');
  summarizer.recordFailure('reciente'); // 2 fallos -> en backoff
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'x', projectId: 'demo-backoff-select' });
  assert.ok(target, 'debe encontrar una candidata alternativa');
  assert.strictEqual(target.sessionId, 'antigua', 'la sesion en backoff se salta, la siguiente se elige');
});

// ---- 6) lock single-flight --------------------------------------------------
run('lock: una segunda adquisicion para la MISMA sesion objetivo falla mientras la primera sigue viva', () => {
  const l1 = summarizer.acquireLock('sesion-lock-1');
  assert.ok(l1, 'la primera adquisicion debe funcionar');
  const l2 = summarizer.acquireLock('sesion-lock-1');
  assert.strictEqual(l2, null, 'la segunda debe fallar: lock ocupado');
  summarizer.releaseLock(l1);
  const l3 = summarizer.acquireLock('sesion-lock-1');
  assert.ok(l3, 'tras liberar, una nueva adquisicion debe funcionar');
  summarizer.releaseLock(l3);
});

// ---- Resultado final --------------------------------------------------------
console.log('');
fs.rmSync(ROOT, { recursive: true, force: true });
if (failed === 0) {
  console.log(`PASS  test-session-summarize-previous (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-session-summarize-previous (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
