'use strict';

/**
 * lib/research/snowball.js — bola de nieve acotada a UN nivel (opcion B de
 * la tarjeta F2, ver plans/2026-09-14-buscador-papers-f2-opciones.md):
 * backward (referencias) y/o forward (citas) de un DOI, via Semantic
 * Scholar con fallback a OpenAlex si S2 falla o no conoce el DOI. Una sola
 * pagina por direccion (sin recursion, sin paginar mas alla de `limit`).
 * Ranking: isInfluential primero, luego citationCount descendente.
 * Deduplica por DOI normalizado (o titulo+anio si no hay DOI, ver
 * merge.js::dedupeKey) y excluye el propio seed y los DOI ya presentes en
 * la sesion (`excludeKeys`, calculado por el llamador con session.js).
 */

const semanticScholar = require('./semantic-scholar');
const openalex = require('./openalex');
const { normalizeS2Paper, normalizeOpenAlexWork, normalizeDoi } = require('./normalize');
const { dedupeKey } = require('./merge');
const { NotFoundError } = require('./errors');
const session = require('./session');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DIRECTIONS = ['backward', 'forward', 'both'];

/** Valida y normaliza `limit`: entero 1..MAX_LIMIT. Rechaza explicitamente fuera de rango. */
function clampLimit(limit) {
  const n = limit === undefined ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new Error(`limit fuera de rango (1-${MAX_LIMIT}): ${limit}`);
  }
  return n;
}

function relationFromS2(item, key) {
  const raw = item[key];
  if (!raw) return null;
  return {
    paper: normalizeS2Paper(raw, {}),
    contexts: item.contexts ?? [],
    intents: item.intents ?? [],
    isInfluential: Boolean(item.isInfluential),
  };
}

async function backwardViaS2(doi, limit) {
  const items = await semanticScholar.getReferences(doi, { limit });
  return items.map((it) => relationFromS2(it, 'citedPaper')).filter(Boolean);
}

async function forwardViaS2(doi, limit) {
  const items = await semanticScholar.getCitations(doi, { limit });
  return items.map((it) => relationFromS2(it, 'citingPaper')).filter(Boolean);
}

async function backwardViaOpenAlex(doi, limit) {
  const ids = await openalex.getReferencedWorkIds(doi, { limit });
  const works = await openalex.getWorksByIds(ids);
  return works.map((w) => ({ paper: normalizeOpenAlexWork(w), contexts: [], intents: [], isInfluential: false }));
}

async function forwardViaOpenAlex(doi, limit) {
  const works = await openalex.getCitingWorks(doi, { limit });
  return works.map((w) => ({ paper: normalizeOpenAlexWork(w), contexts: [], intents: [], isInfluential: false }));
}

/** Un nivel de bola de nieve en una direccion: S2 primero, OpenAlex si S2 falla o no conoce el DOI. */
async function fetchDirection(doi, direction, limit) {
  const [viaS2, viaOpenAlex] = direction === 'backward'
    ? [backwardViaS2, backwardViaOpenAlex]
    : [forwardViaS2, forwardViaOpenAlex];
  try {
    return { items: await viaS2(doi, limit), source: 'semanticscholar' };
  } catch (e) {
    const items = await viaOpenAlex(doi, limit);
    return { items, source: 'openalex', fallbackReason: String(e.message ?? e) };
  }
}

/** isInfluential primero, luego citations descendente (solo desempata). Recibe candidatos ya aplanados (paper + relation/contexts/intents/isInfluential). */
function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.isInfluential !== b.isInfluential) return a.isInfluential ? -1 : 1;
    return (b.citations ?? 0) - (a.citations ?? 0);
  });
}

/**
 * Bola de nieve pura (sin tocar disco): { seedDoi, direction, candidates,
 * warnings }. `excludeKeys` (Set de dedupeKey) descarta candidatos ya
 * conocidos por el llamador (tipicamente los papers ya guardados en la sesion).
 */
async function fetchSnowball(doi, { direction = 'both', limit = DEFAULT_LIMIT, excludeKeys = new Set() } = {}) {
  if (!DIRECTIONS.includes(direction)) throw new Error(`direction invalida: ${direction} (usar backward|forward|both)`);
  const safeLimit = clampLimit(limit);
  const seedDoi = normalizeDoi(doi) ?? String(doi).trim();
  const seedKey = `doi:${seedDoi}`;
  const dirsToFetch = direction === 'both' ? ['backward', 'forward'] : [direction];

  const warnings = [];
  const byKey = new Map();
  for (const dir of dirsToFetch) {
    const relation = dir === 'backward' ? 'reference' : 'citation';
    const { items, source, fallbackReason } = await fetchDirection(seedDoi, dir, safeLimit);
    if (source === 'openalex') {
      warnings.push(`${dir}: Semantic Scholar no respondio (${fallbackReason}); se uso OpenAlex como fallback`);
    }
    for (const item of items) {
      const key = dedupeKey(item.paper);
      if (key === seedKey || excludeKeys.has(key)) continue;
      const existing = byKey.get(key);
      const candidate = { ...item.paper, relation, contexts: item.contexts, intents: item.intents, isInfluential: item.isInfluential };
      if (!existing || (candidate.isInfluential && !existing.isInfluential)) byKey.set(key, candidate);
    }
  }

  const candidates = rankCandidates([...byKey.values()]).slice(0, safeLimit * dirsToFetch.length);
  return { seedDoi, direction, candidates, warnings };
}

/**
 * Bola de nieve de una sesion: valida que `sessionId` existe (NotFoundError
 * si no, caso negativo explicito), excluye los papers ya guardados en
 * papers.json, y persiste el resultado en snowball.json (sustituyendo la
 * entrada de ese mismo seed+direction si ya existia -- idempotente).
 */
async function runSnowball(sessionId, doi, opts = {}) {
  session.resolveSession(sessionId); // lanza NotFoundError si la sesion no existe
  const excludeKeys = new Set(session.readPapers(sessionId).map(dedupeKey));
  const result = await fetchSnowball(doi, { ...opts, excludeKeys });
  const saved = session.saveSnowball(sessionId, result);
  return { session: sessionId, ...saved, warnings: result.warnings };
}

module.exports = { fetchSnowball, runSnowball, clampLimit, DEFAULT_LIMIT, MAX_LIMIT };
