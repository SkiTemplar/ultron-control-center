'use strict';

/**
 * lib/research/access.js — resuelve el acceso abierto a un DOI y,
 * opcionalmente, descarga el PDF a disco. Nunca salta un muro de pago: si
 * ninguna fuente reporta un PDF abierto, openAccessPdf es null (no se
 * inventa una URL). Consulta OpenAlex y Semantic Scholar en paralelo, y
 * Unpaywall como tercera fuente solo si UNPAYWALL_EMAIL esta configurado.
 */

const fs = require('fs');
const path = require('path');
const { request } = require('./http');
const { normalizeDoi } = require('./normalize');
const openalex = require('./openalex');
const semanticScholar = require('./semantic-scholar');
const unpaywall = require('./unpaywall');
const { NotFoundError } = require('./errors');

function candidateFromOpenAlex(work) {
  const url = work.best_oa_location?.pdf_url ?? (work.open_access?.is_oa ? work.open_access.oa_url : null);
  if (!url) return null;
  return { url, source: 'openalex', license: work.best_oa_location?.license ?? null };
}

function candidateFromS2(paper) {
  if (!paper.openAccessPdf?.url) return null;
  return { url: paper.openAccessPdf.url, source: 'semanticscholar', license: paper.openAccessPdf.license ?? null };
}

function candidateFromUnpaywall(data) {
  const loc = data.best_oa_location;
  if (!loc?.url_for_pdf) return null;
  return { url: loc.url_for_pdf, source: 'unpaywall', license: loc.license ?? null };
}

/**
 * Resuelve el mejor PDF de acceso abierto para un DOI. Lanza NotFoundError
 * solo si NINGUNA fuente conoce el DOI (ni OpenAlex ni Semantic Scholar); si
 * el DOI existe pero no hay OA, devuelve openAccessPdf: null explicitamente.
 */
async function resolveAccess(doi) {
  const normDoi = normalizeDoi(doi) ?? String(doi).trim();
  const [oaRes, s2Res] = await Promise.allSettled([openalex.getWorkByDoi(normDoi), semanticScholar.getPaperByDoi(normDoi)]);

  // "No existe" solo se afirma cuando NINGUNA fuente confirma el DOI. Si una
  // fuente dice explicitamente not-found y la otra ni siquiera respondio
  // (rate limit, timeout...), no hay base para decir que existe -> se trata
  // igual que "no encontrado" (nunca se infiere existencia de un fallo de red).
  const noSourceConfirmsIt = oaRes.status !== 'fulfilled' && s2Res.status !== 'fulfilled';
  if (noSourceConfirmsIt) throw new NotFoundError(`DOI no encontrado en OpenAlex ni Semantic Scholar: ${normDoi}`, { resource: normDoi });

  const warnings = [];
  const candidates = [];
  const checkedSources = [];

  if (oaRes.status === 'fulfilled') {
    checkedSources.push('openalex');
    const c = candidateFromOpenAlex(oaRes.value);
    if (c) candidates.push(c);
  } else if (!(oaRes.reason instanceof NotFoundError)) {
    warnings.push(`OpenAlex fallo: ${String(oaRes.reason?.message ?? oaRes.reason)}`);
  }

  if (s2Res.status === 'fulfilled') {
    checkedSources.push('semanticscholar');
    const c = candidateFromS2(s2Res.value);
    if (c) candidates.push(c);
  } else if (!(s2Res.reason instanceof NotFoundError)) {
    warnings.push(`Semantic Scholar fallo: ${String(s2Res.reason?.message ?? s2Res.reason)}`);
  }

  if (unpaywall.isConfigured()) {
    try {
      const data = await unpaywall.getOaLocation(normDoi);
      checkedSources.push('unpaywall');
      const c = candidateFromUnpaywall(data);
      if (c) candidates.push(c);
    } catch (e) {
      if (!(e instanceof NotFoundError)) warnings.push(`Unpaywall fallo: ${String(e.message ?? e)}`);
    }
  }

  return {
    doi: normDoi,
    landingUrl: `https://doi.org/${normDoi}`,
    openAccessPdf: candidates[0] ?? null,
    checkedSources,
    warnings,
  };
}

/**
 * Descarga el PDF de acceso abierto de un resultado de resolveAccess() a
 * `destDir`. Lanza si no hay PDF abierto (nunca descarga de un muro de pago).
 */
async function download(accessResult, destDir) {
  if (!accessResult.openAccessPdf?.url) {
    throw new Error(`sin PDF de acceso abierto para ${accessResult.doi}: no hay nada que descargar`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const { body } = await request(accessResult.openAccessPdf.url, {
    namespace: 'pdf-download',
    minIntervalMs: 0,
    responseType: 'buffer',
    timeoutMs: 30_000,
    retries: 2,
  });
  const filename = `${accessResult.doi.replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
  const dest = path.join(destDir, filename);
  fs.writeFileSync(dest, body);
  return dest;
}

module.exports = { resolveAccess, download };
