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
    model_hint: 'sonnet',
    reason: 'intent=refactor; tarea no-trivial',
  },
});
assert.ok(withDirective.includes('<orchestration-directive'), 'falta el bloque directiva');
assert.ok(withDirective.includes('DELEGA AHORA'), 'falta la orden imperativa');
assert.ok(withDirective.includes('refactoring-specialist'), 'falta el agente');
assert.ok(withDirective.includes('subagent_type="refactoring-specialist"'), 'falta la accion Agent');
assert.ok(withDirective.includes('model="sonnet"'), 'la directiva debe propagar el modelo sugerido');
assert.ok(!withDirective.includes('delegate_to (specialist agents'), 'la directiva NO debe duplicar el advisory');

// Caso 1b: calidad>tokens — sin model_hint, el render NO cae a haiku (default sonnet).
const noHint = render({
  route: 'refactor',
  delegate_agents: [{ name: 'refactoring-specialist', score: 1.0 }],
  delegation_directive: {
    agent: 'refactoring-specialist',
    objective: 'x',
    return_format: 'y',
    reason: 'z',
  },
});
assert.ok(!noHint.includes('haiku'), 'el especialista delegado nunca debe sugerir haiku');
assert.ok(noHint.includes('model="sonnet"'), 'sin model_hint -> default de calidad sonnet');

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
      model_hint: 'sonnet',
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

// Caso 4 (ULTRON 4, 7.1): el tono por defecto es UNA linea y va fuera del bloque.
const conDefault = render({
  route: 'general',
  tone: { id: 'ultron', name: 'Ultron', lang: 'es', style_guide: 'Maquina: resultado + cifra.', is_default: true },
});
const lineasDefault = conDefault.split('\n');
assert.ok(lineasDefault[0].startsWith('tone [ultron, defecto, solo chat, es]: Maquina: resultado + cifra.'), 'la primera linea es el tono');
assert.ok(lineasDefault[1].startsWith('<orchestration-context'), 'el bloque empieza en la segunda linea');
assert.ok(!conDefault.includes('tone_directive:') && !conDefault.includes('tone_active:'), 'sin las lineas largas del default');
assert.ok(lineasDefault[0].length < 320, `la linea del tono debe ser corta (${lineasDefault[0].length})`);

// Caso 4b (NEGATIVO): un tono elegido a proposito sigue dentro del bloque, con su conviccion.
const conElegido = render({
  route: 'general',
  tone: { id: 'cani', name: 'Cani', lang: 'es', style_guide: 'q, ke, po zi', profanity: 'mild', reason: 'trigger' },
});
assert.ok(conElegido.startsWith('<orchestration-context'), 'el tono elegido no va fuera del bloque');
assert.ok(conElegido.includes('tone_detected: Cani [cani]') && conElegido.includes('tone_directive: AMBITO'), 'el tono elegido conserva su directiva completa');

console.log('OK test-memory-orchestrate-render (5 casos)');
