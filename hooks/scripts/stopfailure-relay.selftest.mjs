#!/usr/bin/env node
/**
 * stopfailure-relay.selftest.mjs — contrato del sensor de cuota del relevo.
 *
 * Hermetico: `construirSenal` es pura y el caso extremo a extremo usa un HOME
 * temporal (MARIA_HOME apuntando a una carpeta de usar y tirar), asi que no
 * toca ni ~/.maria ni ~/.ultron. Sin red, sin sidecar.
 *
 * El payload de los casos se construye desde el SCHEMA REAL del evento
 * ({hook_event_name, error, error_details?, last_assistant_message?}), no desde
 * la forma que uno se imagina: el campo es `error`, no `error_type`, y hay un
 * caso negativo dedicado a fijarlo — un hook que leyera el campo equivocado no
 * escribiria nunca nada y el fallo seria invisible.
 *
 * Uso: node hooks/scripts/stopfailure-relay.selftest.mjs   (exit 0 = verde)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { construirSenal, ERRORES, MAX_DETALLE } = require('./stopfailure-relay.js');

let fallos = 0;
function check(nombre, real, esperado) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    console.log(`ok   ${nombre}`);
  } else {
    fallos += 1;
    console.error(`FAIL ${nombre}: esperado ${JSON.stringify(esperado)}, real ${JSON.stringify(real)}`);
  }
}

const AHORA = '2026-09-22T09:41:07.123Z';
const evento = (extra) => ({ hook_event_name: 'StopFailure', ...extra });

// --- los 13 valores del enum -----------------------------------------------
// Son los del binario de Claude Code 2.1.278 (los mismos que
// control-center/src-tauri/src/hooks_admin/claude-events.json). Hasta el
// 2026-09-22 esta lista llevaba cinco nombres de error de la API de Messages
// que NO son valores de este enum, y dejaba sin probar cinco reales: el caso
// negativo pasaba en verde sobre valores que el harness nunca emite.
// Los 8 que le importan al relevo disparan; los 5 restantes (fallos de esa
// peticion o del servidor) NO.
const ENUM_COMPLETO = [
  'rate_limit',
  'overloaded',
  'account_on_hold',
  'billing_error',
  'authentication_failed',
  'verification_required',
  'oauth_org_not_allowed',
  'cloud_credential_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
];
check('el enum tiene 13 valores', ENUM_COMPLETO.length, 13);
const disparan = ENUM_COMPLETO.filter((e) => construirSenal(evento({ error: e }), AHORA) !== null);
check('disparan exactamente los 8 del matcher', disparan, [...ERRORES.keys()]);
check('el resto del enum NO dispara', ENUM_COMPLETO.length - disparan.length, 5);
check(
  'cloud_credential_error es un fallo de cuenta',
  construirSenal(evento({ error: 'cloud_credential_error' }), AHORA)?.clase,
  'cuenta',
);

// --- forma de la linea ------------------------------------------------------
const s1 = construirSenal(
  evento({
    error: 'rate_limit',
    error_details: '5-hour limit reached; resets at 14:00',
    session_id: 'sess-abc',
  }),
  AHORA,
);
check('linea completa', s1, {
  ts: AHORA,
  proveedor: 'claude',
  error: 'rate_limit',
  clase: 'cuota',
  detalle: '5-hour limit reached; resets at 14:00',
  sesion: 'sess-abc',
  fuente: 'stopfailure-relay',
});
check('clase cuenta para los de cuenta', construirSenal(evento({ error: 'billing_error' }), AHORA).clase, 'cuenta');
check('sin error_details el detalle es cadena vacia', construirSenal(evento({ error: 'overloaded' }), AHORA).detalle, '');
check('sin sesion -> null (no se inventa)', construirSenal(evento({ error: 'overloaded' }), AHORA).sesion, null);

// El detalle es texto libre del servidor: se acota y se redacta.
const largo = construirSenal(evento({ error: 'rate_limit', error_details: 'x'.repeat(2000) }), AHORA);
check('el detalle se acota', largo.detalle.length, MAX_DETALLE);
const conSecreto = construirSenal(
  evento({ error: 'rate_limit', error_details: 'token sk-proj-abcdefghijklmnopqrstuvwxyz0123 rechazado' }),
  AHORA,
);
check('el detalle pasa por la redaccion', conSecreto.detalle.includes('sk-proj-'), false);
check('y deja constancia de lo redactado', conSecreto.detalle.includes('[REDACTED]'), true);

// --- casos NEGATIVOS (mandamiento 7) ---------------------------------------
// EL caso que justifica este selftest: el schema del evento NO tiene
// `error_type`. Un payload con ese campo (y sin `error`) no puede escribir
// nada; si algun dia alguien "arregla" el hook leyendo error_type, esto casca.
check(
  'error_type NO es el campo: no dispara',
  construirSenal(evento({ error_type: 'rate_limit' }), AHORA),
  null,
);
check(
  'error_type presente junto a un error irrelevante tampoco dispara',
  construirSenal(evento({ error_type: 'rate_limit', error: 'invalid_request' }), AHORA),
  null,
);
check('sin campo error -> null', construirSenal(evento({}), AHORA), null);
check('error vacio -> null', construirSenal(evento({ error: '   ' }), AHORA), null);
check('error que no es texto -> null', construirSenal(evento({ error: { a: 1 } }), AHORA), null);
check('payload que no es objeto -> null', construirSenal('nada', AHORA), null);
// Sensible a mayusculas a proposito: el enum viene tal cual del harness, y
// aceptar variantes seria adivinar.
check('RATE_LIMIT en mayusculas -> null', construirSenal(evento({ error: 'RATE_LIMIT' }), AHORA), null);

// --- extremo a extremo ------------------------------------------------------
const raiz = mkdtempSync(join(tmpdir(), 'stopfailure-selftest-'));
try {
  const hook = join(dirname(fileURLToPath(import.meta.url)), 'stopfailure-relay.js');
  const env = { ...process.env, MARIA_HOME: raiz, HOME: raiz, USERPROFILE: raiz };
  const lanzar = (payload, extraEnv = {}) =>
    spawnSync(process.execPath, [hook], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...env, ...extraEnv },
    });
  const jsonl = join(raiz, 'cockpit', 'maria', 'relay-cuota.jsonl');

  const r1 = lanzar(evento({ error: 'rate_limit', error_details: 'limite de 5 horas', session_id: 'e2e' }));
  check('e2e: exit 0', r1.status, 0);
  check('e2e: no habla al modelo', r1.stdout.trim(), '');
  const linea = JSON.parse(readFileSync(jsonl, 'utf8').trim().split('\n').pop());
  check('e2e: proveedor', linea.proveedor, 'claude');
  check('e2e: error', linea.error, 'rate_limit');
  check('e2e: clase', linea.clase, 'cuota');
  check('e2e: sesion', linea.sesion, 'e2e');
  check('e2e: fuente', linea.fuente, 'stopfailure-relay');
  check('e2e: ts con forma ISO', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(linea.ts), true);

  // Se acumula: el relevo necesita la historia reciente, no solo la ultima.
  lanzar(evento({ error: 'overloaded' }));
  check('e2e: append, no sobrescritura', readFileSync(jsonl, 'utf8').trim().split('\n').length, 2);

  // Caso NEGATIVO e2e: un error irrelevante no deja rastro nuevo.
  lanzar(evento({ error: 'invalid_request', error_details: 'lo que sea' }));
  check('e2e: error irrelevante no escribe', readFileSync(jsonl, 'utf8').trim().split('\n').length, 2);

  // Caso NEGATIVO e2e: otro evento tampoco.
  lanzar({ hook_event_name: 'Stop', error: 'rate_limit' });
  check('e2e: otro evento no escribe', readFileSync(jsonl, 'utf8').trim().split('\n').length, 2);

  // Caso NEGATIVO e2e: stdin roto no rompe la sesion.
  const r2 = lanzar('{{{ esto no es json');
  check('e2e: stdin roto -> exit 0 sin salida', [r2.status, r2.stdout.trim()], [0, '']);

  // Opt-out en una raiz virgen: no se crea ni el fichero.
  const virgen = mkdtempSync(join(tmpdir(), 'stopfailure-optout-'));
  try {
    const r3 = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(evento({ error: 'rate_limit' })),
      encoding: 'utf8',
      env: { ...env, MARIA_HOME: virgen, CLAUDE_NO_HOOKS: '1' },
    });
    check('e2e: opt-out exit 0', r3.status, 0);
    check('e2e: opt-out no escribe nada', existsSync(join(virgen, 'cockpit', 'maria', 'relay-cuota.jsonl')), false);
  } finally {
    rmSync(virgen, { recursive: true, force: true });
  }
} finally {
  rmSync(raiz, { recursive: true, force: true });
}

if (fallos > 0) {
  console.error(`SELFTEST stopfailure-relay: ROJO (${fallos} fallos)`);
  process.exit(1);
}
console.log('SELFTEST stopfailure-relay: VERDE');
