#!/usr/bin/env node
// hooks/scripts/posttoolfail-capture.js — PostToolUse + PostToolUseFailure hook
// (iter-10 FASE 6; dual-wired en masterplan 3.9).
//
// Cableado en DOS eventos que capturan clases COMPLEMENTARIAS de fallo:
//   - PostToolUse (matcher "*")       — fallos CON resultado: tool_response.is_error /
//                                        status=error / success=false / exit_code!=0.
//   - PostToolUseFailure (matcher "*") — fallos donde la tool NI ejecutó (permiso /
//                                        timeout / error de harness): payload sin
//                                        tool_response pero con `error` top-level.
// `detectError` cubre ambos shapes; en éxito (PostToolUse) retorna null -> no-op.
// Cuando hay fallo PROPONE un `error_resolution` candidate via `ultron-memory
// candidate` (writer_path = MemoryService — single writer).
// The candidate captures the failing tool + error snippet so a future session
// can recall "we hit this error before". Lands pending in the governed inbox;
// never auto-promoted.
//
// FAILURE DETECTION (conservative, to avoid noise):
//   - tool_response.is_error === true / status === "error" / success === false
//   - OR a top-level `error` string on the payload
//   - OR an exit/return code field that is a non-zero number
// Anything else is treated as success -> exit 0, no sidecar call, no write.
//
// NO-OP-SAFE: any failure exits 0 silently. A failed PostToolUse hook must
// never break the harness or block tool execution.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or POSTTOOLFAIL_CAPTURE_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
observe('posttoolfail-capture');

const HOME = os.homedir();
const MAX_ERROR_CHARS = 1200;
const MAX_INPUT_CHARS = 240;
const SIDECAR_TIMEOUT_MS = 10000;

// Tools cuyo campo `code` ES un exit code de proceso. En el resto (WebFetch y
// amigos HTTP) `code` es un status code: code:200 se capturo 4 veces como
// "Error en WebFetch: tool exit code 200" (fix 2026-07-02).
const SHELL_TOOLS_RE = /^(bash|powershell)$/i;

// Marcadores genericos que detectError emite cuando NO hubo stderr/mensaje real.
// Un candidato hecho SOLO de esto no aporta nada a una sesion futura.
const GENERIC_ONLY_RE = /^tool (reported is_error|status=error|success=false|exit code -?\d+)$/;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function findBinary() {
  const exe = process.platform === 'win32' ? 'ultron-memory.exe' : 'ultron-memory';
  if (process.env.ULTRON_MEMORY_BIN) {
    try {
      if (fs.existsSync(process.env.ULTRON_MEMORY_BIN)) return process.env.ULTRON_MEMORY_BIN;
    } catch (_) {}
  }
  const candidates = [
    path.join(HOME, '.ultron', 'bin', exe),
    path.join(HOME, '.ultron', 'control-center', 'src-tauri', 'target', 'release', exe),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

function projectName(cwd) {
  try {
    return path.basename(cwd || process.cwd()).replace(/^\.+/, '') || 'ultron';
  } catch (_) {
    return 'ultron';
  }
}

// Conservative failure detector. Returns an error string if the tool clearly
// failed, otherwise null (treated as success -> no-op).
function detectError(stdin) {
  const resp = stdin.tool_response || stdin.toolResponse || stdin.result || {};

  // Object-shaped responses with explicit error flags.
  if (resp && typeof resp === 'object') {
    if (resp.is_error === true || resp.isError === true) {
      return String(resp.error || resp.message || resp.stderr || 'tool reported is_error');
    }
    if (typeof resp.status === 'string' && resp.status.toLowerCase() === 'error') {
      return String(resp.error || resp.message || resp.stderr || 'tool status=error');
    }
    if (resp.success === false) {
      return String(resp.error || resp.message || resp.stderr || 'tool success=false');
    }
    // `exit_code` explicito es inequivoco en cualquier tool.
    const exit = resp.exit_code != null ? resp.exit_code : resp.exitCode;
    if (typeof exit === 'number' && exit !== 0) {
      return String(resp.stderr || resp.error || resp.message || `tool exit code ${exit}`);
    }
    // `code` a secas SOLO es exit code en tools de shell; sin is_error explicito
    // del harness, un `code` suelto en una tool no-shell no es señal de fallo.
    const toolName = String(stdin.tool_name || stdin.toolName || '');
    if (SHELL_TOOLS_RE.test(toolName) && typeof resp.code === 'number' && resp.code !== 0) {
      return String(resp.stderr || resp.error || resp.message || `tool exit code ${resp.code}`);
    }
  }

  // Top-level error string on the payload.
  if (typeof stdin.error === 'string' && stdin.error.trim()) {
    return stdin.error.trim();
  }

  return null;
}

// Gist del input de la tool (comando/url/ruta/query...) — el "QUE se intento",
// sin el cual una memoria de error no es accionable ("Error en la web" a secas).
function inputGist(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const raw =
    toolInput.command ||
    toolInput.url ||
    toolInput.file_path ||
    toolInput.query ||
    toolInput.pattern ||
    toolInput.prompt ||
    '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

// Construye el candidato de memoria, o null si no debe proponerse nada.
// GATE DE INFORMATIVIDAD (2026-07-02): un fallo sin sustancia (solo el marcador
// generico, sin stderr/mensaje) no se memoriza — recordar humo es peor que no
// recordar. Cuando SI hay señal, el contenido lleva tool + input + error.
function buildCandidate(stdin) {
  const errText = detectError(stdin);
  if (!errText) return null;
  if (GENERIC_ONLY_RE.test(errText.trim())) return null;

  const toolName = stdin.tool_name || stdin.toolName || 'unknown_tool';
  const input = inputGist(stdin.tool_input || stdin.toolInput);
  const clipped = errText.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS);

  return {
    type: 'error_resolution',
    scope: 'project',
    title: `Fallo de ${toolName}`,
    summary: `Error en ${toolName}${input ? ` (${input.slice(0, 80)})` : ''}: ${clipped.slice(0, 180)}`,
    content: `tool=${toolName}\n${input ? `input=${input}\n` : ''}error=${clipped}`,
    confidence: 0.6,
    source: 'posttoolfail-capture',
    capture_source: 'posttoolfail-capture',
    recommended_action: 'review',
  };
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.POSTTOOLFAIL_CAPTURE_DISABLED === '1') {
    return;
  }

  const raw = readStdin();
  let stdin = {};
  try {
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return; // bad payload -> nothing to do
  }

  // SUCCESS o fallo sin sustancia: exit 0, no sidecar call, no write.
  const candidate = buildCandidate(stdin);
  if (!candidate) return;

  const bin = findBinary();
  if (!bin) return;

  const cwd = stdin.cwd || process.cwd();
  const project = projectName(cwd);

  try {
    spawnSync(bin, ['candidate', '--project', project], {
      input: JSON.stringify(candidate),
      encoding: 'utf8',
      timeout: SIDECAR_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (_) {
    // sidecar failure must never break PostToolUse
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
    logHookError('posttoolfail-capture', e);
  }
  process.exitCode = 0;
}

// Exportado para el check conductual (scripts/posttoolfail-capture.selftest.mjs).
module.exports = { detectError, buildCandidate };
