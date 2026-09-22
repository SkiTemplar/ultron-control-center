#!/usr/bin/env node
'use strict';

/**
 * markdown-lint-hint.js — PostToolUse (matcher: Write|Edit|MultiEdit): tras
 * escribir o editar un Markdown, corre `rumdl check <fichero>` (linter
 * instalado como uv tool, verificado 2026-09-22) y avisa al modelo si hay
 * avisos — SINCRONO a proposito: un hook async descarta su stdout (ver
 * rules/common/hooks.md), y este existe para hablarle al modelo.
 *
 * Cuando corre: la herramienta ya escribio a disco (PostToolUse), asi que se
 * lintea el FICHERO REAL, no el `content`/`new_string` del tool_input — eso
 * cubre MultiEdit sin tener que reconstruir el resultado final a mano.
 *
 * Silencio total (nunca bloquea el Write/Edit, solo additionalContext):
 *   - extension distinta de .md/.markdown
 *   - rumdl no esta instalado, no responde a tiempo (<=3s), o el fichero
 *     desaparecio entre el Write y este hook
 *   - la ruta cae bajo cockpit/ (config interna de ULTRON), node_modules/,
 *     ~/.claude/projects/<id>/memory/ (memoria del asistente), o es un
 *     transcript (sesion .jsonl o Markdown nombrado como un session id)
 *   - `rumdl check` no encontro avisos (exit 0)
 *
 * Fail-safe: cualquier error -> exit 0 sin output.
 * Opt-out: CLAUDE_NO_HOOKS=1.
 * Test: MARKDOWN_LINT_HINT_RUMDL_CMD (JSON array, p.ej. ["node","stub.js"])
 * sustituye el binario real por un stub hermetico.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');

const MD_EXT = new Set(['.md', '.markdown']);
const RUMDL_TIMEOUT_MS = 3000;
const MAX_LINES = 5;

// Rutas donde el aviso es ruido: config interna, dependencias, memoria del
// asistente. `MEMORY_DIR_RE`/`TRANSCRIPT_RE` se comprueban aparte porque
// dependen de un patron, no de un substring fijo.
const EXCLUDED_PATH_PARTS = ['/.ultron/cockpit/', '/node_modules/'];
const MEMORY_DIR_RE = /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/i;
const TRANSCRIPT_RE =
  /[\\/]transcripts?[\\/]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:md|markdown|jsonl)$/i;

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** True si la ruta cae en una de las exclusiones. Pura, testeada. */
function isExcludedPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (EXCLUDED_PATH_PARTS.some((part) => normalized.includes(part))) return true;
  if (MEMORY_DIR_RE.test(normalized)) return true;
  if (TRANSCRIPT_RE.test(normalized)) return true;
  return false;
}

/**
 * Parsea la salida de `rumdl check`: numero de avisos (de la linea resumen
 * "Issues: Found N issues…", con fallback a contar lineas de detalle) y las
 * lineas de detalle (sin el resumen ni el "Run `rumdl fmt`…"). Pura, testeada.
 */
function parseRumdlOutput(stdout) {
  const text = String(stdout || '');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^(Issues:|Run `rumdl)/.test(l));
  const m = text.match(/Found (\d+) issues?/);
  const count = m ? Number(m[1]) : lines.length;
  return { count, lines };
}

/** Comando a invocar para `rumdl`: override JSON (tests) o `["rumdl"]` real. */
function rumdlCommand() {
  const raw = process.env.MARKDOWN_LINT_HINT_RUMDL_CMD;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length && arr.every((s) => typeof s === 'string')) return arr;
    } catch {
      /* JSON invalido: cae al default */
    }
  }
  return ['rumdl'];
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
  );
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1') return;
  observe('markdown-lint-hint');

  let payload = {};
  try {
    payload = JSON.parse(readStdinSync() || '{}');
  } catch {
    return; // stdin ilegible -> silencio
  }

  const toolName = payload.tool_name || payload.toolName || '';
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return;

  const toolInput = payload.tool_input || payload.toolInput || {};
  const filePath = String(toolInput.file_path || '');
  if (!filePath) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!MD_EXT.has(ext)) return;
  if (isExcludedPath(filePath)) return;
  if (!fs.existsSync(filePath)) return; // el fichero desaparecio entre el Write y este hook

  const [bin, ...prefixArgs] = rumdlCommand();
  const result = spawnSync(bin, [...prefixArgs, 'check', filePath], {
    encoding: 'utf8',
    timeout: RUMDL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status === null) return; // rumdl no instalado o timeout -> silencio
  if (result.status === 0) return; // sin avisos

  const { count, lines } = parseRumdlOutput(result.stdout);
  if (!count) return;

  const context =
    `[rumdl] ${path.basename(filePath)}: ${count} aviso(s) de Markdown.\n` +
    lines.slice(0, MAX_LINES).join('\n');
  emit(context);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    try { logHookError('markdown-lint-hint', e); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = { isExcludedPath, parseRumdlOutput, rumdlCommand };
}
