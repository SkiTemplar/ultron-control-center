'use strict';

/**
 * lib/research/index.js — barril del nucleo de investigacion (fases 1 y 2:
 * busqueda/acceso/sesiones, retraccion y bola de nieve). El CLI
 * (scripts/research.mjs) y el servidor MCP (hooks/scripts/research-mcp.js)
 * consumen solo estas operaciones, nunca los clientes de proveedor sueltos.
 */

const { search } = require('./search');
const { resolveAccess, download } = require('./access');
const session = require('./session');
const crossref = require('./crossref');
const { checkRetraction } = require('./retraction');
const { runSnowball } = require('./snowball');
const { resolvePaperByDoi } = require('./resolve');

module.exports = {
  search,
  resolveAccess,
  download,
  ...session,
  getBibtex: crossref.getBibtex,
  checkRetraction,
  snowball: runSnowball,
  resolvePaperByDoi,
};
