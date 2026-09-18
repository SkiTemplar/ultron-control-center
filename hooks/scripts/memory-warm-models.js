#!/usr/bin/env node
// hooks/scripts/memory-warm-models.js — recarga E5 en el daemon YA VIVO.
//
// PROBLEMA (medido 2026-09-18): desde que el daemon es residente (2026-09-10) y
// suelta los modelos por inactividad (ULTRON_MODEL_IDLE_MIN, 30 min), el warmup
// de SessionStart dejo de calentar nada: `serve` es idempotente y sale al ver
// un daemon vivo, con E5 fuera de RAM. El primer prompt de la sesion pagaba la
// recarga (18,6-18,7 s en logs/hook-timing.jsonl, 3 de 3 arranques ese dia) y
// salia por timeout con "[memoria degradada]": sin recall justo en el prompt
// que abre el trabajo.
//
// CURA: memory-warmup.js lanza este script DETACHED. Pide un `embed` minimo al
// daemon, que fuerza la carga de E5 mientras el usuario escribe su primer
// prompt. Si el daemon aun esta arrancando (lockfile sin escribir), reintenta
// hasta WARM_DEADLINE_MS. Nunca imprime ni bloquea a nadie: su unico efecto es
// una linea en logs/capture.jsonl (hook "memory-warm-models"; elapsed_ms alto
// = el daemon venia frio).

'use strict';

const { daemonRequest, logMs } = require('./lib/ultron-memory-cli');

const WARM_DEADLINE_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_EVERY_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pide el embed de calentamiento hasta que el daemon responda o venza el plazo.
 * @param {{request: Function, now: Function, wait: Function}} deps inyectables para test
 * @returns {Promise<{ok: boolean, attempts: number, elapsedMs: number}>}
 */
async function warmModels(deps) {
  const { request, now, wait } = deps;
  const t0 = now();
  let attempts = 0;
  while (now() - t0 < WARM_DEADLINE_MS) {
    attempts += 1;
    const resp = await request({ cmd: 'embed', text: 'warmup' }, REQUEST_TIMEOUT_MS);
    if (resp && Number.isFinite(resp.dim)) {
      return { ok: true, attempts, elapsedMs: now() - t0 };
    }
    await wait(RETRY_EVERY_MS);
  }
  return { ok: false, attempts, elapsedMs: now() - t0 };
}

if (require.main === module) {
  warmModels({ request: daemonRequest, now: Date.now, wait: sleep })
    .then((r) => {
      logMs({ hook: 'memory-warm-models', elapsed_ms: r.elapsedMs, ok: r.ok, attempts: r.attempts });
    })
    .catch(() => { /* best effort: el primer prompt degrada como antes */ })
    .finally(() => process.exit(0));
} else {
  module.exports = { warmModels, WARM_DEADLINE_MS };
}
