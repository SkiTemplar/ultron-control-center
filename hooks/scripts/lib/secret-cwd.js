'use strict';
/**
 * lib/secret-cwd.js — palabras de una linea de shell resueltas contra el directorio
 * de trabajo. Sale de deny-secrets.js (limite de 800 lineas por fichero).
 *
 * `cd ~/.codex && cat auth.json`: la regla mira el directorio padre de la ruta, y
 * la palabra suelta `auth.json` no lo trae. Solo se resuelve contra directorios
 * con secretos: fuera de ellos, unir cualquier palabra al cwd haria saltar
 * `e.key` o `process.env` en codigo dentro de un `node -e`.
 *
 * El `cd` se reconoce tambien tras lo que abre un bloque o lanza en segundo plano
 * (`(cd d && …)`, `{ cd d; … }`, `if cd d; then …`, `cd d & …`) y con su salida
 * redirigida (`cd d >/dev/null`). Un `cd` en subshell no se deshace al cerrarlo:
 * `(cd d); cat f` se resuelve contra `d`, un falso positivo aceptado.
 */

const path = require('path');

const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.codex', '.gemini', 'gh', 'github cli', 'cockpit', 'ultron-pupus']);
const SEGMENT_SPLIT = /[\n;&|]+/;
const BLOCK_OPENER = /^(?:[\s({!`]|(?:\w+=)?\$\(|(?:if|then|elif|else|do|while|until|time|command|builtin)\s)+/i;
const CD_SEGMENT = /^(?:cd|chdir|pushd|set-location|sl|push-location)(?:\s+(?:-\w+|\/d))*(?:\s+(.+))?$/i;
const FIRST_WORD = /^(?:"[^"]*"|'[^']*'|[^\s"'])+/;
const ABSOLUTE_DIR = /^(?:[a-z]:|~|\$[\w:{}]+|%\w+%)?[\\/]|^~$|^\$[\w:{}]+$|^%\w+%$/i;
const MAX_DIR_CHARS = 1024;

function slashed(dir) {
  return String(dir || '').replace(/\\/g, '/').replace(/^["']+|["']+$/g, '').trim();
}

/** Destino de un `cd` sin redireccion, cierre de bloque ni comillas. */
function cdTarget(args) {
  const word = String(args || '').trim().match(FIRST_WORD);
  if (!word) return '';
  return word[0].replace(/\d*[<>].*$/, '').replace(/[)}`]+$/, '').replace(/["']/g, '');
}

/** Directorio tras un `cd`, con el `..` resuelto. Vacio si no se puede saber (`cd -`). */
function nextDir(dir, target) {
  const to = slashed(target);
  if (to === '') return '~';
  if (to === '-') return '';
  return path.posix.normalize(ABSOLUTE_DIR.test(to) || !dir ? to : `${dir}/${to}`);
}

function isSensitiveDir(dir) {
  return dir.split('/').some((s) => SENSITIVE_DIRS.has(s.toLowerCase()));
}

/** Palabras de un segmento resueltas contra `dir`, sin el verbo ni las opciones. */
function classifyWordsInDir(segment, dir, { classifyPath, tokenSplit }) {
  // `< f cat`: la primera palabra es el fichero redirigido, no el verbo.
  const first = /^[<>]/.test(segment) ? 0 : 1;
  for (const raw of segment.split(tokenSplit).filter(Boolean).slice(first)) {
    const word = raw.replace(/^["']+|["']+$/g, '');
    if (!word || word.startsWith('-')) continue;
    const reason = classifyPath(`${dir}/${word}`);
    if (!reason) continue;
    // Como en classifyShellToken: `k.key` suelto en codigo no es una clave privada.
    if (reason.startsWith('private key') && !/[\\/]/.test(word) && !dir.toLowerCase().includes('.ssh')) continue;
    return reason;
  }
  return null;
}

/**
 * Recorre los `cd` de la linea partiendo del `cwd` del payload.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {{classifyPath: Function, tokenSplit: RegExp}} rules reglas de deny-secrets
 */
function classifyRelativeToCwd(command, cwd, rules) {
  let dir = slashed(cwd);
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const segment = raw.trim().replace(BLOCK_OPENER, '');
    const cd = segment.match(CD_SEGMENT);
    if (cd) {
      // Una ruta que crece sin parar (`cd x; ` miles de veces) deja de saberse: sin
      // tope, normalizarla hacia cuadratico el escaneo de la linea.
      const next = nextDir(dir, cdTarget(cd[1]));
      dir = next.length > MAX_DIR_CHARS ? '' : next;
      continue;
    }
    if (!dir || !isSensitiveDir(dir)) continue;
    const reason = classifyWordsInDir(segment, dir, rules);
    if (reason) return `command accesses a ${reason}`;
  }
  return null;
}

module.exports = { classifyRelativeToCwd };
