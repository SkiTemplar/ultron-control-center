#!/usr/bin/env node
// Selftest de memory-session-resume.js: el hook SessionStart tiene que caber
// en su timeout_s (12 s en hooks/manifest.json) aunque el sidecar se cuelgue.
// Antes el resume esperaba 11 s fijos y readHead sumaba otros 3 x 2,5 s, asi
// que la CLI podia matar el hook sin dejar rastro.
//   (A) presupuesto puro: arranque + timeout de la CLI + reserva de head caben
//       en el timeout del manifest con 1 s de margen.
//   (B) readHead con el plazo vencido no lanza git y devuelve ''.
//   (C) extremo a extremo: con un sidecar que nunca responde, el hook sale a
//       tiempo con sidecar_status: DEGRADED.
//   (D) render: fijadas con tope, avisos sin el de la bandeja y sin imperativo.
//   (E) pendientes de la ultima bitacora que la fusion LLM haya perdido.
// RESUME_HOOK_UNDER_TEST apunta a una copia: los hooks activos no se editan en
// sitio (copia, selftest contra la copia y renombrado atomico).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = process.env.RESUME_HOOK_UNDER_TEST
  ? path.resolve(process.env.RESUME_HOOK_UNDER_TEST)
  : path.join(here, 'memory-session-resume.js');

let fallos = 0;
function A(cond, ok, ko) {
  if (cond) console.log(`ok     ${ok}`);
  else { fallos++; console.log(`FALLO  ${ko}`); }
}

const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'manifest.json'), 'utf8'));
const entrada = (manifest.hooks || []).find((h) => /memory-session-resume\.js$/.test(h.script || h.path || h.file || ''));
const timeoutS = entrada && Number(entrada.timeout_s);
A(Number.isFinite(timeoutS) && timeoutS > 0, `timeout_s del manifest = ${timeoutS}`, 'sin timeout_s para memory-session-resume en hooks/manifest.json');

const hook = require(HOOK);

// --- (A) presupuesto puro ----------------------------------------------------
A(typeof hook.resumeBudget === 'function', 'resumeBudget exportada', 'resumeBudget no existe');
if (typeof hook.resumeBudget === 'function') {
  const arranque = 1500;
  const deadline = hook.HOOK_BUDGET_MS; // proceso arrancado en t=0
  const { cliTimeoutMs } = hook.resumeBudget(arranque, deadline);
  const total = arranque + cliTimeoutMs + hook.HEAD_RESERVE_MS;
  A(total <= timeoutS * 1000 - 1000,
    `arranque lento cabe: ${total} ms <= ${timeoutS * 1000 - 1000} ms`,
    `arranque lento NO cabe: ${total} ms > ${timeoutS * 1000 - 1000} ms`);
  A(hook.resumeBudget(deadline, deadline).cliTimeoutMs === 0,
    'plazo agotado => la CLI no se lanza (cliTimeoutMs 0)', 'plazo agotado sigue dando tiempo a la CLI');
  // spawnSync/execFileSync rechazan un timeout no entero (process.uptime() da fracciones).
  A(Number.isInteger(hook.resumeBudget(0.5, 5000.25).cliTimeoutMs),
    'cliTimeoutMs es entero aunque el plazo traiga fracciones', 'cliTimeoutMs no es entero');
  A(hook.resumeBudget(0, 1e9).cliTimeoutMs <= 8000,
    'el timeout de la CLI tiene tope', 'el timeout de la CLI no tiene tope');
}

// --- (B) readHead respeta el plazo -------------------------------------------
{
  const t0 = Date.now();
  const head = hook.readHead(path.join(here, '..', '..'), Date.now() - 1);
  const ms = Date.now() - t0;
  A(head === '' && ms < 50, `readHead con plazo vencido devuelve '' en ${ms} ms`,
    `readHead ignora el plazo (head=${JSON.stringify(head)}, ${ms} ms)`);
}

// --- (C) sidecar colgado: sale a tiempo y DEGRADED ---------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-budget-'));
  const home = path.join(tmp, 'home');
  // El proceso del hook corre en cwd (donde estan los scripts falsos del
  // sidecar); el cwd que recibe por stdin es este repo, para que haya head y
  // el resume no caiga a la salida vacia.
  const cwd = path.join(tmp, 'cwd');
  const repo = path.join(here, '..', '..');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  // El "sidecar" es node ejecutando ./resume (o ./serve): nunca responde.
  fs.writeFileSync(path.join(cwd, 'resume'), 'setTimeout(() => {}, 60000);\n');
  fs.writeFileSync(path.join(cwd, 'serve'), 'process.exit(0);\n');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ULTRON_MEMORY_BIN: process.execPath,
  };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    cwd,
    env,
    input: JSON.stringify({ cwd: repo, session_id: 'selftest-resume-budget', source: 'startup' }),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  const ms = Date.now() - t0;
  A(ms < 10500, `el hook sale en ${ms} ms (< 10500)`, `el hook tarda ${ms} ms (>= 10500)`);
  let ctx = '';
  try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { /* abajo */ }
  A(ctx.includes('sidecar_status: DEGRADED'), 'stdout trae sidecar_status: DEGRADED',
    `stdout sin DEGRADED: ${String(r.stdout).slice(0, 200)}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- (D) render: fijadas, avisos y politica ------------------------------------
{
  const out = hook.render({
    project_id: 'p',
    pinned: [1, 2, 3, 4].map((n) => ({ summary: `fijada ${n}\ncon salto` })).concat({ summary: null }),
    next_action: 'tarjeta X',
    warnings: [
      '95 memory candidate(s) await validation in the inbox',
      'kanban de p ilegible (JSON: fallo); las tareas salen de la memoria',
      'estancadas en el kanban: vieja (20d, id-1)',
    ],
  }, {});
  const lineas = out.split('\n');
  const fijadas = lineas.filter((l) => /^ {2}- fijada \d/.test(l));
  A(hook.MAX_PINNED === 3 && fijadas.length === 3, 'pinned: como maximo 3', `pinned: ${fijadas.length} lineas`);
  A(fijadas.includes('  - fijada 1 con salto'), 'pinned: en una linea por memoria', `pinned: ${fijadas[0]}`);
  A(!out.includes('fijada 4'), 'pinned: se quedan las primeras (proyecto antes que globales)', 'pinned: se cuela la cuarta');
  A(lineas.some((l) => l.startsWith('avisos: ') && l.includes('ilegible')), 'avisos: el kanban ilegible llega a la sesion', 'avisos: el kanban ilegible no llega');
  A(lineas.some((l) => l.startsWith('avisos: ') && l.includes('estancadas')), 'avisos: las estancadas llegan a la sesion', 'avisos: las estancadas no llegan');
  A(!out.includes('await validation'), 'avisos: el de la bandeja no viaja', 'avisos: viaja el de la bandeja');
  // Solo un kanban sano y sin fijadas: nada que pintar.
  const limpio = hook.render({ project_id: 'p', pinned: [], warnings: ['1 memory candidate(s) await validation in the inbox'] }, {});
  A(!limpio.includes('avisos:') && !limpio.includes('pinned:'), 'sin avisos ni fijadas no hay lineas vacias', `sobra: ${limpio}`);
  const politica = lineas.find((l) => l.startsWith('startup_policy:')) || '';
  A(!/ejecuta|fiate/i.test(politica) && /no ordenes/.test(politica), 'startup_policy no ordena ejecutar la tarjeta', `politica: ${politica}`);
  A(politica.length <= 120, `startup_policy corta (${politica.length})`, `startup_policy larga (${politica.length})`);
  // Una linea de pinned: seguida de items no debe contaminar next_action en el
  // parser del medidor: va antes de open_tasks.
  A(out.indexOf('pinned:') < out.indexOf('next_action:'), 'pinned va antes de next_action', 'pinned va despues de next_action');
}

// --- (E) pendientes de la ultima bitacora perdidos en la fusion ----------------
{
  const summary = {
    sessionId: 's1',
    content: [
      '---', 'session_id: s1', '---', '', '## Temas', '', '- Tema que no es un pendiente', '',
      '## Pendientes', '',
      '- Confirmar el arranque del actualizador en una lectura real',
      '- Rotar el token filtrado en los snapshots',
      '* Terminar los tests del resume',
      '',
      '## Ficheros', '', '- `a.rs`: no es un pendiente',
    ].join('\r\n'),
  };
  const items = hook.pendingFromSummary(summary.content);
  A(items.length === 3 && !items.some((i) => /Tema|a\.rs/.test(i)), 'solo la seccion Pendientes', `items: ${JSON.stringify(items)}`);
  A(hook.pendingFromSummary('## Pendientes\n\n- Ninguno\n').length === 0, 'NEGATIVO: "Ninguno" no es un pendiente', 'cuenta "Ninguno"');
  A(hook.pendingFromSummary('## Temas\n\n- algo\n').length === 0, 'NEGATIVO: sin seccion no hay pendientes', 'inventa pendientes');

  // La LLM conservo uno reformulado con fecha y tiro los otros dos.
  const pintadas = ['<project-state>', 'Pendientes:', '  - 2026-11-01 Rotar el token filtrado en snapshots', '</project-state>'];
  const perdidas = hook.lostPendingLines(summary, pintadas);
  const texto = perdidas.join('\n');
  A(perdidas[0]?.startsWith('<last-session-pending') && perdidas[0].includes('trust="session-summary"') && perdidas.at(-1) === '</last-session-pending>',
    'bloque propio con trust de bitacora', `bloque: ${texto}`);
  A(texto.includes('actualizador') && texto.includes('tests del resume'), 'la fusion no pierde lo que tiro la LLM', `perdidas: ${texto}`);
  A(!texto.includes('Rotar'), 'NEGATIVO: lo que ya se pinta en el estado no se repite', `repetido: ${texto}`);

  const todo = ['  - Confirmar el arranque del actualizador en una lectura real', '  - Rotar el token filtrado en los snapshots', '  - Terminar los tests del resume'];
  A(hook.lostPendingLines(summary, todo).length === 0, 'NEGATIVO: sin perdidas no hay bloque', 'bloque sin nada que aportar');
  A(hook.lostPendingLines(null, []).length === 0, 'NEGATIVO: sin bitacora no hay bloque', 'bloque sin bitacora');

  const muchos = { sessionId: 's2', content: `## Pendientes\n\n${Array.from({ length: 9 }, (_, i) => `- pendiente distinto numero${i} ${'x'.repeat(400)}`).join('\n')}\n` };
  const recortado = hook.lostPendingLines(muchos, []);
  A(recortado.length === hook.MAX_LAST_PENDING + 2, `tope de ${hook.MAX_LAST_PENDING} pendientes`, `${recortado.length} lineas`);
  A(recortado.every((l) => l.length <= 260), 'cada pendiente con tope de longitud', 'pendiente sin tope');
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
