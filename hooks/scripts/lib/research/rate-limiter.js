'use strict';

/**
 * lib/research/rate-limiter.js — limitador de ritmo por namespace (una fuente
 * externa = un namespace: 'openalex', 'semanticscholar', 'crossref',
 * 'unpaywall'). Cola FIFO en memoria por proceso: cada acquire() espera lo
 * necesario para respetar minIntervalMs desde la ultima peticion admitida de
 * ese namespace. No hay concurrencia entre procesos (no hace falta: el CLI y
 * el MCP corren como comandos cortos, no como servicio compartido).
 */

const lastCallAt = new Map(); // namespace -> timestamp (ms) de la ultima peticion admitida
const queues = new Map(); // namespace -> Promise (cola de turnos pendientes)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reserva un turno para `namespace` respetando minIntervalMs entre llamadas.
 * Devuelve una promesa que resuelve cuando es seguro disparar la peticion.
 */
function acquire(namespace, minIntervalMs) {
  const prevTurn = queues.get(namespace) ?? Promise.resolve();
  const turn = prevTurn.then(async () => {
    const last = lastCallAt.get(namespace) ?? 0;
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt.set(namespace, Date.now());
  });
  queues.set(namespace, turn.catch(() => {})); // una reserva fallida no debe atascar la cola
  return turn;
}

/** Solo para tests: resetea el estado del limitador entre casos. */
function _reset() {
  lastCallAt.clear();
  queues.clear();
}

module.exports = { acquire, _reset };
