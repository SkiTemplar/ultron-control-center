'use strict';

/**
 * __fixtures__/mock-fetch.js — helper SOLO para selftests: sustituye
 * global.fetch por una implementacion determinista sobre `routes` (lista de
 * { test(url) -> bool, handler(url) -> respuesta|respuesta[] }). Cada
 * elemento de `handler` que sea array se consume en orden (permite simular
 * "falla la primera vez, responde bien la segunda" para los tests de
 * backoff). Nunca toca la red real.
 */

function fakeResponse({ status = 200, body = '', headers = {}, isText = false }) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headerMap.get(String(k).toLowerCase()) ?? null },
    json: async () => (isText ? JSON.parse(body) : body),
    text: async () => (isText ? body : JSON.stringify(body)),
  };
}

/** Instala el mock; devuelve { calls, restore() } para inspeccionar/desmontar. */
function installMockFetch(routes) {
  const original = global.fetch;
  const calls = [];
  const cursors = new Map();

  global.fetch = async (url) => {
    calls.push(String(url));
    const route = routes.find((r) => r.test(String(url)));
    if (!route) throw new Error(`mock-fetch: sin ruta para ${url}`);
    const step = cursors.get(route) ?? 0;
    const seq = Array.isArray(route.handler) ? route.handler : [route.handler];
    const spec = seq[Math.min(step, seq.length - 1)];
    cursors.set(route, step + 1);
    return fakeResponse(spec);
  };

  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

module.exports = { installMockFetch, fakeResponse };
