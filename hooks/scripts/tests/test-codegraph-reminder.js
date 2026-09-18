#!/usr/bin/env node
// Test del hook codegraph-reminder: el matcher de Bash solo debe disparar en
// exploracion de CODIGO, no en lectura de datos/estado de runtime (falsos
// positivos medidos 2026-08-15: cat/tail/ls sobre *.json, *.log y .tmp).
// Ejecutar: node hooks/scripts/tests/test-codegraph-reminder.js
const assert = require('node:assert');
const {
  isBlindCodeExploration, classifyArgs, bashSearchPattern, gateDecision, GATE_FREE,
  symbolInIndexDb,
} = require('../codegraph-reminder.js');

// --- Casos NEGATIVOS (los 3 falsos positivos reales + variantes) ---
assert.strictEqual(isBlindCodeExploration('cat run/orchestrate.json'), false,
  'cat de JSON de runtime NO debe disparar');
assert.strictEqual(isBlindCodeExploration('tail -30 .tmp/auto-recall-trace.log'), false,
  'tail de un log NO debe disparar');
assert.strictEqual(isBlindCodeExploration('ls .tmp/'), false,
  'ls de un dir de temporales NO debe disparar');
assert.strictEqual(isBlindCodeExploration('ls'), false,
  'ls pelado (listar cwd) NO debe disparar — no busca simbolos');
assert.strictEqual(isBlindCodeExploration('grep -n foo hooks/manifest.json'), false,
  'grep sobre un objetivo SOLO de datos NO debe disparar');
assert.strictEqual(isBlindCodeExploration('cargo test | tail -5'), false,
  'post-proceso tras pipe de un build/run NO debe disparar');
assert.strictEqual(isBlindCodeExploration('head -20 docs/README.md'), false,
  'lectura de markdown NO debe disparar');
assert.strictEqual(isBlindCodeExploration(''), false, 'comando vacio NO dispara');

// --- Casos POSITIVOS (exploracion de codigo real) ---
assert.strictEqual(isBlindCodeExploration('cat control-center/src-tauri/src/lib.rs'), true,
  'cat de un .rs SI debe disparar');
assert.strictEqual(isBlindCodeExploration('grep -rn "seed_zones" ai_router/'), true,
  'grep de un simbolo sobre un dir de codigo SI debe disparar');
assert.strictEqual(isBlindCodeExploration('find . -name "*.rs"'), true,
  'find por extension de codigo SI debe disparar');
assert.strictEqual(isBlindCodeExploration('rg TODO'), true,
  'rg sin objetivo (barrido del arbol) SI debe disparar');
assert.strictEqual(isBlindCodeExploration('ls && cat src/main.ts'), true,
  'segmento secuenciado con lectura de codigo SI debe disparar');

// El patron de grep NO cuenta como objetivo: aunque parezca un nombre raro,
// el unico path real es de datos -> no dispara.
assert.strictEqual(isBlindCodeExploration('grep "route" ~/.claude/logs/orchestrate.jsonl'), false,
  'grep con patron + objetivo jsonl NO debe disparar');

// --- classifyArgs directo (unidad; NO salta el patron — eso lo hace el caller) ---
assert.strictEqual(classifyArgs(['hooks/manifest.json']), 'data', 'solo JSON => data');
assert.strictEqual(classifyArgs(['"*.rs"']), 'code', 'glob de codigo entre comillas => code');
assert.strictEqual(classifyArgs([]), 'unknown', 'sin argumentos => unknown');
assert.strictEqual(classifyArgs(['ai_router/']), 'unknown', 'dir sin extension => unknown');

// --- Gate: falsos positivos medidos 2026-09-18 ---
// 1) `| grep -v warning` es un FILTRO de salida, no una busqueda en el arbol.
assert.strictEqual(bashSearchPattern('node q.mjs db | grep -v -i warning'), '',
  'grep tras un pipe NO aporta patron de busqueda');
assert.strictEqual(bashSearchPattern('cd x && grep -rn "seed_zones" ai_router/'), 'seed_zones',
  'grep lider de segmento SI aporta patron');
// 2) `cat > fichero <<EOF` ESCRIBE un fichero: no es leer codigo a ciegas.
assert.strictEqual(isBlindCodeExploration('cat > "$TEMP/q.mjs" <<\'EOF\'\nconst a = 1;\nEOF'), false,
  'heredoc de escritura NO debe disparar');
// 3) El deny exige que el indice CONOZCA el simbolo: una palabra suelta que no
//    es simbolo ("warm", "warning") la resuelve grep, no el indice.
const gateArgs = { tool: 'Grep', toolInput: { pattern: 'warm' }, explores: GATE_FREE + 1, mode: 'deny' };
assert.strictEqual(gateDecision({ ...gateArgs, symbolInIndex: () => false }), null,
  'patron ausente del indice NO se deniega');
assert.ok(gateDecision({ ...gateArgs, symbolInIndex: () => true }),
  'patron presente en el indice SI se deniega (caso negativo del arreglo)');
assert.strictEqual(gateDecision({ ...gateArgs, symbolInIndex: () => { throw new Error('db'); } }), null,
  'fallo al consultar el indice => no se deniega (fail-open)');

// --- Hallazgos de la revision 2026-09-18 ---
// El cuerpo de un heredoc es texto escrito: un `; grep Simbolo` dentro NO es
// una busqueda, y el patron real es el del grep que si se ejecuta.
const conHeredoc = 'cat > /tmp/notas.txt <<EOF\nnotas sueltas; grep MemoryService\nEOF\ngrep foo src/main.rs';
assert.strictEqual(bashSearchPattern(conHeredoc), 'foo',
  'el patron sale del grep ejecutado, no del cuerpo del heredoc');
// Dos comandos separados solo por salto de linea son dos segmentos.
assert.strictEqual(isBlindCodeExploration('echo hola\ncat src/main.ts'), true,
  'segunda linea con lectura de codigo SI dispara');
assert.strictEqual(bashSearchPattern('echo hola\ngrep -rn seed_zones ai_router/'), 'seed_zones',
  'grep lider de una segunda linea SI aporta patron');
// Un here-string (<<<) alimenta stdin: no es un heredoc de escritura.
assert.strictEqual(isBlindCodeExploration('grep -c fn src/lib.rs <<< "$x"'), true,
  'here-string NO se confunde con heredoc');

// symbolInIndexDb REAL contra un indice minimo (no el stub inyectado).
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-cgr-'));
  try {
    const dbPath = path.join(dir, 'codegraph.db');
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE nodes (name TEXT); INSERT INTO nodes VALUES ('route');");
    db.close();
    assert.strictEqual(symbolInIndexDb('route', dbPath), true, 'simbolo presente');
    assert.strictEqual(symbolInIndexDb('crate::ai_router::route', dbPath), true,
      'ruta calificada: cuenta el ultimo segmento');
    assert.strictEqual(symbolInIndexDb('zzqnoexiste', dbPath), false, 'simbolo ausente');
    assert.strictEqual(symbolInIndexDb('route', ''), false, 'sin indice => false');
    fs.rmSync(dbPath); // el handle quedo cerrado: en Windows un handle abierto impide borrar
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('test-codegraph-reminder: OK (31 asserts)');
