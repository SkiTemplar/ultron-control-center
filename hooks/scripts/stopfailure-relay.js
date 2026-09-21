#!/usr/bin/env node
/**
 * hooks/scripts/stopfailure-relay.js — hook de StopFailure (2026-09-22).
 *
 * Que hace: cuando un turno de Claude Code muere por cuota, sobrecarga o un
 * problema de cuenta, deja UNA linea en un JSONL para que el relevo de
 * proveedores se entere sin tener que tropezar el mismo.
 *
 * Por que: el relevo (claude/codex/antigravity/local) solo descubre que Claude
 * esta sin cuota cuando la propia app intenta una llamada y falla. Las
 * sesiones de Claude Code que corren fuera de ese camino chocan con la cuota
 * y el relevo no se entera. StopFailure entrega justo ese aviso, y solo
 * cuando hay error: en el camino feliz este hook no existe.
 *
 * FORMATO EXACTO DE LA LINEA (contrato con el lector en Rust)
 * -----------------------------------------------------------
 * Fichero: <raiz>/cockpit/maria/relay-cuota.jsonl   (raiz via lib/maria-home)
 * Append-only, una linea por evento, JSON por linea, rotacion a 1 MiB con una
 * generacion (.1) igual que el resto de JSONL del sistema (lib/jsonl-log).
 *
 *   {
 *     "ts": "2026-09-22T09:41:07.123Z",  // ISO-8601 UTC, momento del evento
 *     "proveedor": "claude",             // SIEMPRE "claude": este hook solo
 *                                        //   corre dentro de Claude Code
 *     "error": "rate_limit",             // valor del enum `error` del payload,
 *                                        //   tal cual, sin normalizar
 *     "clase": "cuota" | "cuenta",       // cuota/sobrecarga vs cuenta/auth:
 *                                        //   el relevo no trata igual "espera
 *                                        //   un rato" que "esta cuenta no va"
 *     "detalle": "…",                    // `error_details` recortado a 400 y
 *                                        //   pasado por redactSecrets; "" si
 *                                        //   el payload no lo trae
 *     "sesion": "<session_id>" | null,   // sesion de origen, si viene
 *     "fuente": "stopfailure-relay"      // quien escribio la linea
 *   }
 *
 * El lector debe tolerar lineas futuras con campos de mas y saltarse las que no
 * parseen: es un JSONL append-only escrito por un hook que falla abierto.
 *
 * Lee `payload.error`, NO `payload.error_type`. El schema del evento es
 * {hook_event_name, error, error_details?, last_assistant_message?}; un hook
 * que leyera `error_type` recibiria undefined y no escribiria nunca nada, que
 * es exactamente el no-op silencioso que prohibe el mandamiento 11. El caso
 * negativo del selftest fija que no se vuelve al campo equivocado.
 *
 * Esto NO es memoria: es estado operativo del relevo. `writes_memory: false`,
 * `writer_path: "NONE"`. Ni brain.db ni Qdrant ni el sidecar.
 *
 * Doble filtro a proposito: el matcher de settings.json ya acota los valores
 * de `error` que disparan el proceso, y aqui se vuelve a comprobar contra la
 * misma lista. Si alguien afloja el matcher a "*", el hook sigue sin degradar
 * un proveedor por un `invalid_request`.
 *
 * Fail-safe: cualquier excepcion sale con exit 0 y sin salida.
 * Opt-out: CLAUDE_NO_HOOKS=1 o STOPFAILURE_RELAY_DISABLED=1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonl } = require('./lib/jsonl-log');
const { observe, logHookError } = require('./lib/hook-obs');
const { mariaHome } = require('./lib/maria-home');
const { redactSecrets } = require('./lib/security-helpers');

observe('stopfailure-relay');

// Valores del enum `error` que interesan al relevo, con su clase. El enum del
// evento tiene 13 valores; los que no estan aqui (invalid_request, y demas
// fallos de la peticion) NO dicen nada sobre la disponibilidad del proveedor
// y degradarlo por ellos dejaria al usuario en el modelo local sin motivo.
const ERRORES = new Map([
  ['rate_limit', 'cuota'],
  ['overloaded', 'cuota'],
  ['account_on_hold', 'cuenta'],
  ['billing_error', 'cuenta'],
  ['authentication_failed', 'cuenta'],
  ['verification_required', 'cuenta'],
  ['oauth_org_not_allowed', 'cuenta'],
]);

const MAX_DETALLE = 400;
// El fichero es una senal operativa, no un historial: 256 KiB sobran de lejos.
const MAX_BYTES = 256 * 1024;

/** Ruta del JSONL de senales. Nunca se construye la raiz a mano. */
function rutaSenales() {
  return path.join(mariaHome(), 'cockpit', 'maria', 'relay-cuota.jsonl');
}

/**
 * Construye la linea a escribir, o null si este evento no le importa al relevo.
 * Pura: el selftest la ejercita sin tocar disco.
 *
 * @param {object} payload  stdin del hook ya parseado
 * @param {string} [ahora]  ISO del momento (inyectable para poder afirmar)
 */
function construirSenal(payload, ahora) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // OJO: `error`, no `error_type`. Ver la cabecera.
  const error = typeof p.error === 'string' ? p.error.trim() : '';
  const clase = ERRORES.get(error);
  if (!clase) return null;

  const detalleCrudo = typeof p.error_details === 'string' ? p.error_details : '';
  return {
    ts: ahora || new Date().toISOString(),
    proveedor: 'claude',
    error,
    clase,
    // `error_details` es texto libre del servidor: puede traer identificadores
    // o cabeceras. Pasa por la redaccion compartida antes de tocar disco.
    detalle: redactSecrets(detalleCrudo).replace(/\s+/g, ' ').trim().slice(0, MAX_DETALLE),
    sesion: p.session_id || p.sessionId || null,
    fuente: 'stopfailure-relay',
  };
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.STOPFAILURE_RELAY_DISABLED === '1') {
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return; // payload ilegible: nada que senalar
  }

  // Registrado por error en otro evento: no escribe nada.
  const evento = String(payload.hook_event_name || 'StopFailure');
  if (evento !== 'StopFailure') return;

  const senal = construirSenal(payload);
  if (!senal) return;

  appendJsonl(rutaSenales(), senal, MAX_BYTES);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    logHookError('stopfailure-relay', e);
  }
  process.exitCode = 0;
}

// Exportado para stopfailure-relay.selftest.mjs.
module.exports = { construirSenal, rutaSenales, ERRORES, MAX_DETALLE };
