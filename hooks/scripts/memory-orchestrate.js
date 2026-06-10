#!/usr/bin/env node
// hooks/scripts/memory-orchestrate.js — UserPromptSubmit hook ("Ultron" auto-route).
//
// Routes the prompt through the canonical orchestrator (`ultron-memory
// orchestrate`): intent -> workflow -> specialist agents to DELEGATE to ->
// relevant memories, injected as additionalContext. FAIL-SAFE: emits empty
// context (never blocks the prompt) if the binary is missing or anything fails.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCli, projectIdFromCwd } = require('./lib/ultron-memory-cli');

// Live Session Monitor feed: persiste cada orquestacion para que la UI de
// ULTRON muestre EN VIVO que skills/agentes/memorias propuso el orquestador
// para la sesion activa. Append-only JSONL; fail-safe (nunca bloquea el prompt).
const ORCH_LOG = path.join(os.homedir(), '.claude', 'logs', 'orchestrate.jsonl');

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: additionalContext || '',
      },
    })
  );
}

function render(ctx) {
  const out = [`<orchestration-context route="${ctx.route || ''}" trust="system">`];
  if (ctx.workflow) out.push(`workflow: ${ctx.workflow.id} — ${ctx.workflow.label}`);
  if (Array.isArray(ctx.delegate_agents) && ctx.delegate_agents.length) {
    out.push('delegate_to (specialist agents, by similarity):');
    for (const a of ctx.delegate_agents.slice(0, 4)) {
      out.push(`  - ${a.name} (${Number(a.score || 0).toFixed(2)})`);
    }
  }
  if (Array.isArray(ctx.delegate_skills) && ctx.delegate_skills.length) {
    out.push('consider_skills (by similarity):');
    for (const s of ctx.delegate_skills.slice(0, 4)) {
      const k = s.kind ? `, ${s.kind}` : '';
      out.push(`  - ${s.name} (${Number(s.score || 0).toFixed(2)}${k})`);
    }
  }
  if (Array.isArray(ctx.memories) && ctx.memories.length) {
    out.push('relevant_memories:');
    for (const m of ctx.memories.slice(0, 12)) out.push(`  - [${m.scope || ''}] ${m.summary || ''}`);
  }
  if (Array.isArray(ctx.constraints) && ctx.constraints.length) {
    out.push(`constraints: ${ctx.constraints.join(' | ')}`);
  }
  if (Array.isArray(ctx.warnings) && ctx.warnings.length) {
    out.push(`warnings: ${ctx.warnings.join('; ')}`);
  }
  out.push('</orchestration-context>');
  return out.join('\n');
}

function logOrchestration(ctx, prompt, project, sessionId) {
  try {
    fs.mkdirSync(path.dirname(ORCH_LOG), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      session_id: sessionId || null,
      project: project || null,
      prompt: String(prompt || '').slice(0, 280),
      route: ctx.route || null,
      workflow: ctx.workflow ? { id: ctx.workflow.id, label: ctx.workflow.label } : null,
      agents: (Array.isArray(ctx.delegate_agents) ? ctx.delegate_agents : [])
        .slice(0, 6)
        .map((a) => ({ name: a.name, score: Number(a.score || 0) })),
      skills: (Array.isArray(ctx.delegate_skills) ? ctx.delegate_skills : [])
        .slice(0, 6)
        .map((s) => ({ name: s.name, kind: s.kind || '', score: Number(s.score || 0) })),
      memories: (Array.isArray(ctx.memories) ? ctx.memories : [])
        .slice(0, 8)
        .map((m) => ({ scope: m.scope || '', summary: String(m.summary || '').slice(0, 160) })),
      cross_project: !!ctx.cross_project,
      warnings: Array.isArray(ctx.warnings) ? ctx.warnings : [],
    };
    fs.appendFileSync(ORCH_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    /* never block the prompt */
  }
}

function main() {
  let prompt = '';
  let cwd = process.cwd();
  let sessionId = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const inp = JSON.parse(raw || '{}');
    prompt = inp.prompt || '';
    if (inp.cwd) cwd = inp.cwd;
    sessionId = inp.session_id || inp.sessionId || null;
  } catch {
    /* no stdin / bad json */
  }
  if (!prompt.trim()) {
    emit('');
    return;
  }
  const project = projectIdFromCwd(cwd);
  const args = ['orchestrate', prompt];
  if (project) {
    args.push('--project', project);
  }
  const ctx = runCli(args, { timeoutMs: 11000 }); // colchon cold-hit E5; bajar a 3000 con daemon serve
  if (!ctx) {
    emit('');
    return;
  }
  logOrchestration(ctx, prompt, project, sessionId);
  emit(render(ctx));
}

try {
  main();
} catch {
  try { emit(''); } catch { /* ignore */ }
}
process.exitCode = 0;
