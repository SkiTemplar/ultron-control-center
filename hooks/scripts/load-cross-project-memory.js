#!/usr/bin/env node
/**
 * Cross-project memory loader — SessionStart hook.
 *
 * Problem: Claude Code carga MEMORY.md SOLO del proyecto activo (cwd).
 * The user has memories across >15 distinct projects; al abrir una sesión
 * desde un directorio cualquiera (System32, ultron, otro), pierde todo
 * el conocimiento acumulado en los otros proyectos.
 *
 * Fix: este hook escanea ~/.claude/projects/*\/memory/MEMORY.md de TODOS
 * los proyectos con actividad reciente y los inyecta como un índice
 * resumido (título + descripción) + el body completo de los 3 más recientes.
 *
 * Salida: additionalContext con un bloque
 *   "## Cross-project memory index"
 * que aparece en la sesión recién arrancada.
 *
 * Cross-platform, fail-safe: cualquier error → exit(0) con context vacío.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'load-cross-project-memory.jsonl');

// Tunables — KIRKARDO R11.3 FIX-3: filtered by cwd-similarity to slash the
// ~18k bootstrap context to ~3-6k on typical sessions. Projects sharing >=2
// path segments with the active cwd are considered "near" and get full body;
// the rest only appear in the index (1 line per project).
const MAX_PROJECTS_INDEXED = 15;
const MAX_FULL_BODY_PROJECTS = 3;
const MAX_BODY_CHARS = 1500;
const MAX_TOTAL_CONTEXT_CHARS = 6000;
const ACTIVITY_WINDOW_DAYS = 60;
const MIN_SIMILARITY_FOR_BODY = 2;

const { appendJsonl } = require('./lib/jsonl-log');

function safeLog(entry) {
  // cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
  appendJsonl(LOG_PATH, entry);
}

function emitPayload(additionalContext) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext || '',
    },
  };
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch (_) {
    /* ignore */
  }
}

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function listProjectMemories() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const cutoff = Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const out = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const memDir = path.join(PROJECTS_DIR, ent.name, 'memory');
    const memFile = path.join(memDir, 'MEMORY.md');
    let st;
    try {
      st = fs.statSync(memFile);
    } catch (_) {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    out.push({
      project: ent.name,
      memFile,
      memDir,
      mtime: st.mtimeMs,
      size: st.size,
    });
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_PROJECTS_INDEXED);
}

function readSafe(p, maxBytes) {
  try {
    const buf = fs.readFileSync(p, 'utf8');
    if (maxBytes && buf.length > maxBytes) {
      return buf.slice(0, maxBytes) + '\n[truncated]';
    }
    return buf;
  } catch (_) {
    return '';
  }
}

function projectLabel(slug) {
  // Slugs look like "C--Users-<user>--ultron" — convert to human-readable.
  return slug.replace(/^C--/, '').replace(/--/g, '/').replace(/-/g, ' ');
}

/**
 * Convert a real cwd ("C:\\Users\\<user>\\.ultron") into the slug format Claude
 * Code uses for project directories ("C--Users-<user>--ultron"). Empty/unknown
 * cwd returns "".
 */
function cwdToSlug(cwd) {
  if (!cwd) return '';
  return String(cwd)
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/^([A-Z])-/, '$1--');
}

/**
 * Count shared path segments between a project slug and the current cwd slug.
 * Higher = more topically relevant. Excludes the empty segment + common stems
 * (drive letters, "Users", the current username) so the score reflects
 * project-specific overlap.
 */
let CURRENT_USER = '';
try {
  CURRENT_USER = os.userInfo().username || '';
} catch (_) {
  CURRENT_USER = path.basename(HOME) || '';
}
const COMMON_STEMS = new Set(['C', 'D', 'Users', CURRENT_USER, '']);
function similarityScore(projectSlug, cwdSlug) {
  if (!projectSlug || !cwdSlug) return 0;
  const a = new Set(projectSlug.split('-').filter((s) => !COMMON_STEMS.has(s)));
  const b = new Set(cwdSlug.split('-').filter((s) => !COMMON_STEMS.has(s)));
  let shared = 0;
  for (const s of a) if (b.has(s)) shared += 1;
  return shared;
}

function buildContext(projects, currentCwd) {
  if (projects.length === 0) return '';

  // KIRKARDO R11.3 FIX-3: score each project by cwd-similarity and only
  // expand bodies for the "near" ones (>=2 shared segments). Far projects
  // still appear in the index, but cost ~1 line instead of ~2500 chars.
  const cwdSlug = cwdToSlug(currentCwd);
  const scored = projects.map((p) => ({
    ...p,
    similarity: similarityScore(p.project, cwdSlug),
  }));
  scored.sort((a, b) => b.similarity - a.similarity || b.mtime - a.mtime);

  const nearProjects = scored.filter((p) => p.similarity >= MIN_SIMILARITY_FOR_BODY);
  // Fallback: if the active cwd shares nothing with any project (e.g. running
  // from System32), still expand the single most recently-touched memory so
  // the session has at least some persistent state to draw from.
  const bodyProjects = nearProjects.length > 0
    ? nearProjects.slice(0, MAX_FULL_BODY_PROJECTS)
    : scored.slice(0, 1);

  const lines = [];
  lines.push('## Cross-project memory index — loaded by user:session:load-cross-project-memory');
  lines.push('');
  lines.push(
    'This session was opened at `' + (currentCwd || 'unknown') + '`. The MEMORY.md ' +
      'files below come from other Claude Code projects on this machine. They are ' +
      'HISTORICAL REFERENCE so you can recall what was discussed across projects ' +
      'without burning tokens asking the user. Treat slugs/paths/IDs as stale-by-default; ' +
      'verify against current state before acting on them.'
  );
  lines.push('');

  lines.push(
    '### Index (' + scored.length + ' projects with recent memory; ' +
      bodyProjects.length + ' shown in full based on cwd-similarity)'
  );
  lines.push('');
  for (const p of scored) {
    const ageDays = Math.round((Date.now() - p.mtime) / (24 * 3600 * 1000));
    const simTag = p.similarity > 0 ? ` [sim:${p.similarity}]` : '';
    lines.push(
      '- **' + projectLabel(p.project) + '** — `' + p.project +
        '` (' + ageDays + 'd ago, ' + p.size + 'B)' + simTag
    );
  }
  lines.push('');

  if (bodyProjects.length > 0) {
    lines.push('### Recent memory bodies (near-cwd projects only)');
    lines.push('');
    for (const p of bodyProjects) {
      const body = readSafe(p.memFile, MAX_BODY_CHARS);
      if (!body) continue;
      lines.push('#### ' + projectLabel(p.project));
      lines.push('');
      lines.push(body);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  let out = lines.join('\n');
  if (out.length > MAX_TOTAL_CONTEXT_CHARS) {
    out = out.slice(0, MAX_TOTAL_CONTEXT_CHARS) +
      '\n\n[cross-project memory index truncated]';
  }
  return out;
}

function main() {
  const stdinRaw = readStdinSafe();
  let stdinPayload = {};
  try {
    stdinPayload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    /* ignore */
  }

  const source = String(stdinPayload.source || '').trim().toLowerCase();
  // Run on startup AND resume — the user wants memory recall on every session.
  if (source && source !== 'startup' && source !== 'resume') {
    safeLog({ level: 'info', msg: 'skip_source', source });
    return emitPayload('');
  }

  const cwd = process.cwd();
  const projects = listProjectMemories();

  if (projects.length === 0) {
    safeLog({ level: 'info', msg: 'no_memories_found' });
    return emitPayload('');
  }

  const ctx = buildContext(projects, cwd);
  safeLog({
    level: 'info',
    msg: 'injected_cross_project_memory',
    cwd,
    project_count: projects.length,
    chars: ctx.length,
    top_projects: projects.slice(0, MAX_FULL_BODY_PROJECTS).map((p) => p.project),
  });
  emitPayload(ctx);
}

try {
  main();
} catch (err) {
  safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
  emitPayload('');
}

process.exitCode = 0;
