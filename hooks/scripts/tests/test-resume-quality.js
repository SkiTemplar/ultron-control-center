#!/usr/bin/env node
// hooks/scripts/tests/test-resume-quality.js
// Tests del bloque calidad-resume (2026-08-10, audit 08-09; perfil 2026-09-03):
//   1) gate de claims numericos memorizados (isStaleMetricLine)
//   2) bloque project_profile (renderProfileLines + render): procedencia, aviso
//      de HEAD anterior, filtros de metrica/trivialidad, ausencia limpia
//   3) filtro de decisiones triviales (isTrivialDecision + render)
// Cada bloque incluye caso negativo (mandamiento 7).
//
// Uso: node hooks/scripts/tests/test-resume-quality.js

'use strict';

const assert = require('assert');

const {
  render,
  renderProfileLines,
  isStaleMetricLine,
  isTrivialDecision,
} = require('../memory-session-resume');

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ---- 1) Gate de claims numericos -----------------------------------------
run('metrica memorizada X/10 se filtra', () => {
  assert.strictEqual(isStaleMetricLine('ULTRON is a project at 9.73/10 score'), true);
});
run('recall memorizado se filtra', () => {
  assert.strictEqual(isStaleMetricLine('recall@8=0.823 medido ayer'), true);
});
run('nota numerica se filtra', () => {
  assert.strictEqual(isStaleMetricLine('la nota 9.31 del harness'), true);
});
run('NEGATIVO: descripcion sin metrica NO se filtra', () => {
  assert.strictEqual(isStaleMetricLine('ULTRON es una app Tauri 2 + React 19'), false);
  assert.strictEqual(isStaleMetricLine('Qdrant nativo en D:/Ultron para recall denso'), false);
});
// ---- 2) Bloque project_profile --------------------------------------------
const PERFIL = {
  version: 1,
  project: 'tortunabo',
  generated_at: '2026-09-03T18:00:00.000Z',
  head: { branch: 'main', sha: 'abc1234' },
  source: 'llm',
  profile: {
    que_es: 'Juego cooperativo multijugador (1-4) en tercera persona, entrega academica.',
    stack: 'Unreal Engine 5.6, C++ y Blueprints, Steam Sockets.',
    arquitectura: 'Modulo Tortunabo con GameInstance propio y replicacion por servidor.',
    estado: 'Fase 2 cerrada; pendiente el playtest PIE 4P.',
    decisiones_clave: [
      'Steam Sockets en vez de LAN para el multijugador',
      'Se utiliza cargo fmt para mantener la consistencia',
      'Recall memorizado 0.823 recall@8=0.823',
      'Ragdoll de muerte replicado por snapshot',
    ],
  },
};
run('el perfil se renderiza con procedencia y todos los campos', () => {
  const lines = renderProfileLines(PERFIL, 'abc1234');
  assert.ok(lines[0].startsWith('project_profile (perfil del proyecto, generado 2026-09-03 por llm, head abc1234)'), lines[0]);
  assert.ok(!lines[0].includes('HEAD anterior'), 'mismo HEAD: sin aviso');
  assert.ok(lines.some((l) => l.startsWith('  que_es: Juego cooperativo')), 'que_es');
  assert.ok(lines.some((l) => l.startsWith('  stack: Unreal')), 'stack');
  assert.ok(lines.some((l) => l.startsWith('  arquitectura: Modulo')), 'arquitectura');
  assert.ok(lines.some((l) => l.startsWith('  estado: Fase 2')), 'estado');
});
run('HEAD distinto al actual -> aviso de perfil de un HEAD anterior', () => {
  const lines = renderProfileLines(PERFIL, 'ffff000');
  assert.ok(lines[0].includes('de un HEAD anterior'), lines[0]);
});
run('decisiones_clave filtra higiene y metricas, conserva las estructurales', () => {
  const lines = renderProfileLines(PERFIL, 'abc1234');
  const decisiones = lines.filter((l) => l.startsWith('    - '));
  assert.strictEqual(decisiones.length, 2, `esperaba 2, hubo ${decisiones.length}: ${decisiones}`);
  assert.ok(decisiones.some((d) => d.includes('Steam Sockets')));
  assert.ok(decisiones.some((d) => d.includes('Ragdoll')));
  assert.ok(!decisiones.some((d) => d.includes('cargo fmt')), 'la higiene no se cuela');
  assert.ok(!decisiones.some((d) => d.includes('0.823')), 'la metrica no se cuela');
});
run('NEGATIVO: sin perfil o sin que_es no hay bloque', () => {
  assert.deepStrictEqual(renderProfileLines(null, 'abc'), []);
  assert.deepStrictEqual(renderProfileLines({ profile: { que_es: '   ' } }, 'abc'), []);
  const r = { project_id: 'x', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  assert.ok(!render(r, null).includes('project_profile'), 'render sin perfil no pinta la seccion');
});
run('render integra el perfil al final del bloque', () => {
  const r = { project_id: 'tortunabo', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: 'playtest', warnings: [] };
  const out = render(r, PERFIL, { headSha: 'abc1234' });
  const idx = out.indexOf('project_profile');
  assert.ok(idx > out.indexOf('next_action'), 'el perfil va despues del next_action');
  assert.ok(out.endsWith('</ultron-memory-resume>'));
});

// ---- 3) Filtro de decisiones triviales -----------------------------------
run('higiene de tooling NO es decision (cargo fmt/test, gitignore, git)', () => {
  assert.strictEqual(isTrivialDecision('Se utiliza cargo fmt para mantener la consistencia en el codigo'), true);
  assert.strictEqual(isTrivialDecision('Se utilizaron pruebas automatizadas con cargo test y clippy para garantizar la calidad y la estabilidad'), true);
  assert.strictEqual(isTrivialDecision('Se agrego una regla a .gitignore para evitar subir kanbans personales'), true);
  assert.strictEqual(isTrivialDecision('El usuario ha decidido utilizar Git para el control de versiones de sus scripts'), true);
});
run('dominio ajeno NO es decision del proyecto (precios plan Tienda)', () => {
  assert.strictEqual(isTrivialDecision('El plan Tienda ofrece 6 horas de actualizaciones al mes por 40 EUR/mes'), true);
});
run('NEGATIVO: decision real de arquitectura SI pasa', () => {
  assert.strictEqual(isTrivialDecision('Mem0 se descarta: la memoria la gestiona brain.db + Qdrant nativo'), false);
  assert.strictEqual(isTrivialDecision('El AI Router arranca las zonas de codigo por CLI (codex-cli)'), false);
});
run('render omite recent_decisions cuando todas son triviales', () => {
  const r = {
    project_id: 'ultron',
    decisions: [
      { summary: 'Se utiliza cargo fmt para mantener la consistencia' },
      { summary: 'El plan Tienda cuesta 40 EUR/mes' },
    ],
    open_tasks: [],
    pinned: [],
    active_workflows: [],
    pending_candidates: 0,
    next_action: null,
    warnings: [],
  };
  const out = render(r, '');
  assert.ok(!out.includes('recent_decisions'), `no debe haber seccion: ${out}`);
});
run('NEGATIVO: render conserva las decisiones con sustancia', () => {
  const r = {
    project_id: 'ultron',
    decisions: [
      { summary: 'Se utiliza cargo fmt para mantener la consistencia' },
      { summary: 'Qdrant nativo sustituye a Mem0 como recall denso' },
    ],
    open_tasks: [],
    pinned: [],
    active_workflows: [],
    pending_candidates: 0,
    next_action: null,
    warnings: [],
  };
  const out = render(r, '');
  assert.ok(out.includes('recent_decisions'), 'debe haber seccion');
  assert.ok(out.includes('Qdrant nativo sustituye'), 'la decision real debe quedar');
  assert.ok(!out.includes('cargo fmt'), 'la trivial no debe colarse');
});

// ---- 4) Lineas de feedback de sesion (ULTRON 4, 12.1) -------------------
run('render inyecta las lineas de feedback antes del cierre', () => {
  const r = { project_id: 'laundry', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  const out = render(r, null, { feedbackLines: ['feedback_pendiente: PREGUNTA al usuario', 'session_feedback (ultimas 5 sesiones de proyecto): si 80 %'] });
  const i1 = out.indexOf('feedback_pendiente');
  const i2 = out.indexOf('session_feedback (ultimas');
  const fin = out.indexOf('</ultron-memory-resume>');
  assert.ok(i1 > 0 && i2 > i1 && fin > i2, 'las dos lineas van dentro del bloque, en orden');
});
run('NEGATIVO: sin feedbackLines el resume no menciona feedback', () => {
  const r = { project_id: 'laundry', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  const out = render(r, null, {});
  assert.ok(!out.includes('feedback_pendiente') && !out.includes('session_feedback'), 'nada de feedback');
});

run('render inyecta la linea del response_meter (4.2)', () => {
  const r = { project_id: 'laundry', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  const out = render(r, null, { meterLine: 'response_meter (ultimas 3 sesiones, 7 respuestas): media 3,9 lineas' });
  assert.ok(out.indexOf('response_meter') > 0 && out.indexOf('response_meter') < out.indexOf('</ultron-memory-resume>'), 'la linea va dentro del bloque');
});
run('NEGATIVO: sin meterLine no aparece response_meter', () => {
  const r = { project_id: 'laundry', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  assert.ok(!render(r, null, {}).includes('response_meter'), 'nada de medidor');
});

run('render inyecta el bloque codegraph (8.1) antes del cierre', () => {
  const r = { project_id: 'laundry', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  const out = render(r, null, { codegraphLines: ['codegraph (indice .codegraph: 5 ficheros, 10 simbolos, 14 aristas):', '  zonas: src/memory (70)'] });
  const i = out.indexOf('codegraph (indice');
  assert.ok(i > 0 && i < out.indexOf('</ultron-memory-resume>') && out.includes('  zonas: src/memory (70)'), 'bloque codegraph dentro del resume');
});
run('NEGATIVO: sin codegraphLines no aparece el bloque', () => {
  const r = { project_id: 'laundry', decisions: [], open_tasks: [], pinned: [], active_workflows: [], pending_candidates: 0, next_action: null, warnings: [] };
  assert.ok(!render(r, null, {}).includes('codegraph ('), 'nada de codegraph');
});

// ---- Resultado final ------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(`PASS  test-resume-quality (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-resume-quality (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
