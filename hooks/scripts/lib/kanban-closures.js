'use strict';

/**
 * lib/kanban-closures.js — cruza la seccion "## Cierres propuestos" de la
 * bitacora (summary.md, escrita por session-summarize-previous.js) contra el
 * kanban VIVO del proyecto, para avisar en el resume cuando una card que la
 * bitacora dio por cerrada/terminada SIGUE abierta.
 *
 * Por que por TITULO y no por id (2026-09-25): el digest que ve `claude -p`
 * (lib/session-digest.js) quita TODAS las llamadas a herramientas -- un
 * `kanban.mjs mv <proyecto> <id> done` nunca llega al modelo. Lo unico que
 * puede citar es el texto que el propio asistente narro, y ahi lo normal es
 * el TITULO de la tarea ("cerre la card de X"), casi nunca el id. Por eso el
 * emparejamiento es substring case-insensitive titulo<->mencion, con un largo
 * minimo para evitar falsos positivos triviales (un titulo de 2-3 letras
 * matchearia casi cualquier frase).
 *
 * Puro (solo texto/JSON en memoria); la IO (leer summary.md / kanban.json) la
 * hace el llamante (hooks/scripts/memory-session-resume.js).
 */

// Titulos mas cortos que esto no se usan para emparejar: demasiado
// inespecificos, generan falsos positivos con cualquier frase que los
// contenga como substring.
const MIN_TITLE_LEN = 4;

/** Nombre de la seccion tal como la pide buildPrompt() en session-summarize-previous.js. */
const SECTION_HEADING = 'cierres propuestos';

/**
 * Contenido (sin la cabecera `## ...`) de la primera seccion de `content`
 * cuyo titulo contiene `headingSubstr` (case-insensitive). '' si no hay
 * ninguna con ese titulo.
 * @param {string} content
 * @param {string} headingSubstr
 * @returns {string}
 */
function extractSection(content, headingSubstr) {
  const text = String(content || '');
  const needle = String(headingSubstr || '').toLowerCase();
  const parts = text.split(/^(?=## )/m);
  for (const part of parts) {
    const m = part.match(/^## +(.*)$/m);
    if (m && m[1].toLowerCase().includes(needle)) {
      return part.replace(/^## .*$/m, '').trim();
    }
  }
  return '';
}

/**
 * Lineas de la seccion "## Cierres propuestos" de un summary.md, una entrada
 * por linea (bullets `-`/`*` o texto suelto), sin la marca "(nada relevante)".
 * [] si la seccion no existe o esta vacia.
 * @param {string} summaryContent
 * @returns {string[]}
 */
function parseClosureMentions(summaryContent) {
  const section = extractSection(summaryContent, SECTION_HEADING);
  if (!section) return [];
  return section
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^\(nada relevante\)$/i.test(line));
}

/**
 * Cards VIVAS (columna con role != "done") de `board` cuyo titulo aparece
 * (o contiene) alguna de las `mentions`. Dedupe por id; el orden respeta el
 * de `mentions` y, dentro de cada mencion, el orden de `board.cards`.
 * @param {object} board kanban.json ya parseado
 * @param {string[]} mentions
 * @returns {{id: string, title: string}[]}
 */
function openCardsMatchingMentions(board, mentions) {
  const columns = Array.isArray(board && board.columns) ? board.columns : [];
  const doneIds = new Set(columns.filter((c) => c && c.role === 'done').map((c) => c.id));
  const cards = Array.isArray(board && board.cards) ? board.cards : [];
  const open = cards.filter((c) => c && !doneIds.has(c.column_id) && typeof c.id === 'string' && typeof c.title === 'string');

  const seen = new Set();
  const out = [];
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const low = String(mention || '').toLowerCase().trim();
    if (!low) continue;
    for (const card of open) {
      if (seen.has(card.id)) continue;
      const title = card.title.toLowerCase().trim();
      if (title.length < MIN_TITLE_LEN) continue; // demasiado corto: no fiable
      if (!low.includes(title) && !title.includes(low)) continue;
      seen.add(card.id);
      out.push({ id: card.id, title: card.title });
    }
  }
  return out;
}

const DEFAULT_LIMIT = 5;

/**
 * Lineas del aviso "cierres pendientes de confirmar" (una sola linea,
 * acotada a `limit` cards) con el comando EXACTO de `kanban.mjs mv` para cada
 * una. [] sin matches.
 * @param {string} projectId
 * @param {{id: string, title: string}[]} matches
 * @param {number} [limit]
 * @returns {string[]}
 */
function renderCierresPendientesLines(projectId, matches, limit = DEFAULT_LIMIT) {
  if (!projectId || !Array.isArray(matches) || matches.length === 0) return [];
  const capped = matches.slice(0, limit);
  const items = capped.map(
    (m) => `${m.title} [${m.id}] -> node ~/.ultron/scripts/kanban.mjs mv ${projectId} ${m.id} done`
  );
  const omitted = matches.length - capped.length;
  const tail = omitted > 0 ? ` (+${omitted} mas)` : '';
  return [`cierres pendientes de confirmar (la bitacora anterior las da por cerradas y siguen abiertas): ${items.join(' | ')}${tail}`];
}

module.exports = {
  MIN_TITLE_LEN,
  SECTION_HEADING,
  extractSection,
  parseClosureMentions,
  openCardsMatchingMentions,
  renderCierresPendientesLines,
};
