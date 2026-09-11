'use strict';

/**
 * lib/research/openalex.js — cliente fino de la API de OpenAlex (Works).
 * Sin clave: funciona igual, pool general. Con OPENALEX_API_KEY: presupuesto
 * diario x10 (https://help.openalex.org/access/pricing/). OPENALEX_MAILTO
 * mete la peticion en el "polite pool" (mas fiable, sin cambiar limites).
 * Limite documentado: 100 peticiones/s; per-page maximo 100
 * (https://help.openalex.org/api/authentication/).
 * Endpoints usados, confirmados contra la API real el 2026-09-11:
 *   GET /works?search=<q>&filter=...&per-page=<n>
 *   GET /works?filter=title_and_abstract.search:<q>,...&per-page=<n>
 *   GET /works/https://doi.org/<doi>
 *
 * searchWorksMulti() (anadido 2026-09-11 tras diagnosticar en vivo que el
 * problema NO era el orden sino la RECUPERACION: para "sim-to-real gap object
 * detection UAV", el `search=` simple no traia ningun paper de sim-to-real en
 * los primeros 100 resultados por relevancia -- estaban fuera del pool antes
 * de rankear nada). Abre el pool con varias consultas en paralelo: la query
 * tal cual, `title_and_abstract.search` (mas precisa, distinto algoritmo de
 * ranking interno de OpenAlex) y hasta 2 variantes con una frase tecnica de
 * la propia query entrecomillada (coincidencia exacta de frase). Union por
 * id, cada variante cacheada por separado.
 */

const { request } = require('./http');
const { NotFoundError, HttpError } = require('./errors');
const { withCache } = require('./cache');

const BASE = 'https://api.openalex.org/works';
const NAMESPACE = 'openalex';
const MIN_INTERVAL_MS = 100; // ~9 req/s: por debajo del limite documentado (100/s) con margen
const VARIANT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h: no repetir consultas contra el presupuesto diario
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'in', 'on', 'and', 'or', 'to', 'with', 'using', 'based', 'from', 'via', 'vs', 'is', 'are', 'as', 'by', 'at']);

function authParams() {
  const params = new URLSearchParams();
  if (process.env.OPENALEX_API_KEY) params.set('api_key', process.env.OPENALEX_API_KEY);
  if (process.env.OPENALEX_MAILTO) params.set('mailto', process.env.OPENALEX_MAILTO);
  return params;
}

/** Construye el filtro `from_publication_date`/`to_publication_date` de OpenAlex. */
function dateFilter({ yearFrom, yearTo }) {
  const parts = [];
  if (yearFrom) parts.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo) parts.push(`to_publication_date:${yearTo}-12-31`);
  return parts;
}

/** GET /works crudo para un `variant` ({mode:'search'|'title_and_abstract', text}). */
async function fetchVariant(variant, { perPage, yearFrom, yearTo }) {
  const params = authParams();
  params.set('per-page', String(Math.max(1, Math.min(100, perPage))));
  const filters = dateFilter({ yearFrom, yearTo });
  if (variant.mode === 'title_and_abstract') {
    filters.push(`title_and_abstract.search:${variant.text}`);
  } else {
    params.set('search', variant.text);
  }
  if (filters.length) params.set('filter', filters.join(','));

  const { body } = await request(`${BASE}?${params.toString()}`, { namespace: NAMESPACE, minIntervalMs: MIN_INTERVAL_MS });
  return body.results ?? [];
}

function fetchVariantCached(variant, opts) {
  const cacheKey = `oa-variant:${JSON.stringify({ variant, opts })}`;
  return withCache(cacheKey, VARIANT_CACHE_TTL_MS, () => fetchVariant(variant, opts)).then((r) => r.value);
}

/** Reemplaza la 1a aparicion (case-insensitive) de `phrase` en `query` por una version entrecomillada. */
function quotePhraseInQuery(query, phrase) {
  const escaped = phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(escaped, 'i');
  return re.test(query) ? query.replace(re, `"${phrase}"`) : `"${phrase}" ${query}`;
}

/**
 * Extrae hasta 2 frases tecnicas de la query para volver a buscar con esa
 * frase entrecomillada (coincidencia exacta): tokens con guion tal cual
 * aparecen ("sim-to-real") y bigramas de palabras informativas consecutivas
 * ("domain randomization"). Acotado a 2 para no disparar el numero de
 * peticiones.
 */
function extractPhrases(query) {
  const phrases = new Set();
  for (const m of String(query).matchAll(/[a-zA-Z]+(?:-[a-zA-Z]+)+/g)) phrases.add(m[0]);
  const words = String(query).toLowerCase().match(/[a-z0-9-]+/g) ?? [];
  for (let i = 0; i < words.length - 1; i += 1) {
    const [a, b] = [words[i], words[i + 1]];
    if (a.length < 3 || b.length < 3 || STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    phrases.add(`${a} ${b}`);
  }
  return [...phrases].slice(0, 2);
}

/** Las variantes de busqueda a lanzar en paralelo para una query. */
function buildSearchVariants(query) {
  const variants = [{ mode: 'search', text: query }, { mode: 'title_and_abstract', text: query }];
  for (const phrase of extractPhrases(query)) {
    if (phrase.toLowerCase() === String(query).toLowerCase()) continue;
    variants.push({ mode: 'search', text: quotePhraseInQuery(query, phrase) });
  }
  return variants;
}

/**
 * Busca works en OpenAlex con un pool ampliado: varias variantes en paralelo
 * (ver buildSearchVariants), union por id, cada variante cacheada aparte. Si
 * alguna variante falla no aborta las demas (Promise.allSettled).
 */
async function searchWorksMulti(query, { limit = 50, yearFrom, yearTo } = {}) {
  const perPage = Math.max(limit, 50);
  const variants = buildSearchVariants(query);
  const settled = await Promise.allSettled(variants.map((v) => fetchVariantCached(v, { perPage, yearFrom, yearTo })));

  const byId = new Map();
  const errors = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      for (const w of outcome.value) if (w.id && !byId.has(w.id)) byId.set(w.id, w);
    } else {
      errors.push(`variante "${variants[i].mode}:${variants[i].text}" fallo: ${String(outcome.reason?.message ?? outcome.reason)}`);
    }
  });

  return { results: [...byId.values()], variantsQueried: variants.map((v) => `${v.mode}:${v.text}`), errors };
}

/** Busca works en OpenAlex con una sola consulta (`search=`). Usado por tests/herramientas simples. */
async function searchWorks(query, { limit = 25, yearFrom, yearTo } = {}) {
  return fetchVariant({ mode: 'search', text: query }, { perPage: limit, yearFrom, yearTo });
}

/** Resuelve un work de OpenAlex por DOI. Lanza NotFoundError si no existe. */
async function getWorkByDoi(doi) {
  const params = authParams();
  const url = `${BASE}/https://doi.org/${encodeURIComponent(doi)}${params.toString() ? `?${params}` : ''}`;
  try {
    const { body } = await request(url, { namespace: NAMESPACE, minIntervalMs: MIN_INTERVAL_MS, retries: 2 });
    return body;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`OpenAlex no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

module.exports = { searchWorks, searchWorksMulti, getWorkByDoi, buildSearchVariants, extractPhrases };
