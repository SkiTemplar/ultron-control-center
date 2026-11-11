'use strict';

/**
 * lib/research/rate-limiter.js — limitador de ritmo por namespace (una fuente
 * externa = un namespace: 'openalex', 'semanticscholar', 'crossref',
 * 'unpaywall'). Cola FIFO en memoria por proceso: cada acquire() espera lo
 * necesario para respetar minIntervalMs desde la ultima peticion admitida de
 * ese namespace y, ademas, cualquier pausa fijada con defer() (un 429 enfria
 * la fuente para toda la cola, no solo para la peticion que lo recibio). No
 * hay coordinacion entre procesos: cada sesion de Claude lanza su propio MCP.
 */

const lastCallAt = new Map(); // namespace -> timestamp (ms) de la ultima peticion admitida
const blockedUntil = new Map(); // namespace -> timestamp (ms) hasta el que la fuente esta en pausa
const queues = new Map(); // namespace -> Promise (cola de turnos pendientes)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(namespace, minIntervalMs) {
  const last = lastCallAt.get(namespace) ?? 0;
  const ready = Math.max(last + minIntervalMs, blockedUntil.get(namespace) ?? 0);
  return ready - Date.now();
}

/**
 * Reserva un turno para `namespace` respetando minIntervalMs entre llamadas
 * y la pausa vigente. Devuelve una promesa que resuelve cuando es seguro
 * disparar la peticion. Se recalcula tras cada espera: un defer() llegado
 * mientras el turno dormia tambien se respeta. Si `skipIf()` es cierto al
 * empezar el turno o tras una espera, el turno se cede sin esperar mas ni
 * contar como peticion (el llamador no va a disparar nada).
 */
function acquire(namespace, minIntervalMs, { skipIf = null } = {}) {
  const prevTurn = queues.get(namespace) ?? Promise.resolve();
  const turn = prevTurn.then(async () => {
    for (let wait = waitFor(namespace, minIntervalMs); ; wait = waitFor(namespace, minIntervalMs)) {
      if (skipIf?.()) return;
      if (wait <= 0) break;
      await sleep(wait);
    }
    lastCallAt.set(namespace, Date.now());
  });
  queues.set(namespace, turn.catch(() => {})); // una reserva fallida no debe atascar la cola
  return turn;
}

/** Pausa `namespace` durante `ms` para todas las peticiones pendientes (nunca acorta una pausa vigente). */
function defer(namespace, ms) {
  if (!namespace || !(ms > 0)) return;
  const until = Date.now() + ms;
  if (until > (blockedUntil.get(namespace) ?? 0)) blockedUntil.set(namespace, until);
}

/** Solo para tests: resetea el estado del limitador entre casos. */
function _reset() {
  lastCallAt.clear();
  blockedUntil.clear();
  queues.clear();
}

module.exports = { acquire, defer, _reset };
