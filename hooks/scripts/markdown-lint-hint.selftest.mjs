#!/usr/bin/env node
// hooks/scripts/markdown-lint-hint.selftest.mjs — el hook PostToolUse de
// lint de Markdown avisa con additionalContext cuando `rumdl check` encuentra
// avisos, y guarda silencio total en el resto de casos (nunca bloquea).
//
// Hermetico: rumdl se sustituye por un stub Node (MARKDOWN_LINT_HINT_RUMDL_CMD),
// asi que no depende de que `rumdl` este instalado en la maquina que corre CI.
//
// Uso: node hooks/scripts/markdown-lint-hint.selftest.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, 'markdown-lint-hint.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-lint-hint-'));

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

// Stub `rumdl`: el primer argv tras "check <fichero>" decide el comportamiento
// via el propio contenido del fichero objetivo — mas simple, cada test escribe
// el fichero de destino con un marcador (`DIRTY`/`CLEAN`) y el stub lo lee.
const STUB = path.join(ROOT, 'stub-rumdl.js');
fs.writeFileSync(
  STUB,
  `const fs = require('fs');
const target = process.argv[3];
const text = fs.readFileSync(target, 'utf8');
if (text.includes('DIRTY')) {
  process.stdout.write(
    "bad.md:3:81: [MD013] Line length 171 exceeds 80 characters\\n" +
    "bad.md:4:1: [MD032] List should be preceded by blank line [*]\\n" +
    "bad.md:5:2: [MD030] Spaces after list markers [*]\\n" +
    "bad.md:6:2: [MD018] No space after # in heading [*]\\n" +
    "bad.md:7:1: [MD022] Headings should be surrounded by blank lines [*]\\n" +
    "bad.md:8:1: [MD047] File should end with a single newline [*]\\n" +
    "\\nIssues: Found 6 issues in 1 file (5ms)\\nRun \`rumdl fmt\` to automatically fix 5 of the 6 issues\\n"
  );
  process.exit(1);
}
process.stdout.write('Success: No issues found in 1 file (4ms)\\n');
process.exit(0);
`,
);
const RUMDL_CMD = JSON.stringify([process.execPath, STUB]);

function fire(toolName, filePath, extraEnv = {}) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input:
      toolName === 'MultiEdit'
        ? { file_path: filePath, edits: [{ old_string: 'x', new_string: 'y' }] }
        : { file_path: filePath, content: 'x' },
  });
  const env = { ...process.env, HOME: ROOT, USERPROFILE: ROOT, MARKDOWN_LINT_HINT_RUMDL_CMD: RUMDL_CMD, ...extraEnv };
  const r = spawnSync(process.execPath, [HOOK], { input: payload, env, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

function writeMd(name, content) {
  const p = path.join(ROOT, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// --- POSITIVO: Write de un .md con avisos -> additionalContext con recuento + detalle ---
run('Write de .md sucio -> additionalContext con recuento y hasta 5 lineas de detalle', () => {
  const p = writeMd('capitulo.md', 'DIRTY');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0, `el hook siempre sale 0: ${r.stderr}`);
  assert.ok(r.stdout, 'debe emitir additionalContext');
  const parsed = JSON.parse(r.stdout);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx, /\[rumdl\] capitulo\.md: 6 aviso\(s\)/);
  assert.strictEqual(ctx.split('\n').length, 1 + 5, 'linea de cabecera + como mucho 5 lineas de detalle');
});

// --- POSITIVO: MultiEdit tambien lintea el fichero YA escrito en disco ---
run('MultiEdit de .md sucio tambien avisa (lintea el fichero real, no el tool_input)', () => {
  const p = writeMd('multi.md', 'DIRTY');
  const r = fire('MultiEdit', p);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /\[rumdl\]/);
});

// --- NEGATIVO: sin avisos (rumdl exit 0) -> silencio total ---
run('NEGATIVO: .md limpio (rumdl sin avisos) -> stdout VACIO', () => {
  const p = writeMd('limpio.md', 'CLEAN');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: extension no-Markdown -> silencio aunque el contenido "sucio" ---
run('NEGATIVO: extension .txt (no Markdown) -> silencio sin ni siquiera invocar rumdl', () => {
  const p = path.join(ROOT, 'nota.txt');
  fs.writeFileSync(p, 'DIRTY');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: ruta bajo cockpit/ -> silencio ---
run('NEGATIVO: ruta bajo .ultron/cockpit/ -> silencio (config interna)', () => {
  const p = writeMd(path.join('.ultron', 'cockpit', 'projects', 'x.md'), 'DIRTY');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: memoria del asistente -> silencio ---
run('NEGATIVO: .claude/projects/<id>/memory/ -> silencio (memoria del asistente)', () => {
  const p = writeMd(path.join('.claude', 'projects', 'demo', 'memory', 'MEMORY.md'), 'DIRTY');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: node_modules -> silencio ---
run('NEGATIVO: ruta bajo node_modules/ -> silencio', () => {
  const p = writeMd(path.join('node_modules', 'algo', 'README.md'), 'DIRTY');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: nombre de transcript (session id) -> silencio ---
run('NEGATIVO: Markdown nombrado como un session id (transcript) -> silencio', () => {
  const p = writeMd('a1b2c3d4-e5f6-7890-abcd-ef1234567890.md', 'DIRTY');
  const r = fire('Write', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: CLAUDE_NO_HOOKS=1 -> no-op ---
run('NEGATIVO: CLAUDE_NO_HOOKS=1 -> no-op aunque el .md este sucio', () => {
  const p = writeMd('conhooks.md', 'DIRTY');
  const r = fire('Write', p, { CLAUDE_NO_HOOKS: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: rumdl no instalado (binario inexistente) -> silencio, nunca crashea ---
run('NEGATIVO: rumdl no instalado -> silencio (ENOENT tragado)', () => {
  const p = writeMd('sinrumdl.md', 'DIRTY');
  const r = fire('Write', p, {
    MARKDOWN_LINT_HINT_RUMDL_CMD: JSON.stringify(['ultron-rumdl-que-no-existe-xyz']),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: toolName distinto de Write/Edit/MultiEdit -> silencio ---
run('NEGATIVO: tool_name=Read -> silencio (este hook solo mira escrituras)', () => {
  const p = writeMd('leido.md', 'DIRTY');
  const r = fire('Read', p);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

// --- NEGATIVO: stdin no es JSON -> no revienta ---
run('NEGATIVO: stdin que no es JSON no revienta el hook', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'esto no es json',
    env: { ...process.env, HOME: ROOT, USERPROFILE: ROOT, MARKDOWN_LINT_HINT_RUMDL_CMD: RUMDL_CMD },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual((r.stdout || '').trim(), '');
});

console.log('');
fs.rmSync(ROOT, { recursive: true, force: true });
if (failed === 0) {
  console.log(`PASS  markdown-lint-hint (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  markdown-lint-hint (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
