#!/usr/bin/env node
/**
 * ULTRON HOOK · uni-deliverable-guard · v1.0
 *
 * PreToolUse (Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell). Bloqueo
 * REAL de escritura del entregable en modo trabajo universitario (decidido
 * 2026-09-14): en proyectos de asignatura, el texto evaluable (memoria,
 * informe, TFG, cuestionario) lo redacta el alumno — la IA senala problemas y
 * orienta, no lo escribe. socratic-gate.js (UserPromptSubmit) es el
 * recordatorio en cada prompt; este hook es el limite duro — sin el, "no
 * redactes el entregable" es solo una peticion de texto que un turno largo
 * puede olvidar.
 *
 * MARCADOR: `.ultron-trabajo.json` en la raiz del proyecto (o hasta 4
 * niveles por encima del cwd de la sesion), formato
 *   { "protegidas": ["borrador", "entrega"] }
 * Sin el fichero, el hook sale de inmediato (cero I/O extra fuera de
 * proyectos de trabajo universitario). Logica de marcador compartida con
 * socratic-gate.js en lib/uni-trabajo.js.
 *
 * LIMITES DECLARADOS (heuristica conservadora, no exhaustiva):
 *  - Write/Edit/MultiEdit/NotebookEdit: EXACTO — lee tool_input.file_path
 *    (o notebook_path), sin ambiguedad posible.
 *  - Bash/PowerShell: heuristica sobre redirecciones de salida (`>`, `>>`,
 *    no `>&N`), la bandera `-Destination` de Copy-Item/Move-Item y el ULTIMO
 *    argumento no-flag de cp/copy/move/mv/xcopy/robocopy/Copy-Item/
 *    Move-Item. NO cubre: variables indirectas (`f=entrega/x.md; > $f`),
 *    `tee`, escritura desde dentro de otro interprete (`python -c`,
 *    `node -e`), symlinks que apunten a la carpeta protegida desde fuera, ni
 *    un `cd` previo en el mismo comando que cambie el cwd relativo. Es una
 *    barrera adicional sobre el recordatorio del gate socratico, no la unica
 *    linea de defensa — un shell da demasiadas formas de escribir un
 *    fichero para cubrirlas todas de forma determinista.
 *
 * Desactivar a proposito: ULTRON_UNI_GUARD=off (vale para la sesion) o
 * retirar la carpeta de `protegidas` en el marcador.
 *
 * MARCADOR CORRUPTO (JSON invalido / `protegidas` con forma rara): no
 * bloquea (fail-open — no hay senal fiable de que proteger) NI pasa en
 * silencio: avisa en systemMessage y deja traza en logHookError (ni bloqueo
 * silencioso ni paso silencioso).
 *
 * Contrato: PreToolUse -> {hookSpecificOutput:{permissionDecision:'deny'}}
 * en bloqueo; sin hookSpecificOutput cuando solo avisa o cuando permite.
 * Fail-safe: cualquier error interno -> exit 0 sin decision (nunca bloquea
 * por un bug propio).
 */
'use strict';

const path = require('path');

if (require.main === module) {
  try {
    require('./lib/hook-obs.js').observe('uni-deliverable-guard');
  } catch (_) { /* la observabilidad jamas rompe un hook */ }
}

const { logHookError } = require('./lib/hook-obs');
const { findTrabajoMarker, matchProtected, DEFAULT_PROTEGIDAS } = require('./lib/uni-trabajo');
const DEFAULT_PROTEGIDAS_TXT = DEFAULT_PROTEGIDAS.join(', ');

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const COPY_MOVE_RE = /^(cp|copy|move|mv|copy-item|move-item|xcopy|robocopy)(\.exe)?(\s|$)/i;

function stripQuotes(s) {
  return String(s || '').trim().replace(/^["']|["']$/g, '');
}

/** Trocea por separadores de comando, ignorando el contenido (no hace falta
 * respetar here-docs aqui: solo miramos redirecciones/comandos de copia al
 * PRINCIPIO de cada trozo, y un here-doc no arranca con `cp`/`>`). */
function segmentsOf(cmd) {
  return String(cmd || '')
    .split(/\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Candidatos de ruta destino de un comando de shell (heuristica, ver cabecera). */
function bashDestCandidates(cmd) {
  const raw = String(cmd || '');
  const out = [];

  // Redirecciones de salida: `> archivo` / `>> archivo`. Excluye `>&N`
  // (duplicado de descriptor, no escribe a ruta).
  const redirRe = /(^|[\s;&|(])>{1,2}(?!&)\s*("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
  let m;
  while ((m = redirRe.exec(raw))) out.push(stripQuotes(m[2]));

  // PowerShell Copy-Item/Move-Item -Destination <valor>
  const destFlagRe = /-Destination\s+("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
  while ((m = destFlagRe.exec(raw))) out.push(stripQuotes(m[1]));

  // cp/copy/move/mv/xcopy/robocopy/Copy-Item/Move-Item: heuristica = ULTIMO
  // token no-flag del segmento (destino habitual en estos comandos).
  for (const seg of segmentsOf(raw)) {
    if (!COPY_MOVE_RE.test(seg)) continue;
    const tokens = seg.split(/\s+/).filter(Boolean).filter((t) => !t.startsWith('-'));
    if (tokens.length >= 2) out.push(stripQuotes(tokens[tokens.length - 1]));
  }

  return out.filter(Boolean);
}

function destPathsFor(toolName, toolInput) {
  if (FILE_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path;
    return p ? [p] : [];
  }
  if (SHELL_TOOLS.has(toolName)) return bashDestCandidates(toolInput.command || '');
  return [];
}

/**
 * @param {object} data  payload PreToolUse completo (tool_name, tool_input, cwd)
 * @returns {{decision:'deny'|'warn', reason:string}|null}
 */
function classify(data) {
  if (process.env.ULTRON_UNI_GUARD === 'off') return null;
  const toolName = (data && data.tool_name) || '';
  const toolInput = (data && data.tool_input) || {};
  const cwd = (data && data.cwd) || process.cwd();

  const destPaths = destPathsFor(toolName, toolInput);
  if (!destPaths.length) return null;

  const marker = findTrabajoMarker(cwd);
  if (!marker) return null;

  if (marker.corrupt) {
    logHookError(
      'uni-deliverable-guard',
      marker.error || new Error(`marcador ilegible: ${marker.markerPath}`),
    );
    return {
      decision: 'warn',
      reason:
        `marcador ${marker.markerPath} no es JSON valido (o "protegidas" no ` +
        `es una lista de carpetas) — este turno NO se bloquea, revisa el ` +
        `marcador (por defecto se asumiria: ${DEFAULT_PROTEGIDAS_TXT}).`,
    };
  }

  for (const raw of destPaths) {
    let resolved;
    try {
      resolved = path.resolve(cwd, raw);
    } catch (_) {
      continue;
    }
    const folder = matchProtected(resolved, marker);
    if (folder) {
      return {
        decision: 'deny',
        reason:
          `escritura en "${resolved}" — carpeta protegida "${folder}" ` +
          `(marcador ${marker.markerPath}). Modo trabajo universitario: el ` +
          `entregable lo escribe el alumno, la IA senala problemas y orienta, ` +
          `no lo redacta. Desactivar a proposito: ULTRON_UNI_GUARD=off (esta ` +
          `sesion) o quita "${folder}" de "protegidas" en el marcador.`,
      };
    }
  }
  return null;
}

function handle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || '').replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || data.hook_event_name !== 'PreToolUse') return null;

  let veredicto;
  try {
    veredicto = classify(data);
  } catch (exc) {
    // FAIL-SAFE: un fallo propio no puede bloquear el trabajo del usuario.
    process.stderr.write(`uni-deliverable-guard: classify() fallo, dejando pasar: ${exc}\n`);
    return null;
  }
  if (!veredicto) return null;

  if (veredicto.decision === 'warn') {
    return JSON.stringify({
      systemMessage: `ULTRON uni-deliverable-guard [AVISO]: ${veredicto.reason}`,
    });
  }

  return JSON.stringify({
    systemMessage: `ULTRON uni-deliverable-guard [BLOQUEADO]: ${veredicto.reason}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOQUEADO (uni-deliverable-guard): ${veredicto.reason}`,
    },
  });
}

module.exports = { classify, handle, bashDestCandidates, destPathsFor };

if (require.main === module) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => {
    const out = handle(stdin);
    if (out) process.stdout.write(`${out}\n`);
    process.exit(0);
  });
}
