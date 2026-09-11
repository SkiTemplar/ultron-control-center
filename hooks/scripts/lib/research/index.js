'use strict';

/**
 * lib/research/index.js — barril del nucleo de investigacion (fase 1). El
 * CLI (scripts/research.mjs) y el servidor MCP (hooks/scripts/research-mcp.js)
 * consumen solo estas operaciones, nunca los clientes de proveedor sueltos.
 */

const { search } = require('./search');
const { resolveAccess, download } = require('./access');
const session = require('./session');
const crossref = require('./crossref');

module.exports = {
  search,
  resolveAccess,
  download,
  ...session,
  getBibtex: crossref.getBibtex,
};
