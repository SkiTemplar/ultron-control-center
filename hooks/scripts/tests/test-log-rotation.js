#!/usr/bin/env node
// hooks/scripts/tests/test-log-rotation.js
// Tests para appendJsonl / rotateIfNeeded de hooks/scripts/lib/jsonl-log.js.
// Cubre: rotacion al superar 1 MiB, archivo nuevo pequeno, fail-safe, record ts.
//
// Uso: node hooks/scripts/tests/test-log-rotation.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendJsonl, rotateIfNeeded, DEFAULT_MAX_BYTES } =
  require('../lib/jsonl-log');

// Directorio temporal aislado para esta suite.
const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-jsonl-test-'));
const LOG_FILE = path.join(SUITE_TMP, 'test.jsonl');

function cleanup() {
  try { fs.rmSync(SUITE_TMP, { recursive: true, force: true }); } catch { /* mejor esfuerzo */ }
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

// Borra el log temporal entre casos para aislar estados.
function resetLog() {
  try { fs.unlinkSync(LOG_FILE); } catch { /* no existia */ }
  try { fs.unlinkSync(LOG_FILE + '.1'); } catch { /* no existia */ }
}

// ---- CASO: appendJsonl crea archivo y escribe registro -------------------
run('appendJsonl crea el archivo si no existe y escribe JSONL valido', () => {
  resetLog();
  appendJsonl(LOG_FILE, { event: 'test', value: 42 });
  assert.ok(fs.existsSync(LOG_FILE), 'El archivo de log no fue creado');
  const line = fs.readFileSync(LOG_FILE, 'utf8').trim();
  const rec = JSON.parse(line);
  assert.strictEqual(rec.event, 'test');
  assert.strictEqual(rec.value, 42);
  assert.ok(typeof rec.ts === 'string', 'Debe agregar campo ts');
});

// ---- CASO: registro que ya trae ts no se sobreescribe -------------------
run('appendJsonl no sobreescribe ts si el registro ya la trae', () => {
  resetLog();
  const myTs = '2000-01-01T00:00:00.000Z';
  appendJsonl(LOG_FILE, { ts: myTs, event: 'custom-ts' });
  const line = fs.readFileSync(LOG_FILE, 'utf8').trim();
  const rec = JSON.parse(line);
  assert.strictEqual(rec.ts, myTs, 'Debe respetar el ts original del registro');
});

// ---- CASO: rotateIfNeeded NO rota cuando el archivo es pequeno ----------
run('rotateIfNeeded no rota archivo menor al umbral', () => {
  resetLog();
  fs.writeFileSync(LOG_FILE, 'pequeno\n', 'utf8');
  rotateIfNeeded(LOG_FILE, DEFAULT_MAX_BYTES);
  assert.ok(fs.existsSync(LOG_FILE), 'El archivo debe seguir existiendo');
  assert.ok(!fs.existsSync(LOG_FILE + '.1'), 'No debe haber creado .1');
});

// ---- CASO PRINCIPAL: rotacion al escribir > 1 MiB -----------------------
run('appendJsonl rota a .1 cuando el log supera 1 MiB y el archivo nuevo es pequeno', () => {
  resetLog();

  // Escribe directamente un bloque de 1 MiB + 1 byte para que ya sea >= umbral.
  const chunk = Buffer.alloc(DEFAULT_MAX_BYTES + 1, 'a');
  fs.writeFileSync(LOG_FILE, chunk);

  // Verifica tamano antes.
  const sizeBefore = fs.statSync(LOG_FILE).size;
  assert.ok(sizeBefore >= DEFAULT_MAX_BYTES, `Tamano previo ${sizeBefore} < ${DEFAULT_MAX_BYTES}`);

  // appendJsonl debe detectar el overflow, rotar a .1 y escribir en el nuevo.
  const registro = { event: 'post-rotation', seq: 1 };
  appendJsonl(LOG_FILE, registro);

  // El .1 debe existir y ser el archivo gordo.
  assert.ok(fs.existsSync(LOG_FILE + '.1'), 'Debe existir el archivo rotado .1');
  const rotatedSize = fs.statSync(LOG_FILE + '.1').size;
  assert.ok(
    rotatedSize >= DEFAULT_MAX_BYTES,
    `El .1 rotado debe ser >= 1 MiB, tiene ${rotatedSize} bytes`
  );

  // El log nuevo solo debe contener el registro recien escrito (pequeno).
  assert.ok(fs.existsSync(LOG_FILE), 'Debe existir el nuevo log principal');
  const newSize = fs.statSync(LOG_FILE).size;
  assert.ok(
    newSize < DEFAULT_MAX_BYTES,
    `El nuevo log debe ser pequeno (<1 MiB), tiene ${newSize} bytes`
  );

  // El registro en el nuevo log debe ser valido JSONL.
  const line = fs.readFileSync(LOG_FILE, 'utf8').trim();
  const rec = JSON.parse(line);
  assert.strictEqual(rec.event, 'post-rotation');
  assert.strictEqual(rec.seq, 1);
});

// ---- CASO: rotacion de segunda generacion sobreescribe el .1 anterior ---
run('segunda rotacion sobreescribe el .1 previo (single-generation)', () => {
  resetLog();

  // Primera rotacion.
  fs.writeFileSync(LOG_FILE, Buffer.alloc(DEFAULT_MAX_BYTES + 1, 'x'));
  appendJsonl(LOG_FILE, { gen: 1 });

  // Infla el log nuevamente para una segunda rotacion.
  fs.writeFileSync(LOG_FILE, Buffer.alloc(DEFAULT_MAX_BYTES + 1, 'y'));
  appendJsonl(LOG_FILE, { gen: 2 });

  // .1 debe existir y contener el ultimo rotado.
  assert.ok(fs.existsSync(LOG_FILE + '.1'), 'Debe existir .1 tras segunda rotacion');
  // El .1 es la segunda generacion (las y); la primera se perdio (single-gen).
  const rotatedContent = fs.readFileSync(LOG_FILE + '.1');
  // El archivo rotado tiene al menos DEFAULT_MAX_BYTES (el bloque 'y').
  assert.ok(
    rotatedContent.length >= DEFAULT_MAX_BYTES,
    `El .1 de segunda rotacion debe ser >= 1 MiB, tiene ${rotatedContent.length}`
  );
});

// ---- CASO: fail-safe (archivo inexistente no lanza error) ----------------
run('rotateIfNeeded no lanza excepcion si el archivo no existe (fail-safe)', () => {
  resetLog();
  // No debe lanzar aunque el archivo no exista.
  rotateIfNeeded('/ruta/que/no/existe/fake.jsonl', DEFAULT_MAX_BYTES);
  // Si llega aqui, el fail-safe funciona.
});

// ---- Limpieza ------------------------------------------------------------
cleanup();

// ---- Resultado final -------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log(`PASS  test-log-rotation (${passed} pruebas, 0 fallos)`);
  process.exitCode = 0;
} else {
  console.error(`FAIL  test-log-rotation (${passed} ok, ${failed} fallos)`);
  process.exitCode = 1;
}
