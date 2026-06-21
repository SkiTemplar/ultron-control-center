#!/usr/bin/env node
// hooks/scripts/memory-warmup.js — SessionStart hook (cura cold-start E5).
//
// PROBLEMA: el modelo FastEmbed multilingual-e5-large (1024d, ~1.3GB ONNX en
// ~/.ultron/.fastembed_cache/) se cargaba LAZY en CADA proceso one-shot del
// sidecar. Como cada invocacion del .exe es un proceso NUEVO, `orchestrate`
// (hook UserPromptSubmit) pagaba 3-5s de carga de modelo ANTES de cada turno
// (medido: 3137/3833/4388/4805ms) -> palanca #1 de latencia del sistema.
//
// CURA: arrancar el daemon residente `ultron-memory serve` (DETACHED) en
// SessionStart. Mantiene el modelo E5 cargado en RAM y escucha en TCP loopback;
// `memory-orchestrate.js` le habla por IPC y el hot path baja a sub-segundo. El
// daemon hace su propio warmup E5 al arrancar y es IDEMPOTENTE (si ya hay uno
// vivo, sale al instante). El hook retorna en <50ms porque NO espera al hijo.
//
// FAIL-SAFE: si el binario es viejo (sin subcomando `serve`), el hijo sale con
// error y NO escribe lockfile -> `memory-orchestrate.js` degrada al proceso
// one-shot (cold E5, correcto). Este hook nunca bloquea: emite vacio y exit 0.

const fs = require('fs');
const { spawnDetached } = require('./lib/ultron-memory-cli');
const { observe, logHookError } = require('./lib/hook-obs');
observe('memory-warmup');

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: additionalContext || '',
      },
    })
  );
}

function main() {
  try { fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  // Arranca el daemon residente (E5 caliente en RAM). Idempotente y detached.
  spawnDetached(['serve']);
  emit(''); // este hook solo arranca el daemon; nunca inyecta nada
}

try {
  main();
} catch (e) {
  logHookError('memory-warmup', e);
  try { emit(''); } catch { /* ignore */ }
}
process.exitCode = 0;

