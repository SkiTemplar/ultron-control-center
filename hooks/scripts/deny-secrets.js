#!/usr/bin/env node
/**
 * ULTRON HOOK · deny-secrets · v2.0 (port Node del deny-secrets.py v1.0)
 *
 * PreToolUse hook that blocks Read / Edit / Write / NotebookEdit / Bash access
 * to credential files: .env, private keys / keystores, anything under an
 * `.ssh/` directory, `~/.aws/credentials`, and `secrets.json` /
 * `credentials.json` / `service-account*.json`.
 *
 * Critical when ULTRON runs with `--dangerously-skip-permissions`: it is the
 * tripwire that stops an agent from reading the user's secrets.
 *
 * Port 2026-08-11 (audit 08-09 #4): reescrito de Python a Node para eliminar
 * los ~200ms de arranque `uv run python` que pagaba CADA tool call del matcher
 * (Read|Edit|Write|NotebookEdit|Bash, hook sincrono en el hot path). Mismas
 * reglas y mismo contrato JSON que el .py; el selftest hermano
 * (deny-secrets.selftest.mjs) fija el comportamiento con casos deny Y allow.
 *
 * Design — SPECIFIC patterns, not a generic `*secret*` substring. A substring
 * match would flag legit code (`secrets_scanner.py`) and blow the "<1% false
 * positive" target. Every rule targets a real credential-file shape.
 *
 * Defense in depth — single-user offline system; this is a tripwire, NOT a
 * primary boundary. The hook never throws and always exits 0.
 *
 * Instrumentacion (2026-09-22): era el unico de los hooks registrados sin
 * una sola llamada a `observe`, y por eso no dejaba ningun rastro en
 * hook-timing.jsonl — no habia forma de saber si el tripwire se habia
 * disparado alguna vez. Ahora cada ejecucion deja su linea de timing y las
 * que bloquean anotan ADEMAS `decision` (deny|ask), `rule` (el NOMBRE de la
 * regla que caso) y `tool`.
 *
 * Lo que NO se registra, a proposito: la ruta. Anotar la ruta bloqueada en un
 * log que la app lee y que puede acabar en un repo publico convierte al
 * guardian en la fuga (mandamiento 9). Los nombres de regla salen de un
 * conjunto cerrado escrito en este fichero, asi que no hay dato del usuario
 * que redactar.
 *
 * El fail-safe de este hook es distinto al del resto: los demas fallan
 * ABIERTOS (exit 0 sin salida ante cualquier excepcion) porque un hook roto
 * no puede tumbar todas las sesiones; este es una puerta de seguridad y falla
 * CERRADO. Por eso la instrumentacion entera va envuelta: si `lib/hook-obs`
 * faltara o lanzara, el hook sigue clasificando y bloqueando igual.
 */

'use strict';

// Observabilidad opcional: un fallo aqui NUNCA puede desarmar el tripwire.
let obs = { observe() {}, annotate() {}, logHookError() {} };
try {
  obs = require('./lib/hook-obs');
} catch (_) {
  /* sin observabilidad, pero el hook sigue bloqueando */
}

// Tools whose tool_input carries a file path.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

// Extensions that are private keys / keystores by definition.
const KEY_EXTS = new Set(['pem', 'pfx', 'p12', 'key', 'keystore', 'jks']);

// .env.<x> suffixes that are SAFE — examples / templates carry no real secret.
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

// SSH private-key basename prefixes.
const SSH_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'];

// Exact credential-file basenames (dotfile variants included).
const CRED_BASENAMES = new Set([
  'secrets.json',
  'credentials.json',
  '.secrets.json',
  '.credentials.json',
]);

/** Return a block reason for a credential file path, or null if safe. */
function classifyPath(p) {
  if (!p || typeof p !== 'string') return null;
  const norm = p
    .replace(/\\/g, '/')
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (!norm) return null;
  const segments = norm.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const basename = segments[segments.length - 1];
  const baseLow = basename.toLowerCase();
  const segLow = new Set(segments.map((s) => s.toLowerCase()));
  const ext = baseLow.includes('.') ? baseLow.split('.').pop() : '';

  // 1. .env credential file (but NOT .env.example / .sample / .template)
  if (baseLow === '.env' || baseLow.startsWith('.env.')) {
    if (!SAFE_ENV_SUFFIXES.some((s) => baseLow.endsWith(s))) {
      return 'dotenv credential file';
    }
  }

  // 2. private key / keystore by extension
  if (KEY_EXTS.has(ext)) return `private key / keystore (.${ext})`;

  // 3. SSH private key by basename
  if (SSH_KEY_PREFIXES.some((pre) => baseLow.startsWith(pre))) {
    return 'SSH private key';
  }

  // 4. anything inside an .ssh directory
  if (segLow.has('.ssh')) return 'file inside an .ssh directory';

  // 5. ~/.aws/credentials
  if (segLow.has('.aws') && baseLow === 'credentials') {
    return 'AWS credentials file';
  }

  // 6. secrets.json / credentials.json / service-account*.json
  if (CRED_BASENAMES.has(baseLow)) return 'credentials/secrets file';
  if (baseLow.startsWith('service-account') && ext === 'json') {
    return 'service-account key file';
  }

  return null;
}

/** Scan a shell command for tokens that reference a credential file. */
function classifyBash(command) {
  if (!command || typeof command !== 'string') return null;
  for (const raw of command.split(/\s+/).filter(Boolean)) {
    const token = raw.replace(/^["';|&<>()`]+|["';|&<>()`]+$/g, '');
    // Only treat path-ish tokens as candidates (skip bare flags/words).
    if (!token.includes('/') && !token.startsWith('.')) continue;
    const reason = classifyPath(token);
    if (reason) return `command accesses a ${reason}`;
  }
  return null;
}

/** Return a block reason for this tool call, or null if it is allowed. */
function classify(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (FILE_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path || '';
    return classifyPath(p);
  }
  if (toolName === 'Bash') return classifyBash(toolInput.command || '');
  return null;
}

// ---------------------------------------------------------------------------
// deny vs ask
// ---------------------------------------------------------------------------

// Motivos que degradan de bloqueo duro a peticion de permiso (2026-08-19).
// El fichero de variables de entorno es la config del proyecto en el que se
// trabaja: bloquearlo en seco obligaba a salir a una shell manual para tareas
// legitimas (ver que variable falta, anadir una clave). Con 'ask' el harness
// pide confirmacion al usuario en el momento y el permiso muere con esa tool
// call — sigue sin haber acceso silencioso, que es lo que este hook existe
// para impedir.
//
// Todo lo demas (claves privadas, keystores, .ssh, credenciales cloud,
// service accounts) se queda en deny duro: ningun flujo normal necesita que
// el agente las lea.
const ASK_REASON_FRAGMENTS = ['dotenv credential file'];

/** 'ask' si el motivo admite permiso explicito del usuario, 'deny' si no. */
function decisionFor(reason) {
  if (!reason || typeof reason !== 'string') return 'deny';
  return ASK_REASON_FRAGMENTS.some((f) => reason.includes(f)) ? 'ask' : 'deny';
}

// Conjunto CERRADO de nombres de regla para el log. Es lo unico que sale de
// aqui hacia hook-timing.jsonl: identifica QUE salto sin decir sobre QUE. El
// orden importa (ssh-key antes que ssh-dir: una clave dentro de .ssh es lo
// primero, mas especifico).
const RULE_IDS = [
  ['dotenv credential file', 'dotenv'],
  ['private key / keystore', 'private-key'],
  ['SSH private key', 'ssh-key'],
  ['file inside an .ssh directory', 'ssh-dir'],
  ['AWS credentials file', 'aws-credentials'],
  ['credentials/secrets file', 'credentials-file'],
  ['service-account key file', 'service-account'],
  ['classifier error', 'classifier-error'],
];

/** Nombre corto y estable de la regla que caso (nunca la ruta). */
function ruleIdFor(reason) {
  const r = String(reason || '');
  for (const [fragmento, id] of RULE_IDS) {
    if (r.includes(fragmento)) return id;
  }
  return 'unknown';
}

function handle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || '').replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || data.hook_event_name !== 'PreToolUse') {
    return null;
  }

  let reason;
  try {
    reason = classify(data.tool_name || '', data.tool_input || {});
  } catch (exc) {
    // Fail-CLOSED: this is a security gate. If the classifier itself crashes
    // we cannot prove the access is safe, so we DENY rather than silently
    // letting the call through. The catch still swallows the exception so
    // the hook never crashes the tool flow.
    process.stderr.write(`deny-secrets: classify() threw, failing closed: ${exc}\n`);
    reason = 'classifier error (failing closed for safety)';
  }

  if (!reason) return null;

  const decision = decisionFor(reason);
  // Rastro del caso interesante: que decidio, que regla caso y sobre que tool.
  // Se anota en la linea de timing de este proceso (ver lib/hook-obs.js); la
  // ruta NO viaja. `via_bash` distingue el bloqueo por argumento de comando
  // del bloqueo por file_path, que son dos caminos distintos del clasificador.
  obs.annotate({
    decision,
    rule: ruleIdFor(reason),
    tool: String(data.tool_name || 'unknown'),
    via_bash: String(reason).startsWith('command accesses'),
  });
  if (decision === 'ask') {
    return JSON.stringify({
      systemMessage:
        `ULTRON deny-secrets: ${reason} — requiere permiso explicito del ` +
        `usuario. Concedido, el acceso vale solo para esta tool call.`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `PERMISO REQUERIDO (deny-secrets): ${reason}`,
      },
    });
  }

  return JSON.stringify({
    systemMessage:
      `ULTRON deny-secrets blocked: ${reason}. Credential files are ` +
      `off-limits to the agent — open it from a manual shell if ` +
      `genuinely needed.`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOCKED (deny-secrets): ${reason}`,
    },
  });
}

// Export para el selftest; ejecucion real solo como script principal.
module.exports = { classify, classifyPath, classifyBash, decisionFor, ruleIdFor, handle };

if (require.main === module) {
  // observe() dentro del bloque principal: requerido por el selftest, el
  // modulo no debe registrar nada ni ensuciar el log de timing.
  obs.observe('deny-secrets');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let out = null;
    try {
      out = handle(raw);
    } catch (e) {
      // Fail-CLOSED tambien aqui: si handle() reventara (no deberia: ya tiene
      // su propio catch), se bloquea en vez de dejar pasar el acceso.
      obs.logHookError('deny-secrets', e);
      obs.annotate({ decision: 'deny', rule: 'classifier-error', tool: 'unknown' });
      out = JSON.stringify({
        systemMessage: 'ULTRON deny-secrets: fallo interno del hook — se bloquea por seguridad.',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'BLOCKED (deny-secrets): fallo interno, failing closed',
        },
      });
    }
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
  });
}
