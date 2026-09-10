#!/usr/bin/env node
/**
 * test-orchestrate-recovery.js — recuperacion del daemon en memory-orchestrate.
 *
 * Ejecutar:  node hooks/scripts/tests/test-orchestrate-recovery.js
 * (Node puro, sin dependencias. Tarda ~30 s: los casos (c) y (e) agotan a
 * proposito el presupuesto de recuperacion del hook.)
 *
 * Cubre HOOKS-07 (2026-09-10): con el daemon muerto el hook relanzaba `serve` y
 * caia al sparse de inmediato, que competia por CPU con la carga de E5 del
 * daemon recien lanzado y vencia su cap fijo de 3 s -> "[memoria degradada]".
 * Ahora el hook ESPERA al daemon nuevo y el cap del sparse es dinamico.
 *
 * Aislamiento (todo en temp, nada toca el sistema vivo):
 *   - USERPROFILE/HOME apuntan a un home temporal por caso; os.homedir() lee
 *     USERPROFILE en Windows, asi que el lockfile ~/.ultron/run/orchestrate.json,
 *     los logs y el estado de fast-lane son los del test.
 *   - ULTRON_MEMORY_BIN apunta a un fichero stub; las llamadas de
 *     child_process a ese path las intercepta un preload (`node --require`) que
 *     devuelve un pack sparse JSON para `orchestrate` y un hijo mudo para
 *     `serve`. En Windows un stub .cmd NO sirve: Node >= 20 rechaza spawnSync
 *     de .cmd sin `shell` con EINVAL (verificado con Node 24.13.0).
 *   - El "daemon" es un net.createServer del propio test: protocolo JSON por
 *     linea con el token del lockfile.
 *
 * Casos: (a) daemon vivo, (b) daemon ausente que aparece a los 2 s,
 * (c) nadie contesta nunca -> sparse dentro del cap, (d) turno de sistema/vacio,
 * (e) nadie contesta y el sparse tambien falla -> "[memoria degradada]".
 */

'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'memory-orchestrate.js');

// Presupuesto del hook (settings.json) y deadline de recuperacion, replicados
// aqui como ESPERADOS del test: si el hook los cambia, estas aserciones deben
// fallar y obligar a revisar el presupuesto.
const HOOK_BUDGET_MS = 20_000;
const RELAUNCH_DEADLINE_MS = 15_500;
const SPARSE_MIN_CAP_MS = 3_000;
const SPARSE_MAX_CAP_MS = 6_000;

const PRELOAD_SOURCE = `'use strict';
// Stub del sidecar ultron-memory para el test hermetico. Se precarga con
// --require, antes de que el hook capture spawn/spawnSync del modulo.
const cp = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');
const BIN = process.env.ULTRON_MEMORY_BIN;
const LOG = process.env.ULTRON_STUB_LOG;
const PACK = process.env.ULTRON_STUB_SPARSE_PACK || '';
function trace(rec) {
  try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\\n'); } catch { /* best effort */ }
}
const realSpawnSync = cp.spawnSync;
cp.spawnSync = function (file, args, opts) {
  if (file === BIN) {
    trace({ kind: 'spawnSync', args: args || [] });
    if (!PACK) return { status: 1, stdout: '', stderr: 'stub: sin pack', error: null, signal: null };
    return { status: 0, stdout: PACK, stderr: '', error: null, signal: null };
  }
  return realSpawnSync.call(cp, file, args, opts);
};
const realSpawn = cp.spawn;
cp.spawn = function (file, args, opts) {
  if (file === BIN) {
    trace({ kind: 'spawn', args: args || [] });
    const child = new EventEmitter();
    child.pid = 0;
    child.unref = () => {};
    child.kill = () => {};
    return child;
  }
  return realSpawn.call(cp, file, args, opts);
};
`;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recovery-'));
const PRELOAD = path.join(ROOT, 'stub-preload.js');
const BIN = path.join(ROOT, 'ultron-memory-stub.bin');
fs.writeFileSync(PRELOAD, PRELOAD_SOURCE);
fs.writeFileSync(BIN, ''); // findBinary() solo comprueba existsSync

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Home temporal aislado (+ cwd de proyecto) para un caso. */
function makeCase(name) {
  const home = path.join(ROOT, name, 'home');
  const cwd = path.join(ROOT, name, 'proyecto');
  fs.mkdirSync(path.join(home, '.ultron', 'run'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd, stubLog: path.join(ROOT, name, 'stub.jsonl') };
}

function writeLock(home, port, token) {
  fs.writeFileSync(
    path.join(home, '.ultron', 'run', 'orchestrate.json'),
    JSON.stringify({ port, token, pid: process.pid, started_at: Date.now() })
  );
}

/** Daemon falso: una respuesta JSON por linea, validando el token del lockfile. */
function startFakeDaemon(token, pack) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let req = null;
          try {
            req = JSON.parse(line);
          } catch {
            req = null;
          }
          const ok = req && req.token === token && req.cmd === 'orchestrate';
          try {
            sock.write(JSON.stringify(ok ? pack : { error: 'bad request' }) + '\n');
          } catch {
            /* el hook puede haber cerrado */
          }
        }
      });
    });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Lanza el hook aislado y devuelve { additionalContext, elapsedMs, code, stderr }. */
function runHook({ home, cwd, stubLog, prompt, sessionId, sparsePack }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--require', PRELOAD, HOOK], {
      cwd,
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        ULTRON_MEMORY_BIN: BIN,
        ULTRON_STUB_LOG: stubLog,
        ULTRON_STUB_SPARSE_PACK: sparsePack ? JSON.stringify(sparsePack) : '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      const elapsedMs = Date.now() - t0;
      let ctx = null;
      try {
        ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
      } catch {
        ctx = null;
      }
      resolve({ additionalContext: ctx, elapsedMs, code, stderr: err, raw: out });
    });
    child.stdin.end(JSON.stringify({ prompt, cwd, session_id: sessionId }));
  });
}

function readStubLog(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const PROMPT = 'refactoriza el recall hibrido del sidecar para que no bloquee el hot path';
const results = [];

async function caseA() {
  const c = makeCase('a-daemon-vivo');
  const token = 'tok-a';
  const { server, port } = await startFakeDaemon(token, {
    route: 'daemon-vivo',
    memories: [{ scope: 'project', summary: 'pack servido por el daemon' }],
  });
  writeLock(c.home, port, token);
  try {
    const r = await runHook({ ...c, prompt: PROMPT, sessionId: 'sess-a' });
    assert.strictEqual(r.code, 0, 'el hook debe salir 0 (fail-safe)');
    assert.ok(r.additionalContext, 'sin additionalContext parseable');
    assert.ok(
      r.additionalContext.includes('route="daemon-vivo"'),
      'el pack debe venir del daemon vivo'
    );
    assert.ok(
      !r.additionalContext.includes('[memoria degradada]'),
      'con daemon vivo no puede degradar'
    );
    assert.ok(
      !r.additionalContext.includes('daemon relanzado'),
      'con daemon vivo no debe relanzar nada'
    );
    assert.ok(r.elapsedMs < 5000, `daemon vivo deberia ser rapido, tardo ${r.elapsedMs} ms`);
    results.push(['(a) daemon vivo', r.elapsedMs]);
  } finally {
    server.close();
  }
}

async function caseB() {
  const c = makeCase('b-daemon-tardio');
  const token = 'tok-b';
  const { server, port } = await startFakeDaemon(token, {
    route: 'daemon-relanzado',
    memories: [{ scope: 'project', summary: 'pack del daemon recuperado' }],
  });
  // El servidor ya escucha, pero el hook no puede verlo: sin lockfile
  // daemonRequest devuelve null al instante (daemon "muerto"). El lockfile
  // aparece a los 2 s, como haria un `serve` recien arrancado.
  const armed = sleep(2000).then(() => writeLock(c.home, port, token));
  try {
    const r = await runHook({ ...c, prompt: PROMPT, sessionId: 'sess-b' });
    await armed;
    assert.strictEqual(r.code, 0, 'el hook debe salir 0 (fail-safe)');
    assert.ok(r.additionalContext, 'sin additionalContext parseable');
    assert.ok(
      r.additionalContext.includes('route="daemon-relanzado"'),
      'el turno debe servirse con el pack del daemon recuperado'
    );
    assert.ok(
      r.additionalContext.includes('daemon relanzado'),
      'falta el warning "daemon relanzado en N ms"'
    );
    assert.ok(
      !r.additionalContext.includes('[memoria degradada]'),
      'recuperado el daemon, no puede degradar'
    );
    assert.ok(
      !r.additionalContext.includes('respaldo sparse'),
      'con el daemon recuperado no debe caer al sparse'
    );
    const serve = readStubLog(c.stubLog).filter((e) => e.kind === 'spawn' && e.args[0] === 'serve');
    assert.strictEqual(serve.length, 1, 'debe relanzar `serve` exactamente una vez');
    assert.ok(r.elapsedMs >= 2000, `no puede contestar antes de que exista el daemon (${r.elapsedMs} ms)`);
    assert.ok(
      r.elapsedMs < RELAUNCH_DEADLINE_MS,
      `debe recuperar dentro de la deadline, tardo ${r.elapsedMs} ms`
    );
    results.push(['(b) daemon recuperado', r.elapsedMs]);
  } finally {
    server.close();
  }
}

async function caseC() {
  const c = makeCase('c-nadie-contesta');
  // Ni lockfile ni servidor: el daemon nunca aparece. El unico camino con
  // resultado es el sparse del stub.
  const r = await runHook({
    ...c,
    prompt: PROMPT,
    sessionId: 'sess-c',
    sparsePack: { route: 'sparse-stub', memories: [{ scope: 'project', summary: 'pack sparse' }] },
  });
  assert.strictEqual(r.code, 0, 'el hook debe salir 0 (fail-safe)');
  assert.ok(r.additionalContext, 'sin additionalContext parseable');
  assert.ok(
    r.additionalContext.includes('route="sparse-stub"'),
    'sin daemon el turno lo debe servir el sparse'
  );
  assert.ok(
    r.additionalContext.includes('respaldo sparse'),
    'falta el warning de respaldo sparse'
  );
  assert.ok(
    !r.additionalContext.includes('[memoria degradada]'),
    'con sparse disponible no debe degradar'
  );
  const cap = /respaldo sparse \(FTS5, sin E5, cap (\d+) ms\)/.exec(r.additionalContext);
  assert.ok(cap, 'el warning debe declarar el cap dinamico usado');
  const capMs = Number(cap[1]);
  assert.ok(
    capMs >= SPARSE_MIN_CAP_MS && capMs <= SPARSE_MAX_CAP_MS,
    `cap fuera de [${SPARSE_MIN_CAP_MS}, ${SPARSE_MAX_CAP_MS}]: ${capMs}`
  );
  const serve = readStubLog(c.stubLog).filter((e) => e.kind === 'spawn' && e.args[0] === 'serve');
  assert.strictEqual(serve.length, 1, 'debe intentar relanzar `serve` una sola vez');
  assert.ok(
    r.elapsedMs < HOOK_BUDGET_MS,
    `el peor caso debe caber en el presupuesto del hook: ${r.elapsedMs} ms`
  );
  results.push([`(c) sin daemon -> sparse cap ${capMs} ms`, r.elapsedMs]);
}

async function caseD() {
  const sistema = makeCase('d1-turno-sistema');
  const rs = await runHook({
    ...sistema,
    prompt: '<task-notification>tarea background terminada</task-notification>',
    sessionId: 'sess-d1',
  });
  assert.strictEqual(rs.code, 0, 'el hook debe salir 0 (fail-safe)');
  assert.strictEqual(rs.additionalContext, '', 'un turno de sistema no se orquesta');
  assert.strictEqual(
    readStubLog(sistema.stubLog).length,
    0,
    'un turno de sistema no debe tocar el sidecar'
  );
  assert.ok(rs.elapsedMs < 5000, `salida inmediata esperada, tardo ${rs.elapsedMs} ms`);
  results.push(['(d) turno de sistema', rs.elapsedMs]);

  const vacio = makeCase('d2-prompt-vacio');
  const rv = await runHook({ ...vacio, prompt: '   ', sessionId: 'sess-d2' });
  assert.strictEqual(rv.code, 0, 'el hook debe salir 0 (fail-safe)');
  assert.strictEqual(rv.additionalContext, '', 'un prompt vacio no se orquesta');
  assert.ok(rv.elapsedMs < 5000, `salida inmediata esperada, tardo ${rv.elapsedMs} ms`);
  results.push(['(d) prompt vacio', rv.elapsedMs]);
}

async function caseE() {
  const c = makeCase('e-degradado');
  // Sin daemon y con el sparse fallando (el stub sale status!=0 sin pack): es el
  // unico caso en que de verdad no hay nada que inyectar.
  const r = await runHook({ ...c, prompt: PROMPT, sessionId: 'sess-e' });
  assert.strictEqual(r.code, 0, 'el hook debe salir 0 (fail-safe)');
  assert.ok(
    r.additionalContext && r.additionalContext.includes('[memoria degradada]'),
    'sin daemon y sin sparse el hook debe avisar de memoria degradada'
  );
  assert.ok(
    r.elapsedMs < HOOK_BUDGET_MS,
    `el caso degradado tambien debe caber en el presupuesto: ${r.elapsedMs} ms`
  );
  results.push(['(e) degradado real', r.elapsedMs]);
}

async function main() {
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  await caseE();
  for (const [name, ms] of results) console.log(`  ok ${name} — ${ms} ms`);
  console.log('test-orchestrate-recovery: OK');
}

main()
  .then(() => {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* limpieza best-effort */
    }
  })
  .catch((e) => {
    console.error('test-orchestrate-recovery: FALLO');
    console.error(e && e.stack ? e.stack : e);
    console.error(`(artefactos del caso en ${ROOT})`);
    process.exitCode = 1;
  });
