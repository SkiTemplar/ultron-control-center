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
 *   GET /graph/v1/paper/search/match?query=<titulo>&fields=...
 * 2026-11-08: la clave de usuario vuelve a dar 403. Con la clave rechazada el
 * ritmo seguia en 1 req/s (solo se miraba si la variable existia) y el pool
 * anonimo devolvia 429 en casi todas las busquedas en paralelo.
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

// La clave dejo de valer el 2026-09-23 (403 con clave, 200 sin ella): cada
// llamada fallaba entera en vez de degradar al pool compartido. Tras el primer
// 401/403 con clave se deja de enviar durante el resto del proceso.
let keyRejected = false;

function hasUsableKey() {
  return Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY) && !keyRejected;
}

function authHeaders() {
  return hasUsableKey() ? { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY } : {};
}

/** Ritmo y backoff segun haya clave valida (1 req/s) o pool anonimo (satura en rafagas). */
function pacing() {
  return hasUsableKey()
    ? { minIntervalMs: 1_000 }
    : { minIntervalMs: 3_000, backoffBaseMs: 2_000, backoffMaxMs: 16_000 };
}

function minIntervalMs() {
  return pacing().minIntervalMs;
}

/**
 * request() con la clave si la hay; si S2 la rechaza (401/403), avisa una vez
 * por stderr y repite sin clave (pool compartido: puede dar 429 en rafagas,
 * pero no falla por la clave). Repite toda peticion que salio con la clave,
 * aunque otra ya la haya marcado como rechazada: con varias en vuelo, las
 * demas reciben su 403 despues (2026-11-08: 4 de 5 busquedas en paralelo
 * fallaban asi).
 */
async function s2Request(url, { anonRetries, ...opts }) {
  let sentWithKey = false;
  // Se decide en cada intento, con turno: si otra peticion ya vio el 403
  // mientras esta esperaba en la cola, esta sale sin clave.
  const keyedHeaders = () => {
    sentWithKey = hasUsableKey();
    return authHeaders();
  };
  const withPacing = () => ({
    ...opts,
    ...pacing(),
    retries: hasUsableKey() ? opts.retries : (anonRetries ?? opts.retries),
    namespace: NAMESPACE,
  });
  try {
    return await request(url, { ...withPacing(), headers: keyedHeaders });
  } catch (e) {
    const rejected = e instanceof HttpError && (e.status === 401 || e.status === 403);
    if (!rejected || !sentWithKey) throw e;
    if (!keyRejected) {
      keyRejected = true;
      process.stderr.write(
        `[research] Semantic Scholar rechaza SEMANTIC_SCHOLAR_API_KEY (HTTP ${e.status}): se sigue sin clave. ` +
          'Regenerala en https://www.semanticscholar.org/product/api\n',
      );
    }
    return request(url, { ...withPacing(), headers: {} });
  }
}

// Cortocircuito de /paper/search (2026-11-08, medido: 5 busquedas en paralelo
// sin clave valida tardaban 3 min en reintentos y 4 acababan en 429). El pool
// anonimo de ese endpoint satura a nivel global, no por nuestro ritmo. El
// primer 429 abre la pausa: la busqueda que lo recibio hace de sonda con sus
// reintentos y las demas fallan sin llamar a S2; si la sonda acaba bien, la
// pausa se cierra. Las consultas por DOI no pasan por aqui (ese endpoint si
// responde sin clave).
const SEARCH_BREAKER_MS = 2 * 60 * 1000;
let searchBreakerUntil = 0;

function keyHint() {
  if (keyRejected) return 'SEMANTIC_SCHOLAR_API_KEY da 403: hay que regenerarla';
  if (!process.env.SEMANTIC_SCHOLAR_API_KEY) return 'sin SEMANTIC_SCHOLAR_API_KEY';
  return 'con clave';
}

function searchBreakerError() {
  if (Date.now() >= searchBreakerUntil) return null;
  const secs = Math.ceil((searchBreakerUntil - Date.now()) / 1000);
  return new HttpError(
    `HTTP 429: busqueda de Semantic Scholar en pausa ${secs} s tras saturar el pool (${keyHint()})`,
    { status: 429, url: `${BASE}/paper/search` },
  );
}

/** Solo para tests: vuelve a enviar la clave y cierra el cortocircuito. */
function _resetKeyRejected() {
  keyRejected = false;
  searchBreakerUntil = 0;
}

/**
 * Busca papers en Semantic Scholar. Devuelve data[] tal cual la API. Sin
 * clave valida, un solo reintento: esperar mas no vacia un pool global.
 */
async function searchPapers(query, { limit = 25 } = {}) {
  const params = new URLSearchParams({ query, fields: FIELDS, limit: String(Math.max(1, Math.min(100, limit))) });
  let isProbe = false;
  try {
    const { body } = await s2Request(`${BASE}/paper/search?${params}`, {
      retries: 4,
      anonRetries: 1,
      abortCheck: () => (isProbe ? null : searchBreakerError()),
      onRateLimited: () => {
        if (!isProbe && searchBreakerError()) return; // ya hay otra sonda
        isProbe = true;
        searchBreakerUntil = Date.now() + SEARCH_BREAKER_MS;
      },
    });
    if (isProbe) searchBreakerUntil = 0;
    return body.data ?? [];
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 429) throw e;
    throw searchBreakerError() ?? e;
  }
}

/** Segmento de ruta del paper: su paperId de S2 si se conoce, si no `DOI:<doi>`. */
function paperPath(doi, paperId) {
  return paperId ? encodeURIComponent(paperId) : `DOI:${encodeURIComponent(doi)}`;
}

/**
 * Mejor coincidencia de S2 para un titulo (/paper/search/match), o null si no
 * la hay. Sirve para los DOI que S2 no indexa: un articulo de revista que S2
 * solo conoce como preprint de arXiv responde 404 por DOI.
 */
async function matchPaperByTitle(title) {
  const params = new URLSearchParams({ query: title, fields: 'title,year,externalIds' });
  try {
    const { body } = await s2Request(`${BASE}/paper/search/match?${params}`, { retries: 3 });
    return body.data?.[0] ?? null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** Resuelve un paper de Semantic Scholar por DOI. Lanza NotFoundError si no existe. */
async function getPaperByDoi(doi) {
  const url = `${BASE}/paper/DOI:${encodeURIComponent(doi)}?fields=${FIELDS}`;
  try {
    const { body } = await s2Request(url, { retries: 3 });
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
async function getReferences(doi, { limit = 25, paperId } = {}) {
  const params = new URLSearchParams({ fields: RELATION_FIELDS, limit: String(Math.max(1, Math.min(1000, limit))) });
  const url = `${BASE}/paper/${paperPath(doi, paperId)}/references?${params}`;
  try {
    const { body } = await s2Request(url, { retries: 3 });
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
async function getCitations(doi, { limit = 25, paperId } = {}) {
  const params = new URLSearchParams({ fields: RELATION_FIELDS, limit: String(Math.max(1, Math.min(1000, limit))) });
  const url = `${BASE}/paper/${paperPath(doi, paperId)}/citations?${params}`;
  try {
    const { body } = await s2Request(url, { retries: 3 });
    return body.data ?? [];
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`Semantic Scholar no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

module.exports = {
  searchPapers,
  getPaperByDoi,
  getReferences,
  getCitations,
  matchPaperByTitle,
  minIntervalMs,
  _resetKeyRejected,
};
