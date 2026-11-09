#!/usr/bin/env node
// scripts/memory-verify.mjs — caducidad de la auto-memoria comprobada por script.
//
// La auto-memoria de Claude Code (~/.claude/projects/<slug>/memory/*.md) cita
// ramas y rutas del repo que dejan de existir sin que nadie lo note. Este
// script las comprueba contra el repo del proyecto, sin LLM:
//
//   - rama: `nombre` precedido de "rama"/"branch" que ya no esta en `git branch -a`;
//   - ruta: `Dir/fichero` cuyo primer segmento es un directorio de la raiz del
//     repo y que ya no existe.
//
// Solo informa: escribe cockpit/projects/<id>/memory-stale.json y no toca
// ninguna memoria (una ruta historica citada a proposito es un falso positivo
// legitimo; decide quien lee el informe). El SessionStart avisa con una linea
// si el informe tiene hallazgos (memory-session-resume.js).
//
// Uso:
//   node scripts/memory-verify.mjs --project <id> [--json]
//   node scripts/memory-verify.mjs --repo <ruta> --memory <dir> [--json]   (tests)
//
// Sale con 0 siempre que pueda comprobar; 2 si faltan argumentos o rutas.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRANCH_RE = /\b(?:rama|ramas|branch)\s+(?:de\s+trabajo\s+)?`([\w./-]+)`/gi;
const CODE_SPAN_RE = /`([^`\n]+)`/g;
/** Ramas que no tiene sentido comprobar (patrones o nombres genericos). */
const BRANCH_IGNORE = /[<>*]|^(HEAD|origin)$/;

function ultronRoot() {
  return process.env.ULTRON_ROOT || path.join(os.homedir(), '.ultron');
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Slug con el que Claude Code nombra la carpeta del proyecto. */
export function claudeSlug(repoPath) {
  return path.resolve(repoPath).replace(/[^A-Za-z0-9]/g, '-');
}

export function memoryDirFor(repoPath) {
  return path.join(os.homedir(), '.claude', 'projects', claudeSlug(repoPath), 'memory');
}

function projectPath(projectId) {
  const raw = JSON.parse(fs.readFileSync(path.join(ultronRoot(), 'cockpit', 'projects.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw && raw.projects) || [];
  const entry = list.find((p) => p && p.id === projectId);
  return entry ? entry.path : '';
}

/** Nombres de rama locales y remotos, sin el prefijo del remoto. */
export function listBranches(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'branch', '-a', '--format=%(refname:short)'], { encoding: 'utf8', windowsHide: true });
    const names = new Set();
    for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      names.add(line);
      names.add(line.replace(/^[^/]+\//, ''));
    }
    return names;
  } catch {
    return null; // sin git: no se comprueban ramas
  }
}

function topLevelDirs(repo) {
  return new Set(
    fs.readdirSync(repo, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name),
  );
}

/** Ruta relativa al repo citada en un code span, o '' si el span no es una ruta comprobable. */
export function repoPathCandidate(span, topDirs) {
  const s = span.trim();
  if (/\s|[<>*|$]|:\/\/|^[~/\\-]|^[A-Za-z]:/.test(s)) return '';
  const norm = s.replace(/\\/g, '/').replace(/[.,;:]+$/, '');
  const first = norm.split('/')[0];
  if (!norm.includes('/') || !topDirs.has(first)) return '';
  return norm.replace(/\/$/, '');
}

/** Hallazgos de una memoria: [{ kind, value }]. Puro salvo por `exists`. */
export function staleRefs(text, { branches, topDirs, exists }) {
  const found = new Map();
  if (branches) {
    for (const m of text.matchAll(BRANCH_RE)) {
      const name = m[1];
      if (!BRANCH_IGNORE.test(name) && !branches.has(name)) found.set(`branch:${name}`, { kind: 'branch', value: name });
    }
  }
  for (const m of text.matchAll(CODE_SPAN_RE)) {
    const rel = repoPathCandidate(m[1], topDirs);
    if (rel && !exists(rel)) found.set(`path:${rel}`, { kind: 'path', value: rel });
  }
  return [...found.values()];
}

/** Existe la ruta o, si se cito sin extension, un fichero `<ruta>.<ext>` (assets). */
export function pathExists(repo, rel) {
  const abs = path.join(repo, rel);
  if (fs.existsSync(abs)) return true;
  if (path.extname(rel)) return false;
  try {
    const base = `${path.basename(abs)}.`;
    return fs.readdirSync(path.dirname(abs)).some((name) => name.startsWith(base));
  } catch {
    return false;
  }
}

export function verify({ repo, memoryDir }) {
  const branches = listBranches(repo);
  const topDirs = topLevelDirs(repo);
  const exists = (rel) => pathExists(repo, rel);
  const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  const stale = [];
  for (const file of files) {
    const refs = staleRefs(fs.readFileSync(path.join(memoryDir, file), 'utf8'), { branches, topDirs, exists });
    if (refs.length) stale.push({ file, refs });
  }
  return { checked: files.length, stale };
}

function main(argv) {
  const project = argValue(argv, '--project');
  const repo = argValue(argv, '--repo') || (project ? projectPath(project) : '');
  if (!repo || !fs.existsSync(repo)) {
    process.stderr.write('memory-verify: falta --project <id> registrado o --repo <ruta>\n');
    return 2;
  }
  const memoryDir = argValue(argv, '--memory') || memoryDirFor(repo);
  if (!fs.existsSync(memoryDir)) {
    process.stderr.write(`memory-verify: no existe ${memoryDir}\n`);
    return 2;
  }
  const report = { project: project || null, repo, memory_dir: memoryDir, checked_at: new Date().toISOString(), ...verify({ repo, memoryDir }) };
  if (project) {
    const out = path.join(ultronRoot(), 'cockpit', 'projects', project, 'memory-stale.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
    fs.renameSync(tmp, out);
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`memorias comprobadas: ${report.checked}; con referencias que ya no existen: ${report.stale.length}\n`);
    for (const s of report.stale) process.stdout.write(`  ${s.file}: ${s.refs.map((r) => `${r.kind} ${r.value}`).join(', ')}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`memory-verify: ${e.message}\n`);
    process.exitCode = 2;
  }
}
