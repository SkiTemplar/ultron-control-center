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
const { runCli, projectIdFromCwd, daemonRequest, spawnDetached } = require('./lib/ultron-memory-cli');

// Hot path budget for the resident daemon (E5 warm -> sub-second). The one-shot
// spawn fallback keeps the wider colchon for cold-hit E5 (see runCli call below).
const DAEMON_TIMEOUT_MS = 3000;

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
  // cat13.4 (2026-06-19): cuando el routing propone un GRUPO (workflow multi-paso),
  // cada paso/agente lleva su PROPIO encuadre derivado del sub-intent de su rol —
  // no solo el encuadre global del turno. Esto cierra "optimiza el prompt del paso".
  if (Array.isArray(ctx.step_plans) && ctx.step_plans.length > 1) {
    out.push('step_plans (encuadre optimizado por paso del grupo):');
    for (const sp of ctx.step_plans.slice(0, 6)) {
      const frame = String(sp.frame || '');
      const short = frame.length > 90 ? frame.slice(0, 90) + '…' : frame;
      out.push(`  - ${sp.agent} [${sp.sub_intent}]: ${short}`);
    }
  }
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
  // cat13 (2026-06-10): paso de mejora de prompt del sidecar. Solo el ENCUADRE
  // y el modo (el prompt literal ya esta en el turno del usuario — no se
  // duplica para no gastar tokens). Las preguntas solo si el prompt era vago.
  const plan = ctx.prompt_plan;
  if (plan && typeof plan === 'object') {
    if (plan.suggested_mode) out.push(`suggested_mode: ${plan.suggested_mode}`);
    const frame = String(plan.improved_prompt || '');
    const idx = frame.indexOf('[encuadre');
    if (idx >= 0) out.push(`prompt_frame: ${frame.slice(idx)}`);
    if (Array.isArray(plan.clarifying_questions) && plan.clarifying_questions.length) {
      out.push(`clarify_first: ${plan.clarifying_questions.join(' | ')}`);
    }
    if (Array.isArray(plan.success_criteria) && plan.success_criteria.length) {
      out.push(`success_criteria: ${plan.success_criteria.join(' | ')}`);
    }
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
      step_plans: (Array.isArray(ctx.step_plans) ? ctx.step_plans : [])
        .slice(0, 6)
        .map((sp) => ({ agent: sp.agent, sub_intent: sp.sub_intent })),
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

async function main() {
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

  // FAST PATH: ask the resident daemon (E5 warm) over TCP loopback. Drops the
  // hot path from ~3.5s (cold model load every spawn) to sub-second.
  let ctx = await daemonRequest(
    { cmd: 'orchestrate', prompt, project: project || undefined },
    DAEMON_TIMEOUT_MS
  );
  if (ctx && ctx.error) ctx = null; // daemon answered but failed -> fall back

  if (!ctx) {
    // No daemon (cold session / it died): spawn one for the NEXT prompt
    // (idempotent — exits at once if a live one already answers), and serve THIS
    // turn from a one-shot process (cold E5 ~3.5s, correct, fail-safe).
    spawnDetached(['serve']);
    const args = ['orchestrate', prompt];
    if (project) args.push('--project', project);
    ctx = runCli(args, { timeoutMs: 11000 }); // colchon cold-hit E5 del proceso one-shot
  }
  if (!ctx) {
    emit('');
    return;
  }
  logOrchestration(ctx, prompt, project, sessionId);
  emit(render(ctx));
}

main()
  .catch(() => {
    try { emit(''); } catch { /* ignore */ }
  })
  .finally(() => {
    process.exitCode = 0;
  });
