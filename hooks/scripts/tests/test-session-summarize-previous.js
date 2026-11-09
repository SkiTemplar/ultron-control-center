#!/usr/bin/env node
// hooks/scripts/tests/test-session-summarize-previous.js
// session-summarize-previous.js: seleccion de la sesion anterior candidata y
// el ciclo completo con Codex y la LLM secundaria FALSOS (exito -> summary.md;
// Codex falla -> relevo Groq -> Gemini; todo falla -> sin summary.md, error
// registrado, exit 0; nunca se lanza `claude`). lib/codex-exec.js se prueba
// ademas con un proceso real: un `codex` falso (CODEX_EXEC_BIN).
// Cada bloque incluye caso negativo (mandamiento 7). Hermetico:
// HOME/cockpit/lock/log redirigidos a un directorio temporal, askText de
// lib/secondary-llm.js sustituido (sin red) y la fusion en el estado del
// proyecto desactivada (PROJECT_STATE_DISABLED=1).
//
// Uso: node hooks/scripts/tests/test-session-summarize-previous.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-test-'));

process.setMaxListeners(50); // cada main() registra su listener de observe() en el mismo proceso
process.env.PROJECT_STATE_DISABLED = '1';
process.env.SESSION_SUMMARY_LOCK_DIR = path.join(ROOT, 'locks');
process.env.SESSION_SUMMARY_LOG = path.join(ROOT, 'session-summary.jsonl');
process.env.SESSION_SUMMARY_ATTEMPTS_DIR = path.join(ROOT, 'attempts');
process.env.SESSION_SUMMARY_TIMEOUT_MS = '5000';
process.env.LAST_SESSION_PROJECTS_DIR = path.join(ROOT, 'cockpit-projects');
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT; // os.homedir() en Windows lee USERPROFILE
process.env.ULTRON_HOOK_LOGS_DIR = path.join(ROOT, '.ultron', 'logs'); // hook-obs: destino explicito

// Espia de procesos: ningun camino del resumidor puede lanzar `claude`
// (NEGATIVO del cambio 2026-09-29: sin caida a Claude si la LLM falla).
const cp = require('child_process');
const claudeSpawns = [];
for (const fn of ['spawnSync', 'spawn', 'execFileSync', 'execFile']) {
  const real = cp[fn];
  cp[fn] = function (file, ...rest) {
    if (/claude(\.exe)?$/i.test(String(file))) claudeSpawns.push(`${fn}(${file})`);
    return real.call(cp, file, ...rest);
  };
}

// LLM secundaria falsa: el resumidor llama a require('./lib/secondary-llm').askText
// en el momento, asi que basta con sustituir la funcion del modulo cacheado.
const secondaryLlm = require('../lib/secondary-llm');
let fakeAsk = async () => {
  throw new Error('fakeAsk sin configurar para este caso');
};
secondaryLlm.askText = (opts) => fakeAsk(opts);
const okLlm = (text) => async () => ({ ok: true, text, provider: 'groq', model: 'openai/gpt-oss-120b', ms: 1 });

// Codex falso: por defecto "no instalado", para que los casos de la cadena
// Groq -> Gemini sigan probando ese camino. Los casos de Codex lo cambian.
const codexExec = require('../lib/codex-exec');
const realAskCodex = codexExec.askCodex;
const codexDown = async () => ({ ok: false, error: 'codex/gpt-5.6-terra: no instalado', ms: 1 });
let fakeCodex = codexDown;
codexExec.askCodex = (opts) => fakeCodex(opts);
const SUMMARY_MD = '## Temas\n- ok\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n## Cierres propuestos\n(nada relevante)\n';

// `codex` falso para lib/codex-exec.js: guarda argv y stdin en CODEX_FAKE_DUMP y
// se comporta segun CODEX_FAKE_MODE (ok | fail401 | hang).
const FAKE_CODEX = path.join(ROOT, 'fake-codex.js');
fs.writeFileSync(FAKE_CODEX, `
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (process.env.CODEX_FAKE_DUMP) fs.writeFileSync(process.env.CODEX_FAKE_DUMP, JSON.stringify({ args, input }));
  const mode = process.env.CODEX_FAKE_MODE;
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'fail401') { process.stderr.write('ERROR: unexpected status 401 Unauthorized'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('-o') + 1], '## Temas' + String.fromCharCode(10) + '- desde codex falso' + String.fromCharCode(10));
  process.stdout.write('ruido de stdout que no es el mensaje final');
});
`);

const summarizer = require('../session-summarize-previous');
const digest = require('../lib/session-digest');
const lastSession = require('../lib/last-session');

let passed = 0;
let failed = 0;
const cases = [];

function run(name, fn) {
  cases.push([name, fn]);
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
run('elige la sesion mas reciente distinta de la actual, con >=2 prompts reales', async () => {
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
run('descarta una sesion con menos de 2 prompts reales', async () => {
  const dir = makeTranscriptsDir({
    corta: [userTurn('unico prompt'), assistantTurn('respuesta')],
  });
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'x', projectId: 'demo-2' });
  assert.strictEqual(target, null);
});
run('descarta una sesion que YA tiene summary.md', async () => {
  const dir = makeTranscriptsDir({
    conresumen: [userTurn('p1'), assistantTurn('r1'), userTurn('p2'), assistantTurn('r2')],
  });
  fs.mkdirSync(lastSession.summaryDir('demo-3', 'conresumen'), { recursive: true });
  fs.writeFileSync(lastSession.summaryPath('demo-3', 'conresumen'), '## Temas\nya resumida\n');
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'x', projectId: 'demo-3' });
  assert.strictEqual(target, null);
});
run('regenera cuando el summary.md es VIEJO: la sesion siguio > margen despues de resumirse', async () => {
  // Caso real 2026-09-21: resumen a las 17:29, sesion hasta las 18:35.
  const dir = makeTranscriptsDir({
    continuo: [userTurn('p1'), assistantTurn('r1'), userTurn('p2'), assistantTurn('r2')],
  });
  fs.mkdirSync(lastSession.summaryDir('demo-3b', 'continuo'), { recursive: true });
  fs.writeFileSync(lastSession.summaryPath('demo-3b', 'continuo'), '## Temas\nresumen a mitad de sesion\n');
  const summaryAt = new Date(Date.now() - summarizer.SUMMARY_STALE_GRACE_MS - 60 * 60 * 1000);
  fs.utimesSync(lastSession.summaryPath('demo-3b', 'continuo'), summaryAt, summaryAt);
  const target = summarizer.selectPreviousSession({ transcriptsDir: dir, currentSessionId: 'x', projectId: 'demo-3b' });
  assert.ok(target, 'un resumen de hace una hora sobre un transcript recien tocado se regenera');
  assert.strictEqual(target.sessionId, 'continuo');
  // NEGATIVO: dentro del margen (los hooks de Stop tocan el transcript segundos
  // despues del resumen) NO se regenera.
  assert.strictEqual(summarizer.summaryCoversTranscript(1_000_000, 1_000_000 + summarizer.SUMMARY_STALE_GRACE_MS - 1), true);
  assert.strictEqual(summarizer.summaryCoversTranscript(1_000_000, 1_000_000 + summarizer.SUMMARY_STALE_GRACE_MS + 1), false);
  assert.strictEqual(summarizer.summaryCoversTranscript(null, 5), false, 'sin resumen nunca "cubre"');
});
run('NEGATIVO: directorio de transcripts inexistente no lanza, devuelve null', async () => {
  const target = summarizer.selectPreviousSession({
    transcriptsDir: path.join(ROOT, 'no-existe-nunca'),
    currentSessionId: 'x',
    projectId: 'demo-4',
  });
  assert.strictEqual(target, null);
});

// ---- 2) ciclo completo: LLM secundaria FALSA ----------------------------------
async function runMainWithArgs(args) {
  const prevArgv = process.argv;
  process.argv = ['node', 'session-summarize-previous.js', ...args];
  try {
    await summarizer.main();
  } finally {
    process.argv = prevArgv;
  }
}

run('exito: la LLM secundaria devuelve un resumen -> summary.md con cabecera y modelo', async () => {
  const projectId = 'demo-ok';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeAsk = okLlm('```markdown\n## Temas\n- demo\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n```');
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  const summary = lastSession.readSummary(projectId, 'previa');
  assert.ok(summary, 'summary.md debe existir');
  assert.ok(summary.content.includes('session_id: previa'), 'cabecera con session_id');
  assert.ok(summary.content.includes('## Temas'), 'cuerpo del resumen del modelo');
  assert.ok(summary.content.includes('modelo: groq/openai/gpt-oss-120b'), 'la cabecera declara el modelo secundario');
  assert.ok(!summary.content.includes('```'), 'el envoltorio de codigo se quita');
});

run('NEGATIVO: la LLM secundaria falla -> sin summary.md, error registrado, sin caer a claude', async () => {
  const projectId = 'demo-fail';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  const before = claudeSpawns.length;
  fakeAsk = async () => ({ ok: false, error: 'groq/openai/gpt-oss-120b: HTTP 500; gemini/gemini-3.6-flash: red', attempts: ['groq/openai/gpt-oss-120b: HTTP 500', 'gemini/gemini-3.6-flash: red'], ms: 1 });
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(lastSession.readSummary(projectId, 'previa'), null, 'no debe escribirse summary.md');
  const log = fs.readFileSync(process.env.SESSION_SUMMARY_LOG, 'utf8');
  assert.ok(log.includes('"ok":false') && log.includes('demo-fail'), 'el fallo queda registrado en el log jsonl');
  const errLog = path.join(ROOT, '.ultron', 'logs', 'hook-errors.jsonl');
  assert.ok(fs.existsSync(errLog), 'logHookError debe dejar rastro en hook-errors.jsonl');
  assert.strictEqual(claudeSpawns.length, before, `no se lanza claude como relevo: ${claudeSpawns.join(', ')}`);
});

run('NEGATIVO: la LLM secundaria lanza (red caida) -> sin summary.md, sin excepcion', async () => {
  const projectId = 'demo-timeout';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeAsk = async () => { throw new Error('socket hang up'); };
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(lastSession.readSummary(projectId, 'previa'), null, 'no debe escribirse summary.md tras timeout');
});

run('sin candidata: main() no escribe nada y no lanza', async () => {
  const projectId = 'demo-nada';
  const dir = makeTranscriptsDir({});
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
});

// ---- 3) hasCheapPendingCandidate: BARATA, nunca lee contenido -------------
run('hasCheapPendingCandidate: true con una candidata sin resumen dentro de la ventana', async () => {
  const dir = makeTranscriptsDir({ candidata: [userTurn('a'), assistantTurn('b')] });
  const has = summarizer.hasCheapPendingCandidate({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-cheap-1' });
  assert.strictEqual(has, true);
});
run('hasCheapPendingCandidate: false si la unica sesion es la actual', async () => {
  const dir = makeTranscriptsDir({ actual: [userTurn('a'), assistantTurn('b')] });
  const has = summarizer.hasCheapPendingCandidate({ transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-cheap-2' });
  assert.strictEqual(has, false);
});
run('NEGATIVO: hasCheapPendingCandidate NUNCA lee el contenido del transcript (solo readdir/stat)', async () => {
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
run('aviso falso: una sesion de 1 prompt deja de contar como pendiente tras la seleccion fina', async () => {
  const dir = makeTranscriptsDir({ trivial1: [userTurn('solo uno'), assistantTurn('ok')] });
  const args = { transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-trivial-1' };
  assert.strictEqual(summarizer.hasCheapPendingCandidate(args), true, 'antes de evaluarla, la barata la cuenta');
  assert.strictEqual(summarizer.selectPreviousSession(args), null);
  assert.strictEqual(summarizer.hasCheapPendingCandidate(args), false, 'tras marcarla trivial, no debe prometer resumen');
});
run('NEGATIVO: la marca trivial caduca si el transcript vuelve a crecer (sesion retomada)', async () => {
  const dir = makeTranscriptsDir({ trivial2: [userTurn('uno'), assistantTurn('ok')] });
  const args = { transcriptsDir: dir, currentSessionId: 'actual', projectId: 'demo-trivial-2' };
  summarizer.selectPreviousSession(args);
  const file = path.join(dir, 'trivial2.jsonl');
  fs.appendFileSync(file, JSON.stringify(userTurn('dos')) + '\n' + JSON.stringify(assistantTurn('vale')) + '\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.strictEqual(summarizer.hasCheapPendingCandidate(args), true);
  const picked = summarizer.selectPreviousSession(args);
  assert.ok(picked && picked.sessionId === 'trivial2', 'con 2 prompts reales vuelve a ser candidata');
});
run('CONTRASTE: selectPreviousSession (la seleccion FINA, en el proceso desacoplado) SI lee el transcript', async () => {
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
run('el digest se redacta ANTES de enviarse a la LLM secundaria', async () => {
  const projectId = 'demo-redact-out';
  const dir = makeTranscriptsDir({
    previa: [userTurn(`mi clave es ${FAKE_SECRET}`), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  let sentPrompt = null;
  fakeAsk = async (opts) => {
    sentPrompt = opts.user;
    return okLlm('## Temas\n- ok\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n')();
  };
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.ok(sentPrompt, 'debe haberse llamado a la LLM secundaria');
  assert.ok(!sentPrompt.includes(FAKE_SECRET), 'el secreto NO debe llegar en claro al prompt');
  assert.ok(sentPrompt.includes('[REDACTED]'), 'el hueco redactado debe quedar marcado');
});
run('instrucciones en system y sesion en user, con la cadena Groq -> Gemini y sin modelos de Anthropic', async () => {
  const projectId = 'demo-chain';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  let seen = null;
  fakeAsk = async (opts) => {
    seen = opts;
    return okLlm('## Temas\n- ok\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n')();
  };
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.ok(seen.system.includes('## Cierres propuestos'), 'las 5 secciones viajan en system');
  assert.ok(seen.user.includes('primer prompt real') && !seen.user.includes('## Cierres propuestos'), 'la sesion viaja en user');
  const providers = seen.chain.map((p) => p.provider);
  assert.deepStrictEqual([...new Set(providers)], ['groq', 'gemini'], 'Groq primero, Gemini de relevo');
  assert.ok(seen.chain.every((p) => !/claude|anthropic/i.test(`${p.model} ${p.endpoint}`)), 'ningun eslabon es de Anthropic');
});
run('NEGATIVO: el resultado del modelo tambien se redacta antes de escribir summary.md', async () => {
  const projectId = 'demo-redact-in';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeAsk = okLlm(`## Temas\n- clave citada: ${FAKE_SECRET}\n## Decisiones\n(nada relevante)\n## Pendientes\n(nada relevante)\n## Ficheros/commits relevantes\n(nada relevante)\n`);
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  const summary = lastSession.readSummary(projectId, 'previa');
  assert.ok(summary, 'summary.md debe existir igualmente (redactado, no bloqueado)');
  assert.ok(!summary.content.includes(FAKE_SECRET), 'el secreto no debe quedar en claro en el fichero');
  assert.ok(summary.content.includes('[REDACTED]'), 'el hueco redactado debe quedar marcado en el fichero');
});
run('NEGATIVO: sin security-helpers.js (fail-closed) no se resume nada, en un proceso real', async () => {
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
run('tras 1 fallo, la sesion NO entra en backoff todavia', async () => {
  summarizer.recordFailure('backoff-a');
  assert.strictEqual(summarizer.backoffReason('backoff-a'), null);
});
run('tras 2 fallos, la sesion entra en backoff (no reintentar durante 6h)', async () => {
  summarizer.recordFailure('backoff-b');
  summarizer.recordFailure('backoff-b');
  const reason = summarizer.backoffReason('backoff-b');
  assert.ok(reason && reason.includes('backoff'), `esperaba backoff: ${reason}`);
});
run('tras 5 fallos, la sesion se abandona', async () => {
  for (let i = 0; i < 5; i++) summarizer.recordFailure('backoff-c');
  const reason = summarizer.backoffReason('backoff-c');
  assert.ok(reason && reason.includes('abandonada'), `esperaba abandono: ${reason}`);
});
run('clearAttempts borra el historial tras un exito', async () => {
  summarizer.recordFailure('backoff-d');
  summarizer.recordFailure('backoff-d');
  summarizer.clearAttempts('backoff-d');
  assert.strictEqual(summarizer.backoffReason('backoff-d'), null);
});
run('NEGATIVO: selectPreviousSession SALTA una candidata en backoff y prueba la siguiente', async () => {
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
run('lock: una segunda adquisicion para la MISMA sesion objetivo falla mientras la primera sigue viva', async () => {
  const l1 = summarizer.acquireLock('sesion-lock-1');
  assert.ok(l1, 'la primera adquisicion debe funcionar');
  const l2 = summarizer.acquireLock('sesion-lock-1');
  assert.strictEqual(l2, null, 'la segunda debe fallar: lock ocupado');
  summarizer.releaseLock(l1);
  const l3 = summarizer.acquireLock('sesion-lock-1');
  assert.ok(l3, 'tras liberar, una nueva adquisicion debe funcionar');
  summarizer.releaseLock(l3);
});

// ---- Cuota agotada en toda la cadena ----------------------------------------
const ALL_429 = ['groq/openai/gpt-oss-120b: HTTP 429', 'groq/openai/gpt-oss-20b: HTTP 429', 'gemini/gemini-3.6-flash: HTTP 429'];
run('isQuotaExhausted: solo si TODOS los eslabones dan 429', async () => {
  assert.ok(summarizer.isQuotaExhausted(ALL_429));
  assert.ok(!summarizer.isQuotaExhausted(['groq/openai/gpt-oss-120b: HTTP 429', 'gemini/gemini-3.6-flash: sin GEMINI_API_KEY']));
  assert.ok(!summarizer.isQuotaExhausted([]));
});
run('cuota agotada: sin summary.md, NO cuenta como fallo de la sesion y congela los resumenes', async () => {
  const projectId = 'demo-quota';
  const dir = makeTranscriptsDir({
    previa: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  let calls = 0;
  fakeAsk = async () => { calls++; return { ok: false, error: ALL_429.join('; '), attempts: ALL_429, ms: 1 }; };
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  assert.strictEqual(calls, 1);
  assert.strictEqual(summarizer.readAttempts('previa').failures, 0, 'la cuota no acerca la sesion al abandono');
  assert.ok(summarizer.quotaCooldownRemainingMs() > 0, 'queda la pausa global');
  // NEGATIVO: durante la pausa ni se llama a la LLM.
  await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(calls, 1, 'con la pausa activa no se gasta otro intento');
  fs.rmSync(path.join(process.env.SESSION_SUMMARY_ATTEMPTS_DIR, '_quota-cooldown.json'), { force: true });
  assert.strictEqual(summarizer.quotaCooldownRemainingMs(), 0);
});
run('NEGATIVO: un error que no es de cuota SI cuenta para el backoff y no congela', async () => {
  const dir = makeTranscriptsDir({
    otra: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  fakeAsk = async () => ({ ok: false, error: 'groq/openai/gpt-oss-120b: HTTP 413; gemini/gemini-3.6-flash: modelo inexistente', attempts: ['groq/openai/gpt-oss-120b: HTTP 413', 'gemini/gemini-3.6-flash: modelo inexistente'], ms: 1 });
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  await runMainWithArgs(['--cwd', 'X', '--project', 'demo-noquota', '--session', 'nueva', '--target-session', 'otra']);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(summarizer.readAttempts('otra').failures, 1);
  assert.strictEqual(summarizer.quotaCooldownRemainingMs(), 0);
  const log = fs.readFileSync(process.env.SESSION_SUMMARY_LOG, 'utf8');
  assert.ok(log.includes('modelo inexistente'), 'el motivo real llega al log');
});

// ---- Digest sin cambios: no se re-resume ---------------------------------------
run('mismo digest que el resumen existente: no llama a la LLM y refresca el mtime', async () => {
  const projectId = 'demo-sha';
  const dir = makeTranscriptsDir({
    fija: [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')],
  });
  let calls = 0;
  fakeAsk = async () => { calls++; return { ok: true, text: '## Temas\n- x\n', provider: 'groq', model: 'openai/gpt-oss-20b', ms: 1 }; };
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  const argv = ['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'fija'];
  await runMainWithArgs(argv);
  assert.strictEqual(calls, 1);
  assert.ok(summarizer.existingDigestSha(projectId, 'fija'), 'la cabecera guarda digest_sha');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lastSession.summaryPath(projectId, 'fija'), old, old);
  await runMainWithArgs(argv);
  assert.strictEqual(calls, 1, 'digest identico: sin segunda llamada');
  assert.ok(lastSession.summaryMtimeMs(projectId, 'fija') > Date.now() - 60000, 'el resumen vuelve a cubrir el transcript');
  // NEGATIVO: si el transcript gana contenido real, se regenera.
  fs.appendFileSync(path.join(dir, 'fija.jsonl'), JSON.stringify(userTurn('tercer prompt nuevo')) + '\n');
  await runMainWithArgs(argv);
  delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  assert.strictEqual(calls, 2, 'contenido nuevo: se vuelve a resumir');
});

// ---- 7) Codex primero, Groq -> Gemini de relevo -------------------------------
function twoPromptSession() {
  return [userTurn('primer prompt real'), assistantTurn('ok'), userTurn('segundo prompt real'), assistantTurn('listo')];
}
async function runTarget(projectId, dir) {
  process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR = dir;
  try {
    await runMainWithArgs(['--cwd', 'X', '--project', projectId, '--session', 'nueva', '--target-session', 'previa']);
  } finally {
    delete process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  }
}

run('Codex responde: summary.md con modelo codex/<modelo> y sin llamar a Groq/Gemini', async () => {
  const dir = makeTranscriptsDir({ previa: twoPromptSession() });
  const order = [];
  let codexOpts = null;
  fakeCodex = async (opts) => { order.push('codex'); codexOpts = opts; return { ok: true, text: SUMMARY_MD, model: opts.model, ms: 1 }; };
  fakeAsk = async () => { order.push('secundaria'); return okLlm(SUMMARY_MD)(); };
  try {
    await runTarget('demo-codex-ok', dir);
  } finally {
    fakeCodex = codexDown;
  }
  assert.deepStrictEqual(order, ['codex'], 'con Codex bien no se toca la cadena secundaria');
  assert.ok(codexOpts.prompt.includes('## Cierres propuestos') && codexOpts.prompt.includes('primer prompt real'), 'instrucciones y sesion en un unico prompt');
  assert.strictEqual(codexOpts.model, summarizer.CODEX_MODEL);
  assert.ok(codexOpts.timeoutMs > 0, 'Codex lleva plazo');
  const summary = lastSession.readSummary('demo-codex-ok', 'previa');
  assert.ok(summary && summary.content.includes(`modelo: codex/${summarizer.CODEX_MODEL}`), 'la cabecera declara codex/<modelo>');
  assert.ok(summary.content.includes('## Cierres propuestos'));
});

run('NEGATIVO: Codex falla -> cae a Groq, en ese orden, y el fallo de Codex queda en el log', async () => {
  const dir = makeTranscriptsDir({ previa: twoPromptSession() });
  const order = [];
  const before = claudeSpawns.length;
  fakeCodex = async () => { order.push('codex'); return { ok: false, error: 'codex/gpt-5.6-terra: exit 1', ms: 1 }; };
  fakeAsk = async () => { order.push('secundaria'); return okLlm(SUMMARY_MD)(); };
  try {
    await runTarget('demo-codex-fallback', dir);
  } finally {
    fakeCodex = codexDown;
  }
  assert.deepStrictEqual(order, ['codex', 'secundaria'], 'Codex primero, Groq -> Gemini despues');
  const summary = lastSession.readSummary('demo-codex-fallback', 'previa');
  assert.ok(summary && summary.content.includes('modelo: groq/openai/gpt-oss-120b'), 'el relevo firma la cabecera');
  const log = fs.readFileSync(process.env.SESSION_SUMMARY_LOG, 'utf8');
  assert.ok(log.includes('"codex_error":"codex/gpt-5.6-terra: exit 1"'), 'el motivo del relevo queda registrado');
  assert.strictEqual(claudeSpawns.length, before, 'ningun proceso claude');
});

run('NEGATIVO: Codex y la cadena secundaria fallan -> sin summary.md, error con ambos motivos', async () => {
  const dir = makeTranscriptsDir({ previa: twoPromptSession() });
  fakeCodex = async () => ({ ok: false, error: 'codex/gpt-5.6-terra: timeout (120 s)', ms: 1 });
  fakeAsk = async () => ({ ok: false, error: 'groq/openai/gpt-oss-120b: HTTP 413', attempts: ['groq/openai/gpt-oss-120b: HTTP 413'], ms: 1 });
  try {
    await runTarget('demo-codex-allfail', dir);
  } finally {
    fakeCodex = codexDown;
  }
  assert.strictEqual(lastSession.readSummary('demo-codex-allfail', 'previa'), null);
  const log = fs.readFileSync(process.env.SESSION_SUMMARY_LOG, 'utf8');
  assert.ok(log.includes('codex/gpt-5.6-terra: timeout (120 s); LLM secundaria: groq/openai/gpt-oss-120b: HTTP 413'));
});

// ---- 8) lib/codex-exec.js con un proceso real (codex falso) -------------------
async function withFakeCodex(mode, fn) {
  const dump = path.join(ROOT, `codex-dump-${caseCounter++}.json`);
  const keys = ['CODEX_EXEC_BIN', 'CODEX_FAKE_MODE', 'CODEX_FAKE_DUMP'];
  const prev = keys.map((k) => process.env[k]);
  process.env.CODEX_EXEC_BIN = FAKE_CODEX;
  process.env.CODEX_FAKE_MODE = mode;
  process.env.CODEX_FAKE_DUMP = dump;
  try {
    return await fn(dump);
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  }
}

run('askCodex: prompt de 150.000 caracteres por stdin (nunca en argv), solo lectura, texto final de -o', async () => {
  const big = 'x'.repeat(150000) + ' FIN';
  await withFakeCodex('ok', async (dump) => {
    const before = claudeSpawns.length;
    const r = await realAskCodex({ prompt: big, model: 'gpt-5.6-terra', reasoningEffort: 'low', timeoutMs: 20000 });
    assert.ok(r.ok, `debe responder: ${r.error}`);
    assert.strictEqual(r.text, '## Temas\n- desde codex falso', 'solo el mensaje final, no el stdout');
    assert.strictEqual(r.model, 'gpt-5.6-terra');
    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    assert.strictEqual(seen.input, big, 'el prompt llega entero por stdin');
    assert.ok(!seen.args.some((a) => a.includes('FIN')), 'el prompt no viaja en argv');
    assert.strictEqual(seen.args[0], 'exec');
    assert.strictEqual(seen.args[seen.args.length - 1], '-', 'stdin como prompt');
    assert.strictEqual(seen.args[seen.args.indexOf('-s') + 1], 'read-only', 'sandbox de solo lectura');
    for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(seen.args.includes(flag), flag);
    assert.ok(seen.args.includes('model_reasoning_effort="low"'));
    assert.strictEqual(claudeSpawns.length, before);
  });
});

run('NEGATIVO: askCodex sin login (401) -> error clasificado, sin volcar stderr', async () => {
  await withFakeCodex('fail401', async () => {
    const r = await realAskCodex({ prompt: 'hola', model: 'gpt-5.6-terra', timeoutMs: 20000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'codex/gpt-5.6-terra: sin login (ejecutar `codex login`)');
  });
});

run('NEGATIVO: askCodex agota el plazo -> mata el proceso y devuelve timeout', async () => {
  await withFakeCodex('hang', async () => {
    const t0 = Date.now();
    const r = await realAskCodex({ prompt: 'hola', model: 'gpt-5.6-terra', timeoutMs: 1500 });
    assert.strictEqual(r.ok, false);
    assert.ok(/timeout/.test(r.error), r.error);
    assert.ok(Date.now() - t0 < 10000, 'no espera mas alla del plazo');
  });
});

run('NEGATIVO: askCodex con el lanzador inexistente -> no instalado', async () => {
  const prev = process.env.CODEX_EXEC_BIN;
  process.env.CODEX_EXEC_BIN = path.join(ROOT, 'no-existe', 'codex.js');
  try {
    const r = await realAskCodex({ prompt: 'hola', model: 'gpt-5.6-terra' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'codex/gpt-5.6-terra: no instalado');
  } finally {
    if (prev === undefined) delete process.env.CODEX_EXEC_BIN;
    else process.env.CODEX_EXEC_BIN = prev;
  }
});

run('NEGATIVO de punta a punta: Codex real (falso) falla -> Groq resume, ningun claude', async () => {
  const dir = makeTranscriptsDir({ previa: twoPromptSession() });
  const before = claudeSpawns.length;
  const order = [];
  fakeCodex = async (opts) => { order.push('codex'); return realAskCodex(opts); };
  fakeAsk = async () => { order.push('secundaria'); return okLlm(SUMMARY_MD)(); };
  try {
    await withFakeCodex('fail401', () => runTarget('demo-codex-e2e', dir));
  } finally {
    fakeCodex = codexDown;
  }
  assert.deepStrictEqual(order, ['codex', 'secundaria']);
  const summary = lastSession.readSummary('demo-codex-e2e', 'previa');
  assert.ok(summary && summary.content.includes('modelo: groq/'), 'el relevo resume');
  assert.strictEqual(claudeSpawns.length, before, `sin claude: ${claudeSpawns.join(', ')}`);
});

// ---- kanban-auto (2026-10-23) ------------------------------------------------
function writeBoard(projectId) {
  const dir = path.join(process.env.LAST_SESSION_PROJECTS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const board = {
    project_id: projectId,
    columns: [{ id: 'c-todo', role: 'todo' }, { id: 'c-done', role: 'done' }],
    cards: [{ id: 'card-1-abcdef', column_id: 'c-todo', title: 'Fusionar la rama de integracion', tags: [] }],
  };
  fs.writeFileSync(path.join(dir, 'kanban.json'), JSON.stringify(board));
  return path.join(dir, 'kanban.json');
}
const SUMMARY_KANBAN = SUMMARY_MD.replace('## Cierres propuestos\n(nada relevante)\n',
  '## Cierres propuestos\n- card-1-abcdef | fusionada\n## Tarjetas nuevas\n- todo | Redesplegar el binario de memoria\n');

run('kanban-auto: la LLM recibe las tarjetas abiertas y la bitacora cierra y crea en el tablero', async () => {
  const dir = makeTranscriptsDir({ previa: twoPromptSession() });
  const boardFile = writeBoard('demo-kanban-auto');
  let prompt = '';
  fakeCodex = async (opts) => { prompt = opts.prompt; return { ok: true, text: SUMMARY_KANBAN, model: opts.model, ms: 1 }; };
  try {
    await runTarget('demo-kanban-auto', dir);
  } finally {
    fakeCodex = codexDown;
  }
  assert.ok(prompt.includes('card-1-abcdef [todo] Fusionar la rama de integracion'), 'las tarjetas abiertas viajan con id');
  const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  assert.strictEqual(board.cards.find((c) => c.id === 'card-1-abcdef').column_id, 'c-done', 'la tarjeta citada por id pasa a Done');
  assert.ok(board.cards.some((c) => c.title === 'Redesplegar el binario de memoria' && c.tags.includes('auto')), 'la tarjeta nueva entra con la etiqueta auto');
  assert.ok(fs.existsSync(path.join(path.dirname(boardFile), 'kanban.auto-log.json')), 'el lote queda en el log para deshacerlo');
});

run('NEGATIVO kanban-auto: proyecto con kanban:manual -> ni tarjetas en el prompt ni cambios', async () => {
  const dir = makeTranscriptsDir({ previa: twoPromptSession() });
  const boardFile = writeBoard('demo-kanban-manual');
  const before = fs.readFileSync(boardFile, 'utf8');
  const registry = path.join(ROOT, 'registry-manual.json');
  fs.writeFileSync(registry, JSON.stringify({ projects: [{ id: 'demo-kanban-manual', tags: ['kanban:manual'] }] }));
  process.env.PROJECT_TRACKER_REGISTRY_OVERRIDE = registry;
  let prompt = '';
  fakeCodex = async (opts) => { prompt = opts.prompt; return { ok: true, text: SUMMARY_KANBAN, model: opts.model, ms: 1 }; };
  try {
    await runTarget('demo-kanban-manual', dir);
  } finally {
    fakeCodex = codexDown;
    delete process.env.PROJECT_TRACKER_REGISTRY_OVERRIDE;
  }
  assert.ok(prompt && !prompt.includes('card-1-abcdef'), 'sin tarjetas en el prompt');
  assert.strictEqual(fs.readFileSync(boardFile, 'utf8'), before, 'el tablero no cambia');
});

// ---- Resultado final --------------------------------------------------------
(async () => {
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
      failed++;
    }
  }
  console.log('');
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (failed === 0) {
    console.log(`PASS  test-session-summarize-previous (${passed} pruebas, 0 fallos)`);
    process.exitCode = 0;
  } else {
    console.error(`FAIL  test-session-summarize-previous (${passed} ok, ${failed} fallos)`);
    process.exitCode = 1;
  }
})();
