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
const { runCli, projectIdFromCwd, daemonRequest, spawnDetached, findBinary } = require('./lib/ultron-memory-cli');
const { appendJsonl } = require('./lib/jsonl-log');
const { observe, logHookError } = require('./lib/hook-obs');
const { isSystemTurnPrompt } = require('./lib/system-turn');
observe('memory-orchestrate');

// Hot path budget for the resident daemon (E5 warm -> sub-second). The one-shot
// spawn fallback keeps the wider colchon for cold-hit E5 (see runCli call below).
const DAEMON_TIMEOUT_MS = 3000;
// Check 1.5 (2026-07-22): con pack cacheado FRESCO del proyecto, el peor caso
// del hook queda ~1200 (daemon) + 800 (one-shot cap) + overhead < 3000ms POR
// CONSTRUCCION. Sin cache fresco se mantiene el colchon completo de 3000ms
// porque no hay red de seguridad si el daemon tarda.
const DAEMON_TIMEOUT_CACHED_MS = 1200;

// HOOKS-04 (auditoria 2026-07-16, decidido por el usuario 2026-07-17): cap del
// fallback one-shot + pack cacheado. Medido: daemon HIT p50=562ms, MISS
// p50=4145ms (35% de prompts). Con cache fresco del proyecto, el one-shot solo
// tiene 800ms de gracia y despues se sirve el pack cacheado (marcado stale);
// sin cache, colchon de 6s (mitad del 11s historico) porque no hay red de
// seguridad. SessionStart ademas precalienta el daemon (memory-session-resume).
const ONE_SHOT_CAP_CACHED_MS = 800;
const ONE_SHOT_CAP_UNCACHED_MS = 6000;
const ORCH_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

function orchCachePath(project) {
  const safe = String(project || 'default').replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(os.homedir(), '.ultron', '.tmp', `orch-cache-${safe}.json`);
}

function readOrchCache(project) {
  try {
    const p = orchCachePath(project);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > ORCH_CACHE_MAX_AGE_MS) return null;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && obj.ctx ? obj.ctx : null;
  } catch {
    return null;
  }
}

function writeOrchCache(project, ctx) {
  try {
    // MEM-AUD-07: write-then-rename (atomico en el mismo volumen) — un lector
    // concurrente nunca ve el JSON a medio escribir.
    const p = orchCachePath(project);
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ctx }));
    fs.renameSync(tmp, p);
  } catch {
    /* cache best-effort — nunca bloquea el prompt */
  }
}

// Live Session Monitor feed: persiste cada orquestacion para que la UI de
// ULTRON muestre EN VIVO que skills/agentes/memorias propuso el orquestador
// para la sesion activa. Append-only JSONL; fail-safe (nunca bloquea el prompt).
const ORCH_LOG = path.join(os.homedir(), '.claude', 'logs', 'orchestrate.jsonl');

function emit(additionalContext) {
  const ctx = additionalContext || '';
  // Pilar 1: contabiliza lo que este hook inyecta al CLI (antes a ciegas).
  try { require('./lib/token-meter').meterInjection('memory-orchestrate', ctx); } catch {}
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ctx,
      },
    })
  );
}

function render(ctx) {
  const out = [`<orchestration-context route="${ctx.route || ''}" trust="system">`];
  // Personalities v1 (2026-08-13): tono detectado por el sidecar (señales del
  // chat o petición explícita). Se emite ANTES que el resto: es una orden de
  // registro para TODA la respuesta, no una sugerencia de routing.
  if (ctx.tone && ctx.tone.id) {
    const t = ctx.tone;
    out.push(`tone_detected: ${t.name} [${t.id}] — ${t.reason || ''}`);
    // Feedback del usuario 2026-08-13: "a good chunk of personality, not a
    // couple of words here and there" — la directiva exige compromiso TOTAL,
    // no salpicar slang sobre una respuesta de oficina.
    out.push(
      `tone_directive: LA PERSONALIDAD ES LA VOZ DE TODA LA RESPUESTA — cada frase, ` +
        `la gramatica, el ritmo y la actitud salen en este registro; PROHIBIDO espolvorear ` +
        `dos palabras de slang sobre una respuesta neutra. Los datos tecnicos se mantienen ` +
        `EXACTOS (cambia la voz, nunca el contenido). Idioma: ${t.lang || 'es'}; ` +
        `insultos: ${t.profanity || 'none'}. Guía: ${t.style_guide || ''}`
    );
  }
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
  if (ctx.delegation_directive) {
    // 2026-06-23: delegación automática (plano chat). La directiva SUSTITUYE al
    // advisory: es una ORDEN, no una sugerencia. El agente la ejecuta con Agent().
    const d = ctx.delegation_directive;
    // calidad>tokens (feedback 2026-06-24): el especialista delegado nunca cae a
    // haiku; si el sidecar no sugiere modelo, default de calidad = sonnet.
    const model = d.model_hint || 'sonnet';
    out.push('<orchestration-directive trust="system">');
    out.push('DELEGA AHORA — no hagas este trabajo en el contexto principal.');
    out.push(`agent: ${d.agent}`);
    out.push(`objetivo: ${d.objective || ''}`);
    out.push(`devuelve: ${d.return_format || ''}`);
    out.push(`modelo: ${model}`);
    out.push(`motivo: ${d.reason || ''}`);
    out.push(
      `Accion: usa la herramienta Agent (subagent_type="${d.agent}", model="${model}") con ese ` +
        'objetivo. Si delegar es contraproducente (ya tienes el resultado, o la tarea resulto ' +
        'trivial), dilo en UNA linea y hazlo inline — nunca ignores la directiva en silencio.'
    );
    out.push('</orchestration-directive>');
  } else if (Array.isArray(ctx.delegate_agents) && ctx.delegate_agents.length) {
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

function buildLogEntry(ctx, prompt, project, sessionId, elapsedMs, usedDaemon) {
  return {
    ts: new Date().toISOString(),
    // cat15.1: latencia de la orquestacion (hot path UserPromptSubmit) para el
    // LiveSessionMonitor y para diagnosticar la latencia del prompt.
    elapsed_ms: typeof elapsedMs === 'number' ? elapsedMs : null,
    // cat9.4: traza si el hot path uso el daemon TCP (sub-segundo) o el spawn
    // one-shot de fallback (cold E5 ~3.5s). Util para diagnosticar si el daemon
    // murio entre sesiones y cuantos prompts pagaron el coste completo.
    daemon_hit: usedDaemon === true,
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
    // Personalities v1: tono detectado (Live Monitor + telemetría de acierto).
    tone: ctx.tone ? { id: ctx.tone.id, explicit: !!ctx.tone.explicit } : null,
    // 2026-06-23: traza de delegación automática para medir la tasa efectiva
    // (directivas emitidas vs delegaciones realmente ejecutadas por el agente).
    directive_emitted: !!ctx.delegation_directive,
    directive_agent: ctx.delegation_directive ? ctx.delegation_directive.agent : null,
  };
}

function logOrchestration(ctx, prompt, project, sessionId, elapsedMs, usedDaemon) {
  try {
    // cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
    appendJsonl(ORCH_LOG, buildLogEntry(ctx, prompt, project, sessionId, elapsedMs, usedDaemon));
  } catch (_) {
    /* never block the prompt */
  }
}

async function main() {
  const t0 = Date.now();
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
  // Turno de SISTEMA (notificacion de tarea background): no orquestar — rutear
  // su XML como si fuera un prompt humano inyecta skills/memorias sin sentido.
  if (isSystemTurnPrompt(prompt)) {
    emit('');
    return;
  }
  const project = projectIdFromCwd(cwd);

  // Cache leida ANTES del daemon: con pack fresco (<30 min) el presupuesto del
  // daemon baja a DAEMON_TIMEOUT_CACHED_MS — el fallback cacheado garantiza
  // respuesta util aunque el daemon este contendido.
  const cached = readOrchCache(project);

  // FAST PATH: ask the resident daemon (E5 warm) over TCP loopback. Drops the
  // hot path from ~3.5s (cold model load every spawn) to sub-second.
  let ctx = await daemonRequest(
    { cmd: 'orchestrate', prompt, project: project || undefined },
    cached ? DAEMON_TIMEOUT_CACHED_MS : DAEMON_TIMEOUT_MS
  );
  if (ctx && ctx.error) ctx = null; // daemon answered but failed -> fall back
  const usedDaemon = ctx !== null;

  let staleFromCache = false;
  if (!ctx) {
    // No daemon (cold session / it died): spawn one for the NEXT prompt
    // (idempotent — exits at once if a live one already answers), and serve THIS
    // turn from a capped one-shot, with the cached pack as safety net (HOOKS-04).
    spawnDetached(['serve']);
    const args = ['orchestrate', prompt];
    if (project) args.push('--project', project);
    ctx = runCli(args, { timeoutMs: cached ? ONE_SHOT_CAP_CACHED_MS : ONE_SHOT_CAP_UNCACHED_MS });
    if (ctx === null && cached) {
      // Pack del prompt ANTERIOR del mismo proyecto (<30 min): mejor un pack
      // stale marcado que 4-5s de bloqueo o que nada. El route/step_plans
      // pueden no encajar con ESTE prompt — el warning lo deja claro.
      ctx = cached;
      staleFromCache = true;
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push('context pack CACHEADO de un prompt anterior (daemon frio) — route/steps pueden no aplicar a este prompt');
    }
    // cat9 (mandamiento 11: prohibido el no-op silencioso). Si ni el daemon ni el
    // spawn one-shot devolvieron orquestacion, es FALLO real del sidecar (no hay
    // "vacio legitimo" aqui: un prompt no vacio sano siempre produce un objeto de
    // ruta). Deja rastro accionable ADEMAS del fail-safe emit('') de abajo.
    if (ctx === null) {
      const reason = findBinary()
        ? 'sidecar orchestrate FALLO (binario presente pero status!=0 / timeout / JSON no parseable)'
        : 'sidecar orchestrate FALLO (binario ultron-memory ausente: no instalado / ULTRON_MEMORY_BIN invalido)';
      logHookError('memory-orchestrate', reason);
    }
  }
  if (!ctx) {
    // Aviso visible al modelo (mismo patron que el resume degradado): sin esto el
    // fallo era 100% silencioso y el usuario no podia saber que la memoria no aporto.
    emit(
      '[memoria degradada] orchestrate sin respuesta (daemon/Qdrant caido o timeout) — ' +
        'este prompt va SIN recall de memoria. Si se repite, revisar: bin/ultron-memory.exe doctor'
    );
    return;
  }
  if (!staleFromCache) {
    writeOrchCache(project, ctx);
    // Solo orquestaciones FRESCAS al Live Session Monitor — un pack cacheado
    // re-loggeado duplicaria la entrada original con datos de otro prompt.
    logOrchestration(ctx, prompt, project, sessionId, Date.now() - t0, usedDaemon);
  }
  emit(render(ctx));
}

if (require.main === module) {
  main()
    .catch((e) => {
      // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
      try {
        appendJsonl(path.join(os.homedir(), '.ultron', 'logs', 'hook-errors.jsonl'), {
          hook: 'memory-orchestrate',
          error: String((e && e.message) || e),
        });
      } catch { /* ignore */ }
      try { emit(''); } catch { /* ignore */ }
    })
    .finally(() => {
      process.exitCode = 0;
    });
} else {
  // Exportadas para test (patrón require.main, como en stop-compress-session.js).
  module.exports = { render, logOrchestration, buildLogEntry };
}
