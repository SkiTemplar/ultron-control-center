#!/usr/bin/env node
// hooks/scripts/memory-orchestrate.js — UserPromptSubmit hook (tono por prompt).
//
// Modo ligero, el unico desde el 2026-11-14 (el modo completo con
// ULTRON_ORCHESTRATE=full —recall, routing, delegacion y carril rapido— se
// retiro con el dispatcher de skills y la ruta densa). Por prompt solo entrega:
//   - el tono, si NO es el default del sistema (el default ya vive en el
//     CLAUDE.md global; se detecta en local, sin llamar al daemon);
//   - el resumen de la sesion anterior si SessionStart no llego a tiempo
//     (entrega diferida, ver lib/session-summary-delivery.js).
// La memoria de proyecto llega en el SessionStart (resume + resumen de la
// sesion anterior) y por la bitacora (cockpit/projects/<id>/estado.json).
// FAIL-SAFE: emite contexto vacio (nunca bloquea el prompt) si algo falla.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { projectIdFromCwd } = require('./lib/ultron-memory-cli');
const { appendJsonl } = require('./lib/jsonl-log');
const { observe } = require('./lib/hook-obs');
const { isSystemTurnPrompt } = require('./lib/system-turn');
const { detectForPrompt, loadPersonality } = require('./lib/tone-detect');
// F-resume (2026-09-11): entrega diferida del resumen de la sesion anterior si
// SessionStart no llego a tiempo (ver lib/session-summary-delivery.js).
const lastSession = require('./lib/last-session');
const sessionSummaryDelivery = require('./lib/session-summary-delivery');
observe('memory-orchestrate');

// Tono por sesion para la statusline (2026-10-03). ULTRON_SESSION_TONE_LOG solo
// para los selftests.
const SESSION_TONE_LOG =
  process.env.ULTRON_SESSION_TONE_LOG || path.join(os.homedir(), '.claude', 'logs', 'session-tone.jsonl');

// F-resume: bloque del resumen de la sesion anterior, resuelto UNA vez por
// sesion en main() ANTES de cualquier salida temprana. Vive fuera de emit()
// para que TODO camino de salida de este hook lo entregue por igual — es el
// unico punto por el que pasan todas las llamadas a emit(), asi que ningun
// early-return puede tragarselo en silencio.
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

/**
 * Tono por defecto del sistema (`default_tone` de personality.json).
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

/** Directiva completa de un tono elegido o detectado (no el default). */
function toneLines(t) {
  if (!t || !t.id) return [];
  // Feedback del usuario 2026-08-13: "a good chunk of personality, not a
  // couple of words here and there" — la directiva exige compromiso TOTAL,
  // no salpicar slang sobre una respuesta de oficina.
  return [
    `tone_detected: ${t.name} [${t.id}] — ${t.reason || ''}`,
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
      `Idioma: ${t.lang || 'es'}; insultos: ${t.profanity || 'none'}. Guía: ${t.style_guide || ''}`,
  ];
}

/**
 * Modo ligero (recorte 2026-09-29): el tono por defecto ya vive en el CLAUDE.md
 * global, asi que repetirlo en CADA prompt solo gasta tokens. Solo se inyecta
 * un tono distinto del default (elegido o detectado), con su directiva
 * completa.
 */
function lightModeToneLines(t) {
  if (!t || !t.id || t.is_default) return [];
  const def = defaultTone();
  if (def && t.id === def.id) return [];
  return toneLines(t);
}

/** Apunta el tono del prompt para la statusline; nunca bloquea el prompt. */
function logSessionTone(sessionId, tone) {
  if (!sessionId) return;
  try {
    appendJsonl(SESSION_TONE_LOG, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      tone: tone && tone.id ? { id: tone.id, is_default: Boolean(tone.is_default) } : null,
    });
  } catch (_) {
    /* never block the prompt */
  }
}

/** stdin del hook -> { prompt, cwd, sessionId } (fail-safe ante stdin vacio o JSON roto). */
function readHookInput() {
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
  return { prompt, cwd, sessionId };
}

// F-resume: si SessionStart dejo un resumen pendiente (session-summary-
// delivery) para ESTA sesion, se resuelve aqui, antes de cualquier salida
// temprana. emit() lo antepone siempre (ver arriba); coste tras resolverse:
// un solo fs.existsSync por prompt.
function deliverPendingSummary(project, sessionId) {
  if (!sessionId) return;
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

function main() {
  const { prompt, cwd, sessionId } = readHookInput();
  const project = projectIdFromCwd(cwd);
  // Antes de cualquier salida temprana: el resumen de la sesion anterior se
  // entrega aunque el prompt sea vacio o un turno de sistema.
  deliverPendingSummary(project, sessionId);
  // Prompt vacio o turno de SISTEMA (notificacion de tarea background): sin tono.
  if (!prompt.trim() || isSystemTurnPrompt(prompt)) {
    emit('');
    return;
  }
  const tone = toneForPrompt(prompt);
  logSessionTone(sessionId, tone);
  emit(lightModeToneLines(tone).join('\n'));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
    try {
      appendJsonl(path.join(os.homedir(), '.ultron', 'logs', 'hook-errors.jsonl'), {
        hook: 'memory-orchestrate',
        error: String((e && e.message) || e),
      });
    } catch { /* ignore */ }
    try { emit(''); } catch { /* ignore */ }
  } finally {
    process.exitCode = 0;
  }
} else {
  // Exportadas para test (patrón require.main, como en stop-compress-session.js).
  module.exports = { lightModeToneLines, defaultTone, toneForPrompt, readHookInput, deliverPendingSummary };
}
