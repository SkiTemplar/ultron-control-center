'use strict';
/**
 * lib/l0-scratch.js — scratch L0 de PreCompact, uno por sesion (hooks-4,
 * auditoria 2026-10-23).
 *
 * precompact-preserve-l0.js escribia una sola ruta global
 * (~/.ultron/.tmp/context.md) para todas las sesiones concurrentes, y el
 * resume la inyectaba en CUALQUIER SessionStart del mismo proyecto durante
 * 24 h, aunque trajera solo la cabecera (turns_scanned: 0, sin hechos). Ahora:
 *
 *   - un fichero por sesion: ~/.ultron/.tmp/l0/<session_id>.md;
 *   - solo se escribe si hay hechos que preservar;
 *   - solo se inyecta en el SessionStart que sigue a la compactacion de ESA
 *     sesion (source=compact y mismo session_id), con frescura < 24 h y el
 *     gate de proyecto de siempre.
 *
 * ULTRON_L0_DIR cambia el directorio (pruebas herméticas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const L0_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const L0_MAX_CHARS = 2000;
const L0_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function l0Dir(env = process.env) {
  return env.ULTRON_L0_DIR || path.join(os.homedir(), '.ultron', '.tmp', 'l0');
}

/** Id de sesion apto para nombre de fichero, o '' si no hay. */
function safeSessionId(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function l0PathFor(sessionId, dir = l0Dir()) {
  const sid = safeSessionId(sessionId);
  return sid ? path.join(dir, `${sid}.md`) : '';
}

/** Borra los scratch de mas de una semana (mejor esfuerzo). */
function pruneOld(dir = l0Dir(), now = Date.now()) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > L0_PRUNE_AGE_MS) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch (_) {
      /* bloqueado o ya borrado */
    }
  }
  return removed;
}

/**
 * Escribe el scratch de la sesion. Sin hechos no escribe nada (y borra el
 * anterior de esa sesion, que ya no describe el estado). Devuelve la ruta
 * escrita o ''.
 */
function writeL0Scratch(sessionId, text, { hasFacts, dir = l0Dir() } = {}) {
  const target = l0PathFor(sessionId, dir);
  if (!target) return '';
  if (!hasFacts) {
    try {
      fs.unlinkSync(target);
    } catch (_) {
      /* no habia */
    }
    return '';
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  pruneOld(dir);
  return target;
}

/** Proyecto que declara la cabecera del scratch, o ''. */
function scratchProject(raw) {
  const m = raw.match(/^>?\s*trigger:.*?project:\s*(\S+)/m) || raw.match(/\bproject:\s*(\S+)\s*·/);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * Bloque <l0-scratch> para el SessionStart que sigue a la compactacion de la
 * sesion `sessionId`, o '' si no corresponde.
 *
 * @param {string} currentProject proyecto de la sesion (gate cross-project)
 * @param {{sessionId?: string, source?: string, dir?: string, now?: number}} opts
 */
function readL0Scratch(currentProject, opts = {}) {
  const { sessionId, source, dir = l0Dir(), now = Date.now() } = opts;
  if (source !== 'compact') return '';
  const file = l0PathFor(sessionId, dir);
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > L0_MAX_AGE_MS) return '';
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return '';
    const declared = scratchProject(raw);
    if (currentProject && declared && declared !== currentProject) return '';
    const clipped = raw.length > L0_MAX_CHARS ? raw.slice(0, L0_MAX_CHARS) + '\n[...]' : raw;
    // Texto de turnos de usuario y asistente, sin verificar: no es una instruccion
    // del sistema (auditoria 2026-11-01; antes iba con trust="system").
    return '\n<l0-scratch source="precompact" trust="untrusted">\n' + clipped + '\n</l0-scratch>';
  } catch (_) {
    return '';
  }
}

module.exports = {
  L0_MAX_AGE_MS,
  L0_MAX_CHARS,
  l0Dir,
  l0PathFor,
  pruneOld,
  readL0Scratch,
  safeSessionId,
  writeL0Scratch,
};
