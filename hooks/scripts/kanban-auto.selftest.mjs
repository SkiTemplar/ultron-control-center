/**
 * kanban-auto.selftest.mjs — lib/kanban-auto.js: aplica al kanban los cierres
 * por id y las tarjetas nuevas de una bitacora, con log y deshacer. Casos con
 * caso negativo (mandamiento 7). IO solo en un directorio temporal.
 * Uso: node hooks/scripts/kanban-auto.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ka = require(join(__dirname, 'lib', 'kanban-auto.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const board = () => ({
  project_id: 'demo',
  columns: [
    { id: 'c-todo', name: 'Backlog', order: 0, role: 'todo' },
    { id: 'c-doing', name: 'In Progress', order: 1, role: 'doing' },
    { id: 'c-done', name: 'Done', order: 2, role: 'done' },
  ],
  cards: [
    { id: 'card-1-aaaaaa', column_id: 'c-todo', title: 'Validar Lienzo en EUIPO', tags: [] },
    { id: 'card-2-bbbbbb', column_id: 'c-doing', title: 'Fusionar tilde/v1 en main', tags: [] },
    { id: 'card-3-cccccc', column_id: 'c-done', title: 'QA final de v1 en emulador', tags: [] },
  ],
});

const SUMMARY = [
  '## Temas', '- algo',
  '## Cierres propuestos',
  '- card-2-bbbbbb | fusionada en 1a2b3c',
  '- card-3-cccccc | ya estaba hecha',
  '- card-9-zzzzzz | id inventado',
  '- Validar Lienzo en EUIPO (solo titulo, sin id)',
  '## Tarjetas nuevas',
  '- todo | Probar en Xiaomi/HyperOS',
  '- doing | validar lienzo en EUIPÓ',
  '- blocked | Rol no permitido aqui',
  '- todo | corto',
  '- todo | Subir el AAB a Play Console',
  '- todo | Escribir el README',
  '- todo | Cuarta tarjeta que sobra',
].join('\n');

console.log('kanban-auto.selftest');

// --- parseo ---------------------------------------------------------------
const closes = ka.parseClosures(SUMMARY, board());
A(closes.length === 1 && closes[0] === 'card-2-bbbbbb', 'cierres: solo ids de tarjetas abiertas',
  `obtenido ${JSON.stringify(closes)} (no debe cerrar la ya hecha, la inventada ni la citada solo por titulo)`);

const news = ka.parseNewCards(SUMMARY);
A(news.length === 5, 'nuevas: parsea las 5 validas', `obtenido ${news.length}`);
A(!news.some((n) => n.title.includes('Rol no permitido') || n.title === 'corto'), 'nuevas: descarta rol invalido y titulo corto', JSON.stringify(news));

A(ka.renderOpenCardsBlock({ ...board(), cards: [board().cards[2]] }) === '', 'bloque de prompt vacio sin tarjetas abiertas', 'deberia ser ""');
A(ka.renderOpenCardsBlock(board()).includes('card-1-aaaaaa [todo] Validar Lienzo en EUIPO'), 'bloque de prompt con id, rol y titulo', ka.renderOpenCardsBlock(board()));

// --- plan -----------------------------------------------------------------
const plan = ka.planOps({ board: board(), summary: SUMMARY, log: [], sessionId: 's1' });
A(!plan.add.some((a) => ka.normalizeTitle(a.title) === ka.normalizeTitle('Validar Lienzo en EUIPO')), 'dedupe por titulo sin tildes ni mayusculas', JSON.stringify(plan.add));
A(plan.add.length === ka.MAX_NEW && plan.add.map((a) => a.title).join(',') === 'Probar en Xiaomi/HyperOS,Subir el AAB a Play Console,Escribir el README', `plan: tope de ${ka.MAX_NEW} tras quitar duplicados`, JSON.stringify(plan.add));

const noDone = { ...board(), columns: board().columns.filter((c) => c.role !== 'done') };
const planNoDone = ka.planOps({ board: noDone, summary: SUMMARY, log: [], sessionId: 's1' });
A(planNoDone.close.length === 0 && planNoDone.add.length === 0, 'sin columna Done no hace nada', JSON.stringify(planNoDone));

// --- IO: aplicar, idempotencia, exclusion, deshacer, aviso ----------------
const root = mkdtempSync(join(tmpdir(), 'kanban-auto-'));
try {
  mkdirSync(join(root, 'demo'));
  const boardFile = join(root, 'demo', 'kanban.json');
  const logFile = join(root, 'demo', ka.LOG_FILE);
  writeFileSync(boardFile, JSON.stringify(board()));
  const original = readFileSync(boardFile, 'utf8');

  const excluded = ka.applyFromSummary({ projectsDir: root, projectId: 'demo', sessionId: 's1', summary: SUMMARY, excluded: 'kanban:manual' });
  A(excluded.applied === 0 && readFileSync(boardFile, 'utf8') === original && !existsSync(logFile), 'proyecto excluido: no escribe nada', JSON.stringify(excluded));

  let n = 0;
  const r1 = ka.applyFromSummary({ projectsDir: root, projectId: 'demo', sessionId: 's1', summary: SUMMARY, newId: () => `card-new-${n++}` });
  const b1 = JSON.parse(readFileSync(boardFile, 'utf8'));
  A(r1.applied === 4, 'aplica 1 cierre y 3 altas', JSON.stringify(r1));
  A(b1.cards.find((c) => c.id === 'card-2-bbbbbb').column_id === 'c-done', 'la tarjeta cerrada esta en Done', 'sigue abierta');
  A(b1.cards.filter((c) => (c.tags || []).includes(ka.AUTO_TAG)).length === 3, 'las altas llevan la etiqueta auto', 'faltan etiquetas');

  const r2 = ka.applyFromSummary({ projectsDir: root, projectId: 'demo', sessionId: 's1', summary: SUMMARY, newId: () => `card-new-${n++}` });
  A(r2.applied === 0, 'misma sesion re-resumida: no repite', JSON.stringify(r2));

  const lines = ka.renderAutoLines('demo', ka.pendingReports(JSON.parse(readFileSync(logFile, 'utf8'))));
  A(lines.length === 1 && lines[0].includes('Fusionar tilde/v1 en main') && lines[0].includes('kanban.mjs undo demo'), 'aviso con lo aplicado y el comando de deshacer', JSON.stringify(lines));
  ka.markReported({ projectsDir: root, projectId: 'demo' });
  A(ka.pendingReports(JSON.parse(readFileSync(logFile, 'utf8'))).length === 0, 'cada lote se anuncia una vez', 'sigue pendiente');

  // El usuario mueve a mano una de las altas: deshacer no debe pisar ese cambio en las movidas.
  const moved = JSON.parse(readFileSync(boardFile, 'utf8'));
  moved.cards = moved.cards.map((c) => (c.id === 'card-2-bbbbbb' ? { ...c, column_id: 'c-todo' } : c));
  writeFileSync(boardFile, JSON.stringify(moved));
  const u = ka.undoLast({ projectsDir: root, projectId: 'demo' });
  const b2 = JSON.parse(readFileSync(boardFile, 'utf8'));
  A(u.reverted === 3 && b2.cards.length === 3, 'deshacer borra las altas', JSON.stringify({ reverted: u.reverted, cards: b2.cards.length }));
  A(b2.cards.find((c) => c.id === 'card-2-bbbbbb').column_id === 'c-todo', 'deshacer no pisa una tarjeta movida a mano despues', 'columna cambiada');
  A(ka.undoLast({ projectsDir: root, projectId: 'demo' }).entry === null, 'segundo deshacer: nada pendiente', 'deshizo otra vez');

  const r3 = ka.applyFromSummary({ projectsDir: root, projectId: 'demo', sessionId: 's1', summary: SUMMARY });
  A(r3.applied === 0, 'lo deshecho no se reaplica al re-resumir la sesion', JSON.stringify(r3));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FALLO(S)` : '\nOK');
process.exit(fail ? 1 : 0);
