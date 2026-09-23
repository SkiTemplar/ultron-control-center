'use strict';
/**
 * lib/hubs-refresh.js — mantiene al día ~/.ultron/cockpit/memory-hubs.json, la
 * lista de memorias "comodín" que el recall penaliza (ver
 * recall_unified/hubs.rs). La genera `ultron-memory hubs --apply` repitiendo
 * ~200 prompts reales (unos 3 min a prioridad baja). Sin refresco, la lista se
 * queda con los comodines de hace semanas y no ve los nuevos.
 *
 * Se lanza desacoplado desde SessionStart como mucho una vez cada
 * REFRESH_EVERY_MS: los comodines cambian despacio y la pasada compite por CPU
 * con el daemon.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

function hubsPath() {
  return path.join(os.homedir(), '.ultron', 'cockpit', 'memory-hubs.json');
}

/** ¿Toca regenerar? true si no existe o su mtime supera `maxAgeMs`. Puro salvo el stat. */
function hubsStale(file = hubsPath(), now = Date.now(), maxAgeMs = REFRESH_EVERY_MS) {
  try {
    return now - fs.statSync(file).mtimeMs > maxAgeMs;
  } catch {
    return true;
  }
}

/**
 * Lanza `hubs --apply` desacoplado si toca. `spawn` se inyecta (spawnDetached
 * en producción). Devuelve true si lo lanzó. Nunca lanza.
 */
function maybeRefreshHubs(spawn, opts = {}) {
  if (process.env.ULTRON_HUBS_REFRESH === 'off') return false;
  try {
    if (!hubsStale(opts.file, opts.now, opts.maxAgeMs)) return false;
    return Boolean(spawn(['hubs', '--apply']));
  } catch {
    return false;
  }
}

module.exports = { hubsPath, hubsStale, maybeRefreshHubs, REFRESH_EVERY_MS };
