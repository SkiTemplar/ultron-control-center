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

// 2026-11-08: un 429 solo hacia esperar a la peticion que lo recibia; las
// demas de la cola seguian saliendo y alargaban el rate limit.
async function test429PausesWholeQueue() {
  rateLimiter._reset();
  const sentAt = [];
  const mock = installMockFetch([
    { test: (u) => u.includes('/first'), handler: [{ status: 429, headers: { 'retry-after': '0.4' }, body: 'rate limited' }, { status: 200, body: { ok: 1 }, isText: false }] },
    { test: (u) => u.includes('/second'), handler: { status: 200, body: { ok: 2 }, isText: false } },
  ]);
  const original = global.fetch;
  global.fetch = async (url, init) => {
    sentAt.push({ url: String(url), at: Date.now() });
    return original(url, init);
  };
  try {
    const opts = { namespace: 'test-pause', minIntervalMs: 100, retries: 2 };
    const start = Date.now();
    const [a, b] = await Promise.all([request('https://example.test/first', opts), request('https://example.test/second', opts)]);
    const second = sentAt.find((s) => s.url.includes('/second'));
    A(a.body.ok === 1 && b.body.ok === 2, 'pausa compartida: ambas peticiones terminan bien', JSON.stringify([a.body, b.body]));
    A(second.at - start >= 350, 'pausa compartida: la peticion en cola espera el Retry-After del 429 ajeno', `${second.at - start} ms`);
  } finally {
    global.fetch = original;
    mock.restore();
  }
}

async function testDeferNeverShortens() {
  rateLimiter._reset();
  rateLimiter.defer('test-defer', 300);
  rateLimiter.defer('test-defer', 10);
  const start = Date.now();
  await rateLimiter.acquire('test-defer', 0);
  A(Date.now() - start >= 250, 'defer: una pausa mas corta no acorta la vigente', `${Date.now() - start} ms`);
  rateLimiter._reset();
  const t0 = Date.now();
  await rateLimiter.acquire('test-defer', 0);
  A(Date.now() - t0 < 100, 'defer: sin pausa, acquire no espera (caso negativo)', `${Date.now() - t0} ms`);
}

// 2026-11-08: con la clave rechazada (403) el ritmo seguia en 1 req/s.
async function testS2PacingAfterKeyRejected() {
  rateLimiter._reset();
  const s2 = require(join(LIB, 'semantic-scholar.js'));
  const previous = process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'clave-de-prueba';
  s2._resetKeyRejected();
  const mock = installMockFetch([
    { test: (u) => u.includes('/paper/DOI:'), handler: [{ status: 403, body: 'Forbidden' }, { status: 200, body: { title: 'ok' }, isText: false }] },
  ]);
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    A(s2.minIntervalMs() === 1_000, 'S2: con clave valida, 1 req/s', String(s2.minIntervalMs()));
    const body = await s2.getPaperByDoi('10.9000/x');
    A(body.title === 'ok', 'S2: tras el 403 repite sin clave', JSON.stringify(body));
    A(mock.requests[1] && !('x-api-key' in mock.requests[1].headers), 'S2: el reintento no envia la clave', JSON.stringify(mock.requests[1]?.headers));
    A(s2.minIntervalMs() === 3_000, 'S2: con la clave rechazada, ritmo del pool anonimo (3 s)', String(s2.minIntervalMs()));
  } finally {
    process.stderr.write = stderrWrite;
    mock.restore();
    s2._resetKeyRejected();
    if (previous === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previous;
  }
}

// 2026-11-08: con varias peticiones en vuelo con la clave, solo la primera en
// recibir el 403 se repetia sin clave; las demas fallaban con 403.
async function testS2ConcurrentKeyRejection() {
  rateLimiter._reset();
  const s2 = require(join(LIB, 'semantic-scholar.js'));
  const previous = process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'clave-de-prueba';
  s2._resetKeyRejected();
  // La primera responde tarde: la segunda sale con la clave antes de que nadie la marque.
  const mock = installMockFetch([
    { test: (u) => u.includes('10.9000%2Fa'), handler: [{ status: 403, body: 'Forbidden' }, { status: 200, body: { title: 'a' }, isText: false }] },
    { test: (u) => u.includes('10.9000%2Fb'), handler: [{ status: 403, body: 'Forbidden' }, { status: 200, body: { title: 'b' }, isText: false }] },
  ]);
  const mocked = global.fetch;
  let delayedFirst = false;
  global.fetch = async (url, init) => {
    const res = await mocked(url, init);
    if (!delayedFirst && String(url).includes('10.9000%2Fa')) {
      delayedFirst = true;
      await new Promise((r) => setTimeout(r, 1_500)); // > 1 s de intervalo con clave
    }
    return res;
  };
  const stderrWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const results = await Promise.allSettled([s2.getPaperByDoi('10.9000/a'), s2.getPaperByDoi('10.9000/b')]);
    const titles = results.map((r) => (r.status === 'fulfilled' ? r.value.title : `ERROR ${r.reason?.message}`));
    A(titles[0] === 'a' && titles[1] === 'b', 'S2: dos peticiones en vuelo con la clave rechazada se repiten ambas sin clave', JSON.stringify(titles));
    A(mock.requests.filter((r) => !('x-api-key' in r.headers)).length === 2, 'S2: exactamente 2 reintentos sin clave', JSON.stringify(mock.requests.map((r) => Object.keys(r.headers))));
  } finally {
    process.stderr.write = stderrWrite;
    global.fetch = mocked;
    mock.restore();
    s2._resetKeyRejected();
    if (previous === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previous;
  }
}

// 2026-11-08: sin clave valida, 5 busquedas en paralelo tardaban 3 min en
// reintentos contra un pool global saturado y 4 acababan igual en 429.
async function testS2SearchBreaker() {
  rateLimiter._reset();
  const s2 = require(join(LIB, 'semantic-scholar.js'));
  const previous = process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  s2._resetKeyRejected();
  const limited = { status: 429, headers: { 'retry-after': '0' }, body: 'Too Many Requests' };
  const mock = installMockFetch([{ test: (u) => u.includes('/paper/search?'), handler: [limited, limited, { status: 200, body: { data: [{ title: 'x' }] }, isText: false }] }]);
  try {
    const start = Date.now();
    const outcomes = await Promise.allSettled(['q1', 'q2', 'q3'].map((q) => s2.searchPapers(q)));
    const elapsed = Date.now() - start;
    A(outcomes.every((o) => o.status === 'rejected' && o.reason.status === 429), 'S2 breaker: las tres busquedas fallan con 429', JSON.stringify(outcomes.map((o) => o.status)));
    A(mock.calls.length === 2, 'S2 breaker: sin clave, 1 intento + 1 reintento y las de la cola no llaman a S2', String(mock.calls.length));
    A(elapsed < 6_000, 'S2 breaker: las de la cola no consumen huecos de 3 s', `${elapsed} ms`);
    A(String(outcomes[2].reason.message).includes('sin SEMANTIC_SCHOLAR_API_KEY'), 'S2 breaker: el aviso dice el estado de la clave', String(outcomes[2].reason.message));
    s2._resetKeyRejected();
    rateLimiter._reset();
    const after = await s2.searchPapers('q4');
    A(after.length === 1 && mock.calls.length === 3, 'S2 breaker: cerrado el cortocircuito, vuelve a consultar (caso negativo)', String(mock.calls.length));
  } finally {
    mock.restore();
    s2._resetKeyRejected();
    if (previous !== undefined) process.env.SEMANTIC_SCHOLAR_API_KEY = previous;
  }
}

async function testS2BreakerClosesOnProbeSuccess() {
  rateLimiter._reset();
  const s2 = require(join(LIB, 'semantic-scholar.js'));
  const previous = process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  s2._resetKeyRejected();
  const okBody = { status: 200, body: { data: [{ title: 'x' }] }, isText: false };
  const mock = installMockFetch([{ test: (u) => u.includes('/paper/search?'), handler: [{ status: 429, headers: { 'retry-after': '0' }, body: 'Too Many Requests' }, okBody, okBody] }]);
  try {
    const probe = await s2.searchPapers('sonda');
    A(probe.length === 1, 'S2 breaker: la sonda reintenta y devuelve resultados', JSON.stringify(probe));
    const next = await s2.searchPapers('siguiente');
    A(next.length === 1 && mock.calls.length === 3, 'S2 breaker: una sonda con exito cierra la pausa', String(mock.calls.length));
  } finally {
    mock.restore();
    s2._resetKeyRejected();
    if (previous !== undefined) process.env.SEMANTIC_SCHOLAR_API_KEY = previous;
  }
}

// 2026-11-08: OpenAlex pedia Retry-After 8592 s y la busqueda se colgaba.
async function testRetryAfterTooLongFailsFast() {
  rateLimiter._reset();
  const mock = installMockFetch([
    { test: (u) => u.includes('/budget'), handler: [{ status: 429, headers: { 'retry-after': '8592' }, body: 'Insufficient budget' }, { status: 200, body: { ok: true }, isText: false }] },
  ]);
  try {
    const start = Date.now();
    let thrown = null;
    try {
      await request('https://example.test/budget', { namespace: 'test-budget', minIntervalMs: 0, retries: 3 });
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof HttpError && thrown.status === 429 && /Retry-After 8592 s/.test(thrown.message), 'Retry-After de horas: falla con 429 y dice cuanto pedia', String(thrown?.message));
    A(mock.calls.length === 1 && Date.now() - start < 1_000, 'Retry-After de horas: no reintenta ni espera', `${mock.calls.length} llamadas, ${Date.now() - start} ms`);
  } finally {
    mock.restore();
  }
}

async function testKeysHydration() {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const keys = require(join(LIB, 'keys.js'));
  const saved = Object.fromEntries(keys.KEY_VARS.map((n) => [n, process.env[n]]));
  const dir = mkdtempSync(join(tmpdir(), 'research-keys-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'OPENALEX_API_KEY="desde-fichero"\nSEMANTIC_SCHOLAR_API_KEY=desde-fichero\n');
  process.env.RESEARCH_ENV_FILE = envFile;
  try {
    for (const n of keys.KEY_VARS) delete process.env[n];
    process.env.SEMANTIC_SCHOLAR_API_KEY = 'del-proceso';
    const recovered = keys.hydrateResearchEnv();
    A(process.env.OPENALEX_API_KEY === 'desde-fichero' && recovered.some((r) => r.name === 'OPENALEX_API_KEY' && r.source === '.env'), 'keys: una clave ausente se toma del .env', JSON.stringify(recovered));
    A(process.env.SEMANTIC_SCHOLAR_API_KEY === 'del-proceso', 'keys: el entorno del proceso manda sobre el .env', process.env.SEMANTIC_SCHOLAR_API_KEY === 'del-proceso' ? 'ok' : 'pisada');
    A(!JSON.stringify(recovered).includes('desde-fichero'), 'keys: el diagnostico no lleva valores', JSON.stringify(recovered));
    for (const n of keys.KEY_VARS) delete process.env[n];
    process.env.RESEARCH_NO_USER_ENV = '1';
    A(keys.hydrateResearchEnv().length === 0 && !process.env.OPENALEX_API_KEY, 'keys: con RESEARCH_NO_USER_ENV=1 no lee nada (caso negativo)', String(process.env.OPENALEX_API_KEY));
  } finally {
    delete process.env.RESEARCH_NO_USER_ENV;
    delete process.env.RESEARCH_ENV_FILE;
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    rmSync(dir, { recursive: true, force: true });
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
  await test429PausesWholeQueue();
  await testDeferNeverShortens();
  await testS2PacingAfterKeyRejected();
  await testS2ConcurrentKeyRejection();
  await testS2SearchBreaker();
  await testS2BreakerClosesOnProbeSuccess();
  await testRetryAfterTooLongFailsFast();
  await testKeysHydration();
  await testNonRetryable4xx();
  await testExhaustsRetriesOn5xx();
  await testTimeout();
  console.log(fail === 0 ? '\nSELFTEST RESEARCH-HTTP: VERDE' : `\nSELFTEST RESEARCH-HTTP: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
