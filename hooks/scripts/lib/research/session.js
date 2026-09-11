'use strict';

/**
 * lib/research/session.js — sesiones de investigacion en disco, FUERA del
 * repo (~/.ultron/research/<fecha>-<slug>/): papers.json (lo que el usuario
 * decide guardar), refs.bib (generado desde BibTeX oficial de Crossref/
 * doi.org, nunca redactado por la IA) y pdfs/ (descargas de acceso abierto).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeId } = require('../safe-id');
const crossref = require('./crossref');
const { dedupeKey } = require('./merge');
const { NotFoundError } = require('./errors');

const SESSION_ID_RE = /^\d{4}-\d{2}-\d{2}-/; // distingue una sesion real de .cache/ u otras carpetas auxiliares

/**
 * Raiz de las sesiones de investigacion. RESEARCH_ROOT_OVERRIDE (solo para
 * los selftest) permite apuntar a una carpeta temporal en vez de
 * ~/.ultron/research/, para no ensuciar el disco real del usuario al testear.
 */
function researchRoot() {
  return process.env.RESEARCH_ROOT_OVERRIDE || path.join(os.homedir(), '.ultron', 'research');
}

function slugify(topic) {
  const slug = String(topic ?? 'sesion')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return safeId(slug || 'sesion');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Lista las sesiones existentes (mas reciente primero por nombre de carpeta). */
function listSessions() {
  if (!fs.existsSync(researchRoot())) return [];
  return fs.readdirSync(researchRoot(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && SESSION_ID_RE.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse()
    .map((id) => ({ id, dir: path.join(researchRoot(), id), paperCount: readPapers(id).length }));
}

/** Crea una sesion nueva (idempotente si ya existe una con el mismo id de hoy). */
function newSession(topic) {
  const id = `${todayIso()}-${slugify(topic)}`;
  const dir = path.join(researchRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'pdfs'), { recursive: true });
  const papersFile = path.join(dir, 'papers.json');
  if (!fs.existsSync(papersFile)) fs.writeFileSync(papersFile, '[]\n');
  return { id, dir };
}

/** Resuelve el directorio de una sesion existente. Lanza NotFoundError si no existe. */
function resolveSession(id) {
  const safe = safeId(id);
  const dir = path.join(researchRoot(), safe);
  if (!fs.existsSync(dir)) throw new NotFoundError(`sesion de investigacion no encontrada: ${id}`, { resource: id });
  return { id: safe, dir };
}

function papersFilePath(id) {
  return path.join(resolveSession(id).dir, 'papers.json');
}

/** Lee papers.json de una sesion (array vacio si la sesion no existe todavia). */
function readPapers(id) {
  try {
    const file = papersFilePath(id);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function writePapersAtomic(id, papers) {
  const file = papersFilePath(id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(papers, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Anade (o actualiza) un Paper normalizado en papers.json, deduplicando por dedupeKey. */
function addPaper(id, paper) {
  const papers = readPapers(id);
  const key = dedupeKey(paper);
  const idx = papers.findIndex((p) => dedupeKey(p) === key);
  if (idx >= 0) papers[idx] = { ...papers[idx], ...paper };
  else papers.push(paper);
  writePapersAtomic(id, papers);
  return papers.length;
}

/**
 * Genera refs.bib a partir de los DOI guardados en papers.json, usando el
 * BibTeX oficial de Crossref/doi.org (negociacion de contenido). Los papers
 * sin DOI se listan en warnings y se omiten (no se inventa BibTeX).
 */
async function writeBib(id) {
  const { dir } = resolveSession(id);
  const papers = readPapers(id);
  const entries = [];
  const warnings = [];
  for (const paper of papers) {
    if (!paper.doi) {
      warnings.push(`sin DOI, omitido del .bib: ${paper.title}`);
      continue;
    }
    try {
      entries.push(await crossref.getBibtex(paper.doi));
    } catch (e) {
      warnings.push(`BibTeX fallo para ${paper.doi}: ${String(e.message ?? e)}`);
    }
  }
  const bibFile = path.join(dir, 'refs.bib');
  fs.writeFileSync(bibFile, `${entries.join('\n\n')}\n`);
  return { file: bibFile, count: entries.length, warnings };
}

module.exports = { researchRoot, listSessions, newSession, resolveSession, readPapers, addPaper, writeBib, slugify };
