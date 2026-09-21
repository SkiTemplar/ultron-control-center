#!/usr/bin/env node
/**
 * hooks/scripts/postcompact-reinject.js — hook de PostCompact (2026-09-22).
 *
 * Que hace: despues de una compactacion devuelve al contexto, en un bloque
 * corto y acotado, el resumen que la propia compactacion produjo.
 *
 * Por que: mar.ia tenia `precompact-preserve-l0` para salvar contexto ANTES de
 * compactar y nada DESPUES. El resume que inyecto SessionStart se va con la
 * compactacion y la sesion sigue sin el. Anthropic publica la receta
 * "re-inject context after compaction"; el sitio correcto hoy es el evento
 * PostCompact, cuyo matcher casa contra `trigger` (enum: manual|auto).
 *
 * De donde sale el texto: del propio payload. PostCompact entrega
 * `compact_summary` con el resumen que acaba de generar la compactacion — o
 * sea, exactamente lo que se perdio, escrito por quien tenia el contexto
 * entero delante. Reconstruirlo aparte (leyendo el transcript con
 * lib/session-digest.js) seria ignorar el dato que ya llega. Ese camino queda
 * SOLO como respaldo: si el payload no trae resumen, se emiten los ultimos
 * prompts del usuario, que es el hilo minimo para no quedarse a ciegas.
 *
 * Presupuesto: el problema que ataca es de contexto, asi que no puede
 * empeorarlo. La salida se recorta a MAX_CHARS (~400 tokens) y el selftest lo
 * assertea.
 *
 * Anti-duplicado: si SessionStart tambien se disparase con motivo `compact`,
 * el bloque se inyectaria dos veces. Dos defensas: (1) en la plantilla,
 * memory-session-resume tiene matcher `startup|resume|clear`, asi que el
 * motivo `compact` queda cedido a este hook; (2) un marcador por sesion en
 * %TEMP% corta la segunda emision dentro de la misma compactacion.
 *
 * Fail-safe: cualquier excepcion sale con exit 0 y sin salida. Un hook roto en
 * PostCompact no puede romper la sesion.
 *
 * Opt-out: CLAUDE_NO_HOOKS=1 o POSTCOMPACT_REINJECT_DISABLED=1.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');
const { readTranscriptEntries, extractUserPrompts } = require('./lib/session-digest');

observe('postcompact-reinject');

// ~400 tokens. El hook existe para recuperar contexto, no para comerselo.
const MAX_CHARS = 1600;
// Cuantos prompts del usuario se reemiten cuando el payload no trae resumen.
const FALLBACK_PROMPTS = 5;
const MAX_PROMPT_CHARS = 200;
// Ventana del marcador anti-duplicado: una compactacion y su posible
// SessionStart gemelo ocurren con segundos de diferencia.
const MARKER_WINDOW_MS = 60 * 1000;
const MARKER_PREFIX = 'ultron-postcompact-';
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let markersPurged = false;

/** Purga best-effort de marcadores viejos (mismo patron que posttoolfail-capture). */
function purgeStaleMarkers() {
  if (markersPurged) return;
  markersPurged = true;
  try {
    const dir = os.tmpdir();
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(MARKER_PREFIX)) continue;
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > MARKER_MAX_AGE_MS) fs.unlinkSync(p);
      } catch (_) {
        /* carrera con otra sesion: ignorar */
      }
    }
  } catch (_) {
    /* purga best-effort: nunca rompe el hook */
  }
}

/**
 * true si ya se re-inyecto para esta sesion hace menos de MARKER_WINDOW_MS.
 * Sin session_id no hay forma de deduplicar: se deja pasar (mejor repetir el
 * bloque una vez que perder el contexto siempre).
 */
function yaInyectado(sessionId) {
  purgeStaleMarkers();
  if (!sessionId) return false;
  try {
    const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '');
    const p = path.join(os.tmpdir(), MARKER_PREFIX + safe);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < MARKER_WINDOW_MS) return true;
    } catch (_) {
      /* sin marcador: primera vez */
    }
    fs.writeFileSync(p, String(Date.now()));
    return false;
  } catch (_) {
    return false; // sin marcador se re-inyecta: el fallo no debe costar contexto
  }
}

/** Recorta a `max` caracteres dejando claro que se recorto. */
function recortar(texto, max = MAX_CHARS) {
  const s = String(texto || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 20).trimEnd() + ' […recortado]';
}

/**
 * Construye el bloque a re-inyectar, o null si no hay nada que decir.
 * Pura salvo por `leerPrompts`, que se inyecta para poder probarla.
 *
 * @param {object} payload   el stdin del hook ya parseado
 * @param {(ruta: string) => string[]} leerPrompts  respaldo: prompts del transcript
 */
function construirBloque(payload, leerPrompts) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const trigger = String(p.trigger || 'auto');

  const resumen = typeof p.compact_summary === 'string' ? p.compact_summary.trim() : '';
  if (resumen) {
    const marco = [
      `<post-compact trigger="${trigger}" fuente="compact_summary" trust="system">`,
      'La conversacion se acaba de compactar. Este es el resumen que produjo la',
      'compactacion; vuelve al contexto para no seguir a ciegas:',
      '',
      '</post-compact>',
    ];
    // El presupuesto es del BLOQUE ENTERO, no solo del resumen: lo que gasta
    // contexto es lo que se emite. Se reserva lo que ocupa el marco.
    const reserva = marco.join('\n').length;
    marco[3] = recortar(resumen, Math.max(120, MAX_CHARS - reserva));
    return marco.join('\n');
  }

  // Respaldo: sin resumen en el payload, el hilo minimo son los ultimos
  // prompts del usuario. Es menos que el resumen, pero no es nada.
  const ruta = p.transcript_path || p.transcriptPath || '';
  if (!ruta) return null;
  let prompts = [];
  try {
    prompts = leerPrompts(ruta);
  } catch (_) {
    return null;
  }
  if (!prompts.length) return null;

  const ultimos = prompts
    .slice(-FALLBACK_PROMPTS)
    .map((t) => '  - ' + String(t).replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS));
  return recortar(
    [
      `<post-compact trigger="${trigger}" fuente="transcript" trust="system">`,
      'La conversacion se acaba de compactar y el evento no trajo resumen.',
      'Ultimos encargos del usuario antes de compactar:',
      ...ultimos,
      '</post-compact>',
    ].join('\n'),
  );
}

/** Prompts del usuario de un transcript JSONL (respaldo). */
function promptsDelTranscript(ruta) {
  return extractUserPrompts(readTranscriptEntries(ruta)).map((e) => e.text);
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.POSTCOMPACT_REINJECT_DISABLED === '1') {
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return; // payload ilegible: nada que re-inyectar
  }

  // Si algun dia este script se registra por error en otro evento, no habla.
  const evento = String(payload.hook_event_name || 'PostCompact');
  if (evento !== 'PostCompact') return;

  const bloque = construirBloque(payload, promptsDelTranscript);
  if (!bloque) return;
  if (yaInyectado(payload.session_id || payload.sessionId)) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostCompact',
        additionalContext: bloque,
      },
    }),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    logHookError('postcompact-reinject', e);
  }
  process.exitCode = 0;
}

// Exportado para postcompact-reinject.selftest.mjs.
module.exports = { construirBloque, recortar, MAX_CHARS, FALLBACK_PROMPTS };
