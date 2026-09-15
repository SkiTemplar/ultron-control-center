/**
 * research-verify.selftest.mjs — check hermetico (fetch simulado con
 * fixtures, sin red) de verify.js: DOI que coincide (ok), DOI cuyo campo
 * `year` citado no coincide con el real (mismatch, caso negativo pedido),
 * DOI inventado que no resuelve en ninguna fuente (doi_not_found, caso
 * negativo pedido), entrada sin DOI con candidato por titulo en OpenAlex
 * (no_doi), DOI retractado (retracted, prioridad sobre mismatch), sesion de
 * investigacion sin ese DOI guardado (not_in_session), cita en el texto sin
 * entrada en el .bib y entrada del .bib nunca citada (uncitedInBib nunca
 * llega a resolver DOI: si lo hiciera, mock-fetch no tendria ruta y fallaria
 * fuerte, lo que ya verifica que se salta correctamente).
 * Uso: node hooks/scripts/research-verify.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

process.env.RESEARCH_ROOT_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-verify-selftest-session-'));
process.env.RESEARCH_CACHE_DIR_OVERRIDE = mkdtempSync(join(tmpdir(), 'research-verify-selftest-cache-'));

const { installMockFetch } = require(join(LIB, '__fixtures__', 'mock-fetch.js'));
const openalexSearchFixture = require(join(LIB, '__fixtures__', 'openalex-search.json'));
const rateLimiter = require(join(LIB, 'rate-limiter.js'));
const { NotFoundError } = require(join(LIB, 'errors.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const reportDir = mkdtempSync(join(tmpdir(), 'research-verify-selftest-report-'));

const DOI_OK = '10.9200/ok-paper';
const DOI_MISMATCH = '10.9201/mismatch-paper';
const DOI_RETRACTED = '10.9100/retracted-publisher'; // mismo DOI que crossref-retraction-publisher.json en research-retraction.selftest
const DOI_NOT_FOUND = '10.9999/invented-doi-does-not-exist';
// A Survey of Deep Learning-Based Object Detection: primer resultado real de openalex-search.json
const NO_DOI_TITLE = 'A Survey of Deep Learning-Based Object Detection';
const NO_DOI_REAL_DOI = '10.1109/access.2019.2939201';
const DOI_TRANSIENT_FAIL = '10.9203/transient-network-failure';

const BIB = `
@article{ok2021,
  title = {Deep Learning for Everyone},
  author = {Ada Lovelace and Grace Hopper},
  year = {2021},
  doi = {${DOI_OK}}
}

@article{mismatch2020,
  title = {Mismatch Paper Title},
  author = {Bob Builder},
  year = {2020},
  doi = {${DOI_MISMATCH}}
}

@article{retracted2020,
  title = {A Retracted Study (Publisher Notice)},
  author = {Some Author},
  year = {2020},
  doi = {${DOI_RETRACTED}}
}

@article{doinotfound2099,
  title = {Invented Paper That Does Not Exist},
  year = {2099},
  doi = {${DOI_NOT_FOUND}}
}

@misc{nodoititle,
  title = {${NO_DOI_TITLE}},
  author = {Someone Else},
  year = {2019}
}

@article{uncited2022,
  title = {Never Cited Paper},
  year = {2022},
  doi = {10.9202/never-cited}
}

@article{transientfail,
  title = {Paper Behind A Flaky Network},
  year = {2022},
  doi = {${DOI_TRANSIENT_FAIL}}
}
`;

const TEX = `
\\documentclass{article}
\\begin{document}
Introduccion citando varias fuentes \\cite{ok2021}.
Un resultado discutido \\citep{mismatch2020} y otro \\textcite{retracted2020}.
Referencia rota \\cite{doinotfound2099} y sin DOI \\cite{nodoititle}.
Cita fantasma sin entrada en el .bib \\cite{ghost2099}.
Una fuente que falla por red, no por DOI inexistente \\cite{transientfail}.
\\bibliography{refs}
\\end{document}
`;

const reportPath = join(reportDir, 'report.tex');
const bibPath = join(reportDir, 'refs.bib');
writeFileSync(reportPath, TEX);
writeFileSync(bibPath, BIB);

function openalexWork({ id, doi, title, authors, year, isRetracted = false }) {
  return {
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/${doi}`,
    display_name: title,
    publication_year: year,
    is_retracted: isRetracted,
    authorships: authors.map((name) => ({ author: { display_name: name } })),
    primary_location: { source: { display_name: 'Journal of Tests' } },
  };
}

function crossrefWork({ doi, retracted = false }) {
  const message = { DOI: doi, type: 'journal-article', title: ['x'], published: { 'date-parts': [[2020]] } };
  if (retracted) {
    message['updated-by'] = [{ DOI: '10.9100/retraction-notice-1', type: 'retraction', source: 'publisher', label: 'Retraction', updated: { 'date-parts': [[2024, 3, 15]] } }];
  }
  return { status: 'ok', 'message-type': 'work', message };
}

function route(test, handler) {
  return { test, handler };
}

function doiRoute(base, doi, body) {
  return route((u) => u.startsWith(base) && u.includes(encodeURIComponent(doi)), body ? { status: 200, body, isText: false } : { status: 404, body: 'not found' });
}

function installRoutes() {
  return installMockFetch([
    doiRoute('https://api.openalex.org/works/https://doi.org/', DOI_OK, openalexWork({ id: 'Wok', doi: DOI_OK, title: 'Deep Learning For Everyone', authors: ['Ada Lovelace', 'Grace Hopper'], year: 2021 })),
    doiRoute('https://api.crossref.org/works/', DOI_OK, crossrefWork({ doi: DOI_OK })),

    doiRoute('https://api.openalex.org/works/https://doi.org/', DOI_MISMATCH, openalexWork({ id: 'Wmis', doi: DOI_MISMATCH, title: 'Mismatch Paper Title', authors: ['Bob Builder'], year: 2019 })),
    doiRoute('https://api.crossref.org/works/', DOI_MISMATCH, crossrefWork({ doi: DOI_MISMATCH })),

    doiRoute('https://api.openalex.org/works/https://doi.org/', DOI_RETRACTED, openalexWork({ id: 'Wret', doi: DOI_RETRACTED, title: 'A Retracted Study (Publisher Notice)', authors: ['Some Author'], year: 2020 })),
    doiRoute('https://api.crossref.org/works/', DOI_RETRACTED, crossrefWork({ doi: DOI_RETRACTED, retracted: true })),

    doiRoute('https://api.openalex.org/works/https://doi.org/', DOI_NOT_FOUND, null),
    route((u) => u.includes(`/paper/DOI:${encodeURIComponent(DOI_NOT_FOUND)}`), { status: 404, body: 'not found' }),

    // 400 no reintentable (a diferencia de 429/5xx): fallo transitorio de la fuente, no "DOI inexistente".
    route(
      (u) => u.startsWith('https://api.openalex.org/works/https://doi.org/') && u.includes(encodeURIComponent(DOI_TRANSIENT_FAIL)),
      { status: 400, body: 'bad request' },
    ),

    route((u) => u.startsWith('https://api.openalex.org/works?') && u.includes('search='), { status: 200, body: openalexSearchFixture, isText: false }),
  ]);
}

async function testVerifyReport() {
  rateLimiter._reset();
  const mock = installRoutes();
  try {
    const { verifyReport } = require(join(LIB, 'verify.js'));
    const result = await verifyReport(reportPath);
    const byKey = Object.fromEntries(result.entries.map((e) => [e.key, e]));

    A(result.bibFile === bibPath, 'autodetecta refs.bib via \\bibliography{} del .tex', result.bibFile);
    A(byKey.ok2021?.status === 'ok', 'DOI, titulo, autor y anio coinciden -> ok', JSON.stringify(byKey.ok2021));
    A(
      byKey.mismatch2020?.status === 'mismatch' && byKey.mismatch2020.mismatches.some((m) => m.field === 'year'),
      'CASO NEGATIVO: anio citado distinto del real -> mismatch con field=year',
      JSON.stringify(byKey.mismatch2020),
    );
    A(
      byKey.doinotfound2099?.status === 'doi_not_found',
      'CASO NEGATIVO: DOI inventado que no resuelve en ninguna fuente -> doi_not_found',
      JSON.stringify(byKey.doinotfound2099),
    );
    A(
      byKey.nodoititle?.status === 'no_doi' && byKey.nodoititle.candidate?.doi === NO_DOI_REAL_DOI,
      'entrada sin DOI -> no_doi con candidato por titulo en OpenAlex, sin darlo por bueno',
      JSON.stringify(byKey.nodoititle),
    );
    A(byKey.retracted2020?.status === 'retracted', 'DOI retractado -> retracted (prioridad sobre otros estados)', JSON.stringify(byKey.retracted2020));
    A(
      byKey.transientfail?.status === 'check_failed' && byKey.transientfail.reason.includes(DOI_TRANSIENT_FAIL),
      'fallo transitorio de red (400, no reintentable) -> check_failed, distinto de doi_not_found; no aborta el resto del informe',
      JSON.stringify(byKey.transientfail),
    );
    A(byKey.uncited2022 === undefined, 'entrada nunca citada no se verifica contra el DOI real (ni siquiera se intenta resolver)', JSON.stringify(byKey.uncited2022));
    A(result.uncitedInBib.includes('uncited2022'), 'entrada del .bib nunca citada -> aparece en uncitedInBib', JSON.stringify(result.uncitedInBib));
    A(result.citedNotInBib.includes('ghost2099'), 'cita del texto sin entrada en el .bib -> aparece en citedNotInBib', JSON.stringify(result.citedNotInBib));
    A(result.summary.total === 6 && result.summary.mismatch === 1 && result.summary.doi_not_found === 1 && result.summary.check_failed === 1, 'summary cuenta solo las 6 entradas citadas', JSON.stringify(result.summary));
  } finally {
    mock.restore();
  }
}

async function testNotInSession() {
  rateLimiter._reset();
  const mock = installRoutes();
  try {
    const session = require(join(LIB, 'session.js'));
    const { verifyReport } = require(join(LIB, 'verify.js'));
    const { id: sessionId } = session.newSession('verify selftest sin papers');
    const result = await verifyReport(reportPath, { sessionId });
    const byKey = Object.fromEntries(result.entries.map((e) => [e.key, e]));
    A(byKey.ok2021?.status === 'not_in_session', 'DOI correcto pero ausente de la sesion indicada -> not_in_session', JSON.stringify(byKey.ok2021));
  } finally {
    mock.restore();
  }
}

async function testInvalidSessionIsExplicit() {
  rateLimiter._reset();
  const mock = installRoutes();
  try {
    const { verifyReport } = require(join(LIB, 'verify.js'));
    let thrown = null;
    try {
      await verifyReport(reportPath, { sessionId: 'sesion-que-no-existe' });
    } catch (e) {
      thrown = e;
    }
    A(thrown instanceof NotFoundError, 'sessionId inexistente -> NotFoundError explicito, no un not_in_session generalizado silencioso', String(thrown?.name));
  } finally {
    mock.restore();
  }
}

async function testBibOnlyReport() {
  rateLimiter._reset();
  const mock = installRoutes();
  try {
    const { verifyReport } = require(join(LIB, 'verify.js'));
    const bibOnlyPath = join(reportDir, 'solo.bib');
    writeFileSync(bibOnlyPath, `@article{ok2021, title = {Deep Learning for Everyone}, author = {Ada Lovelace and Grace Hopper}, year = {2021}, doi = {${DOI_OK}}}`);
    const result = await verifyReport(bibOnlyPath);
    A(result.entries.length === 1 && result.entries[0].status === 'ok', 'informe .bib solo: todas sus entradas se tratan como citadas', JSON.stringify(result.entries));
    A(result.citedNotInBib.length === 0 && result.uncitedInBib.length === 0, 'informe .bib solo: sin texto no hay citedNotInBib/uncitedInBib', JSON.stringify({ citedNotInBib: result.citedNotInBib, uncitedInBib: result.uncitedInBib }));
  } finally {
    mock.restore();
  }
}

async function main() {
  await testVerifyReport();
  await testNotInSession();
  await testInvalidSessionIsExplicit();
  await testBibOnlyReport();
  rmSync(reportDir, { recursive: true, force: true });
  rmSync(process.env.RESEARCH_ROOT_OVERRIDE, { recursive: true, force: true });
  console.log(fail === 0 ? '\nSELFTEST RESEARCH-VERIFY: VERDE' : `\nSELFTEST RESEARCH-VERIFY: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
