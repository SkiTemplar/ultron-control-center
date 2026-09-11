#!/usr/bin/env node
/**
 * research.mjs — CLI del nucleo de investigacion (fase 1 del TFG: buscador de
 * papers OpenAlex + Semantic Scholar, con acceso abierto y sesiones de
 * investigacion). La IA busca y verifica fuentes; NO resume el paper por el
 * usuario, el sigue teniendo que abrirlo y contrastarlo.
 *
 * Nucleo real en hooks/scripts/lib/research/ (CommonJS); este CLI y el
 * servidor MCP (hooks/scripts/research-mcp.js) son las dos capas finas que lo
 * consumen. Sin claves funciona igual (peor presupuesto/ritmo); usa
 * OPENALEX_API_KEY, OPENALEX_MAILTO, SEMANTIC_SCHOLAR_API_KEY,
 * UNPAYWALL_EMAIL si estan en el entorno.
 *
 * Uso:
 *   node scripts/research.mjs search "<query>" [--yearFrom N] [--yearTo N] [--type article|preprint|review] [--minCitations N] [--limit N]
 *   node scripts/research.mjs access <doi> [--session <id>] [--download]
 *   node scripts/research.mjs add <sessionId> <doi>
 *   node scripts/research.mjs bib <sessionId>
 *   node scripts/research.mjs session new "<tema>"
 *   node scripts/research.mjs session list
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const research = require(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'research', 'index.js'));
const { normalizeOpenAlexWork, normalizeS2Paper } = require(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'research', 'normalize.js'));
const openalex = require(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'research', 'openalex.js'));
const semanticScholar = require(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'research', 'semantic-scholar.js'));
const { NotFoundError } = require(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'research', 'errors.js'));

function fail(msg) {
  console.error(`[research] ${msg}`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function cmdSearch(positional, flags) {
  const query = positional[0];
  if (!query) fail('falta la query: research.mjs search "<query>"');
  const opts = {
    yearFrom: flags.yearFrom ? Number(flags.yearFrom) : undefined,
    yearTo: flags.yearTo ? Number(flags.yearTo) : undefined,
    type: flags.type,
    minCitations: flags.minCitations ? Number(flags.minCitations) : undefined,
    limit: flags.limit ? Number(flags.limit) : 20,
  };
  const { results, warnings, totalBeforeFilter } = await research.search(query, opts);
  for (const w of warnings) console.error(`[aviso] ${w}`);
  console.log(JSON.stringify({ query, total: results.length, totalBeforeFilter, results }, null, 2));
}

/** Resuelve el Paper normalizado de un DOI probando OpenAlex y luego Semantic Scholar. */
async function fetchPaperByDoi(doi) {
  try {
    return normalizeOpenAlexWork(await openalex.getWorkByDoi(doi));
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  return normalizeS2Paper(await semanticScholar.getPaperByDoi(doi));
}

async function cmdAccess(positional, flags) {
  const doi = positional[0];
  if (!doi) fail('falta el doi: research.mjs access <doi>');
  const result = await research.resolveAccess(doi);
  if (flags.download) {
    if (!flags.session) fail('--download requiere --session <id>');
    const { dir } = research.resolveSession(flags.session);
    const dest = await research.download(result, join(dir, 'pdfs'));
    result.downloadedTo = dest;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAdd(positional) {
  const [sessionId, doi] = positional;
  if (!sessionId || !doi) fail('uso: research.mjs add <sessionId> <doi>');
  const paper = await fetchPaperByDoi(doi);
  const count = research.addPaper(sessionId, paper);
  console.log(JSON.stringify({ session: sessionId, paperCount: count, added: paper.title }, null, 2));
}

async function cmdBib(positional) {
  const [sessionId] = positional;
  if (!sessionId) fail('uso: research.mjs bib <sessionId>');
  const result = await research.writeBib(sessionId);
  for (const w of result.warnings) console.error(`[aviso] ${w}`);
  console.log(JSON.stringify(result, null, 2));
}

function cmdSession(positional) {
  const [sub, ...rest] = positional;
  if (sub === 'new') {
    const topic = rest.join(' ');
    if (!topic) fail('uso: research.mjs session new "<tema>"');
    console.log(JSON.stringify(research.newSession(topic), null, 2));
    return;
  }
  if (sub === 'list') {
    console.log(JSON.stringify(research.listSessions(), null, 2));
    return;
  }
  fail('uso: research.mjs session new "<tema>" | research.mjs session list');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  try {
    if (cmd === 'search') await cmdSearch(positional, flags);
    else if (cmd === 'access') await cmdAccess(positional, flags);
    else if (cmd === 'add') await cmdAdd(positional);
    else if (cmd === 'bib') await cmdBib(positional);
    else if (cmd === 'session') cmdSession(positional);
    else fail('subcomando desconocido. Uso: search | access | add | bib | session new|list');
  } catch (e) {
    fail(`${e.name ?? 'Error'}: ${String(e.message ?? e)}`);
  }
}

main();
