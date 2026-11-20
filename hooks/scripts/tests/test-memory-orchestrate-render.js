#!/usr/bin/env node
// Test del hook memory-orchestrate (solo modo ligero desde el 2026-11-14): que
// tono inyecta por prompt y que ULTRON_ORCHESTRATE=full ya no reactiva nada.
// Ejecutar: node hooks/scripts/tests/test-memory-orchestrate-render.js
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withFixturePersonality, restoreHome, makeFixtureHome, fixtureHomeEnv } = require('./fixture-personality.js');

// Caso 1 (recorte 2026-09-29): el tono por defecto NO se inyecta (ya vive en el
// CLAUDE.md global); uno distinto del default si, completo.
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

// Caso 2 (NEGATIVO, 2026-11-14): el modo completo esta retirado. Con
// ULTRON_ORCHESTRATE=full el hook real sigue sin emitir orchestration-context,
// directivas ni memorias, y sin llamar al daemon (termina al momento).
const home = makeFixtureHome();
try {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'memory-orchestrate.js')], {
    input: JSON.stringify({ prompt: 'refactoriza el modulo de recall y revisa la arquitectura', hook_event_name: 'UserPromptSubmit' }),
    env: { ...process.env, ...fixtureHomeEnv(home), ULTRON_ORCHESTRATE: 'full' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.strictEqual(r.status, 0, `el hook termina bien (${r.stderr})`);
  const ac = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!/<orchestration-(context|directive)/.test(ac), 'sin bloque de orquestacion aunque se pida full');
  assert.strictEqual(ac, '', 'tono por defecto y sin resumen pendiente: contexto vacio');
} finally {
  require('node:fs').rmSync(home, { recursive: true, force: true });
}

console.log('OK test-memory-orchestrate-render (2 casos)');
