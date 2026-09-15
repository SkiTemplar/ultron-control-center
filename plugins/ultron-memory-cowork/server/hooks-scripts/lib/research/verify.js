'use strict';

/**
 * lib/research/verify.js — verificador de citas (fase 3): dado un informe
 * (.tex, .md o .bib) comprueba que cada referencia CITADA existe y esta bien
 * citada contra el registro real del DOI (OpenAlex/Semantic Scholar via
 * resolve.js, retraccion via retraction.js). Determinista, sin LLM: senala
 * discrepancias, no reescribe el informe ni decide por el usuario.
 *
 * Estados por entrada (uno por referencia citada):
 *  - ok: DOI resuelve y titulo/primer autor/anio coinciden (tolerante a
 *    mayusculas, acentos, puntuacion y subtitulo tras ':').
 *  - mismatch: el DOI existe pero algun campo no coincide (`mismatches`).
 *  - doi_not_found: el DOI no resuelve en OpenAlex ni Semantic Scholar.
 *  - no_doi: la entrada del .bib no trae DOI; se intenta un candidato por
 *    titulo en OpenAlex (`candidate`), nunca se da por bueno.
 *  - retracted: el DOI citado esta retractado (prioridad sobre mismatch).
 *  - not_in_session: DOI valido pero ausente de la sesion de investigacion
 *    indicada (solo si se paso `sessionId`).
 *  - check_failed: fallo transitorio (red/timeout/rate limit) al consultar
 *    la fuente -- distinto de doi_not_found (que afirma que el DOI NO
 *    existe): aqui simplemente no se pudo confirmar. Aislado a ESA entrada,
 *    no aborta la verificacion del resto del informe.
 * Ademas del estado por entrada: `citedNotInBib` (claves citadas en el texto
 * sin entrada en el .bib) y `uncitedInBib` (entradas del .bib nunca citadas,
 * que por eso mismo no se verifican contra el DOI real).
 *
 * Un informe .bib solo (sin .tex/.md que lo acompane) no tiene texto donde
 * buscar citas: se tratan TODAS sus entradas como citadas y no se calculan
 * citedNotInBib/uncitedInBib (no aplican sin texto).
 */

const fs = require('fs');
const path = require('path');
const { parseBibtex, getField, firstAuthorSurname } = require('./bibtex');
const { extractCitedKeys } = require('./citations');
const { titleKey } = require('./merge');
const { normalizeDoi } = require('./normalize');
const { resolvePaperByDoi } = require('./resolve');
const openalex = require('./openalex');
const session = require('./session');
const { NotFoundError, ResearchError } = require('./errors');

function detectFormat(reportPath) {
  const ext = path.extname(reportPath).toLowerCase();
  if (ext === '.bib') return 'bib';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.tex' || ext === '.latex') return 'tex';
  throw new ResearchError(`extension no soportada para el informe: "${ext || '(sin extension)'}" (se esperaba .tex, .md o .bib)`);
}

/**
 * Localiza el .bib de un informe .tex/.md: `explicitBibPath` si se dio,
 * si no `\bibliography{...}`/`\addbibresource{...}` dentro de un .tex, si no
 * `<mismo-nombre-que-el-informe>.bib` en el mismo directorio. Nunca infiere
 * en silencio: si nada de eso resuelve, lanza NotFoundError (mandamiento 11).
 */
function resolveBibPath(reportPath, format, text, explicitBibPath) {
  const dir = path.dirname(reportPath);

  if (explicitBibPath) {
    const p = path.isAbsolute(explicitBibPath) ? explicitBibPath : path.join(dir, explicitBibPath);
    if (!fs.existsSync(p)) throw new NotFoundError(`el .bib indicado no existe: ${p}`, { resource: p });
    return p;
  }

  if (format === 'tex') {
    const m = text.match(/\\(?:bibliography|addbibresource)\{([^}]+)\}/);
    if (m) {
      for (const rawName of m[1].split(',')) {
        const name = rawName.trim();
        if (!name) continue;
        const withExt = name.endsWith('.bib') ? name : `${name}.bib`;
        const p = path.isAbsolute(withExt) ? withExt : path.join(dir, withExt);
        if (fs.existsSync(p)) return p;
      }
    }
  }

  const sameName = path.join(dir, `${path.basename(reportPath, path.extname(reportPath))}.bib`);
  if (fs.existsSync(sameName)) return sameName;

  throw new NotFoundError(
    `no se encontro el .bib del informe (probado: --bib explicito, \\bibliography/\\addbibresource del .tex, y ${sameName})`,
    { resource: reportPath },
  );
}

/** Normaliza el titulo quitando el subtitulo tras ':' (tolerancia a subtitulos, ver cabecera del modulo). */
function coreTitleKey(title) {
  return titleKey(String(title ?? '').split(':')[0]);
}

/** true si `a` y `b` son el mismo titulo tras normalizar (mayusculas/acentos/puntuacion/subtitulo). */
function titlesMatch(a, b) {
  const fullA = titleKey(a);
  const fullB = titleKey(b);
  if (fullA && fullA === fullB) return true;
  const coreA = coreTitleKey(a);
  const coreB = coreTitleKey(b);
  return Boolean(coreA) && coreA === coreB;
}

/** Clave de apellido tolerante a mayusculas/acentos/puntuacion (mismo criterio que titleKey de merge.js). */
function surnameKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

function lastWord(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/** Compara titulo/primer autor/anio citados contra el Paper real; devuelve la lista de discrepancias. */
function compareFields(cited, realPaper) {
  const mismatches = [];

  if (cited.title && realPaper.title && !titlesMatch(cited.title, realPaper.title)) {
    mismatches.push({ field: 'title', cited: cited.title, real: realPaper.title });
  }

  const realFirstAuthor = realPaper.authors?.[0] ? lastWord(realPaper.authors[0]) : null;
  if (cited.firstAuthor && realFirstAuthor && surnameKey(cited.firstAuthor) !== surnameKey(realFirstAuthor)) {
    mismatches.push({ field: 'firstAuthor', cited: cited.firstAuthor, real: realPaper.authors[0] });
  }

  if (cited.year != null && realPaper.year != null && Number(cited.year) !== Number(realPaper.year)) {
    mismatches.push({ field: 'year', cited: cited.year, real: realPaper.year });
  }

  return mismatches;
}

/** Mejor candidato por titulo en OpenAlex para una entrada sin DOI (nunca se da por bueno: solo se informa). */
async function findDoiCandidate(title) {
  if (!title) return null;
  let works;
  try {
    works = await openalex.searchWorks(title, { limit: 5 });
  } catch {
    return null; // best-effort: el estado no_doi ya deja claro que falta el dato, no bloquea el resto del informe
  }
  if (!works.length) return null;

  const exact = works.find((w) => titlesMatch(title, w.display_name ?? w.title ?? ''));
  const pick = exact ?? works[0];
  const doi = normalizeDoi(pick.doi ?? pick.ids?.doi);
  if (!doi) return null;
  return { doi, title: pick.display_name ?? pick.title ?? null, confident: Boolean(exact) };
}

function citedFieldsOf(entry) {
  const yearRaw = getField(entry, 'year');
  const yearMatch = yearRaw ? String(yearRaw).match(/\d{4}/) : null;
  return {
    title: getField(entry, 'title'),
    year: yearMatch ? yearMatch[0] : null,
    firstAuthor: firstAuthorSurname(getField(entry, 'author')),
    doi: getField(entry, 'doi'),
  };
}

async function evaluateEntry(entry, { sessionDoiSet }) {
  const cited = citedFieldsOf(entry);
  const doi = normalizeDoi(cited.doi);

  if (!doi) {
    const candidate = await findDoiCandidate(cited.title);
    return { key: entry.key, cited, status: 'no_doi', reason: 'la entrada del .bib no trae DOI', candidate };
  }

  let paper;
  try {
    paper = await resolvePaperByDoi(doi);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return { key: entry.key, cited, doi, status: 'doi_not_found', reason: `el DOI ${doi} no resuelve en OpenAlex ni Semantic Scholar` };
    }
    // Fallo transitorio (red, timeout, rate limit) al consultar la fuente: se
    // señala explícitamente en ESTA entrada (mandamiento 11) en vez de abortar
    // la verificación completa del informe por un problema de una sola referencia.
    return { key: entry.key, cited, doi, status: 'check_failed', reason: `no se pudo verificar el DOI ${doi}: ${String(e.message ?? e)}` };
  }

  const real = { title: paper.title, year: paper.year, firstAuthor: paper.authors?.[0] ? lastWord(paper.authors[0]) : null, doi: paper.doi };
  const mismatches = compareFields(cited, paper);

  if (paper.isRetracted) {
    return { key: entry.key, cited, real, doi, status: 'retracted', reason: 'el DOI citado esta retractado', mismatches, retraction: paper.retraction };
  }
  if (mismatches.length > 0) {
    return { key: entry.key, cited, real, doi, status: 'mismatch', reason: `no coincide: ${mismatches.map((m) => m.field).join(', ')}`, mismatches };
  }
  if (sessionDoiSet && !sessionDoiSet.has(doi)) {
    return { key: entry.key, cited, real, doi, status: 'not_in_session', reason: 'el DOI es correcto pero no esta en la sesion de investigacion indicada' };
  }
  return { key: entry.key, cited, real, doi, status: 'ok', reason: 'DOI, titulo, primer autor y anio coinciden' };
}

const EMPTY_SUMMARY = { total: 0, ok: 0, mismatch: 0, doi_not_found: 0, no_doi: 0, retracted: 0, not_in_session: 0, check_failed: 0 };

/**
 * Verifica las citas de `reportPath` (.tex, .md o .bib) contra el .bib que
 * lo acompana y, DOI a DOI, contra OpenAlex/Semantic Scholar + retraccion.
 * `opts.bibPath` fuerza el .bib (si no, se autodetecta, ver resolveBibPath).
 * `opts.sessionId` anade el estado `not_in_session` comparando contra los
 * DOI guardados en esa sesion de investigacion (lanza NotFoundError si la
 * sesion no existe).
 */
async function verifyReport(reportPath, { bibPath: explicitBibPath, sessionId } = {}) {
  const absReport = path.resolve(reportPath);
  if (!fs.existsSync(absReport)) throw new NotFoundError(`informe no encontrado: ${absReport}`, { resource: absReport });

  const format = detectFormat(absReport);
  const text = fs.readFileSync(absReport, 'utf8');

  let bibFile;
  let entries;
  let citedCounts;
  if (format === 'bib') {
    bibFile = absReport;
    entries = parseBibtex(text);
    citedCounts = new Map(entries.map((e) => [e.key, 1])); // sin texto: cada entrada del .bib se trata como citada
  } else {
    bibFile = resolveBibPath(absReport, format, text, explicitBibPath);
    entries = parseBibtex(fs.readFileSync(bibFile, 'utf8'));
    citedCounts = extractCitedKeys(text, format);
  }

  const bibKeys = new Set(entries.map((e) => e.key));
  const citedNotInBib = format === 'bib' ? [] : [...citedCounts.keys()].filter((k) => !bibKeys.has(k));
  const uncitedInBib = format === 'bib' ? [] : entries.map((e) => e.key).filter((k) => !citedCounts.has(k));

  let sessionDoiSet = null;
  if (sessionId) {
    session.resolveSession(sessionId); // lanza NotFoundError si la sesion no existe (readPapers() sola no lo hace)
    sessionDoiSet = new Set(session.readPapers(sessionId).map((p) => normalizeDoi(p.doi)).filter(Boolean));
  }

  const toCheck = entries.filter((e) => citedCounts.has(e.key));
  const results = await Promise.all(
    toCheck.map((entry) => evaluateEntry(entry, { sessionDoiSet }).then((r) => ({ ...r, citedTimes: citedCounts.get(entry.key) ?? 0 }))),
  );

  const summary = results.reduce((acc, r) => ({ ...acc, total: acc.total + 1, [r.status]: (acc[r.status] ?? 0) + 1 }), EMPTY_SUMMARY);

  return { report: absReport, bibFile, session: sessionId ?? null, entries: results, citedNotInBib, uncitedInBib, summary };
}

module.exports = { verifyReport };
