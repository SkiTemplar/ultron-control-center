#!/usr/bin/env node
// hooks/scripts/document-convert-hint.selftest.mjs — el hook PreToolUse
// sugiere `markitdown` en Read de office/epub (siempre) y de PDF grande
// (>5MB); guarda silencio en el resto de casos (nunca bloquea el Read).
//
// Uso: node hooks/scripts/document-convert-hint.selftest.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, 'document-convert-hint.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'document-convert-hint-'));

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

function fire(filePath, extraEnv = {}) {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
  });
  const env = { ...process.env, HOME: ROOT, USERPROFILE: ROOT, ...extraEnv };
  const r = spawnSync(process.execPath, [HOOK], { input: payload, env, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

function writeFile(name, sizeBytes) {
  const p = path.join(ROOT, name);
  fs.writeFileSync(p, Buffer.alloc(sizeBytes, 'x'));
  return p;
}

// --- POSITIVO: .docx (office) siempre sugiere, sin importar el tamano ---
run('Read de .docx -> sugiere markitdown', () => {
  const p = writeFile('informe.docx', 10);
  const r = fire(p);
  assert.strictEqual(r.status, 0, `el hook siempre sale 0: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(parsed.hookSpecificOutput.additionalContext, /markitdown "/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /informe\.docx/);
});

// --- POSITIVO: .pptx, .xlsx, .epub tambien ---
for (const ext of ['.pptx', '.xlsx', '.epub']) {
  run(`Read de ${ext} -> sugiere markitdown`, () => {
    const p = writeFile(`archivo${ext}`, 5);
    const r = fire(p);
    assert.strictEqual(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /markitdown "/);
  });
}

// --- POSITIVO: .pdf de mas de 5MB -> sugiere ---
run('Read de .pdf > 5MB -> sugiere markitdown', () => {
  const p = writeFile('grande.pdf', 6 * 1024 * 1024);
  const r = fire(p);
  assert.strictEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /markitdown "/);
});

// --- NEGATIVO: .pdf pequeno -> silencio ---
run('NEGATIVO: .pdf <= 5MB -> silencio (Read ya lo maneja razonablemente)', () => {
  const p = writeFile('pequeno.pdf', 1024);
  const r = fire(p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: extension no cubierta (.md) -> silencio ---
run('NEGATIVO: .md -> silencio (no es un binario que Read no entienda)', () => {
  const p = writeFile('notas.md', 10);
  const r = fire(p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: fichero inexistente -> silencio (deja que Read falle solo) ---
run('NEGATIVO: fichero inexistente -> silencio, no revienta', () => {
  const r = fire(path.join(ROOT, 'no-existe.docx'));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: tool_name distinto de Read -> silencio ---
run('NEGATIVO: tool_name=Write -> silencio (este hook solo mira Read)', () => {
  const p = writeFile('otra.docx', 10);
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: p, content: 'x' } });
  const r = spawnSync(process.execPath, [HOOK], { input: payload, env: { ...process.env, HOME: ROOT, USERPROFILE: ROOT }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});

// --- NEGATIVO: CLAUDE_NO_HOOKS=1 -> no-op ---
run('NEGATIVO: CLAUDE_NO_HOOKS=1 -> no-op aunque sea .docx', () => {
  const p = writeFile('conhooks.docx', 10);
  const r = fire(p, { CLAUDE_NO_HOOKS: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: stdin no es JSON -> no revienta ---
run('NEGATIVO: stdin que no es JSON no revienta el hook', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'esto no es json',
    env: { ...process.env, HOME: ROOT, USERPROFILE: ROOT },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});

console.log('');
fs.rmSync(ROOT, { recursive: true, force: true });
if (failed === 0) {
  console.log(`PASS  document-convert-hint (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  document-convert-hint (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
