#!/usr/bin/env node
// hooks/scripts/tests/test-note-title.js
// Tests de deriveNoteTitle (titulado informativo de agent_notes).
// Casos: resultado largo -> primera frase truncada; resultado vacio -> fallback
// al titulo viejo; contenido con secretos -> redactado.
//
// Uso: node hooks/scripts/tests/test-note-title.js

'use strict';

const assert = require('assert');

const { deriveNoteTitle, TITLE_MAX } = require('../lib/note-title');

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

// ---- Resultado largo: primera frase significativa + prefijo + truncado ----
run('resultado largo -> primera frase con prefijo [agent], sin titulo generico', () => {
  const resultText =
    'Se corrigio el deadlock en el pool de conexiones del scheduler. ' +
    'El problema era un lock tomado en orden inverso entre worker y dispatcher. ' +
    'Ademas se anadieron 3 tests de regresion y se documento el invariante.';
  const title = deriveNoteTitle({ agent: 'debugger', label: 'fix deadlock', resultText });
  assert.ok(title.startsWith('[debugger] '), `prefijo esperado, got: ${title}`);
  assert.ok(
    title.includes('deadlock en el pool de conexiones'),
    `debe derivar de la primera frase, got: ${title}`
  );
  assert.ok(!title.includes('Subagente'), `no debe quedar decoracion generica: ${title}`);
  assert.ok(title.length <= TITLE_MAX + 1, `truncado ~${TITLE_MAX}, got len=${title.length}`);
});

run('frase unica muy larga -> truncada con elipsis a <= TITLE_MAX', () => {
  const resultText = 'A'.repeat(10) + ' ' + 'palabra '.repeat(40); // sin terminador de frase
  const title = deriveNoteTitle({ agent: 'code-reviewer', label: '', resultText });
  assert.ok(title.length <= TITLE_MAX, `len=${title.length} > ${TITLE_MAX}: ${title}`);
  assert.ok(title.endsWith('…'), `debe terminar en elipsis: ${title}`);
});

run('decoracion markdown (headings/fences/bullets) se salta y se limpia', () => {
  const resultText = [
    '## Resumen',
    '```',
    'codigo irrelevante',
    '```',
    '---',
    '- **Hallazgo principal**: la cache de embeddings no invalida al deprecar items.',
  ].join('\n');
  const title = deriveNoteTitle({ agent: 'ultron-perf', label: '', resultText });
  assert.ok(
    title.includes('cache de embeddings no invalida'),
    `debe saltar decoracion y llegar al contenido, got: ${title}`
  );
  assert.ok(!title.includes('**') && !title.includes('```'), `sin marcado markdown: ${title}`);
});

// ---- Resultado vacio: fallbacks -------------------------------------------
run('resultado vacio y sin label -> fallback exacto al titulo viejo', () => {
  const title = deriveNoteTitle({ agent: 'code-reviewer', label: '', resultText: '' });
  assert.strictEqual(title, 'Subagente code-reviewer — resultado');
});

run('resultado vacio con label -> usa el objetivo de la tarea', () => {
  const title = deriveNoteTitle({
    agent: 'rust-engineer',
    label: 'Migrar el recall a RRF con cross-encoder',
    resultText: '   \n\n',
  });
  assert.ok(title.includes('Migrar el recall a RRF'), `debe usar el label, got: ${title}`);
  assert.ok(title.startsWith('[rust-engineer] '), `prefijo esperado, got: ${title}`);
});

run('input no-string / null -> fallback sin lanzar', () => {
  const title = deriveNoteTitle({ agent: 'qa-expert', label: null, resultText: { foo: 1 } });
  assert.strictEqual(title, 'Subagente qa-expert — resultado');
});

run('agent unknown -> sin prefijo [unknown]', () => {
  const title = deriveNoteTitle({
    agent: 'unknown',
    label: '',
    resultText: 'Se actualizo la tabla de rutas del dispatcher semantico v3.',
  });
  assert.ok(!title.includes('[unknown]'), `no debe prefijar unknown: ${title}`);
  assert.ok(title.includes('tabla de rutas'), `contenido esperado, got: ${title}`);
});

// ---- Secretos en el contenido -> redactado --------------------------------
run('token en la primera frase -> [REDACTED], sin token en claro', () => {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // 36 chars tras ghp_
  const resultText = `Se roto el PAT ${token} comprometido en el pipeline de CI y se limpio el historial.`;
  const title = deriveNoteTitle({ agent: 'security-auditor', label: '', resultText });
  assert.ok(!title.includes(token.slice(0, 12)), `token en claro en el titulo: ${title}`);
  assert.ok(title.includes('[REDACTED]'), `debe marcar la redaccion, got: ${title}`);
});

run('clave sk- estilo OpenAI en el contenido -> redactada', () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwx123456';
  const resultText = `La variable OPENAI_API_KEY=${key} estaba hardcodeada en el script de eval del router.`;
  const title = deriveNoteTitle({ agent: 'security-auditor', label: '', resultText });
  assert.ok(!title.includes('sk-proj-abcdef'), `clave en claro en el titulo: ${title}`);
  assert.ok(title.includes('[REDACTED]'), `debe marcar la redaccion, got: ${title}`);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
