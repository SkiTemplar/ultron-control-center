// portfolio-link-plan.mjs — plan puro (sin E/S) para vincular las tarjetas del
// tablero Portfolio con los proyectos registrados. Lo consume
// scripts/portfolio-link.mjs.
//
// Criterio, por orden:
//   1. ruta: la ruta del proyecto aparece en la descripción (sin distinguir
//      mayúsculas y con las barras normalizadas). Una coincidencia exacta con
//      el primer segmento («ruta · stack · remoto») gana a una contenida.
//   2. nombre: título de la tarjeta == nombre (o id) del proyecto, normalizado.
// Un proyecto reclamado por varias tarjetas deja todas como ambiguas.

import { PORTFOLIO_PROJECT_ID, descriptionPath, normalizeName, normalizePath } from './portfolio-board.mjs';

/** La ruta aparece completa: lo siguiente no puede seguir el mismo nombre. */
function containsPath(haystack, path) {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(path, from);
    if (i === -1) return false;
    const next = haystack[i + path.length];
    if (next === undefined || next === ' ' || next === '\n' || next === '·') return true;
    from = i + 1;
  }
}

function candidatesByPath(card, projects) {
  const desc = normalizePath(card.description);
  const first = descriptionPath(card.description);
  const withPath = projects.filter((p) => p.normPath);
  const exact = withPath.filter((p) => p.normPath === first);
  if (exact.length) return exact;
  return withPath.filter((p) => containsPath(desc, p.normPath));
}

function candidatesByName(card, projects) {
  const want = normalizeName(card.title);
  if (!want) return [];
  return projects.filter((p) => normalizeName(p.name) === want || normalizeName(p.id) === want);
}

function matchCard(card, projects) {
  const byPath = candidatesByPath(card, projects);
  if (byPath.length) return { by: 'ruta', candidates: byPath };
  return { by: 'nombre', candidates: candidatesByName(card, projects) };
}

/**
 * @param {Array<{id:string,title:string,description?:string,project?:string}>} cards
 * @param {Array<{id:string,name?:string,path?:string}>} registry
 * @returns {{linked:Array, ambiguous:Array, unmatched:Array, already:Array}}
 */
export function planLinks(cards, registry) {
  const projects = registry
    .filter((p) => p && p.id && p.id !== PORTFOLIO_PROJECT_ID)
    .map((p) => ({ id: p.id, name: p.name || '', normPath: normalizePath(p.path) }));
  const taken = new Set(cards.map((c) => c.project).filter(Boolean));
  const plan = { linked: [], ambiguous: [], unmatched: [], already: [] };
  const proposals = [];
  for (const card of cards) {
    if (card.project) { plan.already.push({ card }); continue; }
    const { by, candidates } = matchCard(card, projects);
    if (candidates.length === 0) plan.unmatched.push({ card });
    else if (candidates.length > 1) plan.ambiguous.push({ card, by, candidates: candidates.map((p) => p.id), reason: 'varios proyectos' });
    else proposals.push({ card, by, project: candidates[0].id });
  }
  const claims = new Map();
  for (const p of proposals) claims.set(p.project, (claims.get(p.project) || 0) + 1);
  for (const p of proposals) {
    if (claims.get(p.project) > 1 || taken.has(p.project)) {
      const reason = taken.has(p.project) ? 'el proyecto ya tiene tarjeta' : 'varias tarjetas para el mismo proyecto';
      plan.ambiguous.push({ card: p.card, by: p.by, candidates: [p.project], reason });
    } else {
      plan.linked.push(p);
    }
  }
  return plan;
}
