'use strict';
/**
 * lib/double-attempt.js — «doble intento» para las peticiones 'ask' de los
 * hooks PreToolUse cuando la sesion corre en `bypassPermissions` (decision del
 * 2026-11-16).
 *
 * Problema: en «sin confirmar» (Sessions) un `permissionDecision: 'ask'` de un
 * hook sigue sacando el aviso de confirmacion, que es justo lo que ese modo
 * quiere evitar (medido en hook-timing.jsonl: 48 'ask', 39 de ellos `dotenv`).
 *
 * Protocolo, solo si la entrada del hook trae `permission_mode ===
 * 'bypassPermissions'` (campo comun de la entrada de hooks de Claude Code;
 * ausente o con otro valor, el hook sigue con su 'ask' de siempre):
 *   1. Primer intento de una llamada que daria 'ask': 'deny' con un motivo que
 *      dice la regla, el motivo original y la orden de repetir la MISMA llamada
 *      en menos de WINDOW_MS si sigue siendo necesaria. Se guarda una marca.
 *   2. La misma llamada (mismo hook, `session_id`, `tool_name` y `tool_input`
 *      canonizado; SHA-256) dentro de WINDOW_MS desde la marca: pasa sin
 *      decision (sigue el flujo normal de bypass) y la marca se consume, asi
 *      que un tercer intento vuelve a empezar.
 *   El hook entra en la clave: cuando dos hooks piden 'ask' sobre la misma
 *   llamada (env-dump y force-push en un solo comando), cada uno lleva su marca
 *   y ninguno consume la del otro.
 *
 * Estado: `~/.ultron/run/hook-double-attempt.json`, junto a la pausa de
 * deny-secrets. Solo guarda hashes y la hora de la marca, nunca el contenido de
 * la llamada. Escritura atomica (tmp + rename) bajo el lock de fichero de
 * lib/file-lock.js, porque deny-secrets y guardrails-pre corren a la vez sobre
 * la misma tool call. Las marcas caducadas (o con fecha futura) se purgan al
 * leer. El agente no puede escribir el fichero: lo protege
 * lib/guard-control-files.js como a la pausa.
 *
 * Fallo: si el estado no se puede leer (JSON corrupto, forma inesperada) o
 * escribir, `doubleAttempt` devuelve `{outcome:'error'}` y el hook cae al 'ask'
 * de siempre. Nunca a allow.
 *
 * Limite declarado: la repeticion la decide el propio agente; el freno es que
 * tiene que releer el motivo y volver a pedir lo mismo a sabiendas, no una
 * confirmacion humana. Con un humano delante, el modo correcto es otro que no
 * sea bypass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { withFileLock, renameWithRetry } = require('./file-lock');

const WINDOW_MS = 120 * 1000;
const STATE_BASENAME = 'hook-double-attempt.json';
const STATE_VERSION = 1;
// Tope de marcas vivas: con WINDOW_MS de vida no deberia acercarse nunca; si
// algo enloquece, el fichero no crece sin limite (se quedan las mas recientes).
const MAX_ENTRIES = 256;
const LOCK_TIMEOUT_MS = 1500;
const BYPASS_MODE = 'bypassPermissions';

/** Ruta del estado (bajo el HOME de este proceso). */
function statePath() {
  return path.join(os.homedir(), '.ultron', 'run', STATE_BASENAME);
}

/** true solo si la entrada del hook declara el modo `bypassPermissions`. */
function isBypass(data) {
  return Boolean(data) && typeof data === 'object' && data.permission_mode === BYPASS_MODE;
}

/** JSON con las claves ordenadas a cualquier profundidad (los arrays conservan su orden). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Hash de la llamada: hook + sesion + tool + entrada canonizada. */
function callHash(hook, data) {
  const material = canonicalJson([
    String(hook),
    String(data.session_id),
    String(data.tool_name || ''),
    data.tool_input === undefined ? {} : data.tool_input,
  ]);
  return crypto.createHash('sha256').update(material).digest('hex');
}

/** Lee el estado; ENOENT = vacio. Lanza si el fichero existe y no tiene la forma esperada. */
function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION ||
      !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    throw new Error(`${STATE_BASENAME}: forma inesperada`);
  }
  return parsed.entries;
}

/** Copia sin marcas caducadas, con fecha futura o mal formadas, y con el tope aplicado. */
function purge(entries, now) {
  const vivas = Object.entries(entries)
    .filter(([k, at]) => /^[0-9a-f]{64}$/.test(k) && Number.isFinite(at) && at <= now && now - at <= WINDOW_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTRIES);
  return Object.fromEntries(vivas);
}

function writeState(file, entries) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: STATE_VERSION, entries })}\n`, 'utf8');
    renameWithRetry(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* el tmp puede no existir */ }
    throw e;
  }
}

/**
 * Aplica el doble intento a una llamada que hoy daria 'ask'.
 * @param {{hook: string, data: object, now?: number, file?: string}} args
 * @returns {{outcome: 'double-deny'|'double-pass'|'error', error?: string}}
 */
function doubleAttempt({ hook, data, now = Date.now(), file = statePath() }) {
  try {
    if (!data || typeof data.session_id !== 'string' || !data.session_id) {
      throw new Error('entrada sin session_id: no se puede atar la repeticion a la sesion');
    }
    const key = callHash(hook, data);
    // El lock vive junto al estado: el directorio tiene que existir antes.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withFileLock(file, () => {
      const entries = purge(readState(file), now);
      if (Object.prototype.hasOwnProperty.call(entries, key)) {
        writeState(file, Object.fromEntries(Object.entries(entries).filter(([k]) => k !== key)));
        return { outcome: 'double-pass' };
      }
      writeState(file, purge({ ...entries, [key]: now }, now));
      return { outcome: 'double-deny' };
    }, { timeoutMs: LOCK_TIMEOUT_MS });
  } catch (e) {
    return { outcome: 'error', error: String((e && e.message) || e) };
  }
}

/** Motivo del primer bloqueo: regla, motivo original y la orden de repetir. */
function denyReason(etiqueta, reason) {
  return `DOBLE INTENTO (${etiqueta}): ${reason}. Revísalo: si tras comprobarlo ` +
    `sigue siendo necesario, repite exactamente la misma llamada en menos de ` +
    `${Math.round(WINDOW_MS / 1000)} s.`;
}

/**
 * Punto de entrada de los hooks para una llamada que hoy daria 'ask'.
 * @param {{hook: string, etiqueta: string, reason: string, data: object, now?: number, file?: string}} args
 *   `etiqueta` = `<hook>/<regla>` para el motivo (solo nombres, sin contenido).
 * @returns {null | {outcome: 'double-pass'} | {outcome: 'double-deny', reason: string} | {outcome: 'error', error: string}}
 *   null fuera de bypass: el hook sigue con su 'ask' sin cambios. Con 'error'
 *   el hook tambien cae al 'ask' (nunca a allow).
 */
function resolveAsk({ hook, etiqueta, reason, data, now, file }) {
  if (!isBypass(data)) return null;
  const r = doubleAttempt({ hook, data, now, file });
  if (r.outcome === 'double-deny') return { outcome: 'double-deny', reason: denyReason(etiqueta, reason) };
  return r;
}

/**
 * Resuelve la salida de un hook para un 'ask' con el doble intento.
 * @param {{hook: string, etiqueta: string, reason: string, data: object,
 *   opts?: {now?: number, doubleAttemptFile?: string}, systemPrefix: string,
 *   annotate?: (fields: object) => void}} args  `annotate` = el de lib/hook-obs.
 * @returns {{handled: false} | {handled: true, out: string|null}}
 *   handled=false: fuera de bypass o estado no disponible; el hook emite su
 *   'ask' de siempre. out=null: la repeticion pasa sin decision.
 */
function handleAsk({ hook, etiqueta, reason, data, opts = {}, systemPrefix, annotate = () => {} }) {
  const r = resolveAsk({ hook, etiqueta, reason, data, now: opts.now, file: opts.doubleAttemptFile });
  if (!r) return { handled: false };
  if (r.outcome === 'error') {
    process.stderr.write(`${hook}: doble intento no disponible, se pide permiso: ${r.error}\n`);
    annotate({ double_error: true });
    return { handled: false };
  }
  annotate({ decision: r.outcome });
  if (r.outcome === 'double-pass') return { handled: true, out: null };
  return {
    handled: true,
    out: JSON.stringify({
      systemMessage: `${systemPrefix}: ${r.reason}`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: r.reason,
      },
    }),
  };
}

module.exports = {
  WINDOW_MS,
  STATE_BASENAME,
  BYPASS_MODE,
  statePath,
  isBypass,
  canonicalJson,
  callHash,
  doubleAttempt,
  denyReason,
  resolveAsk,
  handleAsk,
};
