#!/usr/bin/env node
/**
 * delegate.selftest.mjs - scripts/delegate.mjs con un motor falso.
 * Hermetico: repo git, configuracion, ledger, delegaciones, cuota y saldo en un
 * directorio temporal; sin red ni CLI reales (ULTRON_DELEGATE_FAKE_ENGINE).
 * Entorno comun en lib/delegate/tests/harness.mjs; los casos de la auditoria
 * del 2026-10-26 en lib/delegate/tests/hardening*.mjs.
 *
 * Uso: node scripts/delegate.selftest.mjs   (exit 0 = verde)
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BALANCE, BRIEF, CONFIG_JSON, DELEG, LEDGER, PIDFILE, REPO, ROOT, USAGE, ABSENT_KEY,
  branchExists, check, delegate, git, idOf, isAlive, ledgerOf, results, run, setup,
} from './lib/delegate/tests/harness.mjs';
import { hardeningTests } from './lib/delegate/tests/hardening.mjs';
import { gcCandidates } from './lib/delegate/manage.mjs';
import { mainRepoChanges, parsePorcelainZ } from './lib/delegate/isolation.mjs';
import { descendantsOf } from './lib/delegate/proc.mjs';

setup();
console.log('delegate.mjs');

let okId = null;
const finalsOf = (id) => ledgerOf(id).filter((e) => e.final).map((e) => e.final);
await run('motor y check en verde -> exit 0, commit en la rama sin el encargo ni los enlaces', () => {
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--check', check(0), '--link', 'deps']);
  assert.equal(r.code, 0, r.out);
  okId = idOf(r.out);
  assert.ok(okId, r.out);
  const files = git('show', '--name-only', '--format=', `delegate/${okId}`).split('\n');
  assert.deepEqual(files, ['hecho.txt']);
  assert.match(git('log', '-1', '--format=%s', `delegate/${okId}`), /^chore\(delegate\): Crear hecho\.txt$/);
  assert.match(r.out, /check: OK/);
  assert.match(r.out, /He creado hecho\.txt/);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'el arbol del repo no cambia');
});

await run('el enlace --link apunta al repo dentro del worktree', () => {
  const meta = JSON.parse(readFileSync(join(DELEG, okId, 'meta.json'), 'utf8'));
  assert.equal(readFileSync(join(meta.wt, 'deps', 'lib.txt'), 'utf8'), 'dependencia\n');
});

await run('ledger: una linea por intento con los campos del contrato y repo sin ruta', () => {
  const [e] = ledgerOf(okId);
  const keys = ['ts', 'id', 'attempt', 'engine', 'runner', 'model', 'tier', 'outcome', 'skipReason', 'durationS', 'checkOk', 'filesChanged', 'costUsd', 'branch', 'title', 'repo'];
  assert.deepEqual(Object.keys(e).slice(0, keys.length), keys);
  assert.equal(e.outcome, 'ok');
  assert.equal(e.checkOk, true);
  assert.equal(e.filesChanged, 1);
  assert.equal(e.branch, `delegate/${okId}`);
  assert.equal(e.repo, 'repo');
  assert.ok(!readFileSync(LEDGER, 'utf8').includes(ROOT.replace(/\\/g, '\\\\')), 'el ledger no lleva rutas absolutas');
});

await run('check en rojo con motor forzado -> exit 1 y la cola del log en el resumen', () => {
  const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', check(3)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /check: FALLA \(3\)/);
});

await run('el delegado no cambia nada -> exit 2, nunca exito silencioso', () => {
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check'], 'noop');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cambios: ninguno/);
  assert.equal(branchExists(`delegate/${idOf(r.out)}`), false, 'sin cambios no queda rama');
});

await run('el motor falla -> exit 2 aunque deje cambios (la rama se conserva)', () => {
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check'], 'crash');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /motor exit 7/);
  assert.match(r.out, /hecho\.txt/, 'los cambios quedan en la rama para revisarlos');
  assert.ok(branchExists(`delegate/${idOf(r.out)}`));
});

await run('cuota del motor forzado al 95 % -> no delega (exit 3); --force la salta', () => {
  writeFileSync(USAGE, JSON.stringify({ status: 'ok', windows: [{ kind: 'five_hour', group: null, usedPct: 97 }] }));
  try {
    const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /cuota casi agotada \(codex: ventana five_hour al 97 %\)/);
    assert.equal(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check', '--force']).code, 0);
  } finally {
    writeFileSync(USAGE, 'null');
  }
});

await run('errores de uso -> exit 3 sin crear worktree (incluido --check ausente)', () => {
  const before = git('worktree', 'list').split('\n').length;
  const noCheck = delegate(['run', '--engine', 'codex', '--brief', BRIEF]);
  assert.equal(noCheck.code, 3, noCheck.out);
  assert.match(noCheck.out, /--check .* es obligatorio/);
  assert.equal(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--check', check(0), '--no-check']).code, 3);
  assert.equal(delegate(['run', '--engine', 'gpt', '--brief', BRIEF, '--no-check']).code, 3);
  assert.equal(delegate(['run', '--engine', 'codex', '--brief', join(ROOT, 'no-existe.md'), '--no-check']).code, 3);
  assert.equal(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check', '--link', 'falta']).code, 3);
  assert.equal(delegate(['run', '--brief', BRIEF, '--no-check', '--model', 'x']).code, 3, '--model sin --engine');
  assert.equal(delegate(['run', '--brief', BRIEF, '--no-check', '--tier', 'epico']).code, 3);
  assert.equal(delegate(['run', '--engine', 'off', '--brief', BRIEF, '--no-check']).code, 3, 'motor forzado deshabilitado');
  assert.equal(delegate(['nada']).code, 3);
  assert.equal(git('worktree', 'list').split('\n').length, before, 'ningun error de uso deja worktree');
});

await run('relevo: el motor 1 falla sin cambios -> el motor 2 lo hace (worktree nuevo, exit 0)', () => {
  const r = delegate(['run', '--tier', 'complex', '--brief', BRIEF, '--check', check(0)], 'codex:fail,*:write');
  assert.equal(r.code, 0, r.out);
  const id = idOf(r.out);
  const lines = ledgerOf(id);
  assert.deepEqual(lines.map((e) => [e.engine, e.outcome]), [['codex', 'engine-fail'], ['agy', 'ok']]);
  assert.equal(lines[0].model, 'gpt-5.6-sol', 'modelo por tier');
  assert.equal(lines[0].branch, null);
  assert.equal(branchExists(`delegate/${id}`), false, 'el worktree fallido sin cambios se borra');
  assert.equal(lines[1].branch, `delegate/${id}-a2`);
  assert.ok(branchExists(`delegate/${id}-a2`));
  assert.match(r.out, /resultado: OK con agy/);
});

await run('relevo por check rojo: la rama roja se conserva y el siguiente motor la arregla', () => {
  const red = `node -e "process.exit(require('fs').existsSync('rojo.txt') ? 3 : 0)"`;
  const r = delegate(['run', '--tier', 'complex', '--brief', BRIEF, '--check', red], 'codex:red,*:write');
  assert.equal(r.code, 0, r.out);
  const id = idOf(r.out);
  assert.deepEqual(ledgerOf(id).map((e) => [e.engine, e.outcome, e.checkOk]), [['codex', 'check-fail', false], ['agy', 'ok', true]]);
  assert.ok(branchExists(`delegate/${id}`), 'rama roja conservada');
});

await run('skip por key ausente -> se registra missing-key y pasa al siguiente', () => {
  const r = delegate(['run', '--tier', 'trivial', '--brief', BRIEF, '--no-check']);
  assert.equal(r.code, 0, r.out);
  const lines = ledgerOf(idOf(r.out));
  assert.equal(lines[0].engine, 'needkey');
  assert.equal(lines[0].outcome, 'skipped');
  assert.equal(lines[0].skipReason, 'missing-key');
  assert.equal(lines[1].engine, 'oc');
  assert.equal(lines[1].outcome, 'ok');
  assert.match(r.out, /saltado: missing-key/);
});

await run('todos fallan -> exit 2 y el resumen dice que paso con cada motor', () => {
  const r = delegate(['run', '--brief', BRIEF, '--no-check'], 'fail');
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(ledgerOf(idOf(r.out)).map((e) => e.outcome), ['engine-fail', 'skipped', 'engine-fail', 'engine-fail']);
  assert.match(r.out, /vuelve a Opus/);
  for (const e of ['agy', 'needkey', 'oc', 'codex']) assert.match(r.out, new RegExp(`intento \\d · ${e} `));
});

await run('--no-relay: un solo intento real aunque falle', () => {
  const r = delegate(['run', '--brief', BRIEF, '--no-check', '--no-relay'], 'fail');
  assert.equal(r.code, 2, r.out);
  assert.equal(ledgerOf(idOf(r.out)).length, 1);
});

await run('--scope: un diff fuera del alcance cuenta como check-fail con motivo scope', () => {
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--check', check(0), '--scope', 'docs/**,*.txt'], 'outside');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /check: FALLA \(scope\).*fuera\.md/);
  const [e] = ledgerOf(idOf(r.out));
  assert.equal(e.outcome, 'check-fail');
  assert.equal(e.reason, 'scope');
  assert.equal(e.checkOk, false);
  const inside = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--check', check(0), '--scope', 'docs/**,*.txt']);
  assert.equal(inside.code, 0, inside.out);
});

await run('timeout: mata el arbol entero (sin nietos huerfanos) y cuenta como timeout', () => {
  rmSync(PIDFILE, { force: true });
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check', '--timeout', '3'], 'hang');
  assert.equal(r.code, 2, r.out);
  assert.equal(ledgerOf(idOf(r.out))[0].outcome, 'timeout');
  const pid = Number(readFileSync(PIDFILE, 'utf8'));
  assert.equal(isAlive(pid), false, `el nieto ${pid} sigue vivo`);
});

await run('opencode colgado tras AI_RetryError -> se mata sin esperar al plazo (engine-fail, quota)', () => {
  const r = delegate(['run', '--engine', 'oc', '--brief', BRIEF, '--no-check', '--timeout', '120'], 'oc-hang');
  assert.equal(r.code, 2, r.out);
  assert.ok(r.ms < 60000, `tardo ${r.ms} ms`);
  const [e] = ledgerOf(idOf(r.out));
  assert.equal(e.outcome, 'engine-fail');
  assert.equal(e.reason, 'quota');
});

await run('claude -p: respuesta y coste del JSON; is_error con 429 -> engine-fail quota', () => {
  const ok = delegate(['run', '--engine', 'cl', '--brief', BRIEF, '--no-check'], 'claude-ok');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /Hecho por claude/);
  assert.equal(ledgerOf(idOf(ok.out))[0].costUsd, 0.0123);
  const err = delegate(['run', '--engine', 'cl', '--brief', BRIEF, '--no-check'], 'claude-err');
  assert.equal(err.code, 2, err.out);
  const [e] = ledgerOf(idOf(err.out));
  assert.deepEqual([e.outcome, e.reason, e.costUsd], ['engine-fail', 'quota', 0.001]);
});

await run('status --json: forma del contrato, motivos y configSource', () => {
  writeFileSync(USAGE, JSON.stringify({ status: 'ok', windows: [{ kind: 'seven_day', group: null, usedPct: 12.4 }] }));
  try {
    const r = delegate(['status', '--json']);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j), ['chain', 'engines', 'configSource']);
    assert.equal(j.configSource, 'file');
    assert.deepEqual(j.chain, CONFIG_JSON.chain);
    const keys = ['id', 'runner', 'model', 'enabled', 'installed', 'keyPresent', 'quota', 'balance', 'available', 'reason'];
    for (const e of j.engines) assert.deepEqual(Object.keys(e), keys);
    const by = Object.fromEntries(j.engines.map((e) => [e.id, e]));
    assert.deepEqual(by.codex.quota, { usedPct: 12, window: 'weekly' });
    assert.equal(by.codex.keyPresent, null);
    assert.deepEqual([by.needkey.keyPresent, by.needkey.available, by.needkey.reason], [false, false, 'missing-key']);
    assert.deepEqual([by.off.available, by.off.reason], [false, 'disabled']);
    const missing = delegate(['status', '--json'], 'write', { ULTRON_DELEGATE_CONFIG: join(ROOT, 'no-existe.json') });
    assert.equal(JSON.parse(missing.out).configSource, 'default');
    assert.match(delegate(['status'], 'write', { ULTRON_DELEGATE_CONFIG: join(ROOT, 'no-existe.json') }).out, /valor por defecto/);
  } finally {
    writeFileSync(USAGE, 'null');
  }
});

await run('saldo de DeepSeek no disponible -> skip con motivo quota', () => {
  writeFileSync(BALANCE, JSON.stringify({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }));
  try {
    const r = delegate(['run', '--tier', 'trivial', '--brief', BRIEF, '--no-check'], 'write', { [ABSENT_KEY]: 'k' });
    assert.equal(r.code, 0, r.out);
    const [e] = ledgerOf(idOf(r.out));
    assert.deepEqual([e.engine, e.outcome, e.skipReason], ['needkey', 'skipped', 'quota']);
  } finally {
    writeFileSync(BALANCE, 'null');
  }
});

await run('merge: squash preparado sin commit; ledger squash-prepared (sin final) hasta el commit', () => {
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check']);
  const id = idOf(r.out);
  const m = delegate(['merge', id]);
  assert.equal(m.code, 0, m.out);
  assert.equal(git('diff', '--cached', '--name-only'), 'hecho.txt');
  assert.match(m.out, /SIN commit/);
  assert.equal(git('rev-list', '--count', 'HEAD'), '1', 'merge no hace commit');
  assert.deepEqual(finalsOf(id), [], 'sin commit no hay final merged');
  assert.equal(ledgerOf(id).filter((e) => e.stage).at(-1).stage, 'squash-prepared');
  assert.equal(delegate(['merge', id]).code, 3, 'segundo merge con el squash pendiente rechazado');
  assert.equal(delegate(['clean', id]).code, 3, 'clean con el squash pendiente rechazado');
  git('reset', '-q', '--hard', 'HEAD');
  assert.equal(delegate(['clean', id]).code, 0, 'squash deshecho: clean lo descarta');
  assert.deepEqual(finalsOf(id), ['discarded']);
});

await run('list muestra las delegaciones y clean borra worktree, rama y logs sin tocar el destino del enlace', () => {
  const list = delegate(['list']).out;
  assert.ok(list.includes(okId), list);
  const r = delegate(['clean', okId]);
  assert.equal(r.code, 0, r.out);
  assert.equal(git('branch', '--list', `delegate/${okId}`), '');
  assert.equal(existsSync(join(DELEG, okId)), false);
  assert.equal(readFileSync(join(REPO, 'deps', 'lib.txt'), 'utf8'), 'dependencia\n', 'el destino de --link sigue intacto');
  assert.deepEqual(ledgerOf(okId).filter((e) => e.final).map((e) => e.final), ['discarded']);
  assert.equal(delegate(['clean', okId]).code, 3, 'clean de un id inexistente falla');
});

await run('--link de una ruta ignorada (node_modules, target) no tira el intento', () => {
  mkdirSync(join(REPO, 'ignorado'));
  writeFileSync(join(REPO, 'ignorado', 'x.txt'), 'x\n');
  appendFileSync(join(REPO, '.git', 'info', 'exclude'), 'ignorado/\n');
  const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--check', check(0), '--link', 'ignorado', '--link', 'deps']);
  assert.equal(r.code, 0, r.out);
  const id = idOf(r.out);
  assert.deepEqual(git('show', '--name-only', '--format=', `delegate/${id}`).split('\n'), ['hecho.txt']);
  assert.ok(existsSync(join(REPO, 'ignorado', 'x.txt')), 'el destino del enlace sigue intacto');
});

await run('gc: solo borra lo terminado, viejo y sin trabajo pendiente', () => {
  const now = Date.UTC(2026, 9, 28);
  const old = now - 3 * 86_400_000;
  const entries = [
    { id: 'fusionada', finishedMs: old, final: 'merged', winner: 'delegate/x' },
    { id: 'sin-verde', finishedMs: old, final: null, winner: null },
    { id: 'verde-sin-fusionar', finishedMs: old, final: null, winner: 'delegate/y' },
    { id: 'roja-conservada', finishedMs: old, final: null, winner: null, kept: ['delegate/z'] },
    { id: 'en-curso', finishedMs: null, final: null, winner: null },
    { id: 'reciente', finishedMs: now - 3_600_000, final: null, winner: null },
  ];
  assert.deepEqual(gcCandidates(entries, now), ['fusionada', 'sin-verde']);
  assert.deepEqual(gcCandidates(entries, now, 0), ['fusionada', 'sin-verde', 'reciente']);
});

// --- Auditoria 2026-10-28 (relevo): M8, L7 y L8 ---

// Antes este caso esperaba `isolation` con `escapado.txt`, un fichero ajeno al
// diff del worktree. Ese test consagraba el fallo HIGH de la auditoria 2026-11-01:
// es indistinguible de la actividad de la sesion y abortaba trabajo valido. Queda
// dividido: ruptura cuando hay evidencia (abajo) y sospecha cuando no la hay.
await run('M8: un motor sin sandbox escribe en el checkout lo mismo que en el worktree -> engine-fail isolation, sin relevo', () => {
  const r = delegate(['run', '--tier', 'standard', '--brief', BRIEF, '--check', check(0)], 'agy:escape-same,*:write');
  try {
    assert.equal(r.code, 2, r.out);
    const lines = ledgerOf(idOf(r.out));
    assert.deepEqual(lines.map((e) => [e.engine, e.outcome, e.reason]), [['agy', 'engine-fail', 'isolation']], 'el relevo se corta');
    assert.match(r.out, /AISLAMIENTO ROTO.*hecho\.txt/);
    assert.ok(existsSync(join(REPO, 'hecho.txt')), 'no se revierte nada');
  } finally {
    rmSync(join(REPO, 'hecho.txt'), { force: true });
  }
});

await run('M8: motor sin sandbox que acaba bien, sin cambios en el worktree y con el checkout cambiado -> ruptura', () => {
  const r = delegate(['run', '--tier', 'standard', '--brief', BRIEF, '--no-check'], 'agy:escape-only,*:write');
  try {
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(ledgerOf(idOf(r.out)).map((e) => [e.engine, e.reason]), [['agy', 'isolation']]);
  } finally {
    rmSync(join(REPO, 'hecho.txt'), { force: true });
  }
});

await run('HIGH 2026-11-01: un cambio ajeno al diff no aborta: el check cuenta, exit 0 e isolation-suspect (con y sin sandbox)', () => {
  for (const [flags, mode, engine] of [[['--tier', 'standard'], 'agy:escape,*:write', 'agy'], [['--tier', 'complex'], 'codex:escape,*:write', 'codex']]) {
    const r = delegate(['run', ...flags, '--brief', BRIEF, '--check', check(0)], mode);
    try {
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /check: OK/);
      assert.match(r.out, /AISLAMIENTO SOSPECHOSO.*escapado\.txt/);
      assert.doesNotMatch(r.out, /AISLAMIENTO ROTO/);
      const [e] = ledgerOf(idOf(r.out));
      assert.deepEqual([e.engine, e.outcome, e.reason, e.isolationSuspect], [engine, 'ok', 'isolation-suspect', 1]);
      const meta = JSON.parse(readFileSync(join(DELEG, idOf(r.out), 'meta.json'), 'utf8'));
      assert.deepEqual(meta.attempts[0].suspect, ['escapado.txt']);
    } finally {
      rmSync(join(REPO, 'escapado.txt'), { force: true });
    }
  }
});

await run('HIGH 2026-11-01: un check rojo con sospecha sigue siendo rojo y el relevo continua', () => {
  const r = delegate(['run', '--tier', 'standard', '--brief', BRIEF, '--check', check(3)], 'agy:escape,*:write');
  try {
    const lines = ledgerOf(idOf(r.out));
    assert.deepEqual(lines.slice(0, 2).map((e) => [e.engine, e.outcome]), [['agy', 'check-fail'], ['needkey', 'skipped']]);
    assert.ok(lines.length > 2, 'la sospecha no corta el relevo');
  } finally {
    rmSync(join(REPO, 'escapado.txt'), { force: true });
  }
});

await run('M8: huella del checkout (fichero ya sucio que cambia, nuevo, desaparecido; renombrado con -z)', () => {
  const before = new Map([['a.txt', ' M|1:1'], ['b.txt', '??|2:2'], ['c.txt', ' M|3:3']]);
  const after = new Map([['a.txt', ' M|5:9'], ['b.txt', '??|2:2'], ['d.txt', '??|1:1']]);
  assert.deepEqual(mainRepoChanges(before, after), ['a.txt', 'c.txt', 'd.txt']);
  assert.deepEqual(mainRepoChanges(before, new Map(before)), []);
  assert.deepEqual(parsePorcelainZ(' M a.txt\0R  nuevo.txt\0viejo.txt\0?? año.txt\0'), [
    { xy: ' M', path: 'a.txt' }, { xy: 'R ', path: 'nuevo.txt' }, { xy: '??', path: 'año.txt' },
  ]);
});

await run('L7: merge con el arbol sucio o con la base fuera de HEAD -> exit 3 sin squash ni ledger', () => {
  const id = idOf(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check']).out);
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(REPO, 'README.md'), 'cambio local\n');
  const dirty = delegate(['merge', id]);
  git('checkout', '--', 'README.md');
  assert.equal(dirty.code, 3, dirty.out);
  assert.match(dirty.out, /cambios sin commitear/);
  git('commit', '-q', '--amend', '-m', 'init reescrito');
  try {
    const moved = delegate(['merge', id]);
    assert.equal(moved.code, 3, moved.out);
    assert.match(moved.out, /no es ancestro de HEAD/);
    assert.equal(git('diff', '--cached', '--name-only'), '', 'sin squash');
    assert.deepEqual(ledgerOf(id).filter((e) => e.final || e.stage), []);
  } finally {
    git('reset', '-q', '--hard', head);
  }
  assert.equal(delegate(['clean', id]).code, 0);
});

await run('L7: con el commit del squash hecho el ledger pasa a merged (list lo detecta) y clean no anade discarded', () => {
  const id = idOf(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check']).out);
  const head = git('rev-parse', 'HEAD');
  try {
    assert.equal(delegate(['merge', id]).code, 0);
    git('commit', '-q', '-m', 'squash de la delegacion');
    assert.match(delegate(['list']).out, new RegExp(`${id} · exit 0 · merged`));
    assert.deepEqual(finalsOf(id), ['merged']);
    assert.equal(delegate(['merge', id]).code, 3, 'ya fusionada');
    assert.equal(delegate(['clean', id]).code, 0);
    assert.deepEqual(finalsOf(id), ['merged']);
  } finally {
    git('reset', '-q', '--hard', head);
  }
});

await run('L8: descendientes por PPID y hora de creacion (descarta PIDs reutilizados)', () => {
  const rows = [
    { pid: 200, ppid: 100, created: 1500 }, // hijo real
    { pid: 300, ppid: 200, created: 2500 }, // nieto, nacido tras la salida de la raiz
    { pid: 400, ppid: 100, created: 500 }, // hijo de un proceso anterior con el mismo PID
    { pid: 500, ppid: 100, created: 5000 }, // hijo de un proceso posterior con el mismo PID
    { pid: 600, ppid: 999, created: 1600 }, // ajeno
  ];
  assert.deepEqual(descendantsOf(rows, 100, { startMs: 1000, exitMs: 2000 }), [200, 300]);
});

if (process.platform === 'win32') {
  await run('L8 (Windows): un nieto que sobrevive a un motor que sale bien muere al terminar el intento', () => {
    rmSync(PIDFILE, { force: true });
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--no-check'], 'orphan');
    const pid = Number(readFileSync(PIDFILE, 'utf8'));
    const alive = isAlive(pid);
    if (alive) process.kill(pid);
    assert.equal(r.code, 0, r.out);
    assert.equal(alive, false, `el nieto ${pid} sigue vivo`);
  });
}

await hardeningTests();

git('worktree', 'prune');
rmSync(ROOT, { recursive: true, force: true });
const { passed, failed } = results();
console.log(`\n${passed} ok, ${failed} fallos`);
process.exit(failed ? 1 : 0);
