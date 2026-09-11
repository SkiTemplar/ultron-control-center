'use strict';

/**
 * lib/research/unpaywall.js — mejor ubicacion de acceso abierto por DOI.
 * Unpaywall EXIGE un email de contacto real en cada peticion (lo rechaza si
 * no lo es, verificado el 2026-09-11); por eso este cliente es opt-in via
 * UNPAYWALL_EMAIL y nunca lleva un email hardcodeado (repo con espejo
 * publico: cero datos personales en fichero trackeado). Si la variable no
 * esta puesta, resolveAccess() en access.js sigue funcionando solo con
 * best_oa_location de OpenAlex / openAccessPdf de Semantic Scholar.
 * Endpoint confirmado contra la API real el 2026-09-11:
 *   GET https://api.unpaywall.org/v2/<doi>?email=<email>
 */

const { request } = require('./http');
const { NotFoundError, HttpError } = require('./errors');

const BASE = 'https://api.unpaywall.org/v2';
const NAMESPACE = 'unpaywall';
const MIN_INTERVAL_MS = 150;

/** true si hay UNPAYWALL_EMAIL configurado (unica condicion para poder llamar). */
function isConfigured() {
  return Boolean(process.env.UNPAYWALL_EMAIL);
}

/** Mejor localizacion OA para un DOI segun Unpaywall. Lanza si no esta configurado. */
async function getOaLocation(doi) {
  if (!isConfigured()) {
    throw new Error('UNPAYWALL_EMAIL no configurado: Unpaywall es opt-in, ver lib/research/unpaywall.js');
  }
  const url = `${BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(process.env.UNPAYWALL_EMAIL)}`;
  try {
    const { body } = await request(url, { namespace: NAMESPACE, minIntervalMs: MIN_INTERVAL_MS, retries: 2 });
    return body;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new NotFoundError(`Unpaywall no conoce el DOI ${doi}`, { resource: doi });
    }
    throw e;
  }
}

module.exports = { isConfigured, getOaLocation };
