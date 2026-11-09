/**
 * hardening.mjs - casos de la auditoria del delegador (2026-10-26): sin shell
 * en los motores, entorno sin keys ajenas, rutas no ASCII, vigilante de
 * OpenCode, relevo ante excepciones, clean de huerfanos y validacion de ids,
 * rutas de meta.json, tiers y configuracion por defecto. Cada caso falla sin
 * su arreglo. Lo ejecuta scripts/delegate.selftest.mjs.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { watchOpencode } from '../adapters.mjs';
import { resolveLauncher, shimTarget } from '../launcher.mjs';
import { runLogged } from '../proc.mjs';
import { BRIEF, CONFIG_JSON, DELEG, ROOT, branchExists, check, delegate, git, idOf, ledgerOf, run, worktreeCount } from './harness.mjs';
import { configTests } from './hardening-config.mjs';
import { audit1101Tests } from './hardening-1101.mjs';
import { round2Tests } from './hardening-round2.mjs';

const writeConfig = (name, cfg) => {
  const p = join(ROOT, name);
  writeFileSync(p, JSON.stringify(cfg));
  return p;
};

/** Shim de `codex` que registra su argv (Windows: .cmd de npm; POSIX: ejecutable). */
function makeCodexShim() {
  const bin = join(ROOT, 'shim-bin');
  const js = join(bin, 'node_modules', 'fakecodex', 'bin', 'codex.js');
  mkdirSync(join(bin, 'node_modules', 'fakecodex', 'bin'), { recursive: true });
  const body = [
    "const fs = require('node:fs');",
    "fs.readFileSync(0, 'utf8');",
    'fs.writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(process.argv.slice(2)));',
    "fs.writeFileSync('hecho.txt', 'ok');",
  ].join('\n');
  writeFileSync(js.replace(/\.js$/, '.cjs'), body);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'codex.cmd'), '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\fakecodex\\bin\\codex.cjs" %*\r\n');
  } else {
    writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(js.replace(/\.js$/, '.cjs'))});\n`);
    chmodSync(join(bin, 'codex'), 0o755);
  }
  return bin;
}

async function securityTests() {
  await run('--model con metacaracteres de shell -> exit 3 sin crear worktree', () => {
    const before = worktreeCount();
    const r = delegate(['run', '--engine', 'codex', '--model', 'x" & echo PWNED & "', '--brief', BRIEF, '--no-check']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /--model no valido/);
    assert.equal(worktreeCount(), before);
  });

  await run('modelo de la config con metacaracteres -> motor disabled (status y run forzado)', () => {
    const bad = writeConfig('bad-model.json', { ...CONFIG_JSON, engines: { ...CONFIG_JSON.engines, codex: { runner: 'codex', model: 'gpt$(id)%PATH%', enabled: true } } });
    const st = JSON.parse(delegate(['status', '--json'], 'write', { ULTRON_DELEGATE_CONFIG: bad }).out);
    const codex = st.engines.find((e) => e.id === 'codex');
    assert.deepEqual([codex.available, codex.reason], [false, 'disabled']);
    const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check'], 'write', { ULTRON_DELEGATE_CONFIG: bad });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /modelo no valido/);
  });

  await run('motor real sin shell: argv literal aunque la ruta lleve %VAR% y $VAR', () => {
    const bin = makeCodexShim();
    const out = join(ROOT, 'argv.json');
    const dir = join(ROOT, 'd%ULTRON_PROBE%$ULTRON_PROBE');
    const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check'], 'write', {
      ULTRON_DELEGATE_FAKE_ENGINE: '', ULTRON_DELEGATE_DIR: dir, ULTRON_PROBE: 'EXPANDIDO', FAKE_ARGV_OUT: out,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
    });
    assert.equal(r.code, 0, r.out);
    const argv = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(argv.includes('--model=gpt-5.6-terra'), JSON.stringify(argv));
    const wt = argv[argv.indexOf('-C') + 1];
    assert.ok(wt.includes('%ULTRON_PROBE%$ULTRON_PROBE') && !wt.includes('EXPANDIDO'), wt);
  });

  if (process.platform === 'win32') {
    await run('lanzador: shim .cmd de npm -> node + .js o el .exe; .cmd desconocido -> null', () => {
      const d = join(ROOT, 'shims');
      mkdirSync(join(d, 'node_modules', 'p', 'bin'), { recursive: true });
      writeFileSync(join(d, 'node_modules', 'p', 'bin', 'x.js'), '');
      writeFileSync(join(d, 'node_modules', 'p', 'bin', 'y.exe'), '');
      writeFileSync(join(d, 'x.cmd'), '"%_prog%"  "%dp0%\\node_modules\\p\\bin\\x.js" %*');
      writeFileSync(join(d, 'y.cmd'), '"%dp0%\\node_modules\\p\\bin\\y.exe"   %*');
      writeFileSync(join(d, 'z.cmd'), '@echo off\r\nsomething %*');
      assert.deepEqual(shimTarget(join(d, 'x.cmd')), { file: process.execPath, prefixArgs: [join(d, 'node_modules', 'p', 'bin', 'x.js')] });
      assert.deepEqual(shimTarget(join(d, 'y.cmd')), { file: join(d, 'node_modules', 'p', 'bin', 'y.exe'), prefixArgs: [] });
      assert.equal(resolveLauncher('z', { PATH: d }), null);
    });
  }
}

async function envTests() {
  await run('entorno: el motor solo ve su key; el check, ninguna', () => {
    const cfg = writeConfig('env.json', {
      version: 1, chain: ['own', 'other'], tiers: {},
      engines: {
        own: { runner: 'opencode', model: 'opencode/x', keyEnv: 'ULTRON_T_OWN_KEY_9', envMap: { ULTRON_T_MAPPED_9_API_KEY: 'ULTRON_T_OWN_KEY_9' } },
        other: { runner: 'opencode', model: 'opencode/y', keyEnv: 'ULTRON_T_OTHER_KEY_9' },
      },
    });
    const out = join(ROOT, 'env-keys.json');
    const secrets = ['ULTRON_T_OWN_KEY_9', 'ULTRON_T_OTHER_KEY_9', 'ULTRON_T_X_API_KEY', 'ULTRON_KEY_TESTSLUG', 'ULTRON_T_GH_TOKEN'];
    const leakCheck = `node -e "process.exit(${JSON.stringify(secrets).replace(/"/g, "'")}.some((k) => process.env[k]) ? 4 : 0)"`;
    const r = delegate(['run', '--engine', 'own', '--brief', BRIEF, '--check', leakCheck], 'env', {
      ULTRON_DELEGATE_CONFIG: cfg, FAKE_ENV_OUT: out, ULTRON_T_OWN_KEY_9: 'own', ULTRON_T_OTHER_KEY_9: 'other',
      ULTRON_T_X_API_KEY: 'x', ULTRON_KEY_TESTSLUG: 'y', ULTRON_T_GH_TOKEN: 'z',
    });
    assert.equal(r.code, 0, r.out);
    const seen = new Set(JSON.parse(readFileSync(out, 'utf8')).map((k) => k.toUpperCase()));
    assert.ok(seen.has('ULTRON_T_OWN_KEY_9') && seen.has('ULTRON_T_MAPPED_9_API_KEY'), 'la key propia llega');
    for (const k of secrets.slice(1)) assert.ok(!seen.has(k), `el motor ve ${k}`);
  });
}

async function logicTests() {
  await run('ruta no ASCII (año.txt) casa con --scope y no da check-fail falso', () => {
    const r = delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--check', check(0), '--scope', '*.txt'], 'unicode');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /año\.txt/);
  });

  await run('watchOpencode: solo el error final del modelo principal en stderr', () => {
    const line = (small, msg) => `timestamp=x level=ERROR message="${msg}" providerID=p small=${small} error.error="AI_RetryError: Key limit exceeded"`;
    assert.equal(watchOpencode(line('true', 'stream error'), 'stderr'), null, 'small=true no es terminal');
    assert.equal(watchOpencode(line('false', 'stream error'), 'stdout'), null, 'stdout es texto del modelo');
    assert.equal(watchOpencode('el modelo cita AI_RetryError y "stream error" small=false', 'stderr'), null);
    assert.equal(watchOpencode(line('false', 'stream error'), 'stderr'), 'quota');
    assert.equal(watchOpencode(line('false', 'stream error').replace('Key limit exceeded', 'Free usage limit reached'), 'stderr'), 'quota');
  });

  await run('vigilante: una linea de stderr partida por un chunk de stdout se detecta igual', async () => {
    const err = 'level=ERROR message=\\"stream error\\" small=false error.error=\\"AI_RetryError: Failed after 3 attempts\\"';
    const code = `process.stderr.write("${err.slice(0, 20)}");` +
      `setTimeout(()=>process.stdout.write("texto del modelo\\n"),300);setTimeout(()=>process.stderr.write("${err.slice(20)}\\n"),600);setInterval(()=>{},1000);`;
    const t0 = Date.now();
    const r = await runLogged({ file: process.execPath, args: ['-e', code] }, { cwd: ROOT, logFile: join(ROOT, 'w.log'), timeoutS: 20, env: process.env, watch: watchOpencode });
    assert.equal(r.watchHit, 'retry-exhausted');
    assert.ok(Date.now() - t0 < 10000, `tardo ${Date.now() - t0} ms`);
  });

  await run('plazo: tras exit no se mata nada ni se marca timeout aunque un nieto retenga la tuberia', async () => {
    const code = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'inherit',detached:true}).unref()";
    const r = await runLogged({ file: process.execPath, args: ['-e', code] }, { cwd: ROOT, logFile: join(ROOT, 'g.log'), timeoutS: 1, env: process.env });
    assert.equal(r.timedOut, false);
    assert.equal(r.status, 0);
  });
}

async function relayTests() {
  await run('excepcion de git en un intento -> engine-fail en el ledger y el relevo sigue', () => {
    const r = delegate(['run', '--tier', 'complex', '--brief', BRIEF, '--no-check'], 'codex:lock,*:write');
    assert.equal(r.code, 0, r.out);
    const id = idOf(r.out);
    const lines = ledgerOf(id);
    assert.deepEqual(lines.map((e) => [e.engine, e.outcome]), [['codex', 'engine-fail'], ['agy', 'ok']]);
    assert.match(lines[0].reason, /^git: /);
    assert.equal(branchExists(`delegate/${id}`), false, 'el intento roto no deja rama');
    assert.equal(delegate(['clean', id]).code, 0);
  });

  await run('--base inexistente -> exit 3 sin crear worktree', () => {
    const before = worktreeCount();
    assert.equal(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check', '--base', 'no-existe']).code, 3);
    assert.equal(worktreeCount(), before);
  });
}

async function cleanTests() {
  await run('clean de una ejecucion cortada (meta sin intentos) borra worktree y ramas huerfanas', () => {
    const id = idOf(delegate(['run', '--engine', 'codex', '--brief', BRIEF, '--no-check']).out);
    const metaFile = join(DELEG, id, 'meta.json');
    writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, 'utf8')), attempts: [], wt: null, winner: null }));
    const before = worktreeCount();
    assert.equal(delegate(['clean', id]).code, 0);
    assert.equal(branchExists(`delegate/${id}`), false, 'rama huerfana borrada');
    assert.equal(worktreeCount(), before - 1, 'worktree huerfano borrado');
  });

  await run('clean con id . o .. -> exit 3 sin borrar el directorio padre', () => {
    const sandbox = join(ROOT, 'sb');
    mkdirSync(join(sandbox, 'deleg'), { recursive: true });
    writeFileSync(join(sandbox, 'meta.json'), JSON.stringify({ id: '..', repo: ROOT, attempts: [] }));
    for (const id of ['..', '.']) assert.equal(delegate(['clean', id], 'write', { ULTRON_DELEGATE_DIR: join(sandbox, 'deleg') }).code, 3);
    assert.ok(existsSync(join(sandbox, 'meta.json')));
  });

  await run('clean con meta.json manipulado (wt fuera o rama ajena) -> exit 3 sin tocar nada', () => {
    const victim = join(ROOT, 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'dato.txt'), 'x');
    const id = 'codex-20261026-1200-abcd';
    mkdirSync(join(DELEG, id), { recursive: true });
    const meta = (a) => writeFileSync(join(DELEG, id, 'meta.json'), JSON.stringify({ id, repo: git('rev-parse', '--show-toplevel'), attempts: [a] }));
    meta({ wt: victim, branch: `delegate/${id}` });
    assert.equal(delegate(['clean', id]).code, 3);
    assert.ok(existsSync(join(victim, 'dato.txt')), 'el directorio ajeno sigue');
    meta({ wt: null, branch: 'main' });
    assert.equal(delegate(['clean', id]).code, 3);
    assert.ok(branchExists('main'));
    rmSync(join(DELEG, id), { recursive: true, force: true });
  });
}

export async function hardeningTests() {
  console.log('delegate.mjs (auditoria 2026-10-26)');
  await securityTests();
  await envTests();
  await logicTests();
  await relayTests();
  await cleanTests();
  await configTests();
  await round2Tests();
  await audit1101Tests();
}
