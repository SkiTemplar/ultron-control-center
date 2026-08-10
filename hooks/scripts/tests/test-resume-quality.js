#!/usr/bin/env node
// hooks/scripts/tests/test-resume-quality.js
// Tests del bloque calidad-resume (2026-08-10, audit 08-09):
//   1) gate de claims numericos memorizados (isStaleMetricLine)
//   2) dedupe MULTILINGUE de project_context (jaccardCtx + dedupeContextLines)
//   3) filtro de decisiones triviales (isTrivialDecision + render)
// Cada bloque incluye caso negativo (mandamiento 7).
//
// Uso: node hooks/scripts/tests/test-resume-quality.js

'use strict';

const assert = require('assert');

const {
  render,
  dedupeContextLines,
  isStaleMetricLine,
  isTrivialDecision,
  jaccardCtx,
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
run('dedupeContextLines elimina la linea de metrica del pack', () => {
  const text = [
    'ULTRON is a project at 9.73/10 score',
    'ULTRON es una app Tauri 2 + React 19 + Rust',
  ].join('\n');
  const kept = dedupeContextLines(text);
  assert.ok(!kept.some((l) => l.includes('9.73')), `no debe quedar la metrica: ${kept}`);
  assert.ok(kept.some((l) => l.includes('Tauri')), 'la descripcion real debe quedar');
});

// ---- 2) Dedupe multilingue ------------------------------------------------
run('gemelo EN de contenido ES colapsa (el caso real del resume de hoy)', () => {
  // Las tres lineas del resume de hoy. "is a personal AI OS" es gemelo
  // multilingue de la primera -> debe colapsar. Las dos ES tienen palabras de
  // contenido DISTINTAS (sistema-personal vs proyecto-ai): fusionarlas seria
  // sobre-colapso semantico, no dedupe — se quedan.
  const text = [
    'ULTRON es un sistema personal',
    'ULTRON es un proyecto de AI',
    'ULTRON is a personal AI OS',
  ].join('\n');
  const kept = dedupeContextLines(text);
  assert.strictEqual(kept.length, 2, `esperaba 2 lineas, quedaron ${kept.length}: ${kept}`);
  assert.ok(!kept.includes('ULTRON is a personal AI OS'), `el gemelo EN debe colapsar: ${kept}`);
});
run('NEGATIVO: lineas de contenido distinto NO colapsan', () => {
  const text = [
    'ULTRON es un sistema personal de IA',
    'El AI Router usa groq como primary y gemini cloud como fallback',
  ].join('\n');
  const kept = dedupeContextLines(text);
  assert.strictEqual(kept.length, 2, `no debe sobre-colapsar: ${kept}`);
});
run('jaccardCtx cruza idiomas via canon ES->EN', () => {
  const score = jaccardCtx('ULTRON es un sistema personal', 'ULTRON is a personal system');
  assert.ok(score > 0.5, `esperaba >0.5 entre gemelos ES/EN, obtuvo ${score}`);
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

// ---- Resultado final ------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(`PASS  test-resume-quality (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-resume-quality (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
