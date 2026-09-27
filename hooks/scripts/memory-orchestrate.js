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
const { runCli, projectIdFromCwd, daemonRequestDetailed, spawnDetached, findBinary, readDaemonLock } = require('./lib/ultron-memory-cli');
const { appendJsonl } = require('./lib/jsonl-log');
const { observe, logHookError } = require('./lib/hook-obs');
const { isSystemTurnPrompt } = require('./lib/system-turn');
const { detectForPrompt, loadPersonality } = require('./lib/tone-detect');
// F-resume (2026-09-11): entrega diferida del resumen de la sesion anterior si
// SessionStart no llego a tiempo (ver lib/session-summary-delivery.js).
const lastSession = require('./lib/last-session');
const sessionSummaryDelivery = require('./lib/session-summary-delivery');
observe('memory-orchestrate');

// POLITICA DE ESPERA AL DAEMON (reescrita 2026-09-27, decidido por el usuario:
// "la latencia da igual; el resultado tiene que salir COMPLETO").
//
// Medido ese dia con 3 sesiones simultaneas x 10 rondas por los hooks reales:
// 27 de 30 prompts con memoria degradada, 92 respuestas "busy" y 92 peticiones
// orchestrate al daemon para 30 prompts. La causa no era el daemon lento sino
// esta politica: plazos cortos (6 s con pack cacheado, 14 s sin el) tratados
// como "daemon muerto", que disparaban HOOKS-07 y REENVIABAN el mismo
// orchestrate a un daemon que ya lo estaba calculando. Cada reenvio anadia
// trabajo a la cola que habia provocado el plazo vencido.
//
// Ahora, con el daemon atendiendo todas las conexiones a la vez y el computo de
// los modelos en un turno FIFO sin descartes (serve/tcp.rs,
// qdrant_inference_gate.rs):
//   - Daemon vivo (conecta): UNA peticion y una espera larga (DAEMON_WAIT_MS).
//     Nunca se reenvia. Si vence, es un cuelgue real -> sparse.
//   - Daemon que responde {error} (no "busy"): sparse directo, sin relanzar.
//   - "busy" (solo un daemon anterior a este cambio lo emite): se reintenta
//     contra el mismo daemon dentro de DAEMON_WAIT_MS.
//   - Daemon muerto (sin lockfile, nadie escucha, o cerro sin responder):
//     relanzar `serve` y esperarle hasta DAEMON_RELAUNCH_WAIT_MS (carga en frio
//     de E5 medida hasta 18,7 s), luego sparse.
// Historial de los plazos anteriores (3 -> 6 -> 9 -> 14 s, cache 1,2 -> 4 -> 6 s,
// primer prompt 15 -> 12 -> 14 s): cada subida perseguia el peor caso bajo
// contencion; con la contencion convertida en cola ordenada ya no hay que
// perseguirlo con plazos, basta con esperar.

// HOOKS-04 (auditoria 2026-07-16): el pack cacheado del proyecto (<30 min) queda
// como ULTIMA red, solo si ni el daemon ni el sparse devuelven nada. Ya no
// acorta la espera al daemon: servir el pack de otro prompt es justo la
// degradacion que se quiere evitar.
const ORCH_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

// HOOKS-06 (2026-08-22): "busy" NO es un daemon caido. Ante "busy" se reintenta
// contra el MISMO daemon y NUNCA se spawnea competencia (una estampida de cargas
// de E5 degrado 5/5 prompts ese dia). El daemon actual ya no lo emite; se
// conserva para convivir con un binario anterior durante el redeploy.
const BUSY_RETRY_POLL_MS = 400;

/** ¿La respuesta es un "busy" del daemon (vivo pero con el lock ocupado)? */
function isDaemonBusy(resp) {
  return Boolean(resp && typeof resp.error === 'string' && resp.error === 'busy');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const FAST_LANE_LOG = path.join(os.homedir(), '.ultron', 'logs', 'fast-lane.jsonl');
const { decide: decideLane, markPrompt, readState: readLaneState } = require('./lib/fast-lane');

// Presupuesto TOTAL del hook: el `timeout` de UserPromptSubmit en
// settings.json (y en su plantilla, hooks/install-hooks.ps1). Si el hook lo
// vence, Claude Code descarta TODA su salida en silencio, asi que cada espera se
// resta de aqui. MISMO numero en los tres sitios.
// (2026-09-27) 26 s -> 90 s: con la contencion convertida en cola, el peor caso
// medido son varias sesiones esperando su turno de CPU, no un daemon roto; el
// plazo tiene que cubrir esa cola en vez de cortarla. Claude Code admite
// timeouts de hook de 60 s o mas.
const HOOK_BUDGET_MS = 90_000;
// Colchon reservado para lo que viene DESPUES de la ultima espera: render,
// token-meter, escritura del cache y del log, mas el arranque de node. El hook
// tiene que terminar por debajo del presupuesto, no rozarlo.
const SAFETY_MARGIN_MS = 1_500;

// Respaldo cuando el daemon no ha contestado: `orchestrate --sparse` (FTS5 +
// reglas, sin E5, sin volver a esperar al daemon). El cap es DINAMICO entre
// estos dos limites (2026-09-10): el sparse tarda 626 ms aislado en frio, pero
// ~3,1 s compitiendo por CPU con un daemon recien relanzado cargando E5.
const SPARSE_MIN_CAP_MS = 3_000;
const SPARSE_MAX_CAP_MS = 6_000;

// Espera UNICA a un daemon vivo: todo el presupuesto menos el sparse maximo y
// el colchon (82,5 s). Solo un cuelgue real la agota.
const DAEMON_WAIT_MS = HOOK_BUDGET_MS - SPARSE_MAX_CAP_MS - SAFETY_MARGIN_MS;

// HOOKS-07 (2026-09-10): recuperacion del daemon MUERTO. Sin daemon, el hook
// lanzaba `serve` y caia YA al sparse, que competia con la carga de E5 del
// daemon nuevo y vencia su cap: tres prompts seguidos con "[memoria degradada]".
// Ahora el turno ESPERA al daemon nuevo hasta DAEMON_RELAUNCH_WAIT_MS desde el
// relanzamiento, y nunca mas alla de DAEMON_RELAUNCH_DEADLINE_MS desde t0 (que
// reserva sitio para el sparse).
const DAEMON_RELAUNCH_WAIT_MS = 30_000;
const DAEMON_RELAUNCH_DEADLINE_MS = HOOK_BUDGET_MS - SPARSE_MIN_CAP_MS - SAFETY_MARGIN_MS;
// Sondeo del lockfile mientras el daemon relanzado arranca.
const DAEMON_BOOT_POLL_MS = 1_500;
// Sonda minima contra el daemon nuevo: por debajo de 1 s no le da tiempo ni a
// aceptar la conexion, asi que no se lanza una sonda mas corta que esto.
const DAEMON_RELAUNCH_MIN_PROBE_MS = 1_000;

/** Motivos de daemonRequestDetailed que significan "no hay daemon que escuche". */
function daemonIsDown(reason) {
  return reason === 'no_lock' || reason === 'connect' || reason === 'closed';
}

/** Rastro de un prompt servido por el carril rapido (sin orchestrate). */
function logFastLane({ sessionId, project, prompt, lane, elapsedMs }) {
  try {
    appendJsonl(FAST_LANE_LOG, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      project,
      prompt: String(prompt).slice(0, 120),
      class: lane.class,
      reason: lane.reason,
      elapsed_ms: elapsedMs,
    });
  } catch {
    /* rastro best-effort */
  }
}

// F-resume: bloque del resumen de la sesion anterior, resuelto UNA vez por
// sesion en main() ANTES de cualquier salida temprana. Vive fuera de emit()
// para que TODO camino de salida de este hook (fast-lane, turno de sistema,
// prompt vacio, degradado, normal) lo entregue por igual — es el unico punto
// por el que pasan todas las llamadas a emit(), asi que ningun early-return
// puede tragarselo en silencio.
let pendingDeliveryBlock = '';

function emit(additionalContext) {
  const prefix = pendingDeliveryBlock ? pendingDeliveryBlock + '\n' : '';
  const ctx = prefix + (additionalContext || '');
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

// Personalities v1 (2026-08-13): lineas de tono. Se emiten ANTES que el resto:
// son una orden de registro para TODA la respuesta, no una sugerencia de routing.
// Viven fuera de render() porque el camino de memoria DEGRADADA (sin contexto)
// tambien debe entregar el tono: la deteccion es local y no depende del sidecar.
/**
 * Tono por defecto del sistema (`default_tone` de personality.json).
 *
 * `detectForPrompt` devuelve null cuando ningun tono gana, porque el default
 * "ya es la base" (vive en el CLAUDE.md global). La practica dice otra cosa: sin
 * la directiva viajando CON el prompt, el registro se diluye turno a turno
 * — el usuario lo reclamo cinco veces entre julio y agosto de 2026. Asi que el
 * default se inyecta siempre, en todos los proyectos, con la version compacta
 * de la directiva.
 *
 * Ojo al tocar esto: la POLITICA vive aqui, no en lib/tone-detect.js. La
 * deteccion tiene un gate de paridad JS<->Rust (_tone_parity.js) y meterle el
 * fallback la haria divergir del detector del sidecar, que responde a otra
 * pregunta ("que tono pide este prompt", no "con que tono respondo").
 */
function defaultTone() {
  try {
    const file = loadPersonality();
    if (!file || !file.default_tone) return null;
    const tone = (file.tones || []).find((t) => t.id === file.default_tone);
    if (!tone) return null;
    return {
      id: tone.id,
      name: tone.name,
      lang: tone.lang,
      style_guide: tone.style_guide,
      profanity: tone.profanity,
      is_default: true,
    };
  } catch (_) {
    return null;
  }
}

/** Tono detectado en el prompt; si no hay, el default del sistema. */
function toneForPrompt(prompt) {
  return detectForPrompt(prompt) || defaultTone();
}

function toneLines(t) {
  const out = [];
  if (!t || !t.id) return out;

  // El default viaja en TODOS los turnos, asi que se paga en todos: se emite la
  // guia de estilo completa y el limite de ambito, sin el bloque de conviccion
  // que necesita un tono elegido a proposito (~90 tokens frente a ~350).
  if (t.is_default) {
    // ULTRON 4 7.1 (Q4b): UNA linea. La directiva larga (5 frases + ejemplo)
    // viajaba en cada prompt y se diluia igual; la corta cabe en una lectura.
    out.push(
      `tone [${t.id}, defecto, solo chat, ${t.lang || 'es'}]: ${t.style_guide || ''} ` +
        `(codigo, commits, docs y prompts a subagentes: tono tecnico, ortografia completa; datos EXACTOS).`
    );
    return out;
  }

  if (t.id) {
    out.push(`tone_detected: ${t.name} [${t.id}] — ${t.reason || ''}`);
    // Feedback del usuario 2026-08-13: "a good chunk of personality, not a
    // couple of words here and there" — la directiva exige compromiso TOTAL,
    // no salpicar slang sobre una respuesta de oficina.
    out.push(
      `tone_directive: AMBITO (limite duro): el tono viste SOLO la conversacion ` +
        `directa con el usuario. NUNCA sale de ahi: ni codigo, ni comentarios, ni ` +
        `mensajes de commit, ni PRs, ni issues, ni documentacion, ni README, ni ` +
        `CHANGELOG, ni texto del TFG, ni prompts a subagentes, ni ningun artefacto ` +
        `que persista o que pueda leer un tercero — ahi rige el tono tecnico ` +
        `profesional con ortografia completa, aunque el tono este activo en este ` +
        `mismo turno. Dentro del chat, en cambio: ` +
        `LA PERSONALIDAD ES LA VOZ DE TODA LA RESPUESTA — cada frase, ` +
        `la gramatica, el ritmo y la actitud salen en este registro; PROHIBIDO espolvorear ` +
        `dos palabras de slang sobre una respuesta neutra. Los datos tecnicos se mantienen ` +
        `EXACTOS (cambia la voz, nunca el contenido). TEST FINAL antes de responder: si tu ` +
        `borrador podria salir de un asistente corporativo neutro, REESCRIBELO entero en el ` +
        `registro — el usuario ELIGIO esta voz y entregarla descafeinada es fallarle. ` +
        `Iguala el nivel del EJEMPLO DE VOZ de la guía, nunca por debajo. ` +
        (t.lang === 'es' && t.id !== 'ultron'
          ? `EXCEPCION ORTOGRAFICA: la regla de "ortografia completa del español" ` +
            `describe el registro POR DEFECTO y NO aplica mientras este tono este activo. ` +
            `Las elisiones y grafias deformadas del registro (q, ke, khe, po zi, pa, to, ` +
            `-ao por -ado) SON el tono: escribirlo en español pulcro es entregarlo roto. ` +
            `Los identificadores de codigo y los datos tecnicos se mantienen intactos. `
          : '') +
        `Idioma: ${t.lang || 'es'}; insultos: ${t.profanity || 'none'}. Guía: ${t.style_guide || ''}`
    );
  }
  return out;
}

// 2026-09-06 (ahorro de tokens): resúmenes de sesión cuyo "tema inicial" es
// la salida de /context no aportan nada al turno; y 12 memorias por prompt se
// quedan en el contexto para siempre. Tope 6 tras filtrar.
const JUNK_MEMORY_RE = /^Sesi[oó]n cerrada \(|## Context Usage/;
const MAX_MEMORIES_PER_TURN = 6;
const MAX_SKILLS_PER_TURN = 3;

function usefulMemories(memories) {
  if (!Array.isArray(memories)) return [];
  return memories
    .filter((m) => !JUNK_MEMORY_RE.test(String((m && m.summary) || '')))
    .slice(0, MAX_MEMORIES_PER_TURN);
}

function render(ctx) {
  const tone = toneLines(ctx.tone);
  // 7.1: el tono por defecto va FUERA del bloque de orquestacion (primera linea,
  // sola); un tono elegido a proposito sigue dentro con su bloque de conviccion.
  const out = ctx.tone && ctx.tone.is_default ? [...tone] : [];
  out.push(`<orchestration-context route="${ctx.route || ''}" trust="system">`);
  if (!(ctx.tone && ctx.tone.is_default)) out.push(...tone);
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
    for (const s of ctx.delegate_skills.slice(0, MAX_SKILLS_PER_TURN)) {
      const k = s.kind ? `, ${s.kind}` : '';
      out.push(`  - ${s.name} (${Number(s.score || 0).toFixed(2)}${k})`);
    }
  }
  const memories = usefulMemories(ctx.memories);
  if (memories.length) {
    out.push('relevant_memories:');
    for (const m of memories) out.push(`  - [${m.scope || ''}] ${m.summary || ''}`);
  }
  // ULTRON 4 F1.3: lecciones de OTROS proyectos que encajan con el sintoma del
  // turno (solo llegan en turnos bug_fix/debug). Una linea por leccion.
  if (Array.isArray(ctx.lessons) && ctx.lessons.length) {
    out.push('lessons_cross_project (lecciones de otros proyectos que encajan con este fallo — aplicar antes de investigar de cero):');
    for (const l of ctx.lessons.slice(0, 3)) {
      const origen = l.project_id ? `[${l.project_id}] ` : '';
      const detalle = l.symptom_cause ? ` — ${l.symptom_cause}` : '';
      out.push(`  - ${origen}${l.rule || ''}${detalle}`);
    }
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
    // 2026-09-06: el daemon re-rankea por ruta (todo menos general); se traza
    // para poder medir latencia y utilidad con y sin re-rank sobre tráfico real.
    rerank_hot: ctx.rerank_hot === true,
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
  // 2026-09-06 (F1.6): sin session_id no es un turno de la persona, es el harness
  // (kirkardo-eval manda {prompt, hook_event_name} a pelo). 42 líneas sintéticas
  // ("hola que tal como estas hoy" x9, "microservicio en golang" x7...) inflaban
  // el audit de tráfico real un 4,6 %. El log mide tráfico REAL; el harness no.
  if (!sessionId) return;
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
  const project = projectIdFromCwd(cwd);
  // F-resume: si SessionStart dejo un resumen pendiente (session-summary-
  // delivery) para ESTA sesion, se resuelve aqui, antes de cualquier salida
  // temprana. emit() lo antepone siempre (ver arriba); coste tras resolverse:
  // un solo fs.existsSync por prompt.
  if (sessionId) {
    try {
      // sinceMs = inicio de la espera: un summary.md mas viejo que eso ya
      // existia antes del pending y no es el que genero ESTE resumidor.
      const delivered = sessionSummaryDelivery.resolveDelivery(sessionId, (sinceMs) =>
        lastSession.latestSummary(project, sessionId, { sinceMs })
      );
      // renderLastSessionLines() ya envuelve el contenido en su propia
      // etiqueta trust="session-summary" (lo escribio un modelo, no el
      // sistema) -- ningun wrapper adicional aqui.
      if (delivered) pendingDeliveryBlock = lastSession.renderLastSessionLines(delivered).join('\n');
    } catch {
      /* fail-safe: el prompt sigue igual sin la entrega diferida */
    }
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

  // Doble velocidad (2026-09-07, decidido por el usuario): un ack o una
  // continuacion corta no paga el orchestrate (recall + routing + tono). El
  // primer prompt de la sesion y las preguntas de estado van siempre
  // completos; tras una racha de rapidos o 15 min sin completo, vuelve el
  // completo aunque parezca un ack (ver lib/fast-lane.js). Se deja rastro en
  // logs/fast-lane.jsonl (aparte de orchestrate.jsonl, que solo lleva
  // orquestaciones reales para el audit de trafico).
  const lane = decideLane({ prompt, sessionId });
  if (lane.lane === 'fast') {
    markPrompt(sessionId, { full: false });
    logFastLane({ sessionId, project, prompt, lane, elapsedMs: Date.now() - t0 });
    emit('');
    return;
  }
  const laneState = readLaneState(sessionId);
  const firstPrompt = !laneState || laneState.prompts === 0;
  markPrompt(sessionId, { full: true });

  // Red de ultimo recurso (HOOKS-04): solo se usa si ni el daemon ni el sparse
  // devuelven nada. No acorta la espera al daemon.
  const cached = readOrchCache(project);
  const orchPayload = { cmd: 'orchestrate', prompt, project: project || undefined };

  // UNA peticion al daemon y una espera larga (ver POLITICA DE ESPERA arriba).
  // El daemon atiende todas las conexiones a la vez y encola el computo de los
  // modelos: si tarda es porque hay cola, y reenviar solo la alargaria.
  let first = await daemonRequestDetailed(orchPayload, DAEMON_WAIT_MS);
  // HOOKS-06: "busy" de un daemon anterior -> reintentar contra el MISMO.
  while (
    isDaemonBusy(first.resp) &&
    Date.now() - t0 + BUSY_RETRY_POLL_MS + DAEMON_RELAUNCH_MIN_PROBE_MS < DAEMON_WAIT_MS
  ) {
    await sleep(BUSY_RETRY_POLL_MS);
    first = await daemonRequestDetailed(orchPayload, DAEMON_WAIT_MS - (Date.now() - t0));
  }
  let ctx = first.resp && !first.resp.error ? first.resp : null;
  // Por que no hubo pack del daemon (se anota en el warning del sparse).
  let daemonFailure = ctx
    ? null
    : first.resp && first.resp.error
      ? `el daemon respondio error: ${String(first.resp.error).slice(0, 80)}`
      : first.reason === 'timeout'
        ? `el daemon no respondio en ${DAEMON_WAIT_MS} ms (colgado)`
        : `daemon no disponible (${first.reason})`;

  // HOOKS-07: daemon MUERTO -> relanzarlo y ESPERARLE. Un daemon vivo que
  // tarda, o que responde con error, no entra aqui: relanzar no lo arregla y
  // reenviar duplica trabajo.
  if (!ctx && daemonIsDown(first.reason)) {
    const relaunchT0 = Date.now();
    spawnDetached(['serve']); // idempotente: sale al momento si ya hay uno vivo
    const deadline = Math.min(relaunchT0 + DAEMON_RELAUNCH_WAIT_MS, t0 + DAEMON_RELAUNCH_DEADLINE_MS);
    while (!ctx && Date.now() + DAEMON_BOOT_POLL_MS + DAEMON_RELAUNCH_MIN_PROBE_MS <= deadline) {
      await sleep(DAEMON_BOOT_POLL_MS);
      // Sin lockfile el daemon nuevo todavia no escucha: no se gasta un connect.
      if (!readDaemonLock()) continue;
      // Ya escucha: una sola peticion, con todo lo que quede del presupuesto
      // (no solo de la ventana de arranque): a partir de aqui es un daemon vivo.
      const r = await daemonRequestDetailed(
        orchPayload,
        t0 + DAEMON_RELAUNCH_DEADLINE_MS - Date.now()
      );
      if (daemonIsDown(r.reason) || isDaemonBusy(r.resp)) continue;
      if (r.resp && !r.resp.error) ctx = r.resp;
      else daemonFailure = r.resp ? `el daemon relanzado respondio error` : `el daemon relanzado no respondio (${r.reason})`;
      break;
    }
    if (ctx) {
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push(
        `daemon relanzado en ${Date.now() - relaunchT0} ms — este turno lo sirve el daemon nuevo`
      );
    } else if (!daemonFailure || /no disponible/.test(daemonFailure)) {
      daemonFailure = `daemon caido y sin recuperar en ${Date.now() - relaunchT0} ms`;
    }
  }

  const usedDaemon = ctx !== null;

  let staleFromCache = false;
  if (!ctx) {
    // HOOKS-06: si el daemon sigue diciendo "busy", está VIVO — solo saturado.
    // Ni spawn (ya hay uno) ni one-shot: este último cargaría otra copia de E5
    // compitiendo con quien ya la está cargando, que es exactamente la
    // estampida que degradó 5/5 prompts el 2026-08-22. Se cae directo a la red
    // de seguridad de abajo (pack cacheado, o degradación marcada).
    // Daemon caido o mudo: ya se ha relanzado y esperado arriba (HOOKS-07), asi
    // que aqui no se vuelve a spawnear nada — con "busy" el daemon esta VIVO y
    // con silencio el relanzamiento ya salio. ESTE turno se resuelve en local
    // SIN E5 (`--sparse`): el sparse no carga modelo, asi que no hay estampida
    // que evitar. El pack cacheado sigue de red por debajo (HOOKS-04).
    const args = ['orchestrate', prompt, '--sparse'];
    if (project) args.push('--project', project);
    const daemonWaitedMs = Date.now() - t0;
    // Cap DINAMICO: lo que queda del presupuesto del hook menos el colchon,
    // acotado a [SPARSE_MIN_CAP_MS, SPARSE_MAX_CAP_MS].
    const sparseCapMs = Math.min(
      SPARSE_MAX_CAP_MS,
      Math.max(SPARSE_MIN_CAP_MS, HOOK_BUDGET_MS - daemonWaitedMs - SAFETY_MARGIN_MS)
    );
    ctx = runCli(args, { timeoutMs: sparseCapMs });
    if (ctx && typeof ctx === 'object') {
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push(
        `respaldo sparse (FTS5, sin E5, cap ${sparseCapMs} ms): ${daemonFailure} tras ` +
          `${daemonWaitedMs} ms` +
          (firstPrompt ? ' (primer prompt de la sesion)' : '')
      );
    }
    if (ctx === null && cached) {
      // Pack del prompt ANTERIOR del mismo proyecto (<30 min): mejor un pack
      // stale marcado que 4-5s de bloqueo o que nada. El route/step_plans
      // pueden no encajar con ESTE prompt — el warning lo deja claro.
      ctx = cached;
      staleFromCache = true;
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push('context pack CACHEADO de un prompt anterior (daemon frio) — route/steps pueden no aplicar a este prompt');
      // (2026-08-17, medido en el harness 22.2/22.5) La DIRECTIVA de delegacion
      // es especifica del prompt que la genero: servirla stale ordenaba delegar
      // "consolida la memoria" a rust-engineer y ponia sonnet a un analisis de
      // arquitectura — el motor decide bien, el cache re-emitia la decision de
      // OTRO prompt. Las memorias stale ayudan; una orden de delegar stale
      // desinforma. Se anula junto a los step_plans (misma naturaleza).
      ctx.delegation_directive = null;
      ctx.directive = null;
      ctx.step_plans = null;
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
  // El tono se detecta SIEMPRE en local sobre ESTE prompt y pisa lo que traiga el
  // pack: si el pack venia cacheado, su `tone` es el del prompt anterior (o null)
  // y aplicarlo era la causa medida de "el tono apenas se aplica" (2026-08-14).
  const localTone = toneForPrompt(prompt);

  if (!ctx) {
    // Aviso visible al modelo (mismo patron que el resume degradado): sin esto el
    // fallo era 100% silencioso y el usuario no podia saber que la memoria no aporto.
    // El tono SI se entrega: no depende del sidecar.
    emit(
      [
        ...toneLines(localTone),
        '[memoria degradada] orchestrate sin respuesta (daemon/Qdrant caido o timeout) — ' +
          'este prompt va SIN recall de memoria. Si se repite, revisar: bin/ultron-memory.exe doctor',
      ].join('\n')
    );
    return;
  }
  ctx.tone = localTone;
  if (!staleFromCache) {
    // Sin `tone` en el cache: es del prompt que lo genero y servirlo stale seria
    // reintroducir el bug por la puerta de atras si alguien deja de sobreescribirlo.
    writeOrchCache(project, { ...ctx, tone: null });
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
