#!/usr/bin/env node
// system-turn.selftest.mjs — fija el contrato de isSystemTurnPrompt (filtro de
// turnos de SISTEMA compartido por los hooks; bug 2026-08-12: notificaciones
// de tareas background ruteadas/kanbanizadas como prompts humanos). Hermetico:
// sin FS, sin HOME, sin red — solo el modulo. Cubre los 3 shapes positivos
// (con y sin espacios/BOM delante) y los negativos que NUNCA deben silenciar
// hooks para un prompt humano real.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isSystemTurnPrompt } = require('./lib/system-turn.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// --- POSITIVOS: los 3 shapes de turno de sistema ---------------------------
const notif =
  '[SYSTEM NOTIFICATION - NOT USER INPUT]\nA background task has completed.';
check('prefijo SYSTEM NOTIFICATION', isSystemTurnPrompt(notif), true);
check('SYSTEM NOTIFICATION con espacios delante', isSystemTurnPrompt('   ' + notif), true);
check('SYSTEM NOTIFICATION con BOM delante', isSystemTurnPrompt('﻿' + notif), true);

const taskNotif =
  '<task-notification>\n<task_id>abc-123</task_id>\n<status>completed</status>\n' +
  '<summary>Background agent finished.</summary>\n</task-notification>';
check('tag task-notification al inicio', isSystemTurnPrompt(taskNotif), true);
check(
  'tag task-notification tras preambulo corto (dentro de ~500 chars)',
  isSystemTurnPrompt('Task update from the harness follows.\n' + taskNotif),
  true,
);
check('tag task-notification con BOM y espacios', isSystemTurnPrompt('﻿  ' + taskNotif), true);

const reminder =
  '<system-reminder>\nContexto inyectado por el harness, no input humano.\n</system-reminder>';
check('turno solo-system-reminder', isSystemTurnPrompt(reminder), true);
check('system-reminder con espacios delante', isSystemTurnPrompt('  ' + reminder), true);
check('system-reminder con BOM delante', isSystemTurnPrompt('﻿' + reminder), true);

// --- NEGATIVOS: prompts humanos (falso positivo = hooks silenciados) -------
check(
  'prompt humano normal',
  isSystemTurnPrompt('arregla el bug del panel de settings y ejecuta los tests'),
  false,
);
const humanLong =
  'estuve mirando los logs de ayer y vi que el hook de task-notification estaba ' +
  'metiendo ruido en el kanban; quiero revisar como filtrar eso sin romper los ' +
  'prompts normales, y de paso cuentame que hace el dispatcher cuando la palabra ' +
  'task-notification aparece en medio de una frase larga como esta, porque no ' +
  'deberia activar nada raro ni silenciar ningun hook.';
check('humano que MENCIONA task-notification en una frase larga', isSystemTurnPrompt(humanLong), false);
const humanTagLate =
  'analiza este transcript largo que te pego a continuacion: ' + 'x'.repeat(600) +
  ' ... y al final aparece un <task-notification> fuera de la ventana inicial';
check('tag mas alla de ~500 chars NO matchea (conservador)', isSystemTurnPrompt(humanTagLate), false);
check('prompt vacio', isSystemTurnPrompt(''), false);
check('solo espacios', isSystemTurnPrompt('   '), false);
check('no-string (null)', isSystemTurnPrompt(null), false);
check('no-string (objeto)', isSystemTurnPrompt({ prompt: 'x' }), false);
// Case-sensitive por contrato: variantes de caja NO son el shape del harness.
check(
  'prefijo en minusculas NO matchea (case-sensitive)',
  isSystemTurnPrompt('[system notification - not user input] hola'),
  false,
);
check(
  'tag en mayusculas NO matchea (case-sensitive)',
  isSystemTurnPrompt('<TASK-NOTIFICATION>x</TASK-NOTIFICATION>'),
  false,
);

if (failures > 0) {
  console.error(`SELFTEST system-turn: ROJO (${failures} fallos)`);
  process.exit(1);
}
console.log('SELFTEST system-turn: VERDE');
