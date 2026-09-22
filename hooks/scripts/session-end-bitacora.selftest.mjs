#!/usr/bin/env node
// hooks/scripts/session-end-bitacora.selftest.mjs — el hook de SessionEnd
// lanza el resumidor apuntando a LA SESION QUE CIERRA, con su transcript, y
// no hace nada con una entrada sin session_id. Hermetico: el resumidor se
// sustituye por un stub que vuelca sus argumentos a un fichero.
//
// Uso: node hooks/scripts/session-end-bitacora.selftest.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, 'session-end-bitacora.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-end-bitacora-'));
const STUB = path.join(ROOT, 'stub-summarizer.js');
const ARGS_FILE = path.join(ROOT, 'args.json');
fs.writeFileSync(STUB, `require('fs').writeFileSync(${JSON.stringify(ARGS_FILE)}, JSON.stringify(process.argv.slice(2)));`);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

function fire(input, extraEnv = {}) {
  fs.rmSync(ARGS_FILE, { force: true });
  const env = {
    ...process.env,
    HOME: ROOT,
    USERPROFILE: ROOT,
    SESSION_END_BITACORA_SCRIPT: STUB,
    SESSION_END_BITACORA_SYNC: '1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `el hook siempre sale 0: ${r.stderr}`);
  return fs.existsSync(ARGS_FILE) ? JSON.parse(fs.readFileSync(ARGS_FILE, 'utf8')) : null;
}

run('lanza el resumidor con --target-session = la sesion que cierra y su transcript', () => {
  const args = fire({
    hook_event_name: 'SessionEnd',
    session_id: 'abcdef12-3456-7890-abcd-ef1234567890',
    cwd: 'C:\\proyecto\\demo',
    transcript_path: 'C:\\transcripts\\abcdef12-3456-7890-abcd-ef1234567890.jsonl',
  });
  assert.ok(args, 'el stub debe haberse ejecutado');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.strictEqual(at('--target-session'), 'abcdef12-3456-7890-abcd-ef1234567890');
  assert.strictEqual(at('--cwd'), 'C:\\proyecto\\demo');
  assert.strictEqual(at('--transcript'), 'C:\\transcripts\\abcdef12-3456-7890-abcd-ef1234567890.jsonl');
  assert.strictEqual(at('--session'), '__session_end__', 'nunca se confunde con la sesion actual del resumidor');
});

run('NEGATIVO: sin session_id (o con uno con separadores) no lanza nada', () => {
  assert.strictEqual(fire({ hook_event_name: 'SessionEnd', cwd: 'C:\\x' }), null);
  assert.strictEqual(fire({ hook_event_name: 'SessionEnd', session_id: '../otra', cwd: 'C:\\x' }), null);
  assert.strictEqual(fire({}), null);
});

run('NEGATIVO: CLAUDE_NO_HOOKS=1 y SESSION_END_BITACORA_DISABLED=1 son no-op', () => {
  const input = { session_id: 'abcdef12-3456-7890-abcd-ef1234567890', cwd: 'C:\\x' };
  assert.strictEqual(fire(input, { CLAUDE_NO_HOOKS: '1' }), null);
  assert.strictEqual(fire(input, { SESSION_END_BITACORA_DISABLED: '1' }), null);
});

run('NEGATIVO: stdin que no es JSON no revienta el hook', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'esto no es json',
    env: { ...process.env, HOME: ROOT, USERPROFILE: ROOT, SESSION_END_BITACORA_SCRIPT: STUB, SESSION_END_BITACORA_SYNC: '1' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(ARGS_FILE));
});

console.log('');
fs.rmSync(ROOT, { recursive: true, force: true });
if (failed === 0) {
  console.log(`PASS  session-end-bitacora (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  session-end-bitacora (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
