/**
 * research-http.selftest.mjs — check hermetico (fetch simulado, sin red) de
 * lib/research/http.js: reintentos con backoff ante 429/5xx (respetando
 * Retry-After), 4xx no reintentable falla al primer intento, y timeout.
 * Uso: node hooks/scripts/research-http.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

const { request } = require(join(LIB, 'http.js'));
const { HttpError, TimeoutError } = require(join(LIB, 'errors.js'));
const { installMockFetch } = require(join(LIB, '__fixtures__', 'mock-fetch.js'));
const rateLimiter = require(join(LIB, 'rate-limiter.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

async function testBackoffOn429ThenSuccess() {
  rateLimiter._reset();
  const mock = installMockFetch([
    { test: (u) => u.includes('/retry-me'), handler: [{ status: 429, headers: { 'retry-after': '0' }, body: 'rate limited' }, { status: 200, body: { ok: true }, isText: false }] },
  ]);
  try {
    const { body } = await request('https://example.test/retry-me', { namespace: 'test-backoff', minIntervalMs: 0, retries: 2 });
    A(body.ok === true, 'request: reintenta tras 429 y devuelve el 200 siguiente', JSON.stringify(body));
    A(mock.calls.length === 2, 'request: exactamente 2 llamadas (1 fallo + 1 exito)', String(mock.calls.length));
  } finally {
    mock.restore();
  }
}

async function testNonRetryable4xx() {
  rateLimiter._reset();
  const mock = installMockFetch([
    { test: (u) => u.includes('/bad-request'), handler: { status: 400, body: 'peticion invalida' } },
  ]);
  try {
    let thrown = null;
    try {
      await request('https://example.test/bad-request', { namespace: 'test-4xx', minIntervalMs: 0, retries: 3 });
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof HttpError && thrown.status === 400, 'request: 400 lanza HttpError con status', String(thrown?.status));
    A(mock.calls.length === 1, 'request: un 4xx NO reintentable dispara solo 1 llamada (no gasta reintentos en vano)', String(mock.calls.length));
  } finally {
    mock.restore();
  }
}

async function testExhaustsRetriesOn5xx() {
  rateLimiter._reset();
  const mock = installMockFetch([
    { test: (u) => u.includes('/always-down'), handler: { status: 503, body: 'caido' } },
  ]);
  try {
    let thrown = null;
    try {
      await request('https://example.test/always-down', { namespace: 'test-5xx', minIntervalMs: 0, retries: 2 });
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof HttpError && thrown.status === 503, 'request: agota reintentos en 503 persistente y lanza HttpError explicito', String(thrown?.status));
    A(mock.calls.length === 3, 'request: 1 intento + 2 reintentos = 3 llamadas', String(mock.calls.length));
  } finally {
    mock.restore();
  }
}

async function testTimeout() {
  rateLimiter._reset();
  const original = global.fetch;
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  try {
    let thrown = null;
    try {
      await request('https://example.test/never-responds', { namespace: 'test-timeout', minIntervalMs: 0, timeoutMs: 50, retries: 0 });
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof TimeoutError, 'request: una peticion que nunca responde lanza TimeoutError, no se cuelga', String(thrown?.name));
  } finally {
    global.fetch = original;
  }
}

async function main() {
  await testBackoffOn429ThenSuccess();
  await testNonRetryable4xx();
  await testExhaustsRetriesOn5xx();
  await testTimeout();
  console.log(fail === 0 ? '\nSELFTEST RESEARCH-HTTP: VERDE' : `\nSELFTEST RESEARCH-HTTP: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
