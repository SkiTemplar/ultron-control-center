'use strict';
/**
 * skill-paths.js — convención única de skills lazy en disco (2026-09-06).
 *
 * Claude Code carga en CADA sesión todo `~/.claude/skills/<dir>/SKILL.md`,
 * incluido `<name>.disabled/SKILL.md`: 85 skills "desactivadas" costaban ~3k
 * tokens por sesión y por subagente sin poder invocarse. No desciende a
 * subdirectorios (probado el 2026-09-06 con `_vault/x/SKILL.md` y
 * `.vault/x/SKILL.md`: ninguna visible), así que el contenedor
 * `~/.claude/skills/_disabled/<name>/` es la única forma que mantiene una
 * skill fuera del contexto y a la vez inyectable por el dispatcher de ULTRON.
 * Rust ya conocía el contenedor (`skills/origin.rs`, convención 2); desde hoy
 * es la forma que escribe el toggle. El sufijo `.disabled` queda como forma
 * legacy de solo lectura.
 *
 * Único punto de verdad para JS: dispatcher v2/v3, sync-registry,
 * kirkardo-eval y catalog-usage resuelven rutas por aquí.
 */
const fs = require('fs');
const path = require('path');

const LAZY_CONTAINER = '_disabled';
const LEGACY_SUFFIX = '.disabled';

/** Directorio de una skill lazy dentro del contenedor. */
function lazyDir(skillsDir, id) {
  return path.join(skillsDir, LAZY_CONTAINER, id);
}

/**
 * Candidatos a SKILL.md para un id no namespaced, en orden de preferencia:
 * activa, contenedor, sufijo legacy. El llamador se queda con el primero que
 * exista (o con el primero a secas si quiere una ruta "esperada").
 */
function skillMdCandidates(skillsDir, id) {
  return [
    path.join(skillsDir, id, 'SKILL.md'),
    path.join(skillsDir, LAZY_CONTAINER, id, 'SKILL.md'),
    path.join(skillsDir, id + LEGACY_SUFFIX, 'SKILL.md'),
  ];
}

/** Candidatos para un sub-skill `ns:base` dentro de skillsDir. */
function namespacedSkillMdCandidates(skillsDir, nsPrefix, baseName) {
  return [
    path.join(skillsDir, nsPrefix, baseName, 'SKILL.md'),
    path.join(skillsDir, LAZY_CONTAINER, nsPrefix, baseName, 'SKILL.md'),
    path.join(skillsDir, nsPrefix, baseName + LEGACY_SUFFIX, 'SKILL.md'),
  ];
}

/** Primer candidato existente, o null. */
function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ruta ilegible: siguiente */ }
  }
  return null;
}

/** true si la ruta corresponde a una skill lazy (contenedor o sufijo legacy). */
function isLazyPath(p) {
  const s = String(p || '');
  return (
    s.includes(path.sep + LAZY_CONTAINER + path.sep) ||
    s.includes('/' + LAZY_CONTAINER + '/') ||
    s.includes(LEGACY_SUFFIX)
  );
}

/**
 * Enumera las skills de skillsDir: `{ id, dir, lazy }` por cada directorio con
 * SKILL.md, tanto activas (nivel raíz) como lazy (contenedor y sufijo legacy).
 * Nunca lanza: un directorio ilegible se salta.
 */
function scanSkillDirs(skillsDir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === LAZY_CONTAINER) {
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(skillsDir, LAZY_CONTAINER), { withFileTypes: true });
      } catch (_) { /* contenedor ilegible */ }
      for (const child of inner) {
        if (!child.isDirectory()) continue;
        const dir = path.join(skillsDir, LAZY_CONTAINER, child.name);
        if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push({ id: child.name, dir, lazy: true });
      }
      continue;
    }
    const lazy = entry.name.endsWith(LEGACY_SUFFIX);
    const id = lazy ? entry.name.slice(0, -LEGACY_SUFFIX.length) : entry.name;
    const dir = path.join(skillsDir, entry.name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push({ id, dir, lazy });
  }
  return out;
}

module.exports = {
  LAZY_CONTAINER,
  LEGACY_SUFFIX,
  lazyDir,
  skillMdCandidates,
  namespacedSkillMdCandidates,
  firstExisting,
  isLazyPath,
  scanSkillDirs,
};
