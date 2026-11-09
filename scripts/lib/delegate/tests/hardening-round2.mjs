/**
 * hardening-round2.mjs - segunda ronda de la auditoria del delegador
 * (2026-10-26): modelo que empieza por guion, vigilante de OpenCode solo con el
 * error final, saneado del entorno ampliado (con paridad frente a
 * env_keys.rs) y destinos de `envMap` en lista blanca. Cada caso falla sin su
 * arreglo. Lo ejecuta hardening.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, watchOpencode } from '../adapters.mjs';
import { ULTRON_HOME, isSafeModel } from '../config.mjs';
import { APP_KEYS, engineEnv, scrubbedEnv } from '../env.mjs';
import { runLogged } from '../proc.mjs';
import { BRIEF, CONFIG_JSON, ROOT, delegate, run, worktreeCount } from './harness.mjs';

const ocLine = (error, extra = '') =>
  `level=ERROR service=session message="stream error" providerID=p modelID=m small=false ${extra}error.error="${error}"`;

async function modelTests() {
  await run('modelo que empieza por guion (--share, -c) -> rechazado en --model y en la config', () => {
    for (const m of ['--share', '-c', '-m', '.x', '/x', '@x']) assert.equal(isSafeModel(m), false, m);
    for (const m of ['gpt-5.6-terra', 'openrouter/qwen/qwen3:free', '9b']) assert.equal(isSafeModel(m), true, m);
    const before = worktreeCount();
    for (const m of ['--share', '-c']) {
      const r = delegate(['run', '--engine', 'codex', '--model', m, '--brief', BRIEF, '--no-check']);
      assert.equal(r.code, 3, r.out);
      assert.match(r.out, /--model no valido/);
    }
    assert.equal(worktreeCount(), before);
    const cfg = join(ROOT, 'dash-model.json');
    writeFileSync(cfg, JSON.stringify({ ...CONFIG_JSON, engines: { ...CONFIG_JSON.engines, codex: { runner: 'codex', model: '-c', enabled: true } } }));
    const st = JSON.parse(delegate(['status', '--json'], 'write', { ULTRON_DELEGATE_CONFIG: cfg }).out);
    assert.equal(st.engines.find((e) => e.id === 'codex').reason, 'disabled');
  });

  await run('los cuatro adaptadores pasan el modelo pegado a la opcion (--model=<m>)', () => {
    const ctx = { id: 'x', model: 'm-1', wt: ROOT, lastFile: join(ROOT, 'l.md'), prompt: 'p', engine: {} };
    for (const [runner, a] of Object.entries(ADAPTERS)) {
      const { args } = a.command(ctx);
      assert.ok(args.includes('--model=m-1'), `${runner}: ${JSON.stringify(args)}`);
      assert.ok(!args.includes('m-1'), `${runner}: el modelo va suelto`);
    }
  });
}

async function watchTests() {
  await run('vigilante: un stream error reintentable (503, 429 aislado, high demand) no aborta', () => {
    assert.equal(watchOpencode(ocLine('AI_APICallError: Service Unavailable', 'statusCode=503 ')), null);
    assert.equal(watchOpencode(ocLine('AI_APICallError: 429 Too Many Requests')), null);
    assert.equal(watchOpencode(ocLine('This model is currently experiencing high demand')), null);
    const tpmRetry = 'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000. Please try again in 7s';
    assert.equal(watchOpencode(ocLine(tpmRetry)), null);
  });

  await run('vigilante: aborta con el error final (AI_RetryError o no reintentable)', () => {
    assert.equal(watchOpencode(ocLine('AI_RetryError: Failed after 4 attempts. Last error: Service Unavailable')), 'retry-exhausted');
    assert.equal(watchOpencode(ocLine('AI_APICallError: Payment required to access this resource.')), 'quota');
    assert.equal(watchOpencode(ocLine('AI_APICallError: insufficient balance')), 'quota');
    assert.equal(watchOpencode(ocLine('AI_APICallError: 401 Unauthorized')), 'auth');
    assert.equal(watchOpencode(ocLine('AI_APICallError: Request too large for model on tokens per minute (TPM): Limit 8000, Requested 24036')), 'too-large');
    assert.equal(watchOpencode(ocLine("AI_APICallError: This model's maximum context length is 131072 tokens")), 'context');
  });

  await run('vigilante en runLogged: un 503 no mata el proceso; termina por si solo', async () => {
    const line = ocLine('AI_APICallError: Service Unavailable', 'statusCode=503 ').replace(/"/g, '\\"');
    const code = `process.stderr.write("${line}\\n");setTimeout(()=>process.exit(0),800);`;
    const r = await runLogged({ file: process.execPath, args: ['-e', code] }, { cwd: ROOT, logFile: join(ROOT, 'w503.log'), timeoutS: 20, env: process.env, watch: watchOpencode });
    assert.deepEqual([r.watchHit, r.status], [null, 0]);
  });
}

/** ALLOWED_KEYS de env_keys.rs (solo las cadenas del array). */
function rustAllowedKeys() {
  const src = readFileSync(join(ULTRON_HOME, 'control-center', 'src-tauri', 'src', 'env_keys.rs'), 'utf8');
  const block = /ALLOWED_KEYS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'ALLOWED_KEYS no encontrado en env_keys.rs');
  const body = block[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...body.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

async function envTests() {
  await run('saneado: quita *_SECRET*, *_PASSWORD*, *_PAT, AWS_* y las keys de la app', () => {
    const base = {
      PATH: 'p', HOME: 'h', CLIENT_SECRET_ID: 's', DB_PASSWORD_FILE: 'd', GH_PAT: 'g', AWS_REGION: 'r',
      OPENALEX_MAILTO: 'a@b.c', UNPAYWALL_EMAIL: 'a@b.c',
    };
    assert.deepEqual(Object.keys(scrubbedEnv({ engines: {} }, base)).sort(), ['HOME', 'PATH']);
  });

  await run('paridad: APP_KEYS == ALLOWED_KEYS de env_keys.rs', () => {
    assert.deepEqual([...APP_KEYS].sort(), rustAllowedKeys().sort());
  });

  await run('envMap con destino NODE_OPTIONS o PATH -> motor disabled y engineEnv lanza', () => {
    for (const target of ['NODE_OPTIONS', 'PATH']) {
      const engine = { runner: 'opencode', model: 'opencode/x', envMap: { [target]: 'ULTRON_T_SRC_9' } };
      const cfg = join(ROOT, `envmap-${target}.json`);
      writeFileSync(cfg, JSON.stringify({ ...CONFIG_JSON, engines: { ...CONFIG_JSON.engines, oc: engine } }));
      const env = { ULTRON_DELEGATE_CONFIG: cfg, ULTRON_T_SRC_9: '--require=./pwn.js' };
      const st = JSON.parse(delegate(['status', '--json'], 'write', env).out);
      assert.equal(st.engines.find((e) => e.id === 'oc').reason, 'disabled', target);
      const r = delegate(['run', '--engine', 'oc', '--brief', BRIEF, '--no-check'], 'write', env);
      assert.equal(r.code, 3, r.out);
      assert.match(r.out, /envMap con destino no admitido/);
      assert.throws(() => engineEnv({ engines: { oc: engine } }, { id: 'oc', runner: 'opencode', model: 'm' }, engine), /envMap/);
    }
  });
}

export async function round2Tests() {
  console.log('delegate.mjs (auditoria 2026-10-26, ronda 2)');
  await modelTests();
  await watchTests();
  await envTests();
}
