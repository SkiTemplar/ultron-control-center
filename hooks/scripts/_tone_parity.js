#!/usr/bin/env node
// hooks/scripts/_tone_parity.js — gate de paridad JS <-> Rust del detector de tono.
//
// El hook detecta el tono en local (lib/tone-detect.js) para no depender del
// daemon; el sidecar y el playground de la app lo detectan en Rust
// (orchestrator/personality.rs). Son DOS implementaciones de la misma regla, asi
// que pueden divergir en silencio. Este harness las compara sobre un corpus y
// sale != 0 si no coinciden.
//
// Uso: node hooks/scripts/_tone_parity.js
// Requiere el sidecar desplegado en ~/.ultron/bin (usa `orchestrate`, ~1-5s por
// prompt): es un gate manual/CI, no algo del hot path.

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const { detectForPrompt, loadPersonality } = require('./lib/tone-detect');

const BIN = process.env.ULTRON_MEMORY_BIN || path.join(os.homedir(), '.ultron', 'bin', 'ultron-memory.exe');

// Corpus: un caso por tono (señales), triggers explicitos, casos negativos
// (prompts tecnicos que NO deben activar nada) y los limites que ya mordieron
// una vez (ingles tecnico con 'rather/indeed', floor de 1 señal suelta).
const CORPUS = [
  'illo shurmano q pasa con el build',
  'pray tell, good sir, is the build sound?',
  'yurr gng the tests deadass finna fail',
  'howdy pardner, reckon them tests are broke',
  'compae, esto no ni na, vamo a ve el log',
  'primo, el parne no llega, chanelo poco de esto',
  'te lo digo yo, eso esta tirao, en mis tiempos se hacia en una tarde',
  'manda huevos, me cago en la leche, que cojones pasa aqui',
  'ponte en modo cowboy y explicame el error',
  'modo british formal por favor',
  'quita el tono y responde normal',
  'arregla el build de rust que falla el linker',
  'I would rather refactor this module; indeed the tests are slow',
  'we aim to fix the failing tests, I reckon',
  'necesito revisar el recall de la memoria y el reranker',
  'ESTO NO FUNCIONA Y ESTOY HASTA LOS COJONES',
];

function rustTone(prompt) {
  const out = execFileSync(BIN, ['orchestrate', prompt, '--project', 'ultron'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
  });
  const ctx = JSON.parse(out);
  return ctx.tone ? ctx.tone.id : null;
}

function main() {
  if (!loadPersonality()) {
    console.error('SKIP: no hay ~/.ultron/personality.json');
    process.exit(2);
  }
  let mismatches = 0;
  for (const prompt of CORPUS) {
    const js = detectForPrompt(prompt);
    const jsId = js ? js.id : null;
    let rsId;
    try {
      rsId = rustTone(prompt);
    } catch (e) {
      console.error(`ERROR sidecar en "${prompt.slice(0, 40)}…": ${e.message}`);
      mismatches++;
      continue;
    }
    const ok = jsId === rsId;
    if (!ok) mismatches++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} js=${String(jsId).padEnd(15)} rust=${String(rsId).padEnd(15)} :: ${prompt.slice(0, 52)}`
    );
  }
  console.log(`\n${CORPUS.length - mismatches}/${CORPUS.length} en paridad`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main();
