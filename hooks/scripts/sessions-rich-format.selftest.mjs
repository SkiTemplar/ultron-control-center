#!/usr/bin/env node
// Selftest de sessions-rich-format.js: inyecta el formato solo en sesiones de
// ULTRON Sessions y respeta los opt-out. Ejecuta el hook real como proceso.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'sessions-rich-format.js');

let fallos = 0;

function comprueba(nombre, condicion, detalle = '') {
  if (condicion) {
    console.log(`OK     ${nombre}`);
    return;
  }
  fallos += 1;
  console.error(`FALLO  ${nombre}\n       ${detalle}`);
}

function ejecutaHook(envExtra) {
  const env = { ...process.env, ...envExtra };
  for (const clave of ['ULTRON_SESION_ID', 'CLAUDE_NO_HOOKS', 'SESSIONS_RICH_FORMAT_DISABLED']) {
    if (!(clave in envExtra)) delete env[clave];
  }
  return spawnSync(process.execPath, [HOOK], { env, input: '{"source":"startup"}', encoding: 'utf8' });
}

const enSessions = ejecutaHook({ ULTRON_SESION_ID: 'ses-1' });
comprueba('Sessions: sale con 0', enSessions.status === 0, enSessions.stderr);
const salida = enSessions.stdout ? JSON.parse(enSessions.stdout) : {};
const contexto = salida.hookSpecificOutput?.additionalContext ?? '';
comprueba('Sessions: evento SessionStart', salida.hookSpecificOutput?.hookEventName === 'SessionStart');
comprueba('Sessions: inyecta los recursos', ['[!TIP]', 'mermaid', 'chart', 'skill `rico`'].every((t) => contexto.includes(t)));
comprueba('Sessions: limita el alcance al chat', contexto.includes('Commits, PR, código'));
comprueba('Sessions: las piezas no son obligatorias', contexto.includes('Ni callout ni gráfica son obligatorios'));

for (const [nombre, env] of [
  ['terminal normal', {}],
  ['ULTRON_SESION_ID vacío', { ULTRON_SESION_ID: '' }],
  ['CLAUDE_NO_HOOKS', { ULTRON_SESION_ID: 'ses-1', CLAUDE_NO_HOOKS: '1' }],
  ['opt-out propio', { ULTRON_SESION_ID: 'ses-1', SESSIONS_RICH_FORMAT_DISABLED: '1' }],
]) {
  const r = ejecutaHook(env);
  comprueba(`${nombre}: no emite nada`, r.status === 0 && r.stdout === '', `status=${r.status} stdout=${r.stdout}`);
}

if (fallos > 0) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\nsessions-rich-format: todo verde');
