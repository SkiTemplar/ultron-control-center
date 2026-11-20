#!/usr/bin/env node
// double-attempt.selftest.mjs — fija el «doble intento» de las peticiones 'ask'
// en bypassPermissions (lib/double-attempt.js, 2026-11-16) en deny-secrets y
// guardrails-pre. Hermetico: estado en un directorio temporal, reloj inyectado
// y, en el extremo a extremo, HOME temporal; no toca ~/.ultron real.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'double-attempt-selftest-'));
// La pausa real del usuario no debe cambiar el resultado.
const PAUSA = join(tmp, 'deny-secrets-pausa.json');
process.env.ULTRON_DENY_SECRETS_PAUSA = PAUSA;

const da = require('./lib/double-attempt.js');
const deny = require('./deny-secrets.js');
const guard = require('./guardrails-pre.js');
const { DOUBLE_ATTEMPT_BASENAME } = require('./lib/guard-control-files.js');

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

const ORDEN = 'Revísalo: si tras comprobarlo sigue siendo necesario, repite exactamente la misma llamada en menos de 120 s';
const T0 = Date.parse('2026-11-16T10:00:00Z');
let n = 0;
/** Fichero de estado nuevo para cada escenario. */
function freshState() {
  n += 1;
  return join(tmp, `estado-${n}`, da.STATE_BASENAME);
}

// `mode: undefined` explicito = entrada sin `permission_mode` (un valor por
// defecto en la desestructuracion lo taparia).
function payload(opts = {}) {
  const { session = 'sesion-a', tool = 'Read', input = { file_path: '/proyecto/.env' } } = opts;
  const mode = 'mode' in opts ? opts.mode : 'bypassPermissions';
  const p = { hook_event_name: 'PreToolUse', session_id: session, tool_name: tool, tool_input: input };
  if (mode !== undefined) p.permission_mode = mode;
  return JSON.stringify(p);
}

/** Decision de un handle(): 'pass' si no hay salida. */
function decisionOf(out) {
  return out === null ? 'pass' : JSON.parse(out).hookSpecificOutput.permissionDecision;
}
function reasonOf(out) {
  return out === null ? '' : JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
}

// --- Libreria -----------------------------------------------------------------
check('lib: nombre del estado = el que protege guard-control-files', da.STATE_BASENAME, DOUBLE_ATTEMPT_BASENAME);
check('lib: isBypass con bypassPermissions', da.isBypass({ permission_mode: 'bypassPermissions' }), true);
check('lib: isBypass con default', da.isBypass({ permission_mode: 'default' }), false);
check('lib: isBypass sin campo', da.isBypass({}), false);
check('lib: isBypass con mayusculas distintas', da.isBypass({ permission_mode: 'BYPASSPERMISSIONS' }), false);
check(
  'lib: el hash no depende del orden de las claves',
  da.callHash('h', { session_id: 's', tool_name: 'T', tool_input: { a: 1, b: { c: 2, d: 3 } } }),
  da.callHash('h', { session_id: 's', tool_name: 'T', tool_input: { b: { d: 3, c: 2 }, a: 1 } }),
);
check(
  'lib: el hook entra en el hash',
  da.callHash('h1', { session_id: 's', tool_name: 'T', tool_input: {} }) ===
    da.callHash('h2', { session_id: 's', tool_name: 'T', tool_input: {} }),
  false,
);

// --- deny-secrets: el escenario completo ----------------------------------------
{
  const file = freshState();
  const o = (now, p = payload()) => deny.handle(p, { now, doubleAttemptFile: file });
  const primero = o(T0);
  check('ds bypass 1er intento: deny', decisionOf(primero), 'deny');
  check('ds bypass 1er intento: nombra la regla', reasonOf(primero).includes('DOBLE INTENTO (deny-secrets/dotenv)'), true);
  check('ds bypass 1er intento: trae el motivo original', reasonOf(primero).includes('dotenv credential file'), true);
  check('ds bypass 1er intento: trae la orden', reasonOf(primero).includes(ORDEN), true);
  // Privacidad: el estado solo guarda hashes, nunca la ruta ni la sesion.
  const crudo = readFileSync(file, 'utf8');
  check('ds estado: sin la ruta', crudo.includes('.env'), false);
  check('ds estado: sin la sesion', crudo.includes('sesion-a'), false);
  check('ds repeticion <120 s: pasa', decisionOf(o(T0 + 5000)), 'pass');
  check('ds 3er intento: vuelve a empezar (deny)', decisionOf(o(T0 + 6000)), 'deny');
  check('ds 4o intento: pasa', decisionOf(o(T0 + 7000)), 'pass');
}
{
  const file = freshState();
  const o = (now, p) => deny.handle(p, { now, doubleAttemptFile: file });
  o(T0, payload());
  check('ds input distinto: deny', decisionOf(o(T0 + 1000, payload({ input: { file_path: '/otro/.env' } }))), 'deny');
  check('ds otra sesion: deny', decisionOf(o(T0 + 2000, payload({ session: 'sesion-b' }))), 'deny');
  check('ds otra tool con el mismo input: deny', decisionOf(o(T0 + 2500, payload({ tool: 'Edit' }))), 'deny');
  check('ds la marca original sigue viva: pasa', decisionOf(o(T0 + 3000, payload())), 'pass');
}
{
  const file = freshState();
  const o = (now) => deny.handle(payload(), { now, doubleAttemptFile: file });
  o(T0);
  check('ds caducado (>120 s): deny', decisionOf(o(T0 + 120001)), 'deny');
  check('ds y la nueva marca vale: pasa', decisionOf(o(T0 + 120001 + 1000)), 'pass');
  o(T0 + 500000);
  check('ds justo en el limite (120 s): pasa', decisionOf(o(T0 + 500000 + 120000)), 'pass');
}
{
  const file = freshState();
  const input = { command: 'printenv GROQ_API_KEY', description: 'x' };
  deny.handle(payload({ tool: 'Bash', input }), { now: T0, doubleAttemptFile: file });
  check(
    'ds mismo input con otro orden de claves: pasa',
    decisionOf(deny.handle(payload({ tool: 'Bash', input: { description: 'x', command: 'printenv GROQ_API_KEY' } }), { now: T0 + 1000, doubleAttemptFile: file })),
    'pass',
  );
}

// --- Caso negativo: fuera de bypass, el 'ask' de siempre y sin estado ---------------
for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', undefined]) {
  const file = freshState();
  const o = (now) => deny.handle(payload({ mode }), { now, doubleAttemptFile: file });
  const etiqueta = mode === undefined ? 'ausente' : mode;
  check(`ds modo ${etiqueta}: ask`, decisionOf(o(T0)), 'ask');
  check(`ds modo ${etiqueta}: repetido sigue en ask`, decisionOf(o(T0 + 1000)), 'ask');
  check(`ds modo ${etiqueta}: no escribe estado`, existsSync(file), false);
}

// --- Los deny duros no cambian en bypass --------------------------------------------
{
  const file = freshState();
  const p = payload({ input: { file_path: '/home/u/.ssh/id_ed25519' } });
  const o = (now) => deny.handle(p, { now, doubleAttemptFile: file });
  const a = o(T0);
  const b = o(T0 + 1000);
  check('ds deny duro en bypass: deny', decisionOf(a), 'deny');
  check('ds deny duro en bypass: motivo de siempre', reasonOf(a).startsWith('BLOCKED (deny-secrets):'), true);
  check('ds deny duro repetido: sigue deny', decisionOf(b), 'deny');
  check('ds deny duro: no escribe estado', existsSync(file), false);
}

// --- Fallo del estado: 'ask', nunca allow --------------------------------------------
{
  const file = freshState();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ esto no es json');
  check('ds estado corrupto: ask', decisionOf(deny.handle(payload(), { now: T0, doubleAttemptFile: file })), 'ask');
  check('ds estado corrupto repetido: ask', decisionOf(deny.handle(payload(), { now: T0 + 1000, doubleAttemptFile: file })), 'ask');
  writeFileSync(file, JSON.stringify({ version: 99, entries: {} }));
  check('ds estado de otra version: ask', decisionOf(deny.handle(payload(), { now: T0, doubleAttemptFile: file })), 'ask');
}
{
  // El estado no se puede escribir: su directorio padre es un fichero.
  const padre = join(tmp, 'soy-un-fichero');
  writeFileSync(padre, 'x');
  const file = join(padre, da.STATE_BASENAME);
  check('ds estado inescribible: ask', decisionOf(deny.handle(payload(), { now: T0, doubleAttemptFile: file })), 'ask');
}
{
  const file = freshState();
  const sinSesion = JSON.stringify({ hook_event_name: 'PreToolUse', permission_mode: 'bypassPermissions', tool_name: 'Read', tool_input: { file_path: '/p/.env' } });
  check('ds bypass sin session_id: ask', decisionOf(deny.handle(sinSesion, { now: T0, doubleAttemptFile: file })), 'ask');
}

// --- La pausa de /permisos se mira antes y se respeta --------------------------------
{
  const file = freshState();
  writeFileSync(PAUSA, JSON.stringify({ hasta: new Date(Date.now() + 3600e3).toISOString() }));
  try {
    check('ds pausa vigente en bypass: pasa al primer intento', decisionOf(deny.handle(payload(), { now: T0, doubleAttemptFile: file })), 'pass');
    check('ds pausa vigente: no escribe estado', existsSync(file), false);
  } finally {
    rmSync(PAUSA, { force: true });
  }
}

// --- El agente no puede escribir el estado (guard-control-files) ----------------------
{
  const ruta = 'C:\\Users\\u\\.ultron\\run\\hook-double-attempt.json';
  check('control: Write al estado = deny duro', deny.ruleIdFor(deny.classify('Write', { file_path: ruta })), 'double-attempt-file');
  check('control: Edit al estado = deny duro', deny.ruleIdFor(deny.classify('Edit', { file_path: ruta })), 'double-attempt-file');
  check('control: Bash que lo sobrescribe = deny duro',
    deny.ruleIdFor(deny.classify('Bash', { command: 'echo {} > ~/.ultron/run/hook-double-attempt.json' })), 'double-attempt-file');
  check('control: PowerShell que lo borra = deny duro',
    deny.ruleIdFor(deny.classify('PowerShell', { command: 'Remove-Item $HOME\\.ultron\\run\\hook-double-attempt.json' })), 'double-attempt-file');
  check('control: leerlo con cat sigue permitido', deny.classify('Bash', { command: 'cat ~/.ultron/run/hook-double-attempt.json' }), null);
  const file = freshState();
  const p = payload({ tool: 'Write', input: { file_path: ruta, content: '{}' } });
  deny.handle(p, { now: T0, doubleAttemptFile: file });
  check('control: escribir el estado en bypass sigue deny al repetir',
    decisionOf(deny.handle(p, { now: T0 + 1000, doubleAttemptFile: file })), 'deny');
}

// --- guardrails-pre: force-push ------------------------------------------------------
{
  const file = freshState();
  const p = payload({ tool: 'Bash', input: { command: 'git push --force origin main' } });
  const o = (now, q = p) => guard.handle(q, { now, doubleAttemptFile: file });
  const primero = o(T0);
  check('gp bypass 1er intento: deny', decisionOf(primero), 'deny');
  check('gp bypass 1er intento: nombra la regla', reasonOf(primero).includes('DOBLE INTENTO (guardrails/force-push)'), true);
  check('gp bypass 1er intento: trae el motivo original', reasonOf(primero).includes('push forzado'), true);
  check('gp bypass 1er intento: trae la orden', reasonOf(primero).includes(ORDEN), true);
  check('gp repeticion <120 s: pasa', decisionOf(o(T0 + 1000)), 'pass');
  check('gp 3er intento: deny', decisionOf(o(T0 + 2000)), 'deny');
  check('gp otra sesion: deny', decisionOf(o(T0 + 3000, payload({ session: 'otra', tool: 'Bash', input: { command: 'git push --force origin main' } }))), 'deny');
  check('gp caducado: deny', decisionOf(o(T0 + 2000 + 120001)), 'deny');
}
for (const mode of ['default', 'acceptEdits', undefined]) {
  const file = freshState();
  const p = payload({ mode, tool: 'Bash', input: { command: 'git push -f' } });
  check(`gp modo ${mode ?? 'ausente'}: ask`, decisionOf(guard.handle(p, { now: T0, doubleAttemptFile: file })), 'ask');
  check(`gp modo ${mode ?? 'ausente'}: no escribe estado`, existsSync(file), false);
}
{
  const file = freshState();
  for (const [regla, command] of [['commit-format', 'git commit -m "cosas varias"'], ['uv', 'pip install requests']]) {
    const p = payload({ tool: 'Bash', input: { command } });
    check(`gp deny duro ${regla} en bypass: deny`, decisionOf(guard.handle(p, { now: T0, doubleAttemptFile: file })), 'deny');
    const b = guard.handle(p, { now: T0 + 1000, doubleAttemptFile: file });
    check(`gp deny duro ${regla} repetido: deny`, decisionOf(b), 'deny');
    check(`gp deny duro ${regla}: motivo de siempre`, reasonOf(b).startsWith(`BLOQUEADO (guardrails/${regla})`), true);
  }
  check('gp deny duro: no escribe estado', existsSync(file), false);
}
{
  const file = freshState();
  writeFileSync(join(tmp, 'corrupto.json'), 'no json');
  const p = payload({ tool: 'Bash', input: { command: 'git push --force' } });
  check('gp estado corrupto: ask', decisionOf(guard.handle(p, { now: T0, doubleAttemptFile: join(tmp, 'corrupto.json') })), 'ask');
  check('gp (control) estado sano: deny', decisionOf(guard.handle(p, { now: T0, doubleAttemptFile: file })), 'deny');
}

// --- Dos hooks sobre la misma llamada: cada uno con su marca ------------------------
{
  const file = freshState();
  const p = payload({ tool: 'Bash', input: { command: 'printenv GROQ_API_KEY && git push --force origin main' } });
  check('ambos 1er intento: deny-secrets deny', decisionOf(deny.handle(p, { now: T0, doubleAttemptFile: file })), 'deny');
  check('ambos 1er intento: guardrails deny', decisionOf(guard.handle(p, { now: T0, doubleAttemptFile: file })), 'deny');
  check('ambos repeticion: deny-secrets pasa', decisionOf(deny.handle(p, { now: T0 + 1000, doubleAttemptFile: file })), 'pass');
  check('ambos repeticion: guardrails pasa', decisionOf(guard.handle(p, { now: T0 + 1000, doubleAttemptFile: file })), 'pass');
}

// --- Extremo a extremo: procesos reales, HOME temporal y rastro en el log -----------
{
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const logs = join(home, '.ultron', 'logs');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ULTRON_HOOK_LOGS_DIR: logs };
  const here = dirname(fileURLToPath(import.meta.url));
  const run = (hook, p) => spawnSync(process.execPath, [join(here, hook)], { input: p, encoding: 'utf8', env });
  const p = payload({ input: { file_path: '/home/quienquieraqueseas/proyecto/.env' } });
  const a = run('deny-secrets.js', p);
  const b = run('deny-secrets.js', p);
  check('e2e ds: sale con 0', a.status, 0);
  check('e2e ds 1er intento: deny', decisionOf(a.stdout.trim() || null), 'deny');
  check('e2e ds repeticion: pasa sin salida', b.stdout.trim(), '');
  check('e2e ds: estado bajo el HOME temporal', existsSync(join(home, '.ultron', 'run', da.STATE_BASENAME)), true);
  const g1 = run('guardrails-pre.js', payload({ tool: 'Bash', input: { command: 'git push --force' } }));
  const g2 = run('guardrails-pre.js', payload({ mode: 'default', tool: 'Bash', input: { command: 'git push --force' } }));
  check('e2e gp bypass: deny', decisionOf(g1.stdout.trim() || null), 'deny');
  check('e2e gp default: ask', decisionOf(g2.stdout.trim() || null), 'ask');
  const lineas = readFileSync(join(logs, 'hook-timing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const decisiones = lineas.map((l) => `${l.hook}:${l.decision}:${l.rule}`).join(' ');
  check('e2e log: distingue double-deny, double-pass y ask', decisiones,
    'deny-secrets:double-deny:dotenv deny-secrets:double-pass:dotenv guardrails-pre:double-deny:force-push guardrails-pre:ask:force-push');
  const crudo = JSON.stringify(lineas);
  check('e2e log: sin la ruta', crudo.includes('quienquieraqueseas'), false);
  check('e2e log: sin la sesion', crudo.includes('sesion-a'), false);
}

rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} fallo(s)`);
  process.exit(1);
}
console.log('\ndouble-attempt selftest: todo verde');
