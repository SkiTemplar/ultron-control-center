#!/usr/bin/env node
// hooks/scripts/project-card.js — SessionStart hook ("ficha de proyecto").
//
// When a session opens inside a known project, inject a compact, cached "project
// card" (purpose + architecture + where things live), so the assistant knows the
// project WITHOUT searching. The card is precomputed to disk
// (cockpit/project-cards/<slug>.txt) from the canonical memory, so this hook is a
// fast file read — no binary spawn, no E5 warmup, no timeout risk. Runs ONCE per
// session. FAIL-SAFE: emits empty context if the cwd maps to no card or anything
// throws. Regenerate cards via cockpit/memory-ingest (re-run extraction + cards).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectIdFromCwd } = require('./lib/ultron-memory-cli');

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

function main() {
  let cwd = process.cwd();
  try {
    const inp = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    if (inp.cwd) cwd = inp.cwd;
  } catch {
    /* no stdin / bad json */
  }

  const project = projectIdFromCwd(cwd);
  if (!project) {
    emit('');
    return;
  }
  const slug = project.toLowerCase().replace(/[^a-z0-9]/g, '');
  const card = path.join(
    os.homedir(),
    '.ultron',
    'cockpit',
    'project-cards',
    `${slug}.txt`
  );

  let txt = '';
  try {
    txt = fs.readFileSync(card, 'utf8');
  } catch {
    emit(''); // no card for this project — stay silent
    return;
  }
  emit(txt.trim());
}

try {
  main();
} catch (e) {
  logHookError('project-card', e);
  try {
    emit('');
  } catch {
    /* ignore */
  }
}
process.exitCode = 0;
