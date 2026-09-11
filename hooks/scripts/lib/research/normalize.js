'use strict';

/**
 * lib/research/normalize.js — convierte las respuestas crudas de OpenAlex y
 * Semantic Scholar a un modelo de "Paper" comun, para que merge.js pueda
 * deduplicar y ordenar sin conocer de donde vino cada resultado.
 *
 * Modelo Paper: { title, abstract, authors[], year, venue, doi, type,
 * rawType, citations, isRetracted, landingUrl, openAccessPdf{url,source}|null,
 * ids{openalex,semanticScholar}, sources[], relevanceRaw, sourceRank }.
 * `type` es siempre uno de: 'article' | 'preprint' | 'review' | 'other'.
 * relevanceRaw/sourceRank son las senales de relevancia que trae cada fuente
 * (ver merge.js rankAndFilter): OpenAlex devuelve un relevance_score de
 * Elasticsearch en /works?search=; Semantic Scholar no expone un score pero
 * /paper/search ya llega ordenado por relevancia, asi que la posicion en el
 * array (sourceRank, puesta por search.js) es la senal equivalente.
 */

const PREPRINT_VENUE_RE = /arxiv|biorxiv|medrxiv|preprints?\.org|ssrn|techrxiv/i;

function normalizeDoi(rawDoi) {
  if (!rawDoi) return null;
  return String(rawDoi).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase().trim() || null;
}

/** Reconstruye el abstract en texto plano desde el indice invertido de OpenAlex ({palabra: [posiciones]}). */
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter(Boolean).join(' ').trim();
  return text || null;
}

function guessPreprint(venue, rawTypeHints) {
  if (PREPRINT_VENUE_RE.test(venue ?? '')) return true;
  return rawTypeHints.some((t) => /preprint|posted-content/i.test(String(t ?? '')));
}

function classifyOpenAlex(work) {
  const venue = work.primary_location?.source?.display_name ?? null;
  const rawType = work.type ?? work.type_crossref ?? null;
  if (guessPreprint(venue, [rawType])) return { type: 'preprint', rawType };
  if (rawType === 'review') return { type: 'review', rawType };
  if (rawType === 'article' || rawType === 'journal-article') return { type: 'article', rawType };
  return { type: 'other', rawType };
}

function classifyS2(paper) {
  const venue = paper.venue ?? null;
  const types = paper.publicationTypes ?? [];
  if (guessPreprint(venue, types)) return { type: 'preprint', rawType: types.join(',') || null };
  if (types.includes('Review')) return { type: 'review', rawType: types.join(',') };
  if (types.includes('JournalArticle') || types.includes('Conference')) {
    return { type: 'article', rawType: types.join(',') };
  }
  return { type: 'other', rawType: types.join(',') || null };
}

/** OpenAlex Work -> Paper. */
function normalizeOpenAlexWork(work) {
  const { type, rawType } = classifyOpenAlex(work);
  const pdfUrl = work.best_oa_location?.pdf_url ?? (work.open_access?.is_oa ? work.open_access.oa_url : null);
  return {
    title: work.display_name ?? work.title ?? '(sin titulo)',
    abstract: reconstructAbstract(work.abstract_inverted_index),
    authors: (work.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    year: work.publication_year ?? null,
    venue: work.primary_location?.source?.display_name ?? null,
    doi: normalizeDoi(work.doi ?? work.ids?.doi),
    type,
    rawType,
    citations: work.cited_by_count ?? null,
    isRetracted: Boolean(work.is_retracted),
    landingUrl: work.primary_location?.landing_page_url ?? work.id ?? null,
    openAccessPdf: pdfUrl ? { url: pdfUrl, source: 'openalex' } : null,
    ids: { openalex: work.id ?? null, semanticScholar: null },
    sources: ['openalex'],
    relevanceRaw: typeof work.relevance_score === 'number' ? work.relevance_score : null,
    sourceRank: null,
  };
}

/** Semantic Scholar Paper -> Paper. `rank` es la posicion (0-based) en el array de /paper/search. */
function normalizeS2Paper(paper, { rank = null } = {}) {
  const { type, rawType } = classifyS2(paper);
  const pdfUrl = paper.openAccessPdf?.url ?? null;
  return {
    title: paper.title ?? '(sin titulo)',
    abstract: paper.abstract ?? null,
    authors: (paper.authors ?? []).map((a) => a.name).filter(Boolean),
    year: paper.year ?? null,
    venue: paper.venue ?? null,
    doi: normalizeDoi(paper.externalIds?.DOI),
    type,
    rawType,
    citations: paper.citationCount ?? null,
    isRetracted: false, // Semantic Scholar no expone retraction; se fia de OpenAlex cuando hay match
    landingUrl: paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : null,
    openAccessPdf: pdfUrl ? { url: pdfUrl, source: 'semanticscholar' } : null,
    ids: { openalex: null, semanticScholar: paper.paperId ?? null },
    sources: ['semanticscholar'],
    relevanceRaw: null,
    sourceRank: rank,
  };
}

module.exports = { normalizeOpenAlexWork, normalizeS2Paper, normalizeDoi, reconstructAbstract };
