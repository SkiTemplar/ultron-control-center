#!/usr/bin/env node
/**
 * postcompact-reinject.selftest.mjs — contrato del hook de PostCompact.
 *
 * Hermetico: `construirBloque` recibe el lector de prompts inyectado, asi que
 * no hay FS; el caso extremo a extremo usa un transcript y un HOME temporales
 * y los borra al salir. Sin red, sin sidecar.
 *
 * Uso: node hooks/scripts/postcompact-reinject.selftest.mjs  (exit 0 = verde)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { construirBloque, recortar, MAX_CHARS } = require('./postcompact-reinject.js');

let fallos = 0;
function check(nombre, real, esperado) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    console.log(`ok   ${nombre}`);
  } else {
    fallos += 1;
    console.error(`FAIL ${nombre}: esperado ${JSON.stringify(esperado)}, real ${JSON.stringify(real)}`);
  }
}

const sinPrompts = () => [];

// --- camino principal: el resumen viene en el payload ----------------------
const b1 = construirBloque(
  {
    hook_event_name: 'PostCompact',
    trigger: 'manual',
    compact_summary: 'El usuario pidio cablear PostToolUseFailure; quedan el manifiesto y el CI.',
    session_id: 's1',
  },
  sinPrompts,
);
check('usa compact_summary del payload', b1.includes('quedan el manifiesto y el CI'), true);
check('declara la fuente', b1.includes('fuente="compact_summary"'), true);
check('conserva el trigger', b1.includes('trigger="manual"'), true);
check('trigger por defecto', construirBloque({ compact_summary: 'x' }, sinPrompts).includes('trigger="auto"'), true);

// --- presupuesto: no puede empeorar el problema que ataca -------------------
const largo = 'linea de resumen muy larga. '.repeat(500);
const b2 = construirBloque({ trigger: 'auto', compact_summary: largo }, sinPrompts);
// El presupuesto es del bloque ENTERO: es lo que se emite y lo que gasta.
check('el bloque entero cabe en el presupuesto', b2.length <= MAX_CHARS, true);
check('el recorte se declara', b2.includes('recortado'), true);
check('recortar respeta lo corto', recortar('hola'), 'hola');

// --- respaldo: sin resumen, los ultimos prompts del usuario -----------------
const b3 = construirBloque(
  { trigger: 'auto', transcript_path: '/da-igual.jsonl' },
  () => ['primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto'],
);
check('respaldo: declara la fuente', b3.includes('fuente="transcript"'), true);
check('respaldo: se queda con los ultimos', b3.includes('sexto') && !b3.includes('primero'), true);

// --- casos NEGATIVOS (mandamiento 7) ---------------------------------------
// Sin resumen y sin transcript no hay nada que decir: silencio, no un bloque
// vacio que gaste contexto para no aportar nada.
check('sin resumen ni transcript -> null', construirBloque({ trigger: 'auto' }, sinPrompts), null);
check('resumen en blanco -> null', construirBloque({ compact_summary: '   ' }, sinPrompts), null);
check('resumen que no es texto -> null', construirBloque({ compact_summary: { a: 1 } }, sinPrompts), null);
check('transcript sin prompts -> null', construirBloque({ transcript_path: '/x.jsonl' }, sinPrompts), null);
check('lector que revienta -> null', construirBloque({ transcript_path: '/x.jsonl' }, () => { throw new Error('boom'); }), null);
check('payload que no es objeto -> null', construirBloque(null, sinPrompts), null);

// --- extremo a extremo ------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'postcompact-selftest-'));
try {
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  const hook = join(dirname(fileURLToPath(import.meta.url)), 'postcompact-reinject.js');
  const lanzar = (payload) =>
    spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env });

  const sesion = 'e2e-' + Date.now();
  const r1 = lanzar({
    hook_event_name: 'PostCompact',
    trigger: 'auto',
    compact_summary: 'Se estaba cableando el hook de PostCompact.',
    session_id: sesion,
  });
  check('e2e: exit 0', r1.status, 0);
  const out = JSON.parse(r1.stdout);
  check('e2e: evento correcto', out.hookSpecificOutput.hookEventName, 'PostCompact');
  check('e2e: re-inyecta el resumen', out.hookSpecificOutput.additionalContext.includes('cableando el hook'), true);

  // Caso NEGATIVO: la segunda emision dentro de la misma compactacion no
  // duplica el bloque (el riesgo que senala la propia propuesta).
  const r2 = lanzar({
    hook_event_name: 'PostCompact',
    trigger: 'auto',
    compact_summary: 'Se estaba cableando el hook de PostCompact.',
    session_id: sesion,
  });
  check('e2e: no duplica en la misma sesion', r2.stdout.trim(), '');

  // Caso NEGATIVO: registrado por error en otro evento -> calla.
  const r3 = lanzar({ hook_event_name: 'SessionStart', source: 'compact', compact_summary: 'x' });
  check('e2e: otro evento -> sin salida', r3.stdout.trim(), '');
  check('e2e: otro evento -> exit 0', r3.status, 0);

  // Caso NEGATIVO: stdin basura no rompe la sesion.
  const r4 = spawnSync(process.execPath, [hook], { input: '{{{', encoding: 'utf8', env });
  check('e2e: payload roto -> exit 0 sin salida', [r4.status, r4.stdout.trim()], [0, '']);

  // Opt-out.
  const r5 = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PostCompact', compact_summary: 'x', session_id: 'otra' }),
    encoding: 'utf8',
    env: { ...env, CLAUDE_NO_HOOKS: '1' },
  });
  check('e2e: opt-out respetado', [r5.status, r5.stdout.trim()], [0, '']);

  // Respaldo de verdad, con un transcript en disco.
  const transcript = join(dir, 'sesion.jsonl');
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', timestamp: '2026-09-22T10:00:00Z', message: { role: 'user', content: 'arregla el manifiesto' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hecho' }] } }),
    ].join('\n'),
    'utf8',
  );
  const r6 = lanzar({ hook_event_name: 'PostCompact', trigger: 'auto', transcript_path: transcript, session_id: 'fb-' + Date.now() });
  check('e2e: respaldo lee el transcript', JSON.parse(r6.stdout).hookSpecificOutput.additionalContext.includes('arregla el manifiesto'), true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fallos > 0) {
  console.error(`SELFTEST postcompact-reinject: ROJO (${fallos} fallos)`);
  process.exit(1);
}
console.log('SELFTEST postcompact-reinject: VERDE');
