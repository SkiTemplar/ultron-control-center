#!/usr/bin/env node
// hooks/scripts/tests/test-session-digest.js
// lib/session-digest.js: filtros de "prompt real" del usuario, extraccion de
// texto del asistente y el tope de caracteres del digest (recorte por el
// medio conservando SIEMPRE los prompts del usuario). Cada bloque incluye
// caso negativo (mandamiento 7).
//
// Uso: node hooks/scripts/tests/test-session-digest.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readTranscriptEntries,
  extractUserPrompts,
  extractAssistantTexts,
  sessionTimeRange,
  buildDigest,
} = require('../lib/session-digest');

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

function userEntry(text, extra = {}) {
  return { type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-10T10:00:00.000Z', ...extra };
}

function assistantEntry(text, ts = '2026-09-10T10:00:01.000Z') {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: ts,
  };
}

// ---- 1) extractUserPrompts: filtros de "prompt real" ----------------------
run('conserva un prompt humano normal', () => {
  const out = extractUserPrompts([userEntry('Que hay de nuevo en claude?')]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, 'Que hay de nuevo en claude?');
});
run('excluye isMeta (inyeccion de skill, no algo que el usuario escribio)', () => {
  const out = extractUserPrompts([userEntry('Base directory for this skill: ...', { isMeta: true })]);
  assert.strictEqual(out.length, 0);
});
run('excluye tool_result (no es un prompt, es salida de herramienta)', () => {
  const e = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', is_error: false }] } };
  assert.strictEqual(extractUserPrompts([e]).length, 0);
});
run('excluye isSidechain (turno de un subagente Task, no del usuario)', () => {
  const out = extractUserPrompts([userEntry('objetivo delegado al subagente', { isSidechain: true })]);
  assert.strictEqual(out.length, 0);
});
run('NEGATIVO: excluye isSidechain tambien del texto del asistente y del digest combinado', () => {
  const e = {
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'respuesta del subagente' }] },
  };
  assert.strictEqual(extractAssistantTexts([e]).length, 0);
  const mixed = [userEntry('prompt real del usuario'), e, userEntry('delegado', { isSidechain: true })];
  const digestOut = buildDigest(mixed, { maxChars: 1000 });
  assert.ok(digestOut.includes('prompt real del usuario'), 'el prompt real se conserva');
  assert.ok(!digestOut.includes('subagente') && !digestOut.includes('delegado'), 'nada del sidechain entra en el digest');
});
run('excluye turnos de sistema (<system-reminder>, <task-notification>)', () => {
  const out = extractUserPrompts([
    userEntry('<system-reminder>\ncontexto de sistema\n</system-reminder>'),
    userEntry('<task-notification>tarea en background</task-notification>'),
  ]);
  assert.strictEqual(out.length, 0);
});
run('excluye [Request interrupted y <local-command-stdout>', () => {
  const out = extractUserPrompts([
    userEntry('[Request interrupted by user]'),
    userEntry('<local-command-stdout>salida</local-command-stdout>'),
  ]);
  assert.strictEqual(out.length, 0);
});
run('NEGATIVO: entrada vacia o sin contenido no cuenta como prompt', () => {
  assert.strictEqual(extractUserPrompts([]).length, 0);
  assert.strictEqual(extractUserPrompts([userEntry('   ')]).length, 0);
  assert.strictEqual(extractUserPrompts([{ type: 'assistant' }]).length, 0);
});
run('conserva el orden cronologico de varios prompts reales', () => {
  const out = extractUserPrompts([userEntry('uno'), userEntry('dos'), userEntry('tres')]);
  assert.deepStrictEqual(out.map((p) => p.text), ['uno', 'dos', 'tres']);
});

// ---- 2) extractAssistantTexts ----------------------------------------------
run('extrae solo bloques de texto del asistente (sin thinking/tool_use)', () => {
  const e = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'razonamiento interno' },
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'text', text: 'Aqui esta la respuesta.' },
      ],
    },
  };
  const out = extractAssistantTexts([e]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, 'Aqui esta la respuesta.');
});
run('NEGATIVO: turno del asistente sin bloques de texto no aporta nada', () => {
  const e = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } };
  assert.strictEqual(extractAssistantTexts([e]).length, 0);
});

// ---- 3) sessionTimeRange ----------------------------------------------------
run('calcula el rango de fechas de las entradas con timestamp', () => {
  const range = sessionTimeRange([
    { timestamp: '2026-09-10T10:00:00.000Z' },
    { timestamp: '2026-09-10T12:30:00.000Z' },
    { timestamp: '2026-09-10T09:00:00.000Z' },
  ]);
  assert.strictEqual(range.start, '2026-09-10T09:00:00.000Z');
  assert.strictEqual(range.end, '2026-09-10T12:30:00.000Z');
});
run('NEGATIVO: sin timestamps devuelve rango nulo', () => {
  const range = sessionTimeRange([{ type: 'user' }]);
  assert.strictEqual(range.start, null);
  assert.strictEqual(range.end, null);
});

// ---- 4) buildDigest: tope de caracteres ------------------------------------
run('por debajo del tope, el digest incluye usuario y asistente enteros', () => {
  const entries = [userEntry('pregunta corta'), assistantEntry('respuesta corta')];
  const out = buildDigest(entries, { maxChars: 1000 });
  assert.ok(out.includes('[USUARIO] pregunta corta'));
  assert.ok(out.includes('[ASISTENTE] respuesta corta'));
});
run('por encima del tope: TODOS los prompts del usuario sobreviven intactos', () => {
  const entries = [];
  for (let i = 0; i < 6; i++) {
    entries.push(userEntry(`pregunta numero ${i}`));
    entries.push(assistantEntry('x'.repeat(500), `2026-09-10T10:00:0${i}.000Z`));
  }
  const out = buildDigest(entries, { maxChars: 600 });
  for (let i = 0; i < 6; i++) {
    assert.ok(out.includes(`[USUARIO] pregunta numero ${i}`), `falta el prompt ${i}`);
  }
});
run('por encima del tope: se recorta el asistente MAS CERCANO AL MEDIO, no el principio ni el final', () => {
  // 4 turnos de asistente de 308 chars cada uno (total 1232); prompts de
  // usuario = 22 chars. budgetForAssistant = maxChars - 22. Con maxChars=722
  // (budget=700) el recorte deja de sobrar presupuesto justo tras soltar los
  // DOS turnos centrales (950 -> 668 <= 700): el primero y el ultimo quedan
  // intactos por construccion, no por casualidad.
  const entries = [
    userEntry('inicio'),
    assistantEntry('PRIMERO ' + 'a'.repeat(300)),
    userEntry('medio'),
    assistantEntry('SEGUNDO ' + 'b'.repeat(300)),
    userEntry('medio2'),
    assistantEntry('TERCERO ' + 'c'.repeat(300)),
    userEntry('final'),
    assistantEntry('CUARTO ' + 'd'.repeat(300)),
  ];
  const out = buildDigest(entries, { maxChars: 722 });
  assert.ok(out.includes('PRIMERO'), 'el primer turno del asistente se conserva');
  assert.ok(out.includes('CUARTO'), 'el ultimo turno del asistente se conserva');
  assert.ok(!out.includes('SEGUNDO'), 'el turno central se recorta');
  assert.ok(!out.includes('TERCERO'), 'el otro turno central se recorta');
  assert.ok(out.includes('[recortado por longitud]'), 'el hueco queda marcado, no desaparece sin rastro');
});

// ---- 5) readTranscriptEntries: fichero real + caso negativo ----------------
run('lee un transcript JSONL real linea a linea', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, JSON.stringify(userEntry('hola')) + '\n' + JSON.stringify(assistantEntry('hola tambien')) + '\n');
  const entries = readTranscriptEntries(file);
  assert.strictEqual(entries.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
run('NEGATIVO: fichero inexistente devuelve [] sin lanzar', () => {
  assert.deepStrictEqual(readTranscriptEntries(path.join(os.tmpdir(), 'no-existe-' + Date.now() + '.jsonl')), []);
});
run('NEGATIVO: linea JSON corrupta se ignora sin romper el resto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, '{esto no es json}\n' + JSON.stringify(userEntry('sigue vivo')) + '\n');
  const entries = readTranscriptEntries(file);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(extractUserPrompts(entries)[0].text, 'sigue vivo');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Resultado final --------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(`PASS  test-session-digest (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-session-digest (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
