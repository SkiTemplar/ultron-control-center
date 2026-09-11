/**
 * research-integration.selftest.mjs — check hermetico (fetch simulado con
 * las fixtures reales de __fixtures__/, sin red) de extremo a extremo:
 * search() fusionando OpenAlex+Semantic Scholar, resolveAccess() con DOI
 * inexistente (caso negativo -> error claro) y sin PDF abierto (lo dice, no
 * inventa enlace), y generacion de refs.bib desde una sesion real en disco
 * (carpeta temporal via RESEARCH_ROOT_OVERRIDE).
 * Uso: node hooks/scripts/research-integration.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

process.env.RESEARCH_ROOT_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-selftest-'));
process.env.RESEARCH_CACHE_DIR_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-selftest-cache-'));
// Hermetico de verdad: el re-rank semantico habla por TCP con el daemon real
// (no pasa por el fetch simulado), asi que este selftest lo desactiva y
// verifica el camino de degradacion explicita (ver research-ranking.selftest
// para el semantico real end-to-end contra el daemon vivo).
process.env.RESEARCH_DISABLE_SEMANTIC = '1';

const { installMockFetch } = require(join(LIB, '__fixtures__', 'mock-fetch.js'));
const openalexFixture = require(join(LIB, '__fixtures__', 'openalex-search.json'));
const s2Fixture = require(join(LIB, '__fixtures__', 's2-search.json'));
const crossrefWorkFixture = require(join(LIB, '__fixtures__', 'crossref-work.json'));
const { readFileSync } = require('node:fs');
const bibtexFixture = readFileSync(join(LIB, '__fixtures__', 'crossref-bibtex.txt'), 'utf8');

const rateLimiter = require(join(LIB, 'rate-limiter.js'));
const { NotFoundError } = require(join(LIB, 'errors.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function installFixtureRoutes() {
  return installMockFetch([
    { test: (u) => u.startsWith('https://api.openalex.org/works?'), handler: { status: 200, body: openalexFixture, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes('10.1109%2Faccess.2019.2939201'), handler: { status: 200, body: openalexFixture.results[0], isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes('10.1234'), handler: { status: 404, body: 'not found' } },
    { test: (u) => u.startsWith('https://api.semanticscholar.org/graph/v1/paper/search'), handler: { status: 200, body: s2Fixture, isText: false } },
    { test: (u) => u.includes('/paper/DOI:') && u.toLowerCase().includes('10.1109%2faccess.2019.2939201'), handler: { status: 200, body: s2Fixture.data[0], isText: false } },
    { test: (u) => u.includes('/paper/DOI:') && u.includes('10.1234'), handler: { status: 404, body: 'not found' } },
    { test: (u) => u.startsWith('https://api.crossref.org/works/') && u.includes('10.1109%2Faccess.2019.2939201'), handler: { status: 200, body: crossrefWorkFixture, isText: false } },
    { test: (u) => u.startsWith('https://api.crossref.org/works/') && u.includes('10.1234'), handler: { status: 404, body: 'Resource not found.' } },
    { test: (u) => u.startsWith('https://doi.org/') && u.includes('10.1109%2Faccess.2019.2939201'), handler: { status: 200, body: bibtexFixture, isText: true } },
  ]);
}

async function testSearchEndToEnd() {
  rateLimiter._reset();
  const mock = installFixtureRoutes();
  try {
    const { search } = require(join(LIB, 'search.js'));
    const { results, warnings, totalBeforeFilter } = await search('synthetic data sim-to-real object detection drones', { limit: 5 });
    A(warnings.length === 1 && warnings[0].includes('re-rank semantico no disponible'), 'search: ambas fuentes responden, solo avisa que el semantico esta desactivado (RESEARCH_DISABLE_SEMANTIC)', JSON.stringify(warnings));
    A(totalBeforeFilter === 4, 'search: 6 normalizados fusionan en 4 unicos', String(totalBeforeFilter));
    // Este test verifica el CABLEADO (dedupe/merge/orden con razon), no la calidad del
    // ranking -- eso lo cubre research-ranking.selftest.mjs con fixtures etiquetados a mano.
    A(results[0].doi === '10.1109/access.2019.2939201', 'search: el paper confirmado por ambas fuentes (mayor relevancia combinada) va primero', results[0].doi);
    A(results.every((p) => typeof p.rankReason === 'string'), 'search: todos los resultados traen razon de orden', 'ok');
  } finally {
    mock.restore();
  }
}

async function testAccessNoOpenAccess() {
  rateLimiter._reset();
  const mock = installMockFetch([
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes('10.9999'), handler: { status: 200, body: { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.9999/no-oa', best_oa_location: null, open_access: { is_oa: false } }, isText: false } },
    { test: (u) => u.includes('/paper/DOI:') && u.includes('10.9999'), handler: { status: 404, body: 'not found' } },
  ]);
  try {
    const { resolveAccess } = require(join(LIB, 'access.js'));
    const result = await resolveAccess('10.9999/no-oa');
    A(result.openAccessPdf === null, 'resolveAccess: DOI existe pero sin OA -> openAccessPdf null explicito (no inventa URL)', JSON.stringify(result.openAccessPdf));
    A(result.checkedSources.includes('openalex'), 'resolveAccess: registra que fuentes se consultaron', JSON.stringify(result.checkedSources));
  } finally {
    mock.restore();
  }
}

async function testAccessDoiNotFound() {
  rateLimiter._reset();
  const mock = installMockFetch([
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes('10.1234'), handler: { status: 404, body: 'not found' } },
    { test: (u) => u.includes('/paper/DOI:') && u.includes('10.1234'), handler: { status: 404, body: 'not found' } },
  ]);
  try {
    const { resolveAccess } = require(join(LIB, 'access.js'));
    let thrown = null;
    try {
      await resolveAccess('10.1234/nonexistent-doi-zzz-999');
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof NotFoundError, 'resolveAccess: DOI inexistente en ambas fuentes -> NotFoundError (error claro)', String(thrown?.name));
  } finally {
    mock.restore();
  }
}

async function testSessionAndBib() {
  rateLimiter._reset();
  const mock = installFixtureRoutes();
  try {
    const research = require(join(LIB, 'index.js'));
    const { normalizeOpenAlexWork } = require(join(LIB, 'normalize.js'));
    const session = research.newSession('tfg sim-to-real drones');
    const paper = normalizeOpenAlexWork(openalexFixture.results[0]);
    const count = research.addPaper(session.id, paper);
    A(count === 1, 'session: addPaper guarda 1 paper en papers.json', String(count));

    const paperNoDoi = normalizeOpenAlexWork(openalexFixture.results[3]); // sin DOI
    research.addPaper(session.id, paperNoDoi);
    const papers = research.readPapers(session.id);
    A(papers.length === 2, 'session: addPaper acumula sin pisar el anterior', String(papers.length));

    const bib = await research.writeBib(session.id);
    A(bib.count === 1, 'writeBib: solo genera entrada para el paper CON doi', String(bib.count));
    A(bib.warnings.some((w) => w.includes('sin DOI')), 'writeBib: el paper sin DOI queda en warnings, no se inventa BibTeX', JSON.stringify(bib.warnings));
    const bibContent = readFileSync(bib.file, 'utf8');
    A(bibContent.trim().startsWith('@article'), 'writeBib: refs.bib contiene BibTeX real (empieza por @article)', bibContent.slice(0, 40));
    A(bibContent.includes('10.1109/access.2019.2939201'), 'writeBib: el DOI aparece en el BibTeX generado', 'ok');
  } finally {
    mock.restore();
  }
}

async function main() {
  await testSearchEndToEnd();
  await testAccessNoOpenAccess();
  await testAccessDoiNotFound();
  await testSessionAndBib();
  rmSync(process.env.RESEARCH_ROOT_OVERRIDE, { recursive: true, force: true });
  rmSync(process.env.RESEARCH_CACHE_DIR_OVERRIDE, { recursive: true, force: true });
  console.log(fail === 0 ? '\nSELFTEST RESEARCH-INTEGRATION: VERDE' : `\nSELFTEST RESEARCH-INTEGRATION: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
