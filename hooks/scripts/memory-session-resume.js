#!/usr/bin/env node
// hooks/scripts/memory-session-resume.js — SessionStart hook.
//
// Loads a MINIMAL bounded resume (active workflows, open tasks, recent
// decisions, pinned, next action) from the canonical store via the
// `ultron-memory resume` sidecar, and injects it as additionalContext.
// FAIL-SAFE: emits empty context (never breaks the session) if the binary is
// missing or anything fails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli, projectIdFromCwd } = require('./lib/ultron-memory-cli');
const { observe, logHookError } = require('./lib/hook-obs');
observe('memory-session-resume');

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: additionalContext || '',
      },
    })
  );
}

// cat17.2 (mandamiento #12): precompact-preserve-l0.js deja el estado de trabajo
// L0 en ~/.ultron/.tmp/context.md antes de una compactacion, pero hasta ahora
// NADIE lo leia (el dato se escribia y se abandonaba). Aqui lo re-leemos en
// SessionStart y lo inyectamos como contexto, para que el scratch preservado se
// USE tras compactar. Bounded (<=2KB) + fail-safe + gate de frescura (<24h) para
// no re-inyectar un scratch viejo en sesiones nuevas no relacionadas.
const L0_SCRATCH = path.join(os.homedir(), '.ultron', '.tmp', 'context.md');
const L0_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const L0_MAX_CHARS = 2000;

function readL0Scratch() {
  try {
    const st = fs.statSync(L0_SCRATCH);
    if (Date.now() - st.mtimeMs > L0_MAX_AGE_MS) return ''; // stale -> ignora
    const raw = fs.readFileSync(L0_SCRATCH, 'utf8').trim();
    if (!raw) return '';
    const clipped = raw.length > L0_MAX_CHARS ? raw.slice(0, L0_MAX_CHARS) + '\n[...]' : raw;
    return '\n<l0-scratch source="precompact" trust="system">\n' + clipped + '\n</l0-scratch>';
  } catch {
    return ''; // no scratch / no leible -> nada que inyectar
  }
}

// Perfil de proyectos del usuario (2026-06-22): el resume no debe ser solo
// decisiones tecnicas, tambien "en que anda" en sus proyectos activos.
// El dato YA existe en cockpit/projects/<p>/kanban.json (mandamiento #12: tener
// el dato != usarlo); aqui lo derivamos y lo inyectamos. Sin tocar el sidecar
// Rust: lo construimos en JS desde los kanban locales. Bounded + fail-safe.
const PROJECTS_DIR = path.join(os.homedir(), '.ultron', 'cockpit', 'projects');
const PROJECTS_MAX = 6;

function readProjectsOverview() {
  try {
    const entries = fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '__home' && !e.name.startsWith('.'));
    const projects = [];
    for (const e of entries) {
      const kpath = path.join(PROJECTS_DIR, e.name, 'kanban.json');
      let st;
      let board;
      try {
        st = fs.statSync(kpath);
        board = JSON.parse(fs.readFileSync(kpath, 'utf8'));
      } catch {
        continue; // sin kanban o ilegible -> fuera
      }
      const roleOf = {};
      for (const c of board.columns || []) roleOf[c.id] = c.role;
      const cards = Array.isArray(board.cards) ? board.cards : [];
      const active = cards.filter((c) => roleOf[c.column_id] === 'todo' || roleOf[c.column_id] === 'doing');
      if (!active.length) continue; // sin trabajo activo -> no es relevante ahora
      const doing = cards.find((c) => roleOf[c.column_id] === 'doing');
      const focus = ((doing || active[0]).title || '').slice(0, 90);
      projects.push({ name: e.name, mtime: st.mtimeMs, count: active.length, focus });
    }
    projects.sort((a, b) => b.mtime - a.mtime);
    return projects.slice(0, PROJECTS_MAX);
  } catch {
    return []; // cualquier fallo -> no inyectar (fail-safe)
  }
}

function render(r, projects) {
  const out = ['<ultron-memory-resume source="system" trust="system">'];
  r = r || {};
  if (r.project_id) out.push(`project: ${r.project_id}`);
  if (Array.isArray(r.active_workflows) && r.active_workflows.length) {
    out.push(`active_workflows: ${r.active_workflows.map((w) => w.workflow_id).join(', ')}`);
  }
  if (Array.isArray(r.open_tasks) && r.open_tasks.length) {
    out.push('open_tasks:');
    for (const t of r.open_tasks.slice(0, 8)) out.push(`  - ${t.summary || ''}`);
  }
  if (Array.isArray(r.decisions) && r.decisions.length) {
    out.push('recent_decisions:');
    for (const d of r.decisions.slice(0, 5)) out.push(`  - ${d.summary || ''}`);
  }
  if (Array.isArray(r.pinned) && r.pinned.length) {
    out.push('pinned_memories:');
    for (const p of r.pinned.slice(0, 8)) out.push(`  - ${p.summary || ''}`);
  }
  if (r.next_action) out.push(`next_action: ${r.next_action}`);
  if (Array.isArray(r.warnings) && r.warnings.length) out.push(`warnings: ${r.warnings.join('; ')}`);
  if (Array.isArray(projects) && projects.length) {
    out.push('your_projects (en que andas, por actividad reciente):');
    for (const p of projects) out.push(`  - ${p.name} [${p.count} activas]: ${p.focus}`);
  }
  out.push('</ultron-memory-resume>');
  return out.join('\n');
}

function main() {
  let cwd = process.cwd();
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const inp = JSON.parse(raw || '{}');
    if (inp.cwd) cwd = inp.cwd;
  } catch {
    /* no stdin / bad json — use process cwd */
  }
  const project = projectIdFromCwd(cwd);
  const resume = runCli(
    project ? ['resume', '--project', project] : ['resume'],
    { timeoutMs: 11000 } // colchon para cold-hit E5 post-warmup; bajar a 3000 con daemon serve
  );
  // cat17.2: inyecta tambien el scratch L0 preservado en la ultima compactacion
  // (aunque no haya resume del sidecar).
  const l0 = readL0Scratch();
  // Perfil de proyectos del usuario (independiente del sidecar: se inyecta aunque
  // el resume Rust falle).
  const projects = readProjectsOverview();
  if (!resume && !projects.length) {
    emit(l0);
    return;
  }
  emit(render(resume, projects) + l0);
}

// Exporta readL0Scratch para tests. El bloque main() solo corre cuando el script
// se invoca directamente (como hook), nunca cuando se importa via require().
if (require.main === module) {
  try {
    main();
  } catch (e) {
    logHookError('memory-session-resume', e);
    try { emit(''); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = { readL0Scratch, readProjectsOverview, render, L0_SCRATCH, L0_MAX_AGE_MS, L0_MAX_CHARS };
}
