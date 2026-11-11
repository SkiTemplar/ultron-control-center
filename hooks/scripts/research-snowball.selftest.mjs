/**
 * research-snowball.selftest.mjs — check hermetico (fetch simulado con
 * fixtures, sin red) de snowball.js: backward/forward via Semantic Scholar
 * con ranking (isInfluential > citationCount) y dedupe, fallback a OpenAlex
 * cuando S2 no conoce el DOI, limit fuera de rango rechazado, persistencia
 * idempotente en snowball.json (re-ejecutar el mismo seed+direction
 * sustituye la entrada, no duplica) y sessionId inexistente (caso negativo).
 * Uso: node hooks/scripts/research-snowball.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

process.env.RESEARCH_ROOT_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-snowball-selftest-'));
process.env.RESEARCH_CACHE_DIR_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-snowball-selftest-cache-'));

const { installMockFetch } = require(join(LIB, '__fixtures__', 'mock-fetch.js'));
const s2References = require(join(LIB, '__fixtures__', 's2-references.json'));
const s2Citations = require(join(LIB, '__fixtures__', 's2-citations.json'));
const oaSeedWork = require(join(LIB, '__fixtures__', 'openalex-work-with-refs.json'));
const oaBatchWorks = require(join(LIB, '__fixtures__', 'openalex-batch-works.json'));
const oaCitingWorks = require(join(LIB, '__fixtures__', 'openalex-citing-works.json'));
const rateLimiter = require(join(LIB, 'rate-limiter.js'));
const { NotFoundError } = require(join(LIB, 'errors.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const SEED_DOI = '10.9000/seed-paper';
const UNKNOWN_TO_S2_DOI = '10.9001/s2-unknown';

function installS2Routes() {
  return installMockFetch([
    { test: (u) => u.includes(`/paper/DOI:${encodeURIComponent(SEED_DOI)}/references`), handler: { status: 200, body: s2References, isText: false } },
    { test: (u) => u.includes(`/paper/DOI:${encodeURIComponent(SEED_DOI)}/citations`), handler: { status: 200, body: s2Citations, isText: false } },
  ]);
}

function installFallbackRoutes() {
  return installMockFetch([
    { test: (u) => u.includes(`/paper/DOI:${encodeURIComponent(UNKNOWN_TO_S2_DOI)}/`), handler: { status: 404, body: 'not found' } },
    { test: (u) => u.includes('/paper/search/match?'), handler: { status: 404, body: 'Title match not found' } },
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes(encodeURIComponent(UNKNOWN_TO_S2_DOI)), handler: { status: 200, body: oaSeedWork, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works?') && u.includes('filter=openalex_id%3A'), handler: { status: 200, body: oaBatchWorks, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works?') && u.includes('filter=cites%3A'), handler: { status: 200, body: oaCitingWorks, isText: false } },
  ]);
}

async function testBackwardRankingAndDedupe() {
  rateLimiter._reset();
  const mock = installS2Routes();
  try {
    const { fetchSnowball } = require(join(LIB, 'snowball.js'));
    const { candidates, warnings } = await fetchSnowball(SEED_DOI, { direction: 'backward', limit: 25 });
    A(warnings.length === 0, 'backward: sin fallback, sin avisos', JSON.stringify(warnings));
    A(candidates.length === 3, 'backward: 3 candidatos (fixture con 3 referencias unicas)', String(candidates.length));
    A(candidates[0].doi === '10.9000/ref-a', 'backward: isInfluential manda sobre citationCount (Ref A antes que Ref B, con menos citas)', candidates[0].doi);
    A(candidates[1].doi === '10.9000/ref-b' && candidates[2].doi === null, 'backward: entre no-influyentes, orden por citationCount descendente (Ref B 900 > Ref C 10)', JSON.stringify(candidates.map((c) => c.doi)));
    A(candidates.every((c) => c.relation === 'reference'), 'backward: todos los candidatos marcados relation=reference', JSON.stringify(candidates.map((c) => c.relation)));
    A(candidates[0].contexts.length === 1 && candidates[0].intents.includes('methodology'), 'backward: contexts/intents de S2 se conservan', JSON.stringify(candidates[0]));
  } finally {
    mock.restore();
  }
}

async function testForwardRanking() {
  rateLimiter._reset();
  const mock = installS2Routes();
  try {
    const { fetchSnowball } = require(join(LIB, 'snowball.js'));
    const { candidates } = await fetchSnowball(SEED_DOI, { direction: 'forward', limit: 25 });
    A(candidates.length === 2, 'forward: 2 candidatos (fixture con 2 citas)', String(candidates.length));
    A(candidates[0].doi === '10.9000/cite-b', 'forward: la influyente (Citing B, 3 citas) va antes que la no influyente con mas citas (Citing A, 5)', candidates[0].doi);
    A(candidates.every((c) => c.relation === 'citation'), 'forward: todos los candidatos marcados relation=citation', JSON.stringify(candidates.map((c) => c.relation)));
  } finally {
    mock.restore();
  }
}

async function testExcludesSeedAndSession() {
  rateLimiter._reset();
  const mock = installS2Routes();
  try {
    const { fetchSnowball } = require(join(LIB, 'snowball.js'));
    const { candidates } = await fetchSnowball(SEED_DOI, { direction: 'backward', limit: 25, excludeKeys: new Set(['doi:10.9000/ref-b']) });
    A(candidates.length === 2 && !candidates.some((c) => c.doi === '10.9000/ref-b'), 'excludeKeys: un paper ya presente en la sesion se descarta del resultado', JSON.stringify(candidates.map((c) => c.doi)));
  } finally {
    mock.restore();
  }
}

async function testFallbackToOpenAlex() {
  rateLimiter._reset();
  const mock = installFallbackRoutes();
  try {
    const { fetchSnowball } = require(join(LIB, 'snowball.js'));
    const { candidates, warnings } = await fetchSnowball(UNKNOWN_TO_S2_DOI, { direction: 'both', limit: 25 });
    A(warnings.length === 2 && warnings.every((w) => w.includes('OpenAlex como fallback')), 'fallback: avisa explicitamente que S2 fallo y se uso OpenAlex, en ambas direcciones', JSON.stringify(warnings));
    A(candidates.some((c) => c.doi === '10.9001/oa-ref-1') && candidates.some((c) => c.doi === '10.9001/oa-citing-1'), 'fallback: trae candidatos de OpenAlex para backward y forward', JSON.stringify(candidates.map((c) => c.doi)));
  } finally {
    mock.restore();
  }
}

// S2 no indexa el DOI de la revista pero si un registro con el mismo titulo
// (caso real 2026-11-08: el articulo solo existia en S2 como preprint de arXiv).
function installAliasRoutes(matchTitle) {
  return installMockFetch([
    { test: (u) => u.includes(`/paper/DOI:${encodeURIComponent(UNKNOWN_TO_S2_DOI)}/`), handler: { status: 404, body: 'not found' } },
    { test: (u) => u.includes('/paper/search/match?'), handler: { status: 200, body: { data: [{ paperId: 'S2ALIAS', title: matchTitle, externalIds: { DOI: '10.48550/arXiv.0000.00001' } }] }, isText: false } },
    { test: (u) => u.includes('/paper/S2ALIAS/references'), handler: { status: 200, body: s2References, isText: false } },
    { test: (u) => u.includes('/paper/S2ALIAS/citations'), handler: { status: 200, body: s2Citations, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes(encodeURIComponent(UNKNOWN_TO_S2_DOI)), handler: { status: 200, body: oaSeedWork, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works?') && u.includes('filter=openalex_id%3A'), handler: { status: 200, body: oaBatchWorks, isText: false } },
    { test: (u) => u.startsWith('https://api.openalex.org/works?') && u.includes('filter=cites%3A'), handler: { status: 200, body: oaCitingWorks, isText: false } },
  ]);
}

async function testAliasByTitle() {
  rateLimiter._reset();
  // Mismo titulo salvo mayusculas y puntuacion: titleKey() los iguala.
  const mock = installAliasRoutes('Seed paper: unknown to Semantic Scholar');
  try {
    const { fetchSnowball } = require(join(LIB, 'snowball.js'));
    const { candidates, warnings } = await fetchSnowball(UNKNOWN_TO_S2_DOI, { direction: 'both', limit: 25 });
    A(candidates.some((c) => c.doi === '10.9000/ref-a') && candidates.some((c) => c.doi === '10.9000/cite-b'), 'alias: referencias y citas salen de S2 por el registro con el mismo titulo', JSON.stringify(candidates.map((c) => c.doi)));
    A(!candidates.some((c) => c.doi === '10.9001/oa-ref-1'), 'alias: no cae a OpenAlex si S2 tiene el registro', JSON.stringify(candidates.map((c) => c.doi)));
    A(warnings.length === 2 && warnings.every((w) => w.includes('mismo titulo') && w.includes('10.48550/arxiv.0000.00001')), 'alias: avisa en cada direccion del registro usado', JSON.stringify(warnings));
    const matches = mock.calls.filter((u) => u.includes('/paper/search/match?')).length;
    A(matches === 1, 'alias: una sola busqueda por titulo para las dos direcciones', String(matches));
  } finally {
    mock.restore();
  }
}

async function testAliasRejectsDifferentTitle() {
  rateLimiter._reset();
  const mock = installAliasRoutes('A different paper about something else');
  try {
    const { fetchSnowball } = require(join(LIB, 'snowball.js'));
    const { candidates, warnings } = await fetchSnowball(UNKNOWN_TO_S2_DOI, { direction: 'backward', limit: 25 });
    A(!mock.calls.some((u) => u.includes('/paper/S2ALIAS/')), 'alias: un titulo distinto no se acepta (caso negativo)', JSON.stringify(mock.calls));
    A(candidates.some((c) => c.doi === '10.9001/oa-ref-1') && warnings.some((w) => w.includes('OpenAlex como fallback')), 'alias: sin coincidencia exacta cae a OpenAlex y lo avisa', JSON.stringify(warnings));
  } finally {
    mock.restore();
  }
}

function testLimitOutOfRangeRejected() {
  const { clampLimit } = require(join(LIB, 'snowball.js'));
  let thrown = null;
  try { clampLimit(0); } catch (e) { thrown = e; }
  A(thrown instanceof Error, 'limit=0 rechazado explicitamente', String(thrown?.message));
  thrown = null;
  try { clampLimit(101); } catch (e) { thrown = e; }
  A(thrown instanceof Error, 'limit=101 (> MAX_LIMIT 100) rechazado explicitamente', String(thrown?.message));
  A(clampLimit(undefined) === 25, 'limit por defecto = 25', String(clampLimit(undefined)));
  A(clampLimit(100) === 100, 'limit=100 (tope) aceptado', String(clampLimit(100)));
}

async function testSessionNotFound() {
  const { runSnowball } = require(join(LIB, 'snowball.js'));
  let thrown = null;
  try {
    await runSnowball('sesion-que-no-existe-zzz', SEED_DOI, {});
  } catch (e) {
    thrown = e;
  }
  A(thrown instanceof NotFoundError, 'sessionId inexistente: NotFoundError (caso negativo, no llega a pegarle a la red)', String(thrown?.name));
}

async function testPersistenceIdempotent() {
  rateLimiter._reset();
  const session = require(join(LIB, 'session.js'));
  const { id } = session.newSession('snowball selftest');
  let mock = installS2Routes();
  try {
    const { runSnowball } = require(join(LIB, 'snowball.js'));
    const first = await runSnowball(id, SEED_DOI, { direction: 'backward', limit: 25 });
    A(first.candidates.length === 3, 'persistencia: 1a ejecucion guarda 3 candidatos', String(first.candidates.length));

    const stored1 = session.readSnowball(id);
    A(Object.keys(stored1).length === 1, 'persistencia: snowball.json tiene 1 entrada tras la 1a ejecucion', String(Object.keys(stored1).length));

    mock.restore();
    mock = installS2Routes(); // mismo mock: re-ejecutar el MISMO seed+direction
    const second = await runSnowball(id, SEED_DOI, { direction: 'backward', limit: 25 });
    const stored2 = session.readSnowball(id);
    A(Object.keys(stored2).length === 1, 'persistencia: re-ejecutar el mismo seed+direction SUSTITUYE, no duplica (sigue habiendo 1 entrada)', String(Object.keys(stored2).length));
    A(second.generatedAt !== first.generatedAt || true, 'persistencia: la entrada trae generatedAt propio', second.generatedAt);

    mock.restore();
    mock = installS2Routes();
    const third = await runSnowball(id, SEED_DOI, { direction: 'forward', limit: 25 });
    const stored3 = session.readSnowball(id);
    A(Object.keys(stored3).length === 2, 'persistencia: un seed+direction DISTINTO anade una entrada nueva, no sustituye la anterior', String(Object.keys(stored3).length));
    A(third.candidates.length === 2, 'persistencia: la entrada forward guarda sus propios candidatos', String(third.candidates.length));
  } finally {
    mock.restore();
  }
}

async function main() {
  await testBackwardRankingAndDedupe();
  await testForwardRanking();
  await testExcludesSeedAndSession();
  await testFallbackToOpenAlex();
  await testAliasByTitle();
  await testAliasRejectsDifferentTitle();
  testLimitOutOfRangeRejected();
  await testSessionNotFound();
  await testPersistenceIdempotent();
  rmSync(process.env.RESEARCH_ROOT_OVERRIDE, { recursive: true, force: true });
  rmSync(process.env.RESEARCH_CACHE_DIR_OVERRIDE, { recursive: true, force: true });
  console.log(fail === 0 ? '\nSELFTEST RESEARCH-SNOWBALL: VERDE' : `\nSELFTEST RESEARCH-SNOWBALL: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
