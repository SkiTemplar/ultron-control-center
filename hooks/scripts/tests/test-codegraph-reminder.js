#!/usr/bin/env node
// Test del hook codegraph-reminder: el matcher de Bash solo debe disparar en
// exploracion de CODIGO, no en lectura de datos/estado de runtime (falsos
// positivos medidos 2026-08-15: cat/tail/ls sobre *.json, *.log y .tmp).
// Ejecutar: node hooks/scripts/tests/test-codegraph-reminder.js
const assert = require('node:assert');
const { isBlindCodeExploration, classifyArgs } = require('../codegraph-reminder.js');

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

console.log('test-codegraph-reminder: OK (17 asserts)');
