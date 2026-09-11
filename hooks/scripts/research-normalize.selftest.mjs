/**
 * research-normalize.selftest.mjs — check hermetico (sin red) de
 * normalize.js + merge.js: normalizacion de OpenAlex/Semantic Scholar,
 * clasificacion de tipo (article/preprint/review), deduplicacion por DOI y
 * por titulo+anio, fusion de fuentes y orden explicable.
 * Uso: node hooks/scripts/research-normalize.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LIB = join(__dirname, 'lib', 'research');

const { normalizeOpenAlexWork, normalizeS2Paper } = require(join(LIB, 'normalize.js'));
const { dedupe, rankAndFilter, titleKey } = require(join(LIB, 'merge.js'));
const openalexFixture = require(join(LIB, '__fixtures__', 'openalex-search.json'));
const s2Fixture = require(join(LIB, '__fixtures__', 's2-search.json'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const oaPapers = openalexFixture.results.map(normalizeOpenAlexWork);
const s2Papers = s2Fixture.data.map(normalizeS2Paper);

// --- normalizacion ---------------------------------------------------------
A(oaPapers[0].doi === '10.1109/access.2019.2939201', 'OpenAlex: DOI normalizado (sin prefijo, minusculas)', oaPapers[0].doi);
A(oaPapers[0].authors.includes('Licheng Jiao'), 'OpenAlex: autores extraidos', JSON.stringify(oaPapers[0].authors));
A(oaPapers[0].type === 'article', 'OpenAlex: survey en IEEE Access clasificado como article', oaPapers[0].type);
A(oaPapers[3].type === 'preprint', 'OpenAlex: venue arXiv clasificado como preprint', oaPapers[3].type);
A(oaPapers[3].openAccessPdf === null, 'OpenAlex: sin PDF abierto -> openAccessPdf null (no inventa URL)', JSON.stringify(oaPapers[3].openAccessPdf));
A(oaPapers[0].relevanceRaw === 554.49817, 'OpenAlex: relevance_score real de la busqueda se conserva', String(oaPapers[0].relevanceRaw));
A(typeof oaPapers[0].abstract === 'string' && oaPapers[0].abstract.length > 0, 'OpenAlex: abstract reconstruido del indice invertido', String(oaPapers[0].abstract?.length));
A(s2Papers[0].doi === '10.1109/access.2019.2939201', 'Semantic Scholar: DOI normalizado igual que OpenAlex (case-insensitive)', s2Papers[0].doi);
A(s2Papers[1].doi === null, 'Semantic Scholar: sin DOI -> doi null explicito', String(s2Papers[1].doi));

// --- deduplicacion -----------------------------------------------------------
const merged = dedupe([...oaPapers, ...s2Papers]);
A(merged.length === 4, 'dedupe: 4 works unicos (1 por DOI + 1 por titulo+anio + 2 solo-OpenAlex) de 6 normalizados', String(merged.length));

const jiao = merged.find((p) => p.doi === '10.1109/access.2019.2939201');
A(jiao.sources.length === 2 && jiao.sources.includes('openalex') && jiao.sources.includes('semanticscholar'), 'dedupe: paper con DOI en ambas fuentes fusiona sources', JSON.stringify(jiao.sources));
A(jiao.citations === 1321, 'fusion: citas = max(OpenAlex 1321, S2 1163)', String(jiao.citations));
A(jiao.type === 'review', 'fusion: S2 lo marca Review -> prevalece sobre article de OpenAlex (mas especifico)', jiao.type);

const preprint = merged.find((p) => p.doi === null);
A(preprint !== undefined, 'dedupe por titulo+anio: preprint sin DOI de ambas fuentes fusiona en 1', String(!!preprint));
A(preprint.sources.length === 2, 'dedupe por titulo+anio: fusiona sources de ambas fuentes', JSON.stringify(preprint.sources));
A(titleKey('A Survey: of things!') === titleKey('a survey of things'), 'titleKey ignora puntuacion/mayusculas para el fallback de dedupe', titleKey('A Survey: of things!'));

// --- orden explicable (sin query: solo relevance_score/citas, sin componente lexico/semantico) ---
async function main() {
  const { results: ranked } = await rankAndFilter(merged, {});
  A(ranked[0].doi === '10.1109/access.2019.2939201', 'rank sin query: el mayor relevance_score de OpenAlex (Jiao) va primero', ranked[0].doi);
  A(ranked.every((p) => typeof p.rankReason === 'string' && p.rankReason.length > 0), 'rank: cada resultado trae rankReason no vacio', JSON.stringify(ranked.map((p) => p.rankReason)));
  A(ranked.every((p, i) => i === 0 || ranked[i - 1].rankScore >= p.rankScore), 'rank: orden descendente por rankScore', JSON.stringify(ranked.map((p) => p.rankScore)));

  const { results: filtered } = await rankAndFilter(merged, { minCitations: 300 });
  A(filtered.length === 2 && filtered[0].doi === '10.1109/access.2019.2939201', 'minCitations: excluye por debajo del umbral (deja Jiao 1321 y ML-Drone 376)', JSON.stringify(filtered.map((p) => p.doi)));

  // --- casos negativos: citas desconocidas y retractado ---------------------
  const unknownCitations = { title: 'X', authors: [], year: 2020, venue: null, doi: '10.1/unknown', type: 'article', rawType: null, citations: null, isRetracted: false, landingUrl: null, openAccessPdf: null, ids: { openalex: 'W1', semanticScholar: null }, sources: ['openalex'] };
  const { results: withMinCitations } = await rankAndFilter([unknownCitations], { minCitations: 10 });
  A(withMinCitations.length === 0, 'minCitations: un paper con citas desconocidas NO se afirma que cumple el umbral', String(withMinCitations.length));

  const retracted = { ...unknownCitations, doi: '10.1/retracted', isRetracted: true, citations: 9999 };
  const clean = { ...unknownCitations, doi: '10.1/clean', citations: 1 };
  const { results: withRetraction } = await rankAndFilter([retracted, clean], {});
  A(withRetraction[0].doi === '10.1/clean' && withRetraction[0].doi !== retracted.doi, 'rank: un retractado nunca sale primero aunque tenga mas citas', JSON.stringify(withRetraction.map((p) => p.doi)));
  A(withRetraction.find((p) => p.doi === '10.1/retracted').rankReason.includes('RETRACTADO'), 'rank: el retractado queda marcado explicitamente en rankReason', withRetraction.find((p) => p.doi === '10.1/retracted').rankReason);

  console.log(fail === 0 ? '\nSELFTEST RESEARCH-NORMALIZE: VERDE' : `\nSELFTEST RESEARCH-NORMALIZE: ROJO (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
