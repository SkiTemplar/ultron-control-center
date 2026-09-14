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
 *
 * Modo por proyecto (ULTRON 4 F4.3, decision Q5a 2026-09-02): campo
 * `socratic` en la entrada del proyecto en cockpit/projects.json.
 *  - `strict` (por defecto, tambien si el campo falta o es invalido): todo lo
 *    de arriba.
 *  - `light`: protocolo y recordatorio, pero SIN escalada — un "ok" pasa.
 *  - `off`: silencio absoluto (proyectos personales donde da igual).
 *  - `uni` (decidido 2026-09-14, trabajos de universidad): hereda TODO el
 *    comportamiento de `strict` (protocolo completo, recordatorio, escalada
 *    ante ack de bajo esfuerzo) y anade un bloque conciso con las reglas
 *    especificas de asignatura — texto evaluable (memoria/informe/TFG/
 *    cuestionario): la IA pregunta y orienta, NUNCA redacta el entregable ni
 *    da la solucion; codigo de practicas: la IA SI lo escribe, pero antes de
 *    cerrar una tarea hace 2-3 preguntas tipo defensa oral y espera
 *    respuesta razonada; infraestructura (build/tests/tooling) sin
 *    restriccion. Si el proyecto tiene marcador `.ultron-trabajo.json`
 *    (uni-deliverable-guard.js, PreToolUse, es quien BLOQUEA de verdad la
 *    escritura ahi), el primer prompt y la escalada recuerdan que carpetas
 *    estan protegidas.
 * El proyecto se resuelve por el cwd de la sesion (prefijo de `path`, asi que
 * las subcarpetas heredan el modo). Cambiar el modo:
 *   node ~/.ultron/scripts/project-socratic.mjs <id> strict|light|off|uni
 * Override (selftest): SOCRATIC_PROJECTS_OVERRIDE = ruta del registro.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe, logHookError } = require('./lib/hook-obs');
const { isSystemTurnPrompt } = require('./lib/system-turn');
const { findTrabajoMarker } = require('./lib/uni-trabajo');
observe('socratic-gate');

const PROJECTS_REGISTRY_PATH =
  process.env.SOCRATIC_PROJECTS_OVERRIDE ||
  path.join(os.homedir(), '.ultron', 'cockpit', 'projects.json');
const MODES = new Set(['strict', 'light', 'off', 'uni']);
const DEFAULT_MODE = 'strict';

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

// Recorte de tokens (decidido por el usuario 2026-08-13): el recordatorio
// SHORT solo se inyecta cuando el prompt PARECE llevar una decision abierta
// (pregunta o vocabulario decisional). En charla y ordenes directas, silencio
// — la ESCALADA por ack debil se mantiene SIEMPRE en strict (es el corazon del
// gate) y el FULL de primer prompt de sesion tambien (1 vez, barato).
const DECISION_HINTS = [
  'decid', 'opcion', 'opciones', 'elegir', 'elige', 'arquitectura', 'diseno',
  'disena', 'enfoque', 'alternativa', 'trade', 'prefieres', 'mejor forma',
  'como lo hacemos', 'como hacemos', 'que hacemos', 'deberia', 'deberiamos',
  'plan', 'propuesta', 'should', 'which', 'approach', 'options', 'possible',
  'posible', 'what if', 'y si',
];

function looksDecisional(prompt) {
  const raw = String(prompt || '');
  if (raw.includes('?')) return true;
  const norm = normalize(raw);
  return DECISION_HINTS.some((h) => norm.includes(h));
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

function normalizePath(p) {
  if (!p) return '';
  try {
    return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

// Modo socratico del proyecto cuyo `path` contiene el cwd (el mas largo gana);
// sin registro, sin proyecto o valor invalido => strict.
function modeForCwd(cwd) {
  const objetivo = normalizePath(cwd);
  if (!objetivo) return DEFAULT_MODE;
  let raw;
  try {
    if (!fs.existsSync(PROJECTS_REGISTRY_PATH)) return DEFAULT_MODE;
    raw = JSON.parse(fs.readFileSync(PROJECTS_REGISTRY_PATH, 'utf8'));
  } catch (_) {
    return DEFAULT_MODE;
  }
  const proyectos = Array.isArray(raw) ? raw : (raw && raw.projects) || [];
  let best = null;
  for (const p of proyectos) {
    const base = normalizePath(p && p.path);
    if (!base) continue;
    if (objetivo === base || objetivo.startsWith(base + '/')) {
      if (!best || base.length > best.base.length) best = { base, mode: p.socratic };
    }
  }
  const mode = best ? String(best.mode || '').trim().toLowerCase() : '';
  return MODES.has(mode) ? mode : DEFAULT_MODE;
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

const LIGHT_SUFFIX =
  ' [modo light en este proyecto: presenta las opciones, pero un "ok" del ' +
  'usuario vale como eleccion; sin escalada.]';

// Modo uni (2026-09-14): NO repite el protocolo base (arriba) — solo anade
// las tres reglas de asignatura. Version larga en el primer prompt/escalada,
// version corta en el recordatorio por turno (token-aware).
const UNI_SUFFIX =
  ' [modo uni en este proyecto: texto evaluable (memoria, informe, TFG, ' +
  'cuestionario) => preguntas y orientacion, la IA NUNCA redacta el ' +
  'entregable ni da la solucion. Codigo de practicas => la IA SI lo escribe, ' +
  'pero antes de cerrar la tarea hace 2-3 preguntas tipo defensa oral (por ' +
  'que esa estructura, que pasa si cambia X, complejidad) y espera ' +
  'respuesta; si es floja, repasa el concepto antes de seguir. ' +
  'Infraestructura (build/tests/config/tooling) sin restriccion.]';

const UNI_SUFFIX_SHORT =
  ' [uni: texto evaluable -> preguntar/orientar, nunca redactar el ' +
  'entregable ni dar la solucion; codigo de practicas -> se escribe pero se ' +
  'cierra con 2-3 preguntas de defensa oral; infra sin restriccion.]';

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

// Linea informativa de carpetas protegidas (marcador .ultron-trabajo.json,
// ver lib/uni-trabajo.js). El BLOQUEO real lo hace uni-deliverable-guard.js
// (PreToolUse); esto es solo el recordatorio en el mensaje del gate. Marcador
// corrupto: silencio aqui (uni-deliverable-guard.js ya avisa y registra el
// error en su propio turno, cuando corresponda).
function markerLine(cwd) {
  let marker;
  try {
    marker = findTrabajoMarker(cwd);
  } catch (_) {
    return '';
  }
  if (!marker || marker.corrupt) return '';
  return ` Carpetas protegidas de escritura de la IA en este proyecto: ` +
    `${marker.protegidas.join(', ')} (marcador ${marker.markerPath}).`;
}

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

  const cwd = input.cwd || process.cwd();
  const mode = modeForCwd(cwd);
  if (mode === 'off') return;

  const sessionId = String(input.session_id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');

  // uni hereda la escalada de strict (decidido 2026-09-14): un ack de bajo
  // esfuerzo no vale como eleccion razonada en ninguno de los dos modos.
  let msg;
  if ((mode === 'strict' || mode === 'uni') && isLowEffort(prompt)) {
    msg = mode === 'uni' ? ESCALATED_MSG + markerLine(cwd) : ESCALATED_MSG;
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
    if (firstTime) {
      if (mode === 'light') msg = FULL_MSG + LIGHT_SUFFIX;
      else if (mode === 'uni') msg = FULL_MSG + UNI_SUFFIX + markerLine(cwd);
      else msg = FULL_MSG;
    } else if (looksDecisional(prompt)) {
      msg = mode === 'uni' ? SHORT_MSG + UNI_SUFFIX_SHORT : SHORT_MSG;
    } else {
      return; // turno sin decision a la vista: cero tokens (recorte 2026-08-13)
    }
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
