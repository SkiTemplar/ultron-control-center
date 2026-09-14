/**
 * research-retraction.selftest.mjs — check hermetico (fetch simulado con
 * fixtures, sin red) de retraction.js + crossref.js::extractRetractionNotices:
 * notice de publisher, notice de Retraction Watch, caso sin retraccion,
 * DOI 404 en ambas fuentes (caso negativo) y flag is_retracted solo-OpenAlex
 * (Crossref no lo conoce, pero OpenAlex si lo marca).
 * Uso: node hooks/scripts/research-retraction.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

const { installMockFetch } = require(join(LIB, '__fixtures__', 'mock-fetch.js'));
const retractedPublisher = require(join(LIB, '__fixtures__', 'crossref-retraction-publisher.json'));
const retractedWatch = require(join(LIB, '__fixtures__', 'crossref-retraction-watch.json'));
const cleanWork = require(join(LIB, '__fixtures__', 'crossref-no-retraction.json'));
const rateLimiter = require(join(LIB, 'rate-limiter.js'));
const { NotFoundError } = require(join(LIB, 'errors.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const openalexNotRetracted = (doi) => ({ id: 'https://openalex.org/Wx', doi: `https://doi.org/${doi}`, is_retracted: false });
const openalexRetracted = (doi) => ({ id: 'https://openalex.org/Wy', doi: `https://doi.org/${doi}`, is_retracted: true });
const notFound = { status: 404, body: 'Resource not found.' };

function mockRoutes(routes) {
  return installMockFetch(routes.map(([doiFragment, crossrefBody, openalexBody]) => [
    { test: (u) => u.startsWith('https://api.crossref.org/works/') && u.includes(encodeURIComponent(doiFragment)), handler: crossrefBody === null ? notFound : { status: 200, body: crossrefBody, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes(encodeURIComponent(doiFragment)), handler: openalexBody === null ? notFound : { status: 200, body: openalexBody, isText: false } },
  ]).flat());
}

async function testRetractionPublisher() {
  rateLimiter._reset();
  const doi = '10.9100/retracted-publisher';
  const mock = mockRoutes([[doi, retractedPublisher, openalexNotRetracted(doi)]]);
  try {
    const { checkRetraction } = require(join(LIB, 'retraction.js'));
    const result = await checkRetraction(doi);
    A(result.isRetracted === true, 'retraction publisher: isRetracted true', JSON.stringify(result));
    A(result.sources.includes('publisher'), 'retraction publisher: source = publisher', JSON.stringify(result.sources));
    A(result.notices.length === 1 && result.notices[0].doi === '10.9100/retraction-notice-1', 'retraction publisher: notice trae el DOI de la retraction notice', JSON.stringify(result.notices));
    A(result.notices[0].date === '2024-03-15', 'retraction publisher: fecha de la notice parseada de date-parts', result.notices[0].date);
  } finally {
    mock.restore();
  }
}

async function testRetractionWatch() {
  rateLimiter._reset();
  const doi = '10.9101/retracted-watch';
  // OpenAlex no conoce este DOI (404): Crossref por si solo ya confirma la retraccion.
  const mock = mockRoutes([[doi, retractedWatch, null]]);
  try {
    const { checkRetraction } = require(join(LIB, 'retraction.js'));
    const result = await checkRetraction(doi);
    A(result.isRetracted === true, 'retraction watch: isRetracted true aunque OpenAlex no conozca el DOI', JSON.stringify(result));
    A(result.sources.includes('retraction-watch'), 'retraction watch: source = retraction-watch', JSON.stringify(result.sources));
  } finally {
    mock.restore();
  }
}

async function testNoRetraction() {
  rateLimiter._reset();
  const doi = '10.9102/clean-paper';
  const mock = mockRoutes([[doi, cleanWork, openalexNotRetracted(doi)]]);
  try {
    const { checkRetraction } = require(join(LIB, 'retraction.js'));
    const result = await checkRetraction(doi);
    A(result.isRetracted === false, 'sin retraccion: isRetracted false', JSON.stringify(result));
    A(result.sources.length === 0 && result.notices.length === 0, 'sin retraccion: sin fuentes ni notices inventadas', JSON.stringify(result));
  } finally {
    mock.restore();
  }
}

async function testOpenAlexOnlyFlag() {
  rateLimiter._reset();
  // Crossref no conoce el DOI, pero OpenAlex si lo marca is_retracted: combinacion, no solo Crossref.
  const doi = '10.9103/openalex-only-retracted';
  const mock = mockRoutes([[doi, null, openalexRetracted(doi)]]);
  try {
    const { checkRetraction } = require(join(LIB, 'retraction.js'));
    const result = await checkRetraction(doi);
    A(result.isRetracted === true, 'solo-OpenAlex: is_retracted de OpenAlex basta para marcar isRetracted', JSON.stringify(result));
    A(result.sources.includes('openalex') && !result.sources.includes('publisher'), 'solo-OpenAlex: la fuente es openalex, no una notice de Crossref inventada', JSON.stringify(result.sources));
  } finally {
    mock.restore();
  }
}

async function testDoiNotFoundInBoth() {
  rateLimiter._reset();
  const doi = '10.9999/totally-unknown';
  const mock = mockRoutes([[doi, null, null]]);
  try {
    const { checkRetraction } = require(join(LIB, 'retraction.js'));
    let thrown = null;
    try {
      await checkRetraction(doi);
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof NotFoundError, 'DOI 404 en Crossref y OpenAlex: NotFoundError (caso negativo, error claro)', String(thrown?.name));
  } finally {
    mock.restore();
  }
}

async function main() {
  await testRetractionPublisher();
  await testRetractionWatch();
  await testNoRetraction();
  await testOpenAlexOnlyFlag();
  await testDoiNotFoundInBoth();
  console.log(fail === 0 ? '\nSELFTEST RESEARCH-RETRACTION: VERDE' : `\nSELFTEST RESEARCH-RETRACTION: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
