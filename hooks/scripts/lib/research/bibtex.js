'use strict';

/**
 * lib/research/bibtex.js — parser de BibTeX minimo, sin dependencias (no hay
 * package.json en hooks/scripts/, ver research-mcp.js). Soporta @type{key,
 * campo = {valor}|"valor"|token, ...} con llaves anidadas, @comment/@string/
 * @preamble ignorados y '(' ')' como delimitador alternativo de entrada. No
 * expande macros @string ni valida contra el estandar BibTeX completo: basta
 * para leer el .bib que el propio usuario o Crossref (ver crossref.js::
 * getBibtex) generaron, que es el unico caso de uso (verify.js).
 */

const WHITESPACE_RE = /\s/;
const FIELD_NAME_RE = /[A-Za-z0-9_-]/;
const TYPE_NAME_RE = /[A-Za-z]/;

function isWhitespace(ch) {
  return ch !== undefined && WHITESPACE_RE.test(ch);
}

/** Colapsa espacios/saltos de linea y quita llaves de proteccion de mayusculas ({Deep} Learning -> Deep Learning). */
function normalizeValue(raw) {
  return raw.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** Avanza `i` hasta cerrar el `openChar`/`closeChar` balanceado que empieza justo en `i` (ya consumido el primero). */
function skipBalanced(text, i, openChar, closeChar) {
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === openChar) depth += 1;
    else if (text[i] === closeChar) depth -= 1;
    i += 1;
  }
  return i;
}

/** Lee el valor de un campo empezando en `i` ({...}, "..." o token suelto). Devuelve { value, next }. */
function readValue(text, i) {
  const n = text.length;
  if (text[i] === '{') {
    const start = i + 1;
    const end = skipBalanced(text, start, '{', '}');
    return { value: normalizeValue(text.slice(start, end - 1)), next: end };
  }
  if (text[i] === '"') {
    let j = i + 1;
    let depth = 0;
    while (j < n) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      else if (text[j] === '"' && depth === 0) break;
      j += 1;
    }
    return { value: normalizeValue(text.slice(i + 1, j)), next: j + 1 };
  }
  let j = i;
  while (j < n && !/[,}\)\s]/.test(text[j])) j += 1;
  return { value: normalizeValue(text.slice(i, j)), next: j };
}

/**
 * Parsea el contenido de un .bib a `[{ key, type, fields }]` (fields con
 * nombre en minusculas). Entradas malformadas se descartan sin abortar el
 * resto del fichero (un fichero real tipicamente mezcla entradas escritas a
 * mano con entradas exportadas por herramientas distintas).
 */
function parseBibtex(text) {
  const entries = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const at = text.indexOf('@', i);
    if (at === -1) break;
    i = at + 1;

    let j = i;
    while (j < n && TYPE_NAME_RE.test(text[j])) j += 1;
    const type = text.slice(i, j).toLowerCase();
    i = j;
    while (isWhitespace(text[i])) i += 1;

    if (text[i] !== '{' && text[i] !== '(') continue; // no es una entrada real: sigue buscando el proximo '@'
    const openChar = text[i];
    const closeChar = openChar === '{' ? '}' : ')';
    i += 1;

    if (type === 'comment' || type === 'preamble' || type === 'string') {
      i = skipBalanced(text, i, openChar, closeChar);
      continue;
    }

    let k = i;
    while (k < n && text[k] !== ',' && text[k] !== closeChar) k += 1;
    const key = text.slice(i, k).trim();
    i = k;

    const fields = {};
    let malformed = false;
    while (i < n) {
      while (i < n && (text[i] === ',' || isWhitespace(text[i]))) i += 1;
      if (text[i] === closeChar) { i += 1; break; }
      if (i >= n) { malformed = true; break; }

      let f = i;
      while (f < n && FIELD_NAME_RE.test(text[f])) f += 1;
      const fieldName = text.slice(i, f).toLowerCase();
      i = f;
      while (isWhitespace(text[i])) i += 1;
      if (text[i] !== '=') { malformed = true; break; }
      i += 1;
      while (isWhitespace(text[i])) i += 1;

      const { value, next } = readValue(text, i);
      if (fieldName) fields[fieldName] = value;
      i = next;
    }

    if (!malformed && key) entries.push({ key, type, fields });
  }

  return entries;
}

/** Valor de un campo (case-insensitive), o null si no existe. */
function getField(entry, name) {
  return entry.fields[name.toLowerCase()] ?? null;
}

/** Divide el campo `author`/`editor` en autores individuales (convencion BibTeX: separador ` and `). */
function splitAuthors(authorField) {
  return String(authorField ?? '')
    .split(/\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apellido de un autor: parte antes de la coma en "Apellido, Nombre", o ultima palabra en "Nombre Apellido". */
function authorSurname(rawName) {
  const s = rawName.trim();
  if (s.includes(',')) return s.split(',')[0].trim();
  const parts = s.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? s;
}

/** Apellido del primer autor del campo `author`, o null si no hay campo/autores. */
function firstAuthorSurname(authorField) {
  const authors = splitAuthors(authorField);
  return authors.length ? authorSurname(authors[0]) : null;
}

module.exports = { parseBibtex, getField, splitAuthors, authorSurname, firstAuthorSurname };
