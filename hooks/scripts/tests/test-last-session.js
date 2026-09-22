#!/usr/bin/env node
// hooks/scripts/tests/test-last-session.js
// lib/last-session.js: recorte POR SECCIONES del summary.md inyectado al
// arranque (clipSummary) y deteccion de un summary.md viejo (summaryMtimeMs).
// Caso real que motiva el test (2026-09-21/22): un resumen de 4683 caracteres
// se cortaba a ciegas a 2500 y perdia entero "## Pendientes", donde estaba la
// unica mencion a la rama maria-core. Cada bloque incluye caso negativo.
//
// Uso: node hooks/scripts/tests/test-last-session.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'last-session-test-'));
process.env.LAST_SESSION_PROJECTS_DIR = path.join(ROOT, 'cockpit-projects');

const lastSession = require('../lib/last-session');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

const HEAD = '---\nsession_id: abc\nmodelo: sonnet\n---\n\n';
function section(title, lines) {
  return `## ${title}\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}
const big = (n, text) => Array.from({ length: n }, (_, i) => `${text} ${i}`);

// ---- 1) clipSummary ---------------------------------------------------------
run('contenido por debajo del tope se devuelve intacto', () => {
  const content = HEAD + section('Temas', ['a']) + section('Pendientes', ['b']);
  assert.strictEqual(lastSession.clipSummary(content, 10_000), content);
});

run('por encima del tope salva Pendientes y Decisiones enteras y omite Ficheros con aviso', () => {
  const temas = section('Temas', big(12, 'tema largo de la sesion'));
  const decisiones = section('Decisiones', big(8, 'decision tomada con el usuario'));
  const pendientes = section('Pendientes', ['integrar la rama maria-core', 'rotar el PAT']);
  const ficheros = section('Ficheros/commits relevantes', big(30, 'control-center/src/fichero.rs'));
  const content = HEAD + temas + decisiones + pendientes + ficheros;
  const max = HEAD.length + pendientes.length + decisiones.length + 80;
  const out = lastSession.clipSummary(content, max);
  assert.ok(out.length <= max + 120, `no puede desbordar el tope (+aviso): ${out.length} > ${max}`);
  assert.ok(out.startsWith(HEAD.trimEnd().slice(0, 20)), 'conserva la cabecera');
  assert.ok(out.includes('## Pendientes') && out.includes('maria-core'), 'Pendientes entera');
  assert.ok(out.includes('## Decisiones') && out.includes('decision tomada con el usuario 7'), 'Decisiones entera');
  assert.ok(!out.includes('## Temas'), 'Temas no cabe y se omite');
  assert.ok(!out.includes('fichero.rs'), 'Ficheros no cabe y se omite');
  assert.ok(/secciones omitidas por tamano: Temas, Ficheros/.test(out), 'aviso con las secciones omitidas');
  assert.ok(out.indexOf('## Decisiones') < out.indexOf('## Pendientes'), 'las conservadas salen en su orden original');
});

run('NEGATIVO: si ni la seccion prioritaria cabe entera, se trunca con [...] en vez de perderse', () => {
  const pendientes = section('Pendientes', big(200, 'tarea pendiente muy detallada'));
  const content = HEAD + section('Temas', ['x']) + pendientes;
  const out = lastSession.clipSummary(content, 400);
  assert.ok(out.includes('## Pendientes'), 'la prioritaria sobrevive truncada');
  assert.ok(out.includes('[...]'), 'marca de truncado');
  assert.ok(out.length <= 400 + 80, `tope respetado: ${out.length}`);
  assert.ok(!out.includes('## Temas'), 'sin presupuesto para el resto');
});

run('NEGATIVO: sin secciones "## " cae al corte ciego con [...]', () => {
  const out = lastSession.clipSummary('x'.repeat(5000), 100);
  assert.ok(out.startsWith('x'.repeat(100)) && out.endsWith('[...]'));
  assert.strictEqual(lastSession.clipSummary(undefined, 100), '');
});

run('renderLastSessionLines envuelve el recorte en su bloque de confianza', () => {
  const lines = lastSession.renderLastSessionLines({ sessionId: 's1', content: HEAD + section('Pendientes', ['p']) });
  assert.ok(lines[0].includes('trust="session-summary"') && lines[0].includes('session_id="s1"'));
  assert.ok(lines[lines.length - 1] === '</last-session-summary>');
  assert.deepStrictEqual(lastSession.renderLastSessionLines(null), []);
});

// ---- 2) summaryMtimeMs / hasSummary ------------------------------------------
run('summaryMtimeMs devuelve el mtime del summary.md y null si no existe', () => {
  assert.strictEqual(lastSession.summaryMtimeMs('proj', 'sin-resumen'), null);
  assert.strictEqual(lastSession.hasSummary('proj', 'sin-resumen'), false);
  fs.mkdirSync(lastSession.summaryDir('proj', 'con-resumen'), { recursive: true });
  fs.writeFileSync(lastSession.summaryPath('proj', 'con-resumen'), '## Temas\n- x\n');
  const when = new Date(Date.now() - 3600_000);
  fs.utimesSync(lastSession.summaryPath('proj', 'con-resumen'), when, when);
  const mtime = lastSession.summaryMtimeMs('proj', 'con-resumen');
  assert.ok(Math.abs(mtime - when.getTime()) < 2000, `mtime esperado ${when.getTime()}, obtenido ${mtime}`);
  assert.strictEqual(lastSession.hasSummary('proj', 'con-resumen'), true);
  // Negativo: ids con separadores no salen del cockpit (safeId).
  assert.strictEqual(lastSession.summaryMtimeMs('proj', '../con-resumen'), null);
});

// ---- Resultado final --------------------------------------------------------
console.log('');
fs.rmSync(ROOT, { recursive: true, force: true });
if (failed === 0) {
  console.log(`PASS  test-last-session (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-last-session (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
