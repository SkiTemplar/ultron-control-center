'use strict';

/**
 * lib/research/resolve.js — resuelve un Paper normalizado COMPLETO a partir
 * de un DOI: metadatos (OpenAlex primero, Semantic Scholar como fallback,
 * igual que antes) mas el estado de retraccion REAL (Crossref + OpenAlex,
 * ver retraction.js), en vez del `isRetracted:false` por defecto de
 * normalize.js. Unico punto de resolucion: antes vivia duplicado en
 * research-mcp.js y scripts/research.mjs.
 */

const openalex = require('./openalex');
const semanticScholar = require('./semantic-scholar');
const { normalizeOpenAlexWork, normalizeS2Paper, attachRetraction } = require('./normalize');
const { checkRetraction } = require('./retraction');
const { NotFoundError } = require('./errors');

/** Paper normalizado de un DOI, con isRetracted/retraction reales tras consultar Crossref+OpenAlex. */
async function resolvePaperByDoi(doi) {
  let paper;
  try {
    paper = normalizeOpenAlexWork(await openalex.getWorkByDoi(doi));
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  if (!paper) paper = normalizeS2Paper(await semanticScholar.getPaperByDoi(doi));

  try {
    paper = attachRetraction(paper, await checkRetraction(doi));
  } catch (e) {
    // El paper ya esta confirmado por OpenAlex o Semantic Scholar: un fallo de
    // AMBAS fuentes de retraccion no bloquea el alta, solo se pierde ese dato
    // (isRetracted/retraction se quedan en el default de normalize.js).
    if (!(e instanceof NotFoundError)) throw e;
  }
  return paper;
}

module.exports = { resolvePaperByDoi };
