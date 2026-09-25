/**
 * kanban-closures.selftest.mjs — lib/kanban-closures.js: cruza la seccion
 * "## Cierres propuestos" de una bitacora contra el kanban vivo del
 * proyecto. Puro (sin IO); casos con caso negativo (mandamiento 7).
 * Uso: node hooks/scripts/kanban-closures.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  extractSection,
  parseClosureMentions,
  openCardsMatchingMentions,
  renderCierresPendientesLines,
} = require(join(__dirname, 'lib', 'kanban-closures.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const SUMMARY_CON_CIERRES = [
  '## Temas',
  '- migracion de auth',
  '## Decisiones',
  '- (nada relevante)',
  '## Pendientes',
  '- revisar tests',
  '## Ficheros/commits relevantes',
  '- auth.rs',
  '## Cierres propuestos',
  '- Arreglar bug de sesion resume',
  '- Migrar auth a JWT',
].join('\n');

const SUMMARY_SIN_CIERRES = [
  '## Temas',
  '- charla suelta',
  '## Cierres propuestos',
  '(nada relevante)',
].join('\n');

function board(cards) {
  return {
    columns: [
      { id: 'c-back', role: 'todo' },
      { id: 'c-doing', role: 'doing' },
      { id: 'c-done', role: 'done' },
    ],
    cards,
  };
}

// --- extractSection / parseClosureMentions ---------------------------------
console.log('extractSection / parseClosureMentions');
A(
  extractSection(SUMMARY_CON_CIERRES, 'cierres propuestos').includes('Arreglar bug de sesion resume'),
  'extrae el cuerpo de la seccion pedida',
  extractSection(SUMMARY_CON_CIERRES, 'cierres propuestos')
);
A(extractSection('sin secciones', 'cierres propuestos') === '', 'sin esa seccion -> string vacio (caso negativo)', '?');

const mentions = parseClosureMentions(SUMMARY_CON_CIERRES);
A(
  mentions.length === 2
    && mentions[0] === 'Arreglar bug de sesion resume'
    && mentions[1] === 'Migrar auth a JWT',
  'bullets de la seccion, sin el guion',
  JSON.stringify(mentions)
);
A(parseClosureMentions(SUMMARY_SIN_CIERRES).length === 0, '"(nada relevante)" -> [] (caso negativo)', JSON.stringify(parseClosureMentions(SUMMARY_SIN_CIERRES)));
A(parseClosureMentions('').length === 0, 'summary vacio -> [] (caso negativo)', '?');
A(parseClosureMentions(null).length === 0, 'summary null -> [] sin lanzar (caso negativo)', '?');

// --- openCardsMatchingMentions -----------------------------------------------
console.log('openCardsMatchingMentions');
const b = board([
  { id: 'card-1', column_id: 'c-doing', title: 'Arreglar bug de sesion resume' },
  { id: 'card-2', column_id: 'c-back', title: 'Migrar auth a JWT' },
  { id: 'card-3', column_id: 'c-done', title: 'Ya cerrada de verdad' },
  { id: 'card-4', column_id: 'c-back', title: 'UI' }, // titulo demasiado corto
]);
const matches = openCardsMatchingMentions(b, mentions);
A(
  matches.length === 2 && matches.map((m) => m.id).sort().join(',') === 'card-1,card-2',
  'matchea por substring de titulo, SOLO cards vivas (no Done)',
  JSON.stringify(matches)
);
A(
  !matches.some((m) => m.id === 'card-3'),
  'caso negativo: una card en Done, aunque el titulo aparezca, NUNCA sale',
  JSON.stringify(matches)
);
A(
  openCardsMatchingMentions(b, ['algo que no coincide con nada']).length === 0,
  'caso negativo: mencion sin card viva que la contenga -> []',
  JSON.stringify(openCardsMatchingMentions(b, ['algo que no coincide con nada']))
);
A(
  openCardsMatchingMentions(b, ['UI']).length === 0,
  'caso negativo: titulo demasiado corto (< 4) nunca matchea, evita falsos positivos',
  JSON.stringify(openCardsMatchingMentions(b, ['UI']))
);
A(openCardsMatchingMentions(null, mentions).length === 0, 'caso negativo: board null -> [] sin lanzar', '?');

// dedupe: la misma card no puede aparecer dos veces aunque dos menciones la toquen
const dupBoard = board([{ id: 'card-1', column_id: 'c-doing', title: 'Arreglar bug de sesion resume' }]);
const dupMatches = openCardsMatchingMentions(dupBoard, ['Arreglar bug de sesion resume', 'bug de sesion resume']);
A(dupMatches.length === 1, 'dedupe: la misma card no se repite aunque varias menciones la toquen', JSON.stringify(dupMatches));

// --- renderCierresPendientesLines --------------------------------------------
console.log('renderCierresPendientesLines');
const lines = renderCierresPendientesLines('ultron', matches);
A(lines.length === 1, 'una sola linea acotada', JSON.stringify(lines));
A(lines[0].includes('cierres pendientes de confirmar'), 'lleva la etiqueta del aviso', lines[0]);
A(lines[0].includes('node ~/.ultron/scripts/kanban.mjs mv ultron card-1 done'), 'incluye el comando EXACTO con id completo', lines[0]);
A(renderCierresPendientesLines('ultron', []).length === 0, 'caso negativo: sin matches -> [] (sin aviso vacio)', '?');
A(renderCierresPendientesLines('', matches).length === 0, 'caso negativo: sin projectId -> [] (no se puede construir el comando)', '?');

const manyMatches = Array.from({ length: 8 }, (_, i) => ({ id: `card-${i}`, title: `Card ${i} con titulo largo` }));
const cappedLines = renderCierresPendientesLines('ultron', manyMatches, 5);
A(cappedLines[0].includes('+3 mas'), 'acota a `limit` y avisa de cuantas mas hay', cappedLines[0]);

console.log('');
if (fail === 0) {
  console.log('PASS  kanban-closures (0 fallos)');
  process.exitCode = 0;
} else {
  console.error(`FAIL  kanban-closures (${fail} fallos)`);
  process.exitCode = 1;
}
