#!/usr/bin/env node
// Test de memory-warm-models: el calentamiento reintenta mientras el daemon no
// responde, para en cuanto llega un embed valido y se rinde al vencer el plazo.
// Ejecutar: node hooks/scripts/tests/test-memory-warm-models.js
const assert = require('node:assert');
const { warmModels, WARM_DEADLINE_MS } = require('../memory-warm-models.js');

// Reloj falso: cada wait() avanza el tiempo lo que se le pide.
function fakeDeps(responses) {
  let t = 0;
  const calls = [];
  return {
    calls,
    request: async (payload) => { calls.push(payload); return responses.shift() ?? null; },
    now: () => t,
    wait: async (ms) => { t += ms; },
  };
}

(async () => {
  // Daemon caliente o frio pero vivo: responde a la primera.
  const vivo = fakeDeps([{ vector: [0.1], dim: 1024 }]);
  const r1 = await warmModels(vivo);
  assert.deepStrictEqual({ ok: r1.ok, attempts: r1.attempts }, { ok: true, attempts: 1 });
  assert.deepStrictEqual(vivo.calls[0], { cmd: 'embed', text: 'warmup' }, 'pide un embed minimo');

  // Daemon arrancando: dos null (sin lockfile todavia) y luego responde.
  const arrancando = fakeDeps([null, null, { vector: [0.1], dim: 1024 }]);
  const r2 = await warmModels(arrancando);
  assert.deepStrictEqual({ ok: r2.ok, attempts: r2.attempts }, { ok: true, attempts: 3 });

  // Caso negativo: una respuesta de error NO cuenta como calentado.
  const conError = fakeDeps([{ error: 'empty_text' }, { vector: [0.1], dim: 1024 }]);
  const r3 = await warmModels(conError);
  assert.strictEqual(r3.attempts, 2, 'el error no corta el bucle como si fuera un exito');

  // Caso negativo: daemon mudo => se rinde al vencer el plazo, sin bucle infinito.
  const mudo = fakeDeps([]);
  const r4 = await warmModels(mudo);
  assert.strictEqual(r4.ok, false);
  assert.ok(r4.elapsedMs >= WARM_DEADLINE_MS, 'agota el plazo antes de rendirse');

  console.log('test-memory-warm-models: OK (7 asserts)');
})().catch((e) => { console.error(e); process.exit(1); });
