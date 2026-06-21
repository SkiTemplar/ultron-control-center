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

// Best-effort: registra el error del catch top-level a un log JSONL, sin romper
// el fail-open (envuelto en su propio try/catch; nunca lanza).
function logHookError(hook, e) {
  try {
    const dir = path.join(os.homedir(), '.ultron', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'hook-errors.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        hook,
        error: String(e),
        stack: e && e.stack,
      }) + '\n'
    );
  } catch {
    /* best-effort: si el log falla, seguimos fail-open */
  }
}

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

function render(r) {
  const out = ['<ultron-memory-resume source="system" trust="system">'];
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
  if (!resume) {
    emit(l0);
    return;
  }
  emit(render(resume) + l0);
}

try {
  main();
} catch (e) {
  logHookError('memory-session-resume', e);
  try { emit(''); } catch { /* ignore */ }
}
process.exitCode = 0;
