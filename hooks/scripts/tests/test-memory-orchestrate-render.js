#!/usr/bin/env node
// Test del hook memory-orchestrate: render del bloque imperativo de delegación y
// telemetría. Ejecutar: node hooks/scripts/tests/test-memory-orchestrate-render.js
const assert = require('node:assert');
const { render, buildLogEntry } = require('../memory-orchestrate.js');

// Caso 1: con directiva -> bloque imperativo, sin la linea advisory.
const withDirective = render({
  route: 'refactor',
  delegate_agents: [{ name: 'refactoring-specialist', score: 1.0 }],
  delegation_directive: {
    agent: 'refactoring-specialist',
    objective: 'refactoriza recall a async',
    return_format: 'Resumen <=400 tokens',
    model_hint: 'haiku',
    reason: 'intent=refactor; tarea no-trivial',
  },
});
assert.ok(withDirective.includes('<orchestration-directive'), 'falta el bloque directiva');
assert.ok(withDirective.includes('DELEGA AHORA'), 'falta la orden imperativa');
assert.ok(withDirective.includes('refactoring-specialist'), 'falta el agente');
assert.ok(withDirective.includes('subagent_type="refactoring-specialist"'), 'falta la accion Agent');
assert.ok(!withDirective.includes('delegate_to (specialist agents'), 'la directiva NO debe duplicar el advisory');

// Caso 2: sin directiva -> advisory actual intacto.
const noDirective = render({
  route: 'general',
  delegate_agents: [{ name: 'code-reviewer', score: 1.0 }],
});
assert.ok(noDirective.includes('delegate_to (specialist agents'), 'falta el advisory');
assert.ok(!noDirective.includes('<orchestration-directive'), 'no debe haber directiva');

// Caso 3: telemetría — buildLogEntry refleja la directiva emitida.
const entry = buildLogEntry(
  {
    route: 'refactor',
    delegate_agents: [{ name: 'refactoring-specialist', score: 1.0 }],
    delegation_directive: {
      agent: 'refactoring-specialist',
      objective: 'x',
      return_format: 'y',
      model_hint: 'haiku',
      reason: 'z',
    },
  },
  'refactoriza recall a async',
  'ultron',
  'sess-1',
  42,
  true
);
assert.strictEqual(entry.directive_emitted, true, 'directive_emitted debe ser true');
assert.strictEqual(entry.directive_agent, 'refactoring-specialist', 'directive_agent incorrecto');

const entryNone = buildLogEntry({ route: 'general', delegate_agents: [] }, 'hola', 'ultron', 'sess-2', 5, true);
assert.strictEqual(entryNone.directive_emitted, false, 'sin directiva -> false');
assert.strictEqual(entryNone.directive_agent, null, 'sin directiva -> agent null');

console.log('OK test-memory-orchestrate-render (3 casos)');
