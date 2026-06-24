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
  const ctx = additionalContext || '';
  // Pilar 1: contabiliza lo que este hook inyecta al CLI (antes a ciegas).
  try { require('./lib/token-meter').meterInjection('memory-session-resume', ctx); } catch {}
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ctx,
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

// Contexto del proyecto ACTUAL (peticion 2026-06-22: NO un overview de todos los
// proyectos al arrancar, sino que el sistema sepa de ESTE proyecto cuando se
// trabaja en el). El Stop hook (stop-compress) acumula en
// cockpit/projects/<p>/context.md "que es este proyecto y en que se trabaja";
// aqui inyectamos SOLO el del proyecto actual. Bounded + fail-safe.
const PROJECTS_DIR = path.join(os.homedir(), '.ultron', 'cockpit', 'projects');
const CONTEXT_MAX_CHARS = 1200;

function readProjectContext(projectId) {
  if (!projectId) return '';
  try {
    const raw = fs.readFileSync(path.join(PROJECTS_DIR, projectId, 'context.md'), 'utf8').trim();
    if (!raw) return '';
    return raw.length > CONTEXT_MAX_CHARS ? raw.slice(0, CONTEXT_MAX_CHARS) + '\n[...]' : raw;
  } catch {
    return ''; // sin context.md / ilegible -> nada que inyectar (fail-safe)
  }
}

// Dedupe + cap de las lineas de project_context. El Stop hook acumula en
// context.md frases casi identicas ("ULTRON es Rust+Tauri" x6); inyectarlas todas
// es ruido. Defensa en el punto de inyeccion (la captura duplicada se trata aparte).
const CONTEXT_MAX_LINES = 6;
const JACCARD_DUP = 0.5;

function normCtx(s) {
  return String(s)
    .toLowerCase()
    .replace(/[`*#_~]/g, '')
    .replace(/[/,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardCtx(a, b) {
  const A = new Set(normCtx(a).split(' ').filter(Boolean));
  const B = new Set(normCtx(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Lineas unicas (sin near-duplicados) de project_context, capadas a maxLines.
function dedupeContextLines(text, maxLines = CONTEXT_MAX_LINES) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  const kept = [];
  for (const line of lines) {
    if (kept.some((k) => normCtx(k) === normCtx(line) || jaccardCtx(k, line) > JACCARD_DUP)) continue;
    kept.push(line);
    if (kept.length >= maxLines) break;
  }
  return kept;
}

function render(r, projectContext) {
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
  if (projectContext) {
    const ctxLines = dedupeContextLines(projectContext);
    if (ctxLines.length) {
      out.push('project_context (que es este proyecto / en que andas — captura automatica):');
      for (const line of ctxLines) out.push(`  - ${line}`);
    }
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
  // Contexto del proyecto actual (independiente del sidecar: se inyecta aunque
  // el resume Rust falle).
  const projectContext = readProjectContext(project);
  if (!resume && !projectContext) {
    emit(l0);
    return;
  }
  emit(render(resume, projectContext) + l0);
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
  module.exports = { readL0Scratch, readProjectContext, render, dedupeContextLines, L0_SCRATCH, L0_MAX_AGE_MS, L0_MAX_CHARS };
}
