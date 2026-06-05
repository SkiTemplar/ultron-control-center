#!/usr/bin/env node
// hooks/scripts/memory-orchestrate.js — UserPromptSubmit hook ("Ultron" auto-route).
//
// Routes the prompt through the canonical orchestrator (`ultron-memory
// orchestrate`): intent -> workflow -> specialist agents to DELEGATE to ->
// relevant memories, injected as additionalContext. FAIL-SAFE: emits empty
// context (never blocks the prompt) if the binary is missing or anything fails.

const fs = require('fs');
const { runCli, projectIdFromCwd } = require('./lib/ultron-memory-cli');

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

function main() {
  let prompt = '';
  let cwd = process.cwd();
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const inp = JSON.parse(raw || '{}');
    prompt = inp.prompt || '';
    if (inp.cwd) cwd = inp.cwd;
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
  const ctx = runCli(args);
  if (!ctx) {
    emit('');
    return;
  }
  emit(render(ctx));
}

try {
  main();
} catch {
  try { emit(''); } catch { /* ignore */ }
}
process.exitCode = 0;
