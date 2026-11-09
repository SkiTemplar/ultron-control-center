'use strict';
/**
 * lib/secret-globs.js — rutas de credenciales que un comodin de shell puede
 * seleccionar. Sale de deny-secrets.js (limite de 800 lineas por fichero).
 */

// --- globs (hooks-9) ----------------------------------------------------------
// `cat ~/.ultron/.e*` o `cat ~/.co*/auth.json` seleccionan el fichero real sin
// nombrarlo. Cada segmento con comodines se sustituye por los nombres que las
// reglas reconocen y que el glob selecciona: nombres de fichero en el ultimo
// segmento y de directorio en los demas (`ls ~/logs/ultron*` no lista
// `ultron-pupus`). Si no selecciona ninguno, se deja tal cual.
const GLOB_CHARS = /[*?[]/;
const GLOB_FILE_NAMES = [
  '.env', '.claude.json', 'credentials.json', 'secrets.json', '.secrets.json', '.credentials.json',
  '.git-credentials', '.netrc', '_netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'id_dsa',
  'id_ecdsa', 'mascot-bridge.json', 'auth.json', 'oauth_creds.json', 'hosts.yml', 'credentials',
];
const GLOB_DIR_NAMES = ['.ssh', '.aws', '.codex', '.gemini', 'gh'];
// Directorios con un secreto de nombre conocido: dentro de ellos hasta un glob
// generico (`*`, `*.json`) lo alcanza, asi que no se exige que vaya dirigido.
const DIR_FILE_SECRETS = {
  '.codex': ['auth.json'],
  '.gemini': ['oauth_creds.json'],
  cockpit: ['mascot-bridge.json'],
  '.aws': ['credentials'],
  gh: ['hosts.yml'],
  'github cli': ['hosts.yml'],
};
const DIR_DIR_SECRETS = { temp: ['ultron-pupus'], tmp: ['ultron-pupus'] };
const MAX_GLOB_CANDIDATES = 64;

/** Regex (anclada, sin distinguir mayusculas) de un segmento de glob. */
function globSegmentRegex(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 1);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      const body = seg.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      out += `[${body}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${out}$`, 'i');
  } catch (_) {
    return null;
  }
}

/**
 * Un glob va DIRIGIDO si fija parte del nombre: un prefijo de dos caracteres
 * (`.e*`, `id_*`, `mascot-b*`), cuatro sueltos (`*pupus*`) o tres si empieza
 * por punto (`.[e]nv`). `*`, `*.json`, `*IA*` o `.*n` (una regex) son genericos: fuera de
 * DIR_*_SECRETS casarlos con `credentials.json` haria saltar `ls src/*`.
 */
function isTargetedGlob(seg) {
  const prefix = seg.split(/[*?[]/)[0];
  const stem = seg.replace(/\.[A-Za-z0-9]+$/, '').replace(/\[[^\]]*\]/g, '').replace(/[*?]/g, '');
  return prefix.length >= 2 || stem.length >= 4 || (seg.startsWith('.') && stem.length >= 3);
}

/** Alternativas concretas de un segmento de glob, dado el padre y si es el ultimo. */
function segmentOptions(seg, parentLow, isLast) {
  if (!GLOB_CHARS.test(seg)) return [seg];
  const re = globSegmentRegex(seg);
  if (!re) return [seg];
  const inDir = ((isLast ? DIR_FILE_SECRETS : DIR_DIR_SECRETS)[parentLow] || []).filter((n) => re.test(n));
  const names = isLast ? GLOB_FILE_NAMES : GLOB_DIR_NAMES;
  const targeted = isTargetedGlob(seg) ? names.filter((n) => re.test(n)) : [];
  const all = [...new Set([...inDir, ...targeted])];
  return all.length ? all : [seg];
}

/** Rutas concretas que un glob puede seleccionar (producto acotado). */
function globCandidates(segments) {
  let paths = [[]];
  for (let i = 0; i < segments.length; i++) {
    const next = [];
    for (const prefix of paths) {
      const parentLow = prefix.length ? prefix[prefix.length - 1].toLowerCase() : '';
      for (const opt of segmentOptions(segments[i], parentLow, i === segments.length - 1)) {
        if (next.length < MAX_GLOB_CANDIDATES) next.push([...prefix, opt]);
      }
    }
    paths = next;
  }
  return paths;
}

module.exports = { GLOB_CHARS, globCandidates };
