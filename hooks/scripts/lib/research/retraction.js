'use strict';

/**
 * lib/research/retraction.js — comprueba si un DOI esta retractado,
 * combinando Crossref (integra Retraction Watch desde 2023-09) con el flag
 * is_retracted de OpenAlex (heredado de MAG + eventos PubMed; cobertura
 * distinta y con falsos positivos reportados entre 2023-12 y 2024-03, ver
 * plans/2026-09-14-buscador-papers-f2-opciones.md). Ninguna fuente sola es
 * suficiente: se combinan y se listan las fuentes que confirman cada una.
 */

const crossref = require('./crossref');
const openalex = require('./openalex');
const { normalizeDoi } = require('./normalize');
const { NotFoundError } = require('./errors');

/**
 * Estado de retraccion de un DOI: { doi, isRetracted, sources[], notices[],
 * warnings[] }. Lanza NotFoundError solo si NINGUNA fuente confirma el DOI
 * (mismo criterio que access.js::resolveAccess: un fallo de red nunca se
 * trata como "no existe").
 */
async function checkRetraction(doi) {
  const normDoi = normalizeDoi(doi) ?? String(doi).trim();
  const [crossrefRes, openalexRes] = await Promise.allSettled([
    crossref.getRetractionStatus(normDoi),
    openalex.getWorkByDoi(normDoi),
  ]);

  const noSourceConfirmsIt = crossrefRes.status !== 'fulfilled' && openalexRes.status !== 'fulfilled';
  if (noSourceConfirmsIt) {
    throw new NotFoundError(`DOI no encontrado en Crossref ni OpenAlex: ${normDoi}`, { resource: normDoi });
  }

  const warnings = [];
  const sources = new Set();
  const notices = [];

  if (crossrefRes.status === 'fulfilled') {
    for (const notice of crossrefRes.value.notices) {
      notices.push(notice);
      sources.add(notice.source);
    }
  } else if (!(crossrefRes.reason instanceof NotFoundError)) {
    warnings.push(`Crossref fallo: ${String(crossrefRes.reason?.message ?? crossrefRes.reason)}`);
  }

  if (openalexRes.status === 'fulfilled') {
    if (openalexRes.value.is_retracted) sources.add('openalex');
  } else if (!(openalexRes.reason instanceof NotFoundError)) {
    warnings.push(`OpenAlex fallo: ${String(openalexRes.reason?.message ?? openalexRes.reason)}`);
  }

  return { doi: normDoi, isRetracted: sources.size > 0, sources: [...sources], notices, warnings };
}

module.exports = { checkRetraction };
