#!/usr/bin/env node
// hooks/scripts/tests/test-resume-quality.js
// Contrato del bloque del SessionStart tras el recorte del 2026-09-29:
//   1) solo viajan head, project, open_tasks (max. MAX_OPEN_TASKS),
//      next_action y el estado vivo del proyecto (lastSessionLines);
//   2) NEGATIVO: lo retirado (project_profile, response_meter,
//      session_feedback, codegraph, warnings del inbox, recent_decisions,
//      pinned, nota del harness) no aparece aunque el sidecar lo traiga;
//   3) la startup_policy es una frase corta y el fallo del sidecar se declara.
//
// Uso: node hooks/scripts/tests/test-resume-quality.js

'use strict';

const assert = require('assert');

const { render, MAX_OPEN_TASKS } = require('../memory-session-resume');

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

/** Respuesta del sidecar con TODO lo que el resume solia pintar. */
function fullSidecar() {
  return {
    project_id: 'ultron',
    open_tasks: Array.from({ length: 8 }, (_, i) => ({ summary: `tarea ${i}` })),
    decisions: [{ summary: 'Mem0 se descarta: la memoria la gestiona brain.db' }],
    pinned: [{ summary: 'memoria fijada' }],
    active_workflows: [{ workflow_id: 'wf-demo' }],
    next_action: 'cerrar la tarjeta X',
    warnings: ['95 memory candidate(s) await validation in the inbox'],
  };
}

const STATE_LINES = ['<project-state source="bitacoras" trust="session-summary" updated="x">', 'resumen: r', '</project-state>'];

// ---- 1) Lo que se conserva -------------------------------------------------
run('conserva head, project, open_tasks, next_action y el estado del proyecto, en ese orden', () => {
  const out = render(fullSidecar(), { head: 'main @ abc1234 -- feat: x', lastSessionLines: STATE_LINES });
  const order = ['head: main @ abc1234', 'project: ultron', 'open_tasks:', 'next_action: cerrar la tarjeta X', '<project-state'];
  let prev = -1;
  for (const marker of order) {
    const i = out.indexOf(marker);
    assert.ok(i > prev, `${marker} falta o esta fuera de orden`);
    prev = i;
  }
  assert.ok(out.startsWith('<ultron-memory-resume') && out.endsWith('</ultron-memory-resume>'));
});
run(`open_tasks se corta en ${MAX_OPEN_TASKS}`, () => {
  const out = render(fullSidecar(), {});
  assert.strictEqual(MAX_OPEN_TASKS, 4);
  assert.strictEqual((out.match(/^ {2}- tarea \d$/gm) || []).length, MAX_OPEN_TASKS);
  assert.ok(out.includes('tarea 3') && !out.includes('tarea 4'), 'se quedan las primeras');
});

// ---- 2) NEGATIVO: lo retirado no vuelve -----------------------------------
run('NEGATIVO: sin recent_decisions, pinned, active_workflows ni warnings del inbox', () => {
  const out = render(fullSidecar(), {});
  for (const gone of ['recent_decisions', 'pinned_memories', 'active_workflows', 'warnings:', 'await validation', 'Mem0 se descarta']) {
    assert.ok(!out.includes(gone), `no debe aparecer "${gone}"`);
  }
});
run('NEGATIVO: opciones retiradas (perfil, feedback, medidor, codegraph, harness) se ignoran', () => {
  const out = render(fullSidecar(), {
    harnessNote: 'harness (medidor honesto): all_cats_pass=FAIL',
    feedbackLines: ['session_feedback (ultimas 20 sesiones de proyecto): si 0 %'],
    meterLine: 'response_meter (ultimas 3 sesiones): media 23,4 lineas',
    codegraphLines: ['codegraph (indice .codegraph: 5 ficheros):', '  zonas: src (70)'],
  });
  for (const gone of ['harness (', 'session_feedback', 'response_meter', 'codegraph (', 'project_profile']) {
    assert.ok(!out.includes(gone), `no debe aparecer "${gone}"`);
  }
});

// ---- 3) Politica de arranque y degradacion --------------------------------
run('startup_policy cabe en una frase corta', () => {
  const line = render({}, {}).split('\n').find((l) => l.startsWith('startup_policy:'));
  assert.ok(line, 'la politica sigue presente');
  assert.ok(line.length <= 120, `demasiado larga (${line.length})`);
});
run('sidecar caido: se declara DEGRADED; sano: no', () => {
  assert.ok(render(null, { degraded: true }).includes('DEGRADED'));
  assert.ok(!render(fullSidecar(), {}).includes('DEGRADED'));
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
