#!/usr/bin/env node
// hooks/scripts/tests/test-freshness-gate.js
// Tests para la logica de readL0Scratch() — gate de frescura <24h.
// Caso negativo: archivo > 24h -> debe retornar ''.
// Caso positivo: archivo fresco -> debe retornar contenido envuelto en <l0-scratch>.
//
// Uso: node hooks/scripts/tests/test-freshness-gate.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Importa readL0Scratch y constantes (require.main !== module -> exports disponibles).
const { readL0Scratch, L0_SCRATCH, L0_MAX_AGE_MS, L0_MAX_CHARS } =
  require('../memory-session-resume');

const TMP_DIR = path.dirname(L0_SCRATCH);

// Garantiza que el directorio .tmp exista.
fs.mkdirSync(TMP_DIR, { recursive: true });

// Guarda el contenido original del context.md para restaurarlo al final.
// (2026-08-10) TAMBIEN el mtime: restaurar solo el contenido dejaba el scratch
// viejo con mtime fresco -> el gate de 24h lo daba por vivo durante un dia
// (caso real: scratch de legacy-fc del 08-02 reinyectado tras correr este test).
let originalContent = null;
let originalExists = false;
let originalMtime = null;
try {
  originalContent = fs.readFileSync(L0_SCRATCH, 'utf8');
  originalMtime = fs.statSync(L0_SCRATCH).mtime;
  originalExists = true;
} catch { /* no existia */ }

function restore() {
  try {
    if (originalExists) {
      fs.writeFileSync(L0_SCRATCH, originalContent, 'utf8');
      if (originalMtime) fs.utimesSync(L0_SCRATCH, originalMtime, originalMtime);
    } else {
      try { fs.unlinkSync(L0_SCRATCH); } catch { /* ya no existe */ }
    }
  } catch { /* mejor esfuerzo */ }
}

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

// ---- CASO NEGATIVO: archivo STALE (mtime > 24h) -------------------------
run('archivo stale (>24h) debe retornar cadena vacia', () => {
  const contenido = 'Este es el scratch preservado antes de compactacion.';
  fs.writeFileSync(L0_SCRATCH, contenido, 'utf8');

  // Retrocede el mtime a 25 horas atras.
  const staleMs = Date.now() - (L0_MAX_AGE_MS + 60 * 60 * 1000); // +1h extra
  const staleDate = new Date(staleMs);
  fs.utimesSync(L0_SCRATCH, staleDate, staleDate);

  const result = readL0Scratch();
  assert.strictEqual(
    result,
    '',
    `Esperaba '' pero obtuvo: ${JSON.stringify(result)}`
  );
});

// ---- CASO POSITIVO: archivo FRESCO (<24h) --------------------------------
run('archivo fresco (<24h) debe retornar contenido envuelto en <l0-scratch>', () => {
  const contenido = 'Scratch de trabajo: plan activo cat17, 3 cards en progreso.';
  fs.writeFileSync(L0_SCRATCH, contenido, 'utf8');

  // Ajusta mtime a "ahora" (fresco).
  const now = new Date();
  fs.utimesSync(L0_SCRATCH, now, now);

  const result = readL0Scratch();
  assert.ok(
    result.includes('<l0-scratch'),
    `Esperaba que incluyera <l0-scratch>, obtuvo: ${JSON.stringify(result)}`
  );
  assert.ok(
    result.includes(contenido),
    `Esperaba que incluyera el contenido original, obtuvo: ${JSON.stringify(result)}`
  );
  assert.ok(
    result.includes('</l0-scratch>'),
    `Esperaba que cerrara </l0-scratch>, obtuvo: ${JSON.stringify(result)}`
  );
});

// ---- CASO BORDE: archivo inexistente -------------------------------------
run('archivo inexistente debe retornar cadena vacia (fail-safe)', () => {
  try { fs.unlinkSync(L0_SCRATCH); } catch { /* no existia */ }
  const result = readL0Scratch();
  assert.strictEqual(
    result,
    '',
    `Esperaba '' pero obtuvo: ${JSON.stringify(result)}`
  );
});

// ---- CASO BORDE: contenido vacio -----------------------------------------
run('archivo fresco pero vacio debe retornar cadena vacia', () => {
  fs.writeFileSync(L0_SCRATCH, '   \n  ', 'utf8');
  const now = new Date();
  fs.utimesSync(L0_SCRATCH, now, now);
  const result = readL0Scratch();
  assert.strictEqual(
    result,
    '',
    `Esperaba '' para contenido vacio, obtuvo: ${JSON.stringify(result)}`
  );
});

// ---- CASO BORDE: clip a L0_MAX_CHARS ------------------------------------
run('contenido > L0_MAX_CHARS debe quedar clippeado con [...]', () => {
  const largo = 'x'.repeat(L0_MAX_CHARS + 500);
  fs.writeFileSync(L0_SCRATCH, largo, 'utf8');
  const now = new Date();
  fs.utimesSync(L0_SCRATCH, now, now);
  const result = readL0Scratch();
  assert.ok(
    result.includes('[...]'),
    `Esperaba [...] en contenido largo, obtuvo: ${JSON.stringify(result.slice(0, 80))}...`
  );
  // La cadena envuelta no debe exceder L0_MAX_CHARS en la parte de datos.
  assert.ok(
    !result.includes('x'.repeat(L0_MAX_CHARS + 1)),
    'El contenido original no debe aparecer sin clipear'
  );
});

// ---- GATE CROSS-PROJECT (2026-08-10) --------------------------------------
run('scratch de OTRO proyecto no se inyecta en la sesion actual', () => {
  const contenido = [
    '# ULTRON L0 CONTEXT (pre-compact) · 2026-08-02 00:09',
    '> Preservado por precompact-preserve-l0.js (scratch, no es memoria gobernada).',
    '> trigger: auto · project: legacy-fc · turns_scanned: 3',
    '',
    '## Hechos clave preservados',
    '- dato de otro proyecto',
  ].join('\n');
  fs.writeFileSync(L0_SCRATCH, contenido, 'utf8');
  const now = new Date();
  fs.utimesSync(L0_SCRATCH, now, now);
  const result = readL0Scratch('ultron');
  assert.strictEqual(result, '', `scratch de legacy-fc no debe entrar en ultron: ${JSON.stringify(result.slice(0, 80))}`);
});

run('NEGATIVO: scratch del MISMO proyecto SI se inyecta', () => {
  const contenido = [
    '# ULTRON L0 CONTEXT (pre-compact)',
    '> trigger: auto · project: ultron · turns_scanned: 3',
    '- plan activo bloque 3',
  ].join('\n');
  fs.writeFileSync(L0_SCRATCH, contenido, 'utf8');
  const now = new Date();
  fs.utimesSync(L0_SCRATCH, now, now);
  const result = readL0Scratch('ultron');
  assert.ok(result.includes('plan activo bloque 3'), `mismo proyecto debe inyectarse: ${JSON.stringify(result.slice(0, 80))}`);
});

run('scratch sin header de proyecto se inyecta (compat)', () => {
  fs.writeFileSync(L0_SCRATCH, 'scratch legacy sin header', 'utf8');
  const now = new Date();
  fs.utimesSync(L0_SCRATCH, now, now);
  const result = readL0Scratch('ultron');
  assert.ok(result.includes('scratch legacy sin header'), 'sin header no hay gate');
});

// Restaura el archivo original.
restore();

// ---- Resultado final ------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(`PASS  test-freshness-gate (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-freshness-gate (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
