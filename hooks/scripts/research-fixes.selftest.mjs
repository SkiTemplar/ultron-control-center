/**
 * research-fixes.selftest.mjs — regresiones del MCP de research (2026-09-23),
 * hermético (fetch simulado, sin red):
 *   1. Los errores HTTP no filtran api_key/mailto/email (llegaban al chat).
 *   2. title_and_abstract.search no rompe el filtro con «,», «:» o «|» (HTTP 400).
 *   3. Semantic Scholar: un 403 con clave repite sin clave en vez de fallar.
 * Uso: node hooks/scripts/research-fixes.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

process.env.RESEARCH_CACHE_DIR_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-fixes-cache-'));

const { request, redactUrl } = require(join(LIB, 'http.js'));
const { HttpError } = require(join(LIB, 'errors.js'));
const { filterSafeText } = require(join(LIB, 'openalex.js'));
const s2 = require(join(LIB, 'semantic-scholar.js'));
const { installMockFetch } = require(join(LIB, '__fixtures__', 'mock-fetch.js'));
const rateLimiter = require(join(LIB, 'rate-limiter.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const SECRET_KEY = 'oa-secret-123';
const SECRET_MAIL = 'alumno@example.edu';

function testRedactUrl() {
  const url = `https://api.openalex.org/works?api_key=${SECRET_KEY}&mailto=${encodeURIComponent(SECRET_MAIL)}&search=drones`;
  const safe = redactUrl(url);
  A(!safe.includes(SECRET_KEY) && !safe.includes('alumno'), 'redactUrl: oculta api_key y mailto', safe);
  A(safe.includes('search=drones'), 'redactUrl: conserva los parametros no sensibles', safe);
  A(!redactUrl('no es una url ?api_key=x').includes('api_key=x'), 'redactUrl: URL ilegible se corta en la query', redactUrl('no es una url ?api_key=x'));
}

async function testHttpErrorIsRedacted() {
  rateLimiter._reset();
  const mock = installMockFetch([{ test: () => true, handler: { status: 400, body: 'bad filter', isText: true } }]);
  try {
    await request(`https://api.openalex.org/works?api_key=${SECRET_KEY}&mailto=${SECRET_MAIL}`, { retries: 0 });
    ko('HttpError redactado', 'no lanzo');
  } catch (e) {
    const texto = `${e.message} ${e.url}`;
    A(e instanceof HttpError && e.status === 400, 'HttpError: sigue siendo un 400', String(e.status));
    A(!texto.includes(SECRET_KEY) && !texto.includes(SECRET_MAIL), 'HttpError: mensaje y url sin credenciales', texto);
  } finally {
    mock.restore();
  }
}

function testFilterSafeText() {
  const t = filterSafeText('Sim-to-Real: bridging the gap, again | drones');
  A(!/[,:|]/.test(t), 'filterSafeText: sin , : ni |', t);
  A(t === 'Sim-to-Real bridging the gap again drones', 'filterSafeText: conserva palabras y guiones', t);
}

async function testS2KeyRejectedFallsBackWithoutKey() {
  rateLimiter._reset();
  s2._resetKeyRejected();
  const prev = process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'clave-revocada';
  // 1.ª llamada (con clave): 403. 2.ª (sin clave): 200.
  const mock = installMockFetch([
    { test: (u) => u.includes('/paper/DOI:'), handler: [{ status: 403, body: { message: 'Forbidden' } }, { status: 200, body: { title: 'ok' } }] },
  ]);
  const errWrite = process.stderr.write.bind(process.stderr);
  let aviso = '';
  process.stderr.write = (s) => { aviso += s; return true; };
  try {
    const paper = await s2.getPaperByDoi('10.1/x');
    A(paper && paper.title === 'ok', 'S2 403: repite sin clave y devuelve el paper', JSON.stringify(paper));
    A(mock.requests.length === 2, 'S2 403: exactamente 2 peticiones', String(mock.requests.length));
    A(mock.requests[0].headers['x-api-key'] === 'clave-revocada', 'S2 403: la 1.ª lleva la clave', JSON.stringify(mock.requests[0].headers));
    A(!('x-api-key' in mock.requests[1].headers), 'S2 403: la 2.ª va sin clave', JSON.stringify(mock.requests[1].headers));
    A(aviso.includes('rechaza SEMANTIC_SCHOLAR_API_KEY') && !aviso.includes('clave-revocada'), 'S2 403: avisa sin imprimir la clave', aviso);
  } finally {
    process.stderr.write = errWrite;
    mock.restore();
    s2._resetKeyRejected();
    if (prev === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = prev;
  }
}

async function testS2OtherErrorsStillFail() {
  rateLimiter._reset();
  s2._resetKeyRejected();
  const prev = process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  const mock = installMockFetch([{ test: () => true, handler: { status: 403, body: { message: 'Forbidden' } } }]);
  try {
    await s2.getPaperByDoi('10.1/y');
    ko('S2 403 sin clave', 'no lanzo');
  } catch (e) {
    A(e instanceof HttpError && e.status === 403 && mock.requests.length === 1, 'S2 403 SIN clave: falla sin reintentar (caso negativo)', `${e.status} x${mock.requests.length}`);
  } finally {
    mock.restore();
    if (prev !== undefined) process.env.SEMANTIC_SCHOLAR_API_KEY = prev;
  }
}

testRedactUrl();
await testHttpErrorIsRedacted();
testFilterSafeText();
await testS2KeyRejectedFallsBackWithoutKey();
await testS2OtherErrorsStillFail();

console.log(fail ? `\n${fail} FAIL` : '\nOK');
process.exit(fail ? 1 : 0);
