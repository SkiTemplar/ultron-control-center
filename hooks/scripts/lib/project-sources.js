'use strict';

/**
 * project-sources.js — lo que se sabe de un proyecto mirando su repositorio y
 * el cockpit, como texto acotado para el destilador de perfiles (ULTRON 4 F1.4).
 *
 * Fuentes, en orden de fiabilidad:
 *   1. Registro del Control Center (`cockpit/projects.json`): nombre, tags.
 *   2. Cabecera de CLAUDE.md / README (describen el proyecto mejor que nada).
 *   3. Manifiestos (package.json, Cargo.toml, pyproject, .uproject…): el stack.
 *   4. Kanban del proyecto: en qué se trabaja y qué está bloqueado.
 *   5. Git: rama, HEAD y últimos commits.
 *
 * Todo es best-effort y acotado: una fuente ausente se omite, nunca lanza.
 * No lee memoria: eso lo hace el daemon, que tiene el store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DOC_HEAD_CHARS = 1500;
const DOC_FILES = ['CLAUDE.md', 'README.md', 'README', 'readme.md', 'Readme.md'];
const MANIFEST_PRESENCE = ['go.mod', 'pom.xml', 'build.gradle', 'CMakeLists.txt', 'Gemfile', 'composer.json', 'requirements.txt'];
const KANBAN_TOP = 5;
const COMMITS = 6;
const GIT_TIMEOUT_MS = 2500;
const STACK_HINTS = ['next', 'react', 'vue', 'svelte', 'angular', 'tailwindcss', '@supabase/supabase-js', 'express', 'fastify', 'electron', '@tauri-apps/api', 'vite', 'vitest', 'jest', 'playwright', 'prisma', 'drizzle-orm', 'three'];
const MAX_HINTS = 8;
const PARAGRAPH_MAX_CHARS = 400;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function head(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max) + '\n[...]' : t;
}

/** Cabeceras de los documentos que describen el proyecto (sin repetir nombre). */
function docHeads(cwd) {
  const out = [];
  const seen = new Set();
  for (const name of DOC_FILES) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const text = readText(path.join(cwd, name));
    if (!text.trim()) continue;
    seen.add(key);
    out.push({ name, text: head(text, DOC_HEAD_CHARS) });
  }
  return out;
}

/** Primer párrafo de prosa de un documento markdown (sin cabeceras ni listas). */
function firstParagraph(text) {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  for (const b of blocks) {
    if (/^(#|[-*]\s|\||```|<|>|!\[)/.test(b)) continue;
    const plano = b.replace(/\s+/g, ' ').replace(/[*_`]/g, '').trim();
    if (plano.length < 20) continue;
    return plano.length > PARAGRAPH_MAX_CHARS ? plano.slice(0, PARAGRAPH_MAX_CHARS - 1) + '…' : plano;
  }
  return '';
}

function tomlSection(text, section) {
  const re = new RegExp(`^\\[${section.replace('.', '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|\\Z)`, 'm');
  const m = String(text || '').match(re);
  return m ? m[1] : '';
}

function tomlValue(block, key) {
  const m = String(block || '').match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : '';
}

/** Resumen de manifiestos: una línea por manifiesto encontrado. */
function manifestSummary(cwd) {
  const lines = [];
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg && typeof pkg === 'object') {
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    const hints = STACK_HINTS.filter((h) => deps.includes(h)).slice(0, MAX_HINTS);
    const parts = [`package.json: name=${pkg.name || '?'}`];
    if (pkg.description) parts.push(`description=${String(pkg.description).slice(0, 160)}`);
    if (hints.length) parts.push(`deps=${hints.join(', ')}`);
    lines.push(parts.join('; '));
  }
  const cargo = readText(path.join(cwd, 'Cargo.toml'));
  if (cargo.trim()) {
    const pkgBlock = tomlSection(cargo, 'package');
    const parts = ['Cargo.toml'];
    const name = tomlValue(pkgBlock, 'name');
    if (name) parts.push(`name=${name}`);
    const desc = tomlValue(pkgBlock, 'description');
    if (desc) parts.push(`description=${desc.slice(0, 160)}`);
    if (/^\[workspace\]/m.test(cargo)) parts.push('workspace');
    if (/\btauri\b/.test(cargo)) parts.push('tauri');
    lines.push(parts.join('; '));
  }
  const py = readText(path.join(cwd, 'pyproject.toml'));
  if (py.trim()) {
    const proj = tomlSection(py, 'project');
    const parts = ['pyproject.toml'];
    const name = tomlValue(proj, 'name');
    if (name) parts.push(`name=${name}`);
    const desc = tomlValue(proj, 'description');
    if (desc) parts.push(`description=${desc.slice(0, 160)}`);
    lines.push(parts.join('; '));
  }
  let entries = [];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    entries = [];
  }
  // Un .sln junto a un .uproject lo genera Unreal para Visual Studio: no es .NET.
  const hasUproject = entries.some((e) => e.endsWith('.uproject'));
  for (const e of entries) {
    if (e.endsWith('.uproject')) {
      const up = readJson(path.join(cwd, e));
      const engine = up && up.EngineAssociation ? ` (Unreal Engine ${up.EngineAssociation})` : ' (Unreal Engine)';
      const modules = up && Array.isArray(up.Modules) ? up.Modules.map((m) => m.Name).filter(Boolean).slice(0, 4) : [];
      lines.push(`${e}${engine}${modules.length ? `; modules=${modules.join(', ')}` : ''}`);
    } else if (e.endsWith('.csproj') || (e.endsWith('.sln') && !hasUproject)) {
      lines.push(`${e} (.NET)`);
    }
  }
  for (const m of MANIFEST_PRESENCE) {
    if (fs.existsSync(path.join(cwd, m))) lines.push(m);
  }
  return lines;
}

/** Entrada del proyecto en el registro del Control Center. */
function registryEntry(projectId, registryPath) {
  const reg = readJson(registryPath || path.join(os.homedir(), '.ultron', 'cockpit', 'projects.json'));
  const list = reg && Array.isArray(reg.projects) ? reg.projects : [];
  return list.find((p) => p && p.id === projectId) || null;
}

/** Estado del kanban: títulos por columna (role) y cuántas hechas. */
function kanbanSummary(projectsDir, projectId) {
  const doc = readJson(path.join(projectsDir, projectId, 'kanban.json'));
  if (!doc || !Array.isArray(doc.columns) || !Array.isArray(doc.cards)) return null;
  const roleOf = new Map(doc.columns.map((c) => [c.id, c.role]));
  const byRole = { doing: [], todo: [], blocked: [], done: 0 };
  for (const card of doc.cards) {
    const role = roleOf.get(card.column_id || card.columnId || card.column);
    const title = String(card.title || '').trim();
    if (role === 'done') byRole.done += 1;
    else if (role && byRole[role] && title) byRole[role].push(title);
  }
  return byRole;
}

/** Rama, SHA corto y últimos asuntos de commit. Null si no es un repo. */
function gitSummary(cwd) {
  const o = { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], o).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], o).trim();
    if (!sha) return null;
    const subjects = execFileSync('git', ['log', `-${COMMITS}`, '--pretty=%s'], o)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { branch, sha, subjects };
  } catch {
    return null;
  }
}

function kanbanText(k) {
  if (!k) return '';
  const parts = [];
  if (k.doing.length) parts.push(`In Progress: ${k.doing.slice(0, KANBAN_TOP).join(' | ')}`);
  if (k.todo.length) parts.push(`Backlog (primeras): ${k.todo.slice(0, KANBAN_TOP).join(' | ')}`);
  if (k.blocked.length) parts.push(`Blocked: ${k.blocked.slice(0, KANBAN_TOP).join(' | ')}`);
  parts.push(`Done: ${k.done}`);
  return parts.join('\n');
}

/**
 * Reúne todas las fuentes. Devuelve `{ head, text, docs, manifests, kanban, registry }`:
 * `text` es lo que viaja al daemon; el resto sirve al perfil determinista.
 */
function gatherSources(cwd, projectId, opts = {}) {
  const projectsDir = opts.projectsDir || path.join(os.homedir(), '.ultron', 'cockpit', 'projects');
  const registry = registryEntry(projectId, opts.registryPath);
  const docs = docHeads(cwd);
  const manifests = manifestSummary(cwd);
  const kanban = kanbanSummary(projectsDir, projectId);
  const git = gitSummary(cwd);

  const sections = [];
  if (registry) {
    const parts = [`id: ${registry.id}`];
    if (registry.name) parts.push(`nombre: ${registry.name}`);
    if (Array.isArray(registry.tags) && registry.tags.length) parts.push(`tags: ${registry.tags.join(', ')}`);
    if (registry.description) parts.push(`descripción: ${String(registry.description).slice(0, 300)}`);
    sections.push(`### Registro del Control Center\n${parts.join('\n')}`);
  }
  for (const d of docs) sections.push(`### ${d.name} (cabecera)\n${d.text}`);
  if (manifests.length) sections.push(`### Manifiestos\n${manifests.map((m) => `- ${m}`).join('\n')}`);
  const kt = kanbanText(kanban);
  if (kt) sections.push(`### Kanban\n${kt}`);
  if (git) {
    sections.push(
      `### Git\n${git.branch} @ ${git.sha}\nÚltimos commits:\n${git.subjects.map((s) => `- ${s}`).join('\n')}`
    );
  }
  return {
    head: git ? { branch: git.branch, sha: git.sha } : null,
    text: sections.join('\n\n'),
    docs,
    manifests,
    kanban,
    registry,
  };
}

/**
 * Perfil sin modelo: lo que se puede afirmar leyendo el repo. Es el relevo
 * cuando la cadena de proveedores no responde y no hay perfil previo. Devuelve
 * null si no hay ni una frase que decir.
 */
// Un primer parrafo que habla del documento y no del proyecto ("Instrucciones
// de proyecto para trabajar en este repo…"): tipico de CLAUDE.md.
const META_PARAGRAPH_RE = /^(instrucciones|instructions|normas|reglas|guidelines|este (fichero|archivo|documento)|this (file|document))\b/i;

function perfilDeterminista(sources) {
  // El README describe el proyecto para personas; CLAUDE.md da instrucciones al
  // asistente y su primer parrafo suele ser meta. Se prefiere el README y se
  // salta cualquier parrafo que hable del documento en vez del proyecto.
  const ordered = [...sources.docs].sort((a, b) => {
    const ra = /^readme/i.test(a.name) ? 0 : 1;
    const rb = /^readme/i.test(b.name) ? 0 : 1;
    return ra - rb;
  });
  const queEs = ordered
    .map((d) => firstParagraph(d.text))
    .find((p) => p && !META_PARAGRAPH_RE.test(p)) || '';
  const desc = sources.registry && sources.registry.description ? String(sources.registry.description).trim() : '';
  const stack = sources.manifests.join('; ').slice(0, 300);
  const estado = kanbanText(sources.kanban).replace(/\n/g, '; ').slice(0, PARAGRAPH_MAX_CHARS);
  const que_es = queEs || desc;
  if (!que_es && !stack) return null;
  return { que_es, stack, arquitectura: '', estado, decisiones_clave: [] };
}

module.exports = {
  gatherSources,
  perfilDeterminista,
  firstParagraph,
  manifestSummary,
  kanbanSummary,
  gitSummary,
  docHeads,
  DOC_HEAD_CHARS,
};
