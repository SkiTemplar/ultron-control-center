#!/usr/bin/env node
// hooks/scripts/codegraph-first.selftest.mjs — el hook PreToolUse deniega una
// sola vez la segunda llamada de exploracion (Grep, Glob o Read de codigo) sin
// CodeGraph previo, solo dentro de un proyecto con indice, y nunca bloquea si
// ya se uso CodeGraph, fuera de un proyecto indexado o con el opt-out.
//
// Uso: node hooks/scripts/codegraph-first.selftest.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, 'codegraph-first.js');
const { classifyTool, decide } = createRequire(import.meta.url)(HOOK);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-first-'));
const TMP = path.join(ROOT, 'tmp');
const INDEXED = path.join(ROOT, 'proyecto');
const PLAIN = path.join(ROOT, 'sin-indice');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(path.join(INDEXED, '.codegraph'), { recursive: true });
fs.writeFileSync(path.join(INDEXED, '.codegraph', 'codegraph.db'), '');
fs.mkdirSync(path.join(INDEXED, 'src', 'deep'), { recursive: true });
fs.mkdirSync(PLAIN, { recursive: true });

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

let seq = 0;
function fire(session, toolName, toolInput, { cwd = INDEXED, agentId, env = {} } = {}) {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: session,
    ...(agentId ? { agent_id: agentId } : {}),
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
  });
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    // HOME = raiz del fixture: la busqueda del indice se para ahi y no llega al
    // ~/.codegraph global de quien ejecuta (con --fake-home daba un falso deny).
    env: {
      ...process.env,
      HOME: ROOT,
      USERPROFILE: ROOT,
      TMP,
      TEMP: TMP,
      TMPDIR: TMP,
      ULTRON_CODEGRAPH_FIRST: '',
      CLAUDE_NO_HOOKS: '',
      ...env,
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
}
const sid = () => `s${++seq}`;
const grep = { pattern: 'foo' };
const readCode = { file_path: path.join(INDEXED, 'src', 'a.rs') };

run('clasifica: Grep/Glob y Read de codigo cuentan; Read de .md no; codegraph aparte', () => {
  assert.equal(classifyTool('Grep', {}), 'explore');
  assert.equal(classifyTool('Glob', {}), 'explore');
  assert.equal(classifyTool('Read', { file_path: 'x/y.tsx' }), 'explore');
  assert.equal(classifyTool('Read', { file_path: 'x/README.md' }), null);
  assert.equal(classifyTool('Bash', {}), null);
  assert.equal(classifyTool('mcp__codegraph__codegraph_explore', {}), 'codegraph');
});

run('decide es pura y no muta el estado previo', () => {
  const prev = { explore: 1, usedCg: false, denied: false };
  const r = decide(prev, 'explore');
  assert.equal(r.deny, true);
  assert.deepEqual(prev, { explore: 1, usedCg: false, denied: false });
});

run('negativo: la segunda exploracion sin CodeGraph se deniega', () => {
  const s = sid();
  assert.equal(fire(s, 'Grep', grep), 'allow');
  assert.equal(fire(s, 'Read', readCode), 'deny');
});

run('la denegacion sale una sola vez: la tercera pasa', () => {
  const s = sid();
  fire(s, 'Grep', grep);
  assert.equal(fire(s, 'Grep', grep), 'deny');
  assert.equal(fire(s, 'Grep', grep), 'allow');
  assert.equal(fire(s, 'Glob', { pattern: '*.rs' }), 'allow');
});

run('con CodeGraph usado antes no se deniega nunca', () => {
  const s = sid();
  assert.equal(fire(s, 'mcp__codegraph__codegraph_explore', { query: 'x' }), 'allow');
  for (let i = 0; i < 4; i++) assert.equal(fire(s, 'Grep', grep), 'allow');
});

run('subdirectorio de un proyecto indexado tambien cuenta', () => {
  const s = sid();
  const cwd = path.join(INDEXED, 'src', 'deep');
  fire(s, 'Grep', grep, { cwd });
  assert.equal(fire(s, 'Grep', grep, { cwd }), 'deny');
});

run('fuera de un proyecto con indice: silencio', () => {
  const s = sid();
  for (let i = 0; i < 4; i++) assert.equal(fire(s, 'Grep', grep, { cwd: PLAIN }), 'allow');
});

run('cada subagente tiene su propio contador', () => {
  const s = sid();
  fire(s, 'Grep', grep);
  assert.equal(fire(s, 'Grep', grep), 'deny');
  assert.equal(fire(s, 'Grep', grep, { agentId: 'sub1' }), 'allow');
  assert.equal(fire(s, 'Grep', grep, { agentId: 'sub1' }), 'deny');
});

run('Read de un .md no cuenta como exploracion', () => {
  const s = sid();
  fire(s, 'Grep', grep);
  assert.equal(fire(s, 'Read', { file_path: path.join(INDEXED, 'README.md') }), 'allow');
});

run('opt-out ULTRON_CODEGRAPH_FIRST=0 y CLAUDE_NO_HOOKS=1', () => {
  for (const env of [{ ULTRON_CODEGRAPH_FIRST: '0' }, { CLAUDE_NO_HOOKS: '1' }]) {
    const s = sid();
    for (let i = 0; i < 3; i++) assert.equal(fire(s, 'Grep', grep, { env }), 'allow');
  }
});

run('stdin ilegible: exit 0 sin salida (fail-open)', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: '{no json', encoding: 'utf8', env: { ...process.env, TMP, TEMP: TMP } });
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), '');
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallos`);
process.exitCode = failed ? 1 : 0;
