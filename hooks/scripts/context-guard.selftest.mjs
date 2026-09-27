#!/usr/bin/env node
/**
 * context-guard.selftest.mjs — hook UserPromptSubmit context-guard.js.
 * Hermetico: estado, log y bitacoras en un directorio temporal; la LLM
 * secundaria se sustituye por un stub que cuenta llamadas (en proceso) o por
 * un endpoint cerrado (en el caso end-to-end), nunca Groq/Gemini de verdad.
 *
 * Uso: node hooks/scripts/context-guard.selftest.mjs   (exit 0 = verde)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK = join(__dirname, 'context-guard.js');
const ROOT = mkdtempSync(join(tmpdir(), 'context-guard-'));
process.env.ULTRON_CONTEXT_GUARD_STATE_DIR = join(ROOT, 'state');
process.env.ULTRON_CONTEXT_GUARD_LOG = join(ROOT, 'context-guard.jsonl');
process.env.LAST_SESSION_PROJECTS_DIR = join(ROOT, 'cockpit-projects');
delete process.env.ULTRON_CONTEXT_GUARD;
delete process.env.CLAUDE_NO_HOOKS;

const guard = require(HOOK);
const { currentContextTokens } = require(join(__dirname, 'lib', 'context-size.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

let n = 0;
/** Transcript con un prompt y un assistant cuyo usage suma `tokens`. */
function transcript(tokens, { extra = [] } = {}) {
  const file = join(ROOT, `t-${n++}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: 'arregla el parser de fechas' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\repo\\src\\fechas.js' } }],
        usage: { input_tokens: 10, cache_read_input_tokens: tokens - 1010, cache_creation_input_tokens: 1000, output_tokens: 50 },
      },
    },
    ...extra,
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** Stub de la LLM secundaria: cuenta llamadas y devuelve `reply`. */
function stub(reply) {
  const s = async () => {
    s.calls++;
    return reply;
  };
  s.calls = 0;
  return s;
}
const OK = (compact, focus = 'conserva el parser de fechas') => ({ ok: true, json: { compact, reason: 'motivo de prueba', focus }, provider: 'stub', model: 'stub', ms: 1 });
const DOWN = { ok: false, error: 'groq/x: HTTP 503', ms: 5 };
const input = (sid, file, prompt = 'sigue con los tests') => ({ session_id: sid, transcript_path: file, prompt, cwd: 'C:\\repo' });

await run('por debajo de 200k: silencio y NO llama a la LLM', async () => {
  const llm = stub(OK(true));
  const out = await guard.decide(input('s-bajo', transcript(150_000)), { llm });
  assert.equal(out, null);
  assert.equal(llm.calls, 0);
});

await run('por debajo de 200k (proceso real): sin salida, exit 0 y rapido', async () => {
  const file = transcript(120_000);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input('s-e2e-bajo', file)), encoding: 'utf8', env: process.env });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  console.log(`        (proceso completo: ${ms} ms, incluye arranque de node)`);
  assert.ok(ms < 1500, `demasiado lento: ${ms} ms`);
});

await run('LLM caida a 300k: aviso SIN bloquear', async () => {
  const llm = stub(DOWN);
  const out = await guard.decide(input('s-caida', transcript(300_000)), { llm });
  assert.equal(llm.calls, 1);
  assert.equal(out.decision, undefined, 'nunca bloquear por un fallo propio');
  assert.match(out.systemMessage, /300k/);
  assert.match(out.systemMessage, /evaluador no disponible/);
});

await run('LLM caida (proceso real, endpoint cerrado): aviso sin bloquear', async () => {
  const file = transcript(300_000);
  const env = {
    ...process.env,
    SECONDARY_LLM_ENDPOINT: 'http://127.0.0.1:9/v1/chat/completions',
    GROQ_API_KEY: 'test-key', GEMINI_API_KEY: 'test-key',
    ULTRON_CONTEXT_GUARD_LLM_MS: '3000',
  };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input('s-e2e-caida', file)), encoding: 'utf8', env, timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /evaluador no disponible/);
  const log = readFileSync(process.env.ULTRON_CONTEXT_GUARD_LOG, 'utf8');
  assert.ok(!log.includes('test-key'), 'la clave nunca llega al log');
});

await run('compact=true a 300k: bloquea con /compact <focus> y guarda el prompt', async () => {
  const llm = stub(OK(true, 'conserva el parser de fechas y los tests pendientes'));
  const out = await guard.decide(input('s-block', transcript(300_000), 'prompt que no debe perderse'), { llm });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /300k/);
  assert.match(out.reason, /\/compact conserva el parser de fechas y los tests pendientes/);
  const dir = join(process.env.ULTRON_CONTEXT_GUARD_STATE_DIR, 'blocked');
  const saved = readdirSync(dir).filter((f) => f.startsWith('s-block-'));
  assert.equal(saved.length, 1);
  assert.equal(readFileSync(join(dir, saved[0]), 'utf8'), 'prompt que no debe perderse');
});

await run('cache: no re-evalua hasta que el contexto crece 40k', async () => {
  const llm = stub(OK(false));
  await guard.decide(input('s-cache', transcript(300_000)), { llm });
  const out2 = await guard.decide(input('s-cache', transcript(339_000)), { llm });
  assert.equal(llm.calls, 1, '+39k: veredicto cacheado');
  assert.match(out2.systemMessage, /no hace falta compactar/);
  await guard.decide(input('s-cache', transcript(340_000)), { llm });
  assert.equal(llm.calls, 2, '+40k: se re-evalua');
});

await run('NEGATIVO: si el contexto BAJA (hubo /compact) el veredicto viejo no vale', async () => {
  const llm = stub(OK(true));
  await guard.decide(input('s-baja', transcript(450_000)), { llm });
  const llm2 = stub(OK(false));
  const out = await guard.decide(input('s-baja', transcript(250_000)), { llm: llm2 });
  assert.equal(llm2.calls, 1);
  assert.equal(out.decision, undefined);
});

await run('a 500k bloquea siempre, aunque la LLM diga que no', async () => {
  const llm = stub(OK(false, 'foco de la llm'));
  const out = await guard.decide(input('s-500', transcript(500_000)), { llm });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /\/compact foco de la llm/);
});

await run('a 500k con la LLM caida: bloquea igual con un foco por defecto', async () => {
  const out = await guard.decide(input('s-500-caida', transcript(520_000)), { llm: stub(DOWN) });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /\/compact conserva la tarea en curso/);
});

await run('cruzar 500k invalida el veredicto cacheado (su foco no servia para compactar)', async () => {
  const llm = stub(OK(false));
  await guard.decide(input('s-cruce', transcript(480_000)), { llm });
  const llm2 = stub(OK(true, 'foco obligatorio'));
  const out = await guard.decide(input('s-cruce', transcript(505_000)), { llm: llm2 });
  assert.equal(llm2.calls, 1, '+25k pero cruzando 500k: se re-evalua');
  assert.match(out.reason, /\/compact foco obligatorio/);
});

await run('proceso real con LLM que responde (servidor local falso): bloquea y sale con 0 sin abortar', async () => {
  const server = join(ROOT, 'fake-llm.cjs');
  const portFile = join(ROOT, 'fake-llm.port');
  writeFileSync(server, `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ compact: true, reason: 'tarea cerrada', focus: 'conserva los pendientes' }) } }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => require('fs').writeFileSync(${JSON.stringify(portFile)}, String(srv.address().port)));
    setTimeout(() => process.exit(0), 20000);
  `);
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [server], { stdio: 'ignore' });
  try {
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const deadline = Date.now() + 5000;
    while (!existsSync(portFile) && Date.now() < deadline) sleep(20);
    const port = readFileSync(portFile, 'utf8');
    const env = { ...process.env, SECONDARY_LLM_ENDPOINT: `http://127.0.0.1:${port}/v1/chat/completions`, GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k' };
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input('s-e2e-ok', transcript(300_000))), encoding: 'utf8', env, timeout: 15000 });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(!/Assertion failed/.test(r.stderr), r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /tarea cerrada/);
    assert.match(out.reason, /\/compact conserva los pendientes/);
  } finally {
    child.kill();
  }
});

await run('forzar: deja pasar y silencia el bloqueo hasta +40k', async () => {
  const llm = stub(OK(true));
  const f = await guard.decide(input('s-force', transcript(300_000), 'forzar: manda esto'), { llm });
  assert.equal(f.decision, undefined);
  const next = await guard.decide(input('s-force', transcript(310_000)), { llm });
  assert.equal(next.decision, undefined, 'dentro de +40k tras forzar:: solo aviso');
  const later = await guard.decide(input('s-force', transcript(345_000)), { llm });
  assert.equal(later.decision, 'block', 'pasados +40k vuelve a bloquear');
});

await run('ULTRON_CONTEXT_GUARD=0 apaga el hook', async () => {
  process.env.ULTRON_CONTEXT_GUARD = '0';
  try {
    const llm = stub(OK(true));
    assert.equal(await guard.decide(input('s-off', transcript(600_000)), { llm }), null);
    assert.equal(llm.calls, 0);
  } finally {
    delete process.env.ULTRON_CONTEXT_GUARD;
  }
});

await run('compact_boundary posterior al ultimo usage: manda postTokens (silencio tras /compact)', async () => {
  const file = transcript(900_000, {
    extra: [{ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 900_000, postTokens: 45_000 } }],
  });
  assert.deepEqual(currentContextTokens(file), { tokens: 45_000, source: 'compact' });
  const llm = stub(OK(true));
  assert.equal(await guard.decide(input('s-compactado', file), { llm }), null);
});

await run('usage fuera de la cola de 256 KB (tool_result enorme al final): se amplia y se encuentra', async () => {
  const big = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(600 * 1024) }] } };
  const file = transcript(260_000, { extra: [big] });
  assert.deepEqual(currentContextTokens(file), { tokens: 260_000, source: 'usage' });
});

await run('NEGATIVO: mensajes <synthetic> (limite/errores, usage a 0) no cuentan', async () => {
  const synth = { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'limit' }], usage: { input_tokens: 0 } } };
  const file = transcript(230_000, { extra: [synth] });
  assert.equal(currentContextTokens(file).tokens, 230_000);
});

await run('la entrada a la LLM incluye la bitacora de la sesion, los prompts y los ficheros', async () => {
  const sd = join(process.env.LAST_SESSION_PROJECTS_DIR, 'demo', 'sessions', 's-bitacora');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'summary.md'), '## Temas\n- migracion del parser\n');
  let seen = '';
  const llm = async ({ user }) => {
    seen = user;
    return OK(false);
  };
  await guard.decide(input('s-bitacora', transcript(300_000), 'prompt nuevo'), { llm });
  assert.match(seen, /migracion del parser/);
  assert.match(seen, /arregla el parser de fechas/);
  assert.match(seen, /fechas\.js/);
  assert.match(seen, /Edit x1|Editx1/);
});

console.log('');
rmSync(ROOT, { recursive: true, force: true });
if (failed === 0) {
  console.log(`PASS  context-guard (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  context-guard (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
