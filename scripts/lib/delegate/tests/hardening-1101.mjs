/**
 * hardening-1101.mjs - auditoria del 2026-11-01: se commitea lo que se valida,
 * `merge` exige el SHA validado, plazos en los procesos del delegador, git con
 * entorno limpio, vigilancia de la config de git, aviso de entradas sucias,
 * `gc`/`list` frente a las ramas reales, alcance sin renombrados y paridad de la
 * cadena con el contrato. Cada caso falla sin su arreglo. Lo ejecuta hardening.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ULTRON_HOME } from '../config.mjs';
import { boundedSync, git as procGit, gitEnv, reapOrphans } from '../proc.mjs';
import { BRIEF, DELEG, REPO, ROOT, branchExists, check, delegate, git, idOf, ledgerOf, run } from './harness.mjs';

const metaOf = (id) => JSON.parse(readFileSync(join(DELEG, id, 'meta.json'), 'utf8'));
/** Check en verde que antes ejecuta `body` con `fs` y `git` (execSync) a mano. */
const checkDoing = (body) => `node -e "const fs=require('fs');const git=(c)=>require('child_process').execSync('git '+c);${body}"`;

async function sameTreeTests() {
  await run('Codex #1: el check crea un fichero -> check-fail tree-changed, sin relevo y fuera del commit', () => {
    const r = delegate(['run', '--tier', 'standard', '--brief', BRIEF, '--check', checkDoing("fs.writeFileSync('extra.txt','x')")]);
    assert.equal(r.code, 2, r.out);
    const id = idOf(r.out);
    assert.deepEqual(ledgerOf(id).map((e) => [e.engine, e.outcome, e.reason, e.checkOk]), [['agy', 'check-fail', 'tree-changed', false]]);
    assert.match(r.out, /FALLA \(tree-changed\).*extra\.txt/);
    assert.deepEqual(git('show', '--name-only', '--format=', `delegate/${id}`).split('\n'), ['hecho.txt']);
    assert.equal(metaOf(id).validatedSha, null, 'nada validado');
  });

  await run('Codex #1: el check cambia un fichero validado -> tree-changed y el commit lleva el contenido anterior', () => {
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', checkDoing("fs.writeFileSync('hecho.txt','otro')")]);
    assert.equal(r.code, 1, r.out);
    const id = idOf(r.out);
    assert.equal(ledgerOf(id)[0].reason, 'tree-changed');
    assert.equal(git('show', `delegate/${id}:hecho.txt`), 'ok');
  });

  await run('Codex #1: el check mete algo en el indice -> tree-changed y no entra en el commit', () => {
    const body = "fs.writeFileSync('colado.txt','x');git('add colado.txt');";
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', checkDoing(body)]);
    assert.equal(r.code, 1, r.out);
    const id = idOf(r.out);
    assert.equal(ledgerOf(id)[0].reason, 'tree-changed');
    assert.match(r.out, /indice de git/);
    assert.deepEqual(git('show', '--name-only', '--format=', `delegate/${id}`).split('\n'), ['hecho.txt']);
  });

  await run('Codex #1 (negativo): un artefacto ignorado por git no invalida el check', () => {
    appendFileSync(join(REPO, '.git', 'info', 'exclude'), 'artefacto.log\n');
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', checkDoing("fs.writeFileSync('artefacto.log','x')")]);
    assert.equal(r.code, 0, r.out);
  });

  await run('Codex #1: un commit del motor no esconde un fichero del alcance ni duplica commits', () => {
    const shim = checkDoing("process.exit(0)");
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', shim, '--scope', '*.txt'], 'commit-outside');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /fuera del alcance.*fuera\.md/);
  });
}

async function mergeShaTests() {
  await run('Codex #2: merge exige el SHA validado; una rama movida tras el check se rechaza', () => {
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', check(0)]);
    assert.equal(r.code, 0, r.out);
    const id = idOf(r.out);
    const m = metaOf(id);
    const sha = git('rev-parse', `delegate/${id}`);
    assert.equal(m.validatedSha, sha);
    assert.equal(m.attempts[0].sha, sha);
    git('update-ref', `refs/heads/delegate/${id}`, git('rev-parse', 'HEAD'));
    const moved = delegate(['merge', id]);
    assert.equal(moved.code, 3, moved.out);
    assert.match(moved.out, /ya no apunta al commit validado/);
    assert.equal(git('diff', '--cached', '--name-only'), '', 'sin squash');
    assert.deepEqual(ledgerOf(id).filter((e) => e.stage), []);
    git('update-ref', `refs/heads/delegate/${id}`, sha);
    assert.equal(delegate(['merge', id]).code, 0, 'con el SHA de vuelta se fusiona');
    git('reset', '-q', '--hard', 'HEAD');
    assert.equal(delegate(['clean', id]).code, 0);
  });

  await run('Codex #2: una delegacion sin SHA registrado no se fusiona', () => {
    const id = idOf(delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--no-check']).out);
    const file = join(DELEG, id, 'meta.json');
    writeFileSync(file, JSON.stringify({ ...metaOf(id), validatedSha: null }));
    const r = delegate(['merge', id]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /no registra el SHA/);
    assert.equal(delegate(['clean', id]).code, 0);
  });

  await run('--scope sin renombrados: mover un fichero desde fuera del alcance se detecta y se persiste', () => {
    mkdirSync(join(REPO, 'zona'), { recursive: true });
    writeFileSync(join(REPO, 'zona', 'secreto.md'), 'dato de varias palabras para que git lo vea como renombrado\n');
    git('add', '-A', 'zona');
    git('commit', '-q', '-m', 'zona');
    const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', check(0), '--scope', 'dentro/**'], 'rename-outside');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /fuera del alcance.*zona\/secreto\.md/);
    assert.deepEqual(metaOf(idOf(r.out)).attempts[0].outside, ['zona/secreto.md']);
  });
}

async function timeoutTests() {
  await run('Codex #8: boundedSync corta un proceso colgado y lo dice', () => {
    const t0 = Date.now();
    const r = boundedSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 500 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 10000, `tardo ${Date.now() - t0} ms`);
    assert.equal(boundedSync(process.execPath, ['-e', ''], { timeoutMs: 20000 }).timedOut, false, 'caso negativo');
  });

  await run('Codex #8: reapOrphans tolera una tabla que no responde y respeta su plazo total', () => {
    const silence = console.error;
    const warnings = [];
    console.error = (m) => warnings.push(m);
    try {
      const times = { startMs: 1000, exitMs: 2000 };
      const base = { platform: 'win32' };
      assert.deepEqual(reapOrphans(100, times, { ...base, table: () => null }), []);
      assert.match(warnings.at(-1), /tabla de procesos/);
      const table = () => [{ pid: 200, ppid: 100, created: 1500 }, { pid: 300, ppid: 100, created: 1600 }];
      let clock = 0;
      const killed = [];
      const kill = (pid) => { killed.push(pid); clock += 60_000; };
      assert.deepEqual(reapOrphans(100, times, { ...base, table, kill, now: () => clock }), [200]);
      assert.deepEqual(killed, [200], 'agotado el plazo no sigue matando');
      assert.match(warnings.at(-1), /plazo agotado.*300/);
    } finally {
      console.error = silence;
    }
  });
}

async function gitSafetyTests() {
  await run('seguridad: gitEnv deja fuera keys y GIT_* peligrosas (sin distinguir mayusculas)', () => {
    const env = gitEnv({
      Path: 'p', SystemRoot: 's', HOME: 'h', GROQ_API_KEY: 'k', ULTRON_KEY_X: 'k', GH_TOKEN: 'k',
      GIT_DIR: 'd', GIT_INDEX_FILE: 'i', GIT_CONFIG_COUNT: '1', GIT_SSH_COMMAND: 'x', GIT_AUTHOR_NAME: 'a', NODE_OPTIONS: 'n',
    });
    assert.deepEqual(Object.keys(env).sort(), ['GIT_AUTHOR_NAME', 'HOME', 'Path', 'SystemRoot']);
  });

  await run('seguridad: el git del delegador no pasa las keys a lo que ejecute', () => {
    const out = join(ROOT, 'git-env.json');
    const dump = `alias.volcado=!node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify(Object.keys(process.env)))" ${JSON.stringify(out.replace(/\\/g, '/'))}`;
    process.env.ULTRON_T_GIT_API_KEY = 'x';
    try {
      procGit(REPO, ['volcado'], { config: [dump] });
    } finally {
      delete process.env.ULTRON_T_GIT_API_KEY;
    }
    const seen = JSON.parse(readFileSync(out, 'utf8')).map((k) => k.toUpperCase());
    assert.ok(seen.length > 0);
    assert.ok(!seen.includes('ULTRON_T_GIT_API_KEY'), 'la key llega a git');
  });

  await run('seguridad: un core.fsmonitor plantado no se ejecuta con el git del delegador (y si con uno normal)', () => {
    const marker = join(ROOT, 'fsmonitor-ejecutado.txt').replace(/\\/g, '/');
    const planted = `core.fsmonitor=echo x > "${marker}"`;
    spawnSync('git', ['-c', planted, 'status'], { cwd: REPO, encoding: 'utf8' });
    assert.ok(existsSync(marker), 'control: sin anularlo, git lo ejecuta');
    rmSync(marker);
    git('config', 'core.fsmonitor', `echo x > "${marker}"`);
    try {
      procGit(REPO, ['status']);
      assert.ok(!existsSync(marker), 'el fsmonitor plantado se ejecuto');
    } finally {
      git('config', '--unset', 'core.fsmonitor');
    }
  });

  for (const [mode, label, restore] of [
    ['plant-config', '.git/config', (saved) => writeFileSync(join(REPO, '.git', 'config'), saved)],
    ['plant-hook', '.git/hooks/post-commit', () => rmSync(join(REPO, '.git', 'hooks', 'post-commit'), { force: true })],
  ]) {
    await run(`seguridad: un motor que toca ${label} -> isolation, sin relevo, sin commit y worktree conservado`, () => {
      const saved = readFileSync(join(REPO, '.git', 'config'));
      const r = delegate(['run', '--tier', 'standard', '--brief', BRIEF, '--check', check(0)], `agy:${mode},*:write`);
      restore(saved);
      assert.equal(r.code, 2, r.out);
      const id = idOf(r.out);
      assert.deepEqual(ledgerOf(id).map((e) => [e.engine, e.outcome, e.reason]), [['agy', 'engine-fail', 'isolation']]);
      assert.match(r.out, new RegExp(`AISLAMIENTO ROTO.*${label.replace(/\./g, '\\.')}`));
      assert.match(r.out, /worktree .* conservado/);
      assert.ok(existsSync(metaOf(id).attempts[0].wt), 'el worktree se queda para revisarlo');
      assert.equal(git('rev-parse', `delegate/${id}`), git('rev-parse', 'HEAD'), 'la rama no recibe commit');
      assert.equal(delegate(['clean', id]).code, 0);
    });
  }
}

async function runNoticeTests() {
  await run('run avisa de cuantas entradas sucias deja fuera y de la base', () => {
    writeFileSync(join(REPO, 'README.md'), 'cambio sin commitear\n');
    writeFileSync(join(REPO, 'nuevo-sin-add.txt'), 'x');
    try {
      const r = delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--no-check']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /base: HEAD \([0-9a-f]{10}\).*AVISO: \d+ entrada\(s\) sin commitear/);
      const m = metaOf(idOf(r.out));
      assert.ok(m.dirtyAtStart >= 2, String(m.dirtyAtStart));
      assert.equal(m.baseSha, git('rev-parse', 'HEAD'));
    } finally {
      git('checkout', '--', 'README.md');
      rmSync(join(REPO, 'nuevo-sin-add.txt'));
    }
  });
}

async function branchStateTests() {
  await run('gc conserva una rama roja vieja y la lista; list y gc no afirman una rama verde que no existe', () => {
    const old = Date.now() / 1000 - 5 * 86400;
    const age = (id) => utimesSync(join(DELEG, id, 'result.json'), old, old);

    const red = idOf(delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--check', check(3)]).out);
    age(red);
    const gone = idOf(delegate(['run', '--engine', 'agy', '--brief', BRIEF, '--no-check']).out);
    age(gone);
    const dropped = metaOf(gone).wt;
    git('worktree', 'remove', '--force', dropped);
    git('branch', '-D', `delegate/${gone}`);

    const list = delegate(['list']).out;
    assert.match(list, new RegExp(`${gone} .*rama desaparecida \\(delegate/${gone}\\)`));

    const gc = delegate(['gc']);
    assert.equal(gc.code, 0, gc.out);
    assert.ok(branchExists(`delegate/${red}`), 'la rama roja sin revisar se conserva');
    assert.ok(existsSync(join(DELEG, red)), 'y su delegacion');
    assert.match(gc.out, new RegExp(`con rama sin fusionar ni descartar: [^\\n]*${red}`));
    assert.doesNotMatch(gc.out, new RegExp(`descartar: [^\\n]*${gone}`));
    assert.ok(!existsSync(join(DELEG, gone)), 'sin rama no hay nada que proteger');
    assert.equal(delegate(['clean', red]).code, 0);
  });
}

/** Primer bloque ```json de la seccion 1 del contrato. */
function contractBlock() {
  const text = readFileSync(join(ULTRON_HOME, 'docs', 'delegacion-contrato.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = text.slice(text.indexOf('## 1. Configuraci'));
  const m = /```json\n([\s\S]*?)\n```/.exec(section);
  assert.ok(m, 'el contrato no tiene bloque json en la seccion 1');
  return JSON.parse(m[1]);
}

async function parityTests() {
  await run('paridad: chain y tiers de delegation.default.json == bloque del contrato', () => {
    const def = JSON.parse(readFileSync(join(ULTRON_HOME, 'cockpit', 'ai-router', 'delegation.default.json'), 'utf8'));
    const doc = contractBlock();
    assert.deepEqual(doc.chain, def.chain);
    assert.deepEqual(doc.tiers, def.tiers);
    for (const [id, e] of Object.entries(doc.engines)) {
      assert.deepEqual(e, def.engines[id], `motor ${id} del extracto del contrato`);
    }
  });
}

export async function audit1101Tests() {
  console.log('delegate.mjs (auditoria 2026-11-01)');
  await sameTreeTests();
  await mergeShaTests();
  await timeoutTests();
  await gitSafetyTests();
  await runNoticeTests();
  await branchStateTests();
  await parityTests();
}
