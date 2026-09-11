'use strict';

/**
 * lib/research/crossref.js — metadatos de DOI y BibTeX oficial. Crossref NO
 * se usa como buscador (decision del usuario): solo para (a) confirmar que
 * un DOI existe y traer sus metadatos canonicos, y (b) generar BibTeX real
 * via negociacion de contenido de doi.org (Accept: application/x-bibtex),
 * que resuelve contra la agencia de registro correcta (Crossref, DataCite...)
 * sin que la IA redacte el BibTeX.
 * Endpoints confirmados contra la API real el 2026-09-11:
 *   GET https://api.crossref.org/works/<doi>            (JSON, 404 limpio)
 *   GET https://doi.org/<doi>  Accept: application/x-bibtex (texto BibTeX)
 */

const { request } = require('./http');
const { NotFoundError, HttpError } = require('./errors');

const API_BASE = 'https://api.crossref.org/works';
const NAMESPACE = 'crossref';
const MIN_INTERVAL_MS = 200;

function politeHeaders() {
  const mailto = process.env.OPENALEX_MAILTO; // mismo contacto politeness; no hay env dedicado para Crossref
  return mailto ? { 'User-Agent': `ultron-research/1.0 (mailto:${mailto})` } : {};
}

/** Metadatos canonicos de Crossref para un DOI. Lanza NotFoundError si no existe. */
async function getWorkByDoi(doi) {
  const url = `${API_BASE}/${encodeURIComponent(doi)}`;
  try {
    const { body } = await request(url, {
      namespace: NAMESPACE,
      minIntervalMs: MIN_INTERVAL_MS,
      headers: politeHeaders(),
      retries: 2,
    });
    return body.message;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`Crossref no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

/**
 * BibTeX oficial de un DOI. Verifica primero que el DOI existe (Crossref da
 * un 404 JSON limpio; doi.org devuelve una pagina HTML de error que no
 * queremos colar como si fuera BibTeX valido).
 */
async function getBibtex(doi) {
  await getWorkByDoi(doi); // lanza NotFoundError si el DOI no existe
  const url = `https://doi.org/${encodeURIComponent(doi)}`;
  const { body } = await request(url, {
    namespace: 'doi-org',
    minIntervalMs: MIN_INTERVAL_MS,
    headers: { Accept: 'application/x-bibtex', ...politeHeaders() },
    responseType: 'text',
    retries: 2,
  });
  return body.trim();
}

module.exports = { getWorkByDoi, getBibtex };
