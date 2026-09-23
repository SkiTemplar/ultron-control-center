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
// Campos para bola de nieve (referencias/citas): metadatos del paper relacionado
// + contexto de la relacion (contexts/intents/isInfluential), pedidos tal cual
// especifica la tarjeta F2 opcion B.
const RELATION_FIELDS = 'contexts,intents,isInfluential,externalIds,title,year,citationCount';

function minIntervalMs() {
  return process.env.SEMANTIC_SCHOLAR_API_KEY ? 1_000 : 3_000;
}

// La clave dejo de valer el 2026-09-23 (403 con clave, 200 sin ella): cada
// llamada fallaba entera en vez de degradar al pool compartido. Tras el primer
// 401/403 con clave se deja de enviar durante el resto del proceso.
let keyRejected = false;

function authHeaders() {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key && !keyRejected ? { 'x-api-key': key } : {};
}

/**
 * request() con la clave si la hay; si S2 la rechaza (401/403), avisa una vez
 * por stderr y repite sin clave (pool compartido: puede dar 429 en rafagas,
 * pero no falla por la clave).
 */
async function s2Request(url, opts) {
  try {
    return await request(url, { ...opts, headers: authHeaders() });
  } catch (e) {
    const rejected = e instanceof HttpError && (e.status === 401 || e.status === 403);
    if (!rejected || keyRejected || !process.env.SEMANTIC_SCHOLAR_API_KEY) throw e;
    keyRejected = true;
    process.stderr.write(
      `[research] Semantic Scholar rechaza SEMANTIC_SCHOLAR_API_KEY (HTTP ${e.status}): se sigue sin clave. ` +
        'Regenerala en https://www.semanticscholar.org/product/api\n',
    );
    return request(url, { ...opts, headers: {} });
  }
}

/** Solo para tests: vuelve a enviar la clave. */
function _resetKeyRejected() {
  keyRejected = false;
}

/** Busca papers en Semantic Scholar. Devuelve data[] tal cual la API. */
async function searchPapers(query, { limit = 25 } = {}) {
  const params = new URLSearchParams({ query, fields: FIELDS, limit: String(Math.max(1, Math.min(100, limit))) });
  const { body } = await s2Request(`${BASE}/paper/search?${params}`, {
    namespace: NAMESPACE,
    minIntervalMs: minIntervalMs(),
    retries: 4, // el pool sin clave satura con frecuencia: mas margen de backoff
  });
  return body.data ?? [];
}

/** Resuelve un paper de Semantic Scholar por DOI. Lanza NotFoundError si no existe. */
async function getPaperByDoi(doi) {
  const url = `${BASE}/paper/DOI:${encodeURIComponent(doi)}?fields=${FIELDS}`;
  try {
    const { body } = await s2Request(url, {
      namespace: NAMESPACE,
      minIntervalMs: minIntervalMs(),
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

/**
 * Referencias (backward, un nivel) de un DOI. Cada item trae { contexts,
 * intents, isInfluential, citedPaper }. Lanza NotFoundError si S2 no conoce
 * el DOI (el llamador cae a OpenAlex, ver snowball.js).
 */
async function getReferences(doi, { limit = 25 } = {}) {
  const params = new URLSearchParams({ fields: RELATION_FIELDS, limit: String(Math.max(1, Math.min(1000, limit))) });
  const url = `${BASE}/paper/DOI:${encodeURIComponent(doi)}/references?${params}`;
  try {
    const { body } = await s2Request(url, { namespace: NAMESPACE, minIntervalMs: minIntervalMs(), retries: 3 });
    return body.data ?? [];
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`Semantic Scholar no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

/**
 * Citas entrantes (forward, un nivel) de un DOI. Cada item trae { contexts,
 * intents, isInfluential, citingPaper }. Lanza NotFoundError si S2 no conoce
 * el DOI (el llamador cae a OpenAlex, ver snowball.js).
 */
async function getCitations(doi, { limit = 25 } = {}) {
  const params = new URLSearchParams({ fields: RELATION_FIELDS, limit: String(Math.max(1, Math.min(1000, limit))) });
  const url = `${BASE}/paper/DOI:${encodeURIComponent(doi)}/citations?${params}`;
  try {
    const { body } = await s2Request(url, { namespace: NAMESPACE, minIntervalMs: minIntervalMs(), retries: 3 });
    return body.data ?? [];
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`Semantic Scholar no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

module.exports = { searchPapers, getPaperByDoi, getReferences, getCitations, _resetKeyRejected };
