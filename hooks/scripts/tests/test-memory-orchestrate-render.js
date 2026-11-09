#!/usr/bin/env node
// Test del hook memory-orchestrate: render del bloque imperativo de delegación y
// telemetría. Ejecutar: node hooks/scripts/tests/test-memory-orchestrate-render.js
const assert = require('node:assert');
const { render, buildLogEntry } = require('../memory-orchestrate.js');
const { withFixturePersonality, restoreHome } = require('./fixture-personality.js');

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
assert.ok(withDirective.includes('model="claude-sonnet-5-5"'), 'la directiva traduce el alias sugerido al ID vigente');
assert.ok(!withDirective.includes('delegate_to (specialist agents'), 'la directiva NO debe duplicar el advisory');

// Caso 1b: calidad>tokens — sin model_hint, el render NO cae a haiku (default Opus 5.5).
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
assert.ok(noHint.includes('model="claude-opus-5-5"'), 'sin model_hint -> default de calidad claude-opus-5-5');
// NEGATIVO: ids viejos o prohibidos nunca salen tal cual.
const { delegateModel } = require('../memory-orchestrate.js');
for (const old of ['haiku', 'claude-opus-4-7', 'claude-opus-5', 'fable', 'opus']) {
  assert.strictEqual(delegateModel(old), 'claude-opus-5-5', `${old} -> claude-opus-5-5`);
}
assert.strictEqual(delegateModel('claude-sonnet-5'), 'claude-sonnet-5-5');
assert.strictEqual(delegateModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');

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

// Caso 5 (recorte 2026-09-29): en modo ligero el tono por defecto NO se inyecta
// (ya vive en el CLAUDE.md global); uno distinto del default si, completo.
// Hermetico: defaultTone() lee ~/.ultron/personality.json, que no se versiona
// (lo siembra la app al arrancar). En el runner del CI no existe, asi que el
// test lo lee de un HOME temporal con un catalogo minimo.
const { lightModeToneLines, defaultTone } = require('../memory-orchestrate.js');
// lightModeToneLines() tambien consulta defaultTone(), asi que el HOME del
// fixture se mantiene hasta el final del caso.
const fakeHome = withFixturePersonality();
try {
  const def = defaultTone();
  assert.ok(def && def.id === 'ultron', 'personality.json debe declarar un default_tone');
  assert.deepStrictEqual(lightModeToneLines(def), [], 'default marcado: sin linea');
  assert.deepStrictEqual(lightModeToneLines({ ...def, is_default: undefined, reason: 'explicito' }), [], 'default pedido a mano: sin linea');
  assert.deepStrictEqual(lightModeToneLines(null), [], 'sin tono: sin linea');
  // NEGATIVO: un tono no-default mantiene su directiva completa, igual que antes.
  const cani = { id: 'cani', name: 'Cani', lang: 'es', style_guide: 'q, ke, po zi', profanity: 'mild', reason: 'trigger' };
  const lineasCani = lightModeToneLines(cani);
  assert.ok(lineasCani[0].startsWith('tone_detected: Cani [cani]'), 'el tono elegido se inyecta');
  assert.ok(lineasCani.some((l) => l.startsWith('tone_directive: AMBITO')), 'con su directiva completa');
} finally {
  restoreHome(fakeHome);
}

console.log('OK test-memory-orchestrate-render (6 casos)');
