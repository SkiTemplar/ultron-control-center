#!/usr/bin/env node
/**
 * UserPromptSubmit hook — SOCRATIC GATE (lanzamiento 100%).
 *
 * Por que existe (decidido 2026-07-08): el usuario detecto dependencia excesiva
 * de la IA para RESOLVER problemas y decidir arquitectura. La IA sigue
 * escribiendo todo el codigo, pero las decisiones no triviales las toma EL.
 * CLAUDE.md es prosa best-effort; este hook es determinista: el protocolo
 * entra EN CONTEXTO en cada prompt, sin excepcion.
 *
 * Diseno (token-aware, 100% de disparo):
 *  - 1er prompt de la sesion: protocolo completo.
 *  - Prompts siguientes: recordatorio de 1 linea.
 *  - Respuesta de bajo esfuerzo ("ok", "dale", "lo que veas"...): ESCALADA —
 *    instruye al modelo a NO dar la decision por aprobada y a exigir
 *    eleccion razonada (opcion + porque) antes de avanzar.
 *  - NUNCA bloquea el prompt; cualquier error => exit 0 silencioso.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe, logHookError } = require('./lib/hook-obs');
const { isSystemTurnPrompt } = require('./lib/system-turn');
observe('socratic-gate');

// Acks de una palabra que NO constituyen una eleccion razonada.
const ACK_WORDS = new Set([
  'ok', 'okay', 'okey', 'oki', 'vale', 'dale', 'va', 'si', 'yes', 'ya',
  'continua', 'sigue', 'adelante', 'hazlo', 'procede', 'perfecto', 'genial',
  'guay', 'bien', 'venga', 'go', 'next', 'claro', 'eso', 'aja',
]);

// Frases de delegacion: aunque el prompt sea mas largo, delegan la decision.
const DELEGATION_PHRASES = [
  'lo que veas', 'como veas', 'tu decides', 'decide tu', 'elige tu',
  'me da igual', 'lo que sea', 'lo que tu creas', 'tu mismo', 'tu sabras',
  'lo que prefieras', 'cualquiera vale', 'la que sea',
];

// Eleccion de opcion SIN porque ("la 1", "opcion b", "la primera"): CLAUDE.md
// exige eleccion razonada — elegir sin dar ni una razon cuenta como bajo esfuerzo.
// El regex debe cubrir el prompt ENTERO normalizado (sin razon adjunta).
const OPTION_PICK_RE =
  /^(?:(?:la|el|lo)\s+)?(?:opcion\s+)?(?:\d{1,2}|[abcd]|primer[ao]?|segund[ao]|tercer[ao]|cuart[ao]|ultim[ao])$/;

// Normaliza: minusculas, sin diacriticos (NFD + filtro de combining marks
// U+0300..U+036F por code-point, sin literales unicode fragiles en el regex),
// sin puntuacion, espacios colapsados.
function normalize(text) {
  const decomposed = String(text || '').toLowerCase().normalize('NFD');
  let plain = '';
  for (const ch of decomposed) {
    const c = ch.charCodeAt(0);
    if (c >= 0x0300 && c <= 0x036f) continue;
    plain += ch;
  }
  return plain
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True si el prompt es un ack de bajo esfuerzo, una delegacion de decision,
// o una eleccion de opcion sin porque.
function isLowEffort(prompt) {
  const norm = normalize(prompt);
  if (!norm) return false;
  if (OPTION_PICK_RE.test(norm)) return true;
  // Delegacion solo en respuestas cortas: incrustada en un prompt tecnico
  // largo ("...aunque me da igual el naming...") no es delegar la decision.
  if (norm.length <= 60) {
    for (const phrase of DELEGATION_PHRASES) {
      if (norm.includes(phrase)) return true;
    }
  }
  if (norm.length > 30) return false;
  const tokens = norm.split(' ');
  return tokens.every((t) => ACK_WORDS.has(t));
}

// Limpieza de markers de sesiones pasadas (>48h) — evita acumulacion en %TEMP%.
function sweepOldMarkers(tmpdir) {
  try {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    for (const name of fs.readdirSync(tmpdir)) {
      if (!name.startsWith('ultron-socratic-')) continue;
      const p = path.join(tmpdir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* marker bloqueado o ajeno — ignorar */ }
    }
  } catch (_) { /* la limpieza nunca rompe el hook */ }
}

const FULL_MSG =
  '[ULTRON / SOCRATICO] Protocolo activo (decidido 2026-07-08, ver CLAUDE.md ' +
  'global): la IA escribe TODO el codigo, pero las decisiones de arquitectura, ' +
  'diseno y resolucion de problemas NO triviales las toma el usuario. Ante una: ' +
  'presenta 2-3 opciones con trade-offs reales (AskUserQuestion si esta ' +
  'disponible, recomendacion marcada si la hay) y espera su eleccion razonada ' +
  '(opcion + porque). Si responde con bajo esfuerzo ("ok", "dale", "lo que ' +
  'veas"), NO avances: repregunta exigiendo que conteste bien. Lo trivial ' +
  '(naming, fixes obvios, detalles de implementacion) NO se pregunta — esto no ' +
  'es un examen. TFG/proyectos de investigacion: senalar problemas SI, dar la ' +
  'solucion NUNCA (el usuario la investiga; la IA valida y ayuda a aplicar).';

const SHORT_MSG =
  '[ULTRON / SOCRATICO] Decision no trivial de arquitectura/diseno/resolucion ' +
  'en este turno => opciones + trade-offs y decide el usuario (eleccion razonada, ' +
  'no un "ok"). Trivial no se pregunta. TFG: problemas si, soluciones nunca.';

const ESCALATED_MSG =
  '[ULTRON / SOCRATICO — GATE] Respuesta de bajo esfuerzo detectada. Si en el ' +
  'turno anterior habia una decision abierta (opciones presentadas o problema ' +
  'sin resolver que le tocaba razonar al usuario), esto NO es una eleccion ' +
  'valida: NO la des por aprobada y NO avances por el camino que tu prefieras. ' +
  'Devuelvesela con el estilo directo de ULTRON: que vuelva y conteste bien — ' +
  'que opcion elige y POR QUE (minimo una razon tecnica). Solo continua si la ' +
  'eleccion razonada ya existe o si realmente no habia ninguna decision ' +
  'pendiente.';

function handle(raw) {
  raw = String(raw || '').replace(/^﻿/, '').trim();
  if (!raw) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return;
  }

  const prompt = input.prompt || '';
  // Turno de SISTEMA (notificacion de tarea background): no es un prompt
  // humano — sin protocolo socratico ni escalada (salida limpia, sin output).
  if (isSystemTurnPrompt(prompt)) return;
  const sessionId = String(input.session_id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');

  let msg;
  if (isLowEffort(prompt)) {
    msg = ESCALATED_MSG;
  } else {
    const marker = path.join(os.tmpdir(), `ultron-socratic-${sessionId}`);
    let firstTime = false;
    try {
      if (!fs.existsSync(marker)) {
        firstTime = true;
        fs.writeFileSync(marker, '');
        sweepOldMarkers(os.tmpdir());
      }
    } catch (_) {
      // sin marcador fiable => mandar la version corta (mejor poco que doble)
    }
    msg = firstTime ? FULL_MSG : SHORT_MSG;
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: msg,
    },
  });
}

function getStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    } catch (_) { finish(); }
    timer = setTimeout(finish, 2500);
  });
}

(async () => {
  let raw = '';
  try { raw = await getStdin(); } catch (_) { /* ignore */ }

  let out = '';
  try { out = handle(raw) || ''; } catch (e) { logHookError('socratic-gate', e); /* nunca romper un prompt */ }

  if (out) {
    process.stdout.write(out, () => process.exit(0));
  } else {
    process.exit(0);
  }
})();
