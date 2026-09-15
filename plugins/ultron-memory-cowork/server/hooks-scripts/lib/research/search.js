'use strict';

/**
 * lib/research/search.js — orquesta la busqueda: recupera un pool amplio de
 * OpenAlex (varias variantes de consulta, ver openalex.js::searchWorksMulti)
 * y Semantic Scholar en paralelo (Promise.allSettled: una fuente caida nunca
 * tumba la otra), normaliza, fusiona/deduplica y ordena por relevancia
 * (merge.js::rankAndFilter, con re-rank semantico E5 cuando el daemon de
 * memoria esta vivo). yearFrom/yearTo se pasan a OpenAlex como filtro de
 * servidor; minCitations/type se aplican despues de fusionar.
 *
 * Reajustado 2026-09-11 (2a ronda de feedback en vivo): la primera correccion
 * de orden no bastaba porque el problema real era de RECUPERACION -- para
 * varias queries del dominio, el pool de `search=` simple ni siquiera
 * contenia los papers pertinentes antes de rankear nada (ver diagnostico en
 * el commit). searchWorksMulti() abre el pool per_page 50-100 con variantes.
 */

const openalex = require('./openalex');
const semanticScholar = require('./semantic-scholar');
const { normalizeOpenAlexWork, normalizeS2Paper } = require('./normalize');
const { dedupe, rankAndFilter } = require('./merge');
const { withCache } = require('./cache');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h: suficiente para no repetir la misma busqueda en una sesion de trabajo

/**
 * Busca en OpenAlex + Semantic Scholar y devuelve { results, warnings,
 * sourcesQueried, totalBeforeFilter }. warnings[] lista que fuente (o que
 * variante de OpenAlex, o el re-rank semantico) fallo y por que, sin abortar
 * la busqueda si al menos algo respondio.
 */
async function search(query, { yearFrom, yearTo, type, minCitations, limit = 20 } = {}) {
  const openAlexPerPage = Math.min(100, Math.max(limit * 4, 50));
  const s2PerPage = Math.min(100, Math.max(limit * 4, 50));
  const s2CacheKey = JSON.stringify({ query, s2PerPage });

  const [openAlexOutcome, s2Outcome] = await Promise.allSettled([
    openalex.searchWorksMulti(query, { limit: openAlexPerPage, yearFrom, yearTo }),
    withCache(`s2:${s2CacheKey}`, CACHE_TTL_MS, () => semanticScholar.searchPapers(query, { limit: s2PerPage })),
  ]);

  const warnings = [];
  const normalized = [];

  if (openAlexOutcome.status === 'fulfilled') {
    const { results, errors } = openAlexOutcome.value;
    normalized.push(...results.map(normalizeOpenAlexWork));
    warnings.push(...errors);
  } else {
    warnings.push(`OpenAlex fallo: ${String(openAlexOutcome.reason?.message ?? openAlexOutcome.reason)}`);
  }

  if (s2Outcome.status === 'fulfilled') {
    // /paper/search llega ya ordenado por relevancia (sin sort= explicito):
    // el indice del array es la senal de relevancia de esta fuente (ver normalize.js).
    normalized.push(...s2Outcome.value.value.map((paper, rank) => normalizeS2Paper(paper, { rank })));
  } else {
    warnings.push(`Semantic Scholar fallo: ${String(s2Outcome.reason?.message ?? s2Outcome.reason)}`);
  }

  const merged = dedupe(normalized);
  const { results: ranked, warnings: rankWarnings } = await rankAndFilter(merged, { minCitations, type, query });
  warnings.push(...rankWarnings);

  return {
    results: ranked.slice(0, limit),
    warnings,
    sourcesQueried: {
      openalex: openAlexOutcome.status === 'fulfilled',
      semanticscholar: s2Outcome.status === 'fulfilled',
    },
    totalBeforeFilter: merged.length,
  };
}

module.exports = { search };
