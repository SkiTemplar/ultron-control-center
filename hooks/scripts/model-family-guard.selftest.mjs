#!/usr/bin/env node
// hooks/scripts/model-family-guard.selftest.mjs — el hook PreModelSwitch deja
// pasar los cambios a la familia 5.5 (Opus, Sonnet, Haiku, con o sin [1m] o
// fecha) y deniega el resto con un motivo legible. Caso negativo incluido:
// sin el hook, un cambio a claude-opus-5 o a Fable saldria sin denegar.
//
// Uso: node hooks/scripts/model-family-guard.selftest.mjs   (exit 0 = verde)

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, 'model-family-guard.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-family-guard-'));
const require = createRequire(import.meta.url);

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

function fire(payload, extraEnv = {}) {
  const { ULTRON_MODEL_GUARD: _ignored, ...base } = process.env;
  const env = { ...base, HOME: ROOT, USERPROFILE: ROOT, ULTRON_SELFTEST: '1', ...extraEnv };
  const input = typeof payload === 'string' ? payload : JSON.stringify({ hook_event_name: 'PreModelSwitch', ...payload });
  const r = spawnSync(process.execPath, [HOOK], { input, env, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

function outputOf(r) {
  assert.strictEqual(r.status, 0, `el hook siempre sale 0: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function decisionOf(r) {
  const parsed = outputOf(r);
  if (!parsed) return null;
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreModelSwitch');
  return parsed.hookSpecificOutput;
}

function post(payload) {
  return JSON.stringify({ hook_event_name: 'PostModelSwitch', ...payload });
}

const { isAllowedModel } = require('./model-family-guard.js');

run('isAllowedModel acepta la familia 5.5 y rechaza el resto', () => {
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5-20260901', 'CLAUDE-OPUS-5-5']) {
    assert.strictEqual(isAllowedModel(m), true, `deberia aceptar ${m}`);
  }
  for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-fable-1', 'claude-opus-5-50', 'gpt-6-astra', 'opus']) {
    assert.strictEqual(isAllowedModel(m), false, `deberia rechazar ${m}`);
  }
});

run('cambio a claude-sonnet-5-5 -> sin salida (sigue el flujo normal)', () => {
  const r = fire({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command' });
  assert.strictEqual(decisionOf(r), null);
});

run('cambio a claude-haiku-5-5 desde el SDK (Sessions) -> permitido', () => {
  const r = fire({ from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5-5', requested_model: 'claude-haiku-5-5', source: 'sdk' });
  assert.strictEqual(decisionOf(r), null);
});

run('NEGATIVO: cambio a claude-opus-5 -> deny con motivo que nombra la familia 5.5', () => {
  const out = decisionOf(fire({ from_model: 'claude-opus-5-5', to_model: 'claude-opus-5', requested_model: 'claude-opus-5', source: 'picker' }));
  assert.ok(out, 'debe emitir decision');
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /claude-opus-5\b/);
  assert.match(out.permissionDecisionReason, /5\.5/);
  assert.match(out.permissionDecisionReason, /ULTRON_MODEL_GUARD=0/);
});

run('NEGATIVO: cambio a un modelo Fable -> deny', () => {
  const out = decisionOf(fire({ to_model: 'claude-fable-1', requested_model: 'fable', source: 'command' }));
  assert.strictEqual(out && out.permissionDecision, 'deny');
});

run('ULTRON_MODEL_GUARD=0 desactiva el guardarrail', () => {
  const r = fire({ to_model: 'claude-opus-5', source: 'command' }, { ULTRON_MODEL_GUARD: '0' });
  assert.strictEqual(decisionOf(r), null);
});

run('sin to_model (entrada incompleta) -> no decide (fail-open)', () => {
  assert.strictEqual(decisionOf(fire({ source: 'command' })), null);
});

run('stdin ilegible -> exit 0 sin salida', () => {
  assert.strictEqual(decisionOf(fire('no es json')), null);
});

run('NEGATIVO PostModelSwitch: fallback automatico a claude-opus-5 -> aviso a usuario y modelo, sin deny', () => {
  const out = outputOf(fire(post({ from_model: 'claude-opus-5-5', to_model: 'claude-opus-5', requested_model: null, source: 'auto' })));
  assert.ok(out, 'debe avisar');
  assert.match(out.systemMessage, /claude-opus-5 \(origen: auto\)/);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostModelSwitch');
  assert.match(out.hookSpecificOutput.additionalContext, /fuera de la familia 5\.5/);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, undefined);
});

run('PostModelSwitch a claude-sonnet-5-5 (resume) -> silencio', () => {
  assert.strictEqual(outputOf(fire(post({ to_model: 'claude-sonnet-5-5', source: 'resume' }))), null);
});

run('evento ajeno con el mismo script -> no decide', () => {
  const r = fire(JSON.stringify({ hook_event_name: 'Stop', to_model: 'claude-opus-5' }));
  assert.strictEqual(outputOf(r), null);
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallo/s`);
console.log(failed === 0 ? 'SELFTEST model-family-guard: VERDE' : 'SELFTEST model-family-guard: ROJO');
process.exit(failed === 0 ? 0 : 1);
