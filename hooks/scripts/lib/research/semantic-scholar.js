'use strict';

/**
 * lib/research/semantic-scholar.js — cliente fino de la Semantic Scholar
 * Graph API. Sin clave: pool compartido (verificado el 2026-09-11: el
 * endpoint de busqueda satura con 429 en rafagas cortas incluso con backoff,
 * la consulta por DOI individual responde bien). Con
 * SEMANTIC_SCHOLAR_API_KEY: 1 req/s garantizado (formulario gratuito,
 * https://www.semanticscholar.org/product/api). El namespace comun con
 * http.js hace que ambos endpoints compartan el mismo ritmo.
 * Endpoints usados, confirmados contra la API real el 2026-09-11:
 *   GET /graph/v1/paper/search?query=<q>&fields=...&limit=<n>
 *   GET /graph/v1/paper/DOI:<doi>?fields=...
 */

const { request } = require('./http');
const { NotFoundError, HttpError } = require('./errors');

const BASE = 'https://api.semanticscholar.org/graph/v1';
const NAMESPACE = 'semanticscholar';
const FIELDS = 'title,abstract,year,authors,venue,externalIds,citationCount,openAccessPdf,publicationTypes';

function minIntervalMs() {
  return process.env.SEMANTIC_SCHOLAR_API_KEY ? 1_000 : 3_000;
}

function authHeaders() {
  return process.env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY } : {};
}

/** Busca papers en Semantic Scholar. Devuelve data[] tal cual la API. */
async function searchPapers(query, { limit = 25 } = {}) {
  const params = new URLSearchParams({ query, fields: FIELDS, limit: String(Math.max(1, Math.min(100, limit))) });
  const { body } = await request(`${BASE}/paper/search?${params}`, {
    namespace: NAMESPACE,
    minIntervalMs: minIntervalMs(),
    headers: authHeaders(),
    retries: 4, // el pool sin clave satura con frecuencia: mas margen de backoff
  });
  return body.data ?? [];
}

/** Resuelve un paper de Semantic Scholar por DOI. Lanza NotFoundError si no existe. */
async function getPaperByDoi(doi) {
  const url = `${BASE}/paper/DOI:${encodeURIComponent(doi)}?fields=${FIELDS}`;
  try {
    const { body } = await request(url, {
      namespace: NAMESPACE,
      minIntervalMs: minIntervalMs(),
      headers: authHeaders(),
      retries: 3,
    });
    return body;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`Semantic Scholar no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

module.exports = { searchPapers, getPaperByDoi };
