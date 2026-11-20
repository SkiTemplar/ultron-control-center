'use strict';

/**
 * lib/research/merge.js — fusiona los resultados normalizados de OpenAlex y
 * Semantic Scholar: deduplica por DOI (o por titulo normalizado + anio
 * cuando no hay DOI en ninguna de las dos), fusiona los campos de las
 * fuentes que coinciden en el mismo trabajo, y ordena por RELEVANCIA para la
 * consulta (no por citas). Cada resultado trae una razon explicita.
 *
 * Ranking (2a revision, 2026-09-11, tras feedback en vivo de que el problema
 * era de RECUPERACION, no de orden -- ver search.js/openalex.js para el pool
 * ampliado que ahora SI contiene los papers pertinentes):
 *   score = 0.35*relevancia + 0.55*lexico(IDF) + 0.10*citas/anio
 * - relevancia: relevance_score de OpenAlex (raw/(raw+150)) promediado con
 *   1/(1+rank) de Semantic Scholar cuando hay ambas senales; 0 si no hay ninguna.
 * - lexico (IDF): fraccion de terminos de la consulta presentes en
 *   titulo/abstract, pesados por rareza dentro del PROPIO pool de candidatos
 *   (document frequency en esta busqueda -> IDF corpus-free: "detection"
 *   aparece en casi todos los candidatos y pesa poco, "sim-to-real" aparece
 *   en pocos y pesa mucho), con bonus por frase exacta.
 * - El componente semantico (coseno E5 via el daemon de memoria) se retiro el
 *   2026-11-15 junto con la ruta densa: sin embeddings, el orden ya salia
 *   siempre con estos pesos (antes FALLBACK_WEIGHTS).
 * - citas/anio: log(1+citas/anio) con techo absoluto de 50 citas/anio --
 *   SOLO desempata.
 * Un retractado nunca sale primero, tenga la puntuacion que tenga.
 */

const TYPE_PRIORITY = { review: 3, preprint: 2, article: 1, other: 0 };
// Pesos calibrados en vivo (2026-09-11) para relevancia + lexico + citas.
const WEIGHTS = { rel: 0.35, lex: 0.55, cit: 0.10 };
const RELEVANCE_RAW_K = 150; // curva raw/(raw+K) para el relevance_score de OpenAlex
const CITATIONS_PER_YEAR_CAP = 50; // techo absoluto: mas de esto no anade mas senal de "citado"
const RETRACTED_PENALTY = 1e6;
const STOPWORD_MIN_LEN = 3; // descarta terminos triviales ("of", "a", "on"...) de la coincidencia lexica

function titleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Clave de deduplicacion: DOI si existe, si no titulo normalizado + anio. */
function dedupeKey(paper) {
  if (paper.doi) return `doi:${paper.doi}`;
  return `ty:${titleKey(paper.title)}|${paper.year ?? ''}`;
}

function pickType(a, b) {
  return (TYPE_PRIORITY[a.type] ?? 0) >= (TYPE_PRIORITY[b.type] ?? 0) ? a.type : b.type;
}

function mergeTwo(a, b) {
  return {
    title: a.title.length >= b.title.length ? a.title : b.title,
    abstract: (a.abstract?.length ?? 0) >= (b.abstract?.length ?? 0) ? (a.abstract ?? b.abstract) : (b.abstract ?? a.abstract),
    authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
    year: a.year ?? b.year,
    venue: a.venue ?? b.venue,
    doi: a.doi ?? b.doi,
    type: pickType(a, b),
    rawType: a.rawType ?? b.rawType,
    citations: Math.max(a.citations ?? 0, b.citations ?? 0) || (a.citations ?? b.citations ?? null),
    isRetracted: Boolean(a.isRetracted || b.isRetracted),
    landingUrl: a.landingUrl ?? b.landingUrl,
    openAccessPdf: a.openAccessPdf ?? b.openAccessPdf,
    ids: {
      openalex: a.ids.openalex ?? b.ids.openalex,
      semanticScholar: a.ids.semanticScholar ?? b.ids.semanticScholar,
    },
    sources: [...new Set([...a.sources, ...b.sources])],
    relevanceRaw: a.relevanceRaw ?? b.relevanceRaw,
    sourceRank: a.sourceRank ?? b.sourceRank,
  };
}

/** Deduplica una lista de Papers normalizados (ver normalize.js). */
function dedupe(papers) {
  const byKey = new Map();
  for (const paper of papers) {
    const key = dedupeKey(paper);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeTwo(existing, paper) : paper);
  }
  return [...byKey.values()];
}

function tokenize(text) {
  const raw = String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (raw.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= STOPWORD_MIN_LEN);
}

/**
 * IDF corpus-free: document frequency de cada termino de la query DENTRO del
 * propio pool de candidatos de esta busqueda (no hace falta un corpus
 * externo). Un termino que aparece en casi todos los candidatos ("object",
 * "detection") pesa poco; uno que aparece en pocos ("sim-to-real") pesa mucho.
 */
function computeIdfWeights(queryTerms, papers) {
  const N = papers.length || 1;
  const weights = new Map();
  for (const term of queryTerms) {
    let df = 0;
    for (const p of papers) {
      if (tokenize(p.title).includes(term) || tokenize(p.abstract).includes(term)) df += 1;
    }
    weights.set(term, Math.log((N + 1) / (df + 1)) + 1); // suavizado, siempre > 0
  }
  return weights;
}

/**
 * Coincidencia lexica de la consulta contra titulo/abstract, pesada por
 * `idfWeights` (Map termino->peso; si no se pasa, peso plano 1 por termino).
 * Bonus grande por frase exacta (mas peso en titulo). Consulta sin terminos
 * utiles -> 0 explicito, nunca inventado.
 */
function lexicalMatch(query, paper, idfWeights = null) {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return { score: 0, titleHits: 0, abstractHits: 0, total: 0, exactPhrase: null };

  const titleTerms = new Set(tokenize(paper.title));
  const abstractTerms = new Set(tokenize(paper.abstract));
  let titleWeight = 0;
  let abstractWeight = 0;
  let totalWeight = 0;
  let titleHits = 0;
  let abstractHits = 0;
  for (const term of queryTerms) {
    const w = idfWeights?.get(term) ?? 1;
    totalWeight += w;
    if (titleTerms.has(term)) { titleWeight += w; titleHits += 1; }
    if (abstractTerms.has(term)) { abstractWeight += w; abstractHits += 1; }
  }

  const phrase = String(query ?? '').trim().toLowerCase();
  const titleLower = String(paper.title ?? '').toLowerCase();
  const abstractLower = String(paper.abstract ?? '').toLowerCase();
  const exactPhrase = phrase.length > 0 && titleLower.includes(phrase) ? 'titulo' : (phrase.length > 0 && abstractLower.includes(phrase) ? 'abstract' : null);

  let score = totalWeight > 0 ? 0.5 * (titleWeight / totalWeight) + 0.25 * (abstractWeight / totalWeight) : 0;
  if (exactPhrase === 'titulo') score += 0.5;
  else if (exactPhrase === 'abstract') score += 0.2;

  return { score: Math.min(1, score), titleHits, abstractHits, total: queryTerms.length, exactPhrase };
}

function citationsPerYear(paper, nowYear) {
  if (paper.citations == null) return null;
  const age = Math.max(1, nowYear - (paper.year ?? nowYear) + 1);
  return paper.citations / age;
}

function relevanceComponentOf(paper) {
  const parts = [];
  let sum = 0;
  if (paper.relevanceRaw != null) { sum += paper.relevanceRaw / (paper.relevanceRaw + RELEVANCE_RAW_K); parts.push('OpenAlex'); }
  if (paper.sourceRank != null) { sum += 1 / (1 + paper.sourceRank); parts.push(`S2 #${paper.sourceRank + 1}`); }
  return { value: parts.length ? sum / parts.length : 0, parts };
}

function explain({ relevance, lex, citPerYear, paper }) {
  const bits = [];
  bits.push(relevance.parts.length ? `relevancia ${relevance.value.toFixed(2)} (${relevance.parts.join(', ')})` : 'sin senal de relevancia de las fuentes');
  if (lex.total === 0) bits.push('consulta sin terminos utiles');
  else if (lex.exactPhrase) bits.push(`frase exacta en ${lex.exactPhrase}`);
  else bits.push(`${lex.titleHits}/${lex.total} terminos en titulo, ${lex.abstractHits}/${lex.total} en abstract (IDF)`);
  bits.push(citPerYear != null ? `${citPerYear.toFixed(1)} citas/anio` : 'citas desconocidas');
  bits.push(paper.sources.length > 1 ? 'confirmado por OpenAlex + Semantic Scholar' : `solo ${paper.sources[0]}`);
  if (paper.isRetracted) bits.push('RETRACTADO');
  return bits.join(', ');
}

/**
 * Filtra por minCitations/type y ordena por relevancia para `query`
 * (relevancia+lexico; las citas solo desempatan). Devuelve {results,
 * warnings}; se conserva async y el campo warnings para no romper la firma
 * que consumen search.js y los selftests.
 */
async function rankAndFilter(papers, { minCitations, type, query = '' } = {}) {
  let list = papers;
  if (minCitations != null) list = list.filter((p) => p.citations != null && p.citations >= minCitations);
  if (type) list = list.filter((p) => p.type === type);
  if (list.length === 0) return { results: [], warnings: [] };

  const nowYear = new Date().getFullYear();
  const citPerYearCap = Math.log1p(CITATIONS_PER_YEAR_CAP);
  const queryTerms = [...new Set(tokenize(query))];
  const idfWeights = queryTerms.length ? computeIdfWeights(queryTerms, list) : null;

  const prelim = list.map((paper) => ({ paper, relevance: relevanceComponentOf(paper), lex: lexicalMatch(query, paper, idfWeights) }));
  prelim.sort((a, b) => (b.relevance.value + b.lex.score) - (a.relevance.value + a.lex.score));

  const results = prelim
    .map(({ paper, relevance, lex }) => {
      const citPerYear = citationsPerYear(paper, nowYear);
      const citationComponent = citPerYear != null ? Math.min(1, Math.log1p(citPerYear) / citPerYearCap) : 0;
      let rankScore = WEIGHTS.rel * relevance.value + WEIGHTS.lex * lex.score + WEIGHTS.cit * citationComponent;
      if (paper.isRetracted) rankScore -= RETRACTED_PENALTY;

      return { ...paper, rankScore, rankReason: explain({ relevance, lex, citPerYear, paper }) };
    })
    .sort((a, b) => b.rankScore - a.rankScore);

  return { results, warnings: [] };
}

module.exports = { dedupe, dedupeKey, titleKey, rankAndFilter, lexicalMatch, computeIdfWeights };
