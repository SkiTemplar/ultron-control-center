// Selftest de lib/project-state.js con una LLM falsa (sin red).
// Uso: node hooks/scripts/lib/project-state.selftest.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url); // carga CJS
const ROOT = mkdtempSync(join(tmpdir(), 'project-state-'));
process.env.ULTRON_ROOT = ROOT;
const ps = require('./project-state.js');

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const SUMMARY = (sha, body) => `---\nsession_id: s\ndigest_sha: ${sha}\n---\n\n${body}\n`;
const fakeAsk = (json) => async () => ({ ok: true, json, provider: 'fake', model: 'm' });
const STATE = (n) => ({
  resumen: 'Proyecto en marcha.',
  decisiones: Array.from({ length: n }, (_, i) => `decision ${i}`),
  pendientes: ['pendiente A'],
  gotchas: [],
});

console.log('project-state');

await run('fusiona una bitacora y escribe el estado', async () => {
  const r = await ps.mergeSummary({ project: 'p1', sessionId: 's1', summaryText: SUMMARY('aaa', '## Temas\n- x'), ask: fakeAsk(STATE(3)) });
  assert.equal(r.ok, true);
  const st = ps.readState('p1');
  assert.equal(st.decisiones.length, 3);
  assert.deepEqual(st.merged, ['s1:aaa']);
});

await run('la misma bitacora (sesion + sha) no se fusiona dos veces', async () => {
  let calls = 0;
  const r = await ps.mergeSummary({ project: 'p1', sessionId: 's1', summaryText: SUMMARY('aaa', 'x'), ask: async () => { calls++; return { ok: false }; } });
  assert.equal(r.skipped, 'ya fusionada');
  assert.equal(calls, 0);
});

await run('misma sesion con digest nuevo: se refusiona y sustituye la clave', async () => {
  const r = await ps.mergeSummary({ project: 'p1', sessionId: 's1', summaryText: SUMMARY('bbb', 'x'), ask: fakeAsk(STATE(4)) });
  assert.equal(r.ok, true);
  assert.deepEqual(ps.readState('p1').merged, ['s1:bbb']);
});

await run('guardia anti-borrado: una fusion que vacia la memoria se rechaza', async () => {
  await ps.mergeSummary({ project: 'p2', sessionId: 's1', summaryText: SUMMARY('a', 'x'), ask: fakeAsk(STATE(10)) });
  const r = await ps.mergeSummary({ project: 'p2', sessionId: 's2', summaryText: SUMMARY('b', 'x'), ask: fakeAsk(STATE(0)) });
  assert.equal(r.ok, false);
  assert.match(r.error, /rechazada/);
  assert.equal(ps.readState('p2').decisiones.length, 10, 'el estado previo queda intacto');
});

await run('respuesta sin forma de estado: no se escribe nada', async () => {
  const r = await ps.mergeSummary({ project: 'p3', sessionId: 's1', summaryText: SUMMARY('a', 'x'), ask: fakeAsk({ resumen: 'x' }) });
  assert.equal(r.ok, false);
  assert.throws(() => readFileSync(ps.statePath('p3')));
});

await run('LLM caida: error y estado intacto', async () => {
  const r = await ps.mergeSummary({ project: 'p1', sessionId: 's9', summaryText: SUMMARY('z', 'x'), ask: async () => ({ ok: false, error: 'groq: HTTP 429' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /429/);
  assert.equal(ps.readState('p1').decisiones.length, 4);
});

await run('normalize recorta items, deduplica y respeta los topes', () => {
  const long = 'x'.repeat(500);
  const n = ps.normalize({ resumen: 'r', decisiones: [long, 'A', 'a', ...Array(20).fill(0).map((_, i) => `d${i}`)], pendientes: [], gotchas: [] });
  assert.ok(n.decisiones[0].length <= 200);
  assert.equal(n.decisiones.filter((d) => d.toLowerCase() === 'a').length, 1);
  assert.equal(n.decisiones.length, ps.MAX_ITEMS.decisiones);
});

await run('render: bloque con tope de caracteres y cierre siempre presente', () => {
  const big = { resumen: 'r', decisiones: Array(12).fill('d'.repeat(200)), pendientes: Array(12).fill('p'.repeat(200)), gotchas: Array(8).fill('g'.repeat(200)), merged: [] };
  const lines = ps.renderLines(big);
  assert.ok(lines.join('\n').length <= ps.RENDER_MAX_CHARS + 40);
  assert.equal(lines[lines.length - 1], '</project-state>');
  assert.deepEqual(ps.renderLines({ decisiones: [], pendientes: [], gotchas: [] }), []);
});

await run('render: topes por seccion (6/6/4) con los items mas recientes primero', () => {
  const dated = (p, n) => Array.from({ length: n }, (_, i) => `2026-09-${String(10 + i).padStart(2, '0')} ${p}${i}`);
  const state = { resumen: 'r', pendientes: [...dated('p', 12), 'sin fecha'], decisiones: dated('d', 12), gotchas: dated('g', 8), merged: [] };
  const text = ps.renderLines(state).join('\n');
  const count = (p) => (text.match(new RegExp(`^  - 2026-09-\\d\\d ${p}\\d+$`, 'gm')) || []).length;
  assert.equal(count('p'), ps.RENDER_LIMITS.pendientes);
  assert.equal(count('d'), ps.RENDER_LIMITS.decisiones);
  assert.equal(count('g'), ps.RENDER_LIMITS.gotchas);
  assert.ok(text.includes('2026-09-21 p11') && text.indexOf('p11') < text.indexOf('p10'), 'la mas reciente va primero');
  // NEGATIVO: lo antiguo y lo que no tiene fecha se queda fuera del arranque.
  assert.ok(!text.includes('2026-09-10 p0') && !text.includes('sin fecha') && !text.includes('2026-09-10 g0'));
  assert.equal(state.pendientes.length, 13, 'renderLines no muta el estado');
});

await run('render: con tracker externo no viajan los pendientes de las bitacoras', () => {
  const state = { resumen: 'r', pendientes: ['2026-09-29 p-viejo'], decisiones: ['2026-09-29 d-vigente'], gotchas: [], merged: [] };
  const con = ps.renderLines(state, { externalTracker: 'github' }).join('\n');
  assert.ok(!con.includes('p-viejo'), 'el pendiente no se inyecta');
  assert.ok(con.includes('tracker del proyecto (github)') && con.includes('d-vigente'));
  // NEGATIVO: sin tracker externo el pendiente sigue viajando.
  assert.ok(ps.renderLines(state).join('\n').includes('p-viejo'));
});

// Auditoria 2026-10-23: autorizaciones de una sesion, restricciones de turno,
// acciones del asistente y notas de una medicion viajaban como "Decisiones vigentes".
const SESION = [
  '2026-10-22 Decisión: Usuario autorizó continuar «a full ultracode».',
  '2026-10-22 Decisión: No hacer commits, no mover Kanban, no editar ~/.claude.json ni tocar memory-session-resume.js.',
  '2026-10-22 Decisión: Asistente decidió lanzar harness oficial de evaluación.',
  '2026-10-23 Decisión: Posponer correcciones para no modificar el working tree mientras los auditores leen.',
  '2026-10-23 Decisión: ULTRON no se puede cerrar (nota 6,5/10).',
];
const DURADERAS = [
  '2026-10-19 ollama solo para programar; lo trivial por groq/gemini.',
  '2026-10-18 Barra lateral del Control Center en inglés; contenido en español.',
];

await run('las decisiones de alcance de sesion se reconocen y las duraderas no', () => {
  for (const d of SESION) assert.equal(ps.isSessionScopedDecision(d), true, d);
  // NEGATIVO: una decision de diseno no se filtra.
  for (const d of DURADERAS) assert.equal(ps.isSessionScopedDecision(d), false, d);
});

await run('la fusion no guarda decisiones de sesion aunque la LLM las devuelva', async () => {
  const json = { resumen: 'r', decisiones: [...SESION, ...DURADERAS], pendientes: ['p'], gotchas: [] };
  const r = await ps.mergeSummary({ project: 'p-sesion', sessionId: 's1', summaryText: SUMMARY('z', 'x'), ask: fakeAsk(json) });
  assert.equal(r.ok, true);
  assert.deepEqual(ps.readState('p-sesion').decisiones, DURADERAS);
});

await run('el render no inyecta decisiones de sesion ya guardadas', () => {
  const text = ps.renderLines({ resumen: 'r', decisiones: [...SESION, ...DURADERAS], pendientes: [], gotchas: [] }).join('\n');
  assert.ok(!text.includes('full ultracode') && !text.includes('No hacer commits') && !text.includes('6,5/10'), text);
  assert.ok(text.includes('ollama solo para programar'), text);
});

await run('hasMerged reconoce la sesion sin importar el sha', () => {
  assert.equal(ps.hasMerged({ merged: ['s1:bbb'] }, 's1'), true);
  assert.equal(ps.hasMerged({ merged: ['s1:bbb'] }, 's2'), false);
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallos`);
process.exit(failed ? 1 : 0);
