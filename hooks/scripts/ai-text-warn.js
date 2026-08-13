#!/usr/bin/env node
// hooks/scripts/ai-text-warn.js — PostToolUse (Write|Edit): aviso de texto-IA.
//
// Decidido por el usuario 2026-08-13 (card pp97cd): cuando se ESCRIBE prosa
// (.md/.tex/.txt/.rst), pasar el detector determinista de patrones de texto IA
// (mismo catálogo que el Lab del Control Center) y AVISAR al modelo si el texto
// recién escrito canta a IA — con patrón, señal y corrección del catálogo.
//
// Diseño:
//   - SÍNCRONO a propósito: un hook async descarta su stdout (ver
//     rules/common/hooks.md) y este existe para hablarle al modelo.
//   - Solo AVISA (additionalContext); nunca bloquea ni modifica nada.
//   - Analiza SOLO el texto nuevo (Write.content / Edit.new_string), no el
//     archivo entero: el aviso apunta a lo que se acaba de escribir.
//   - Exclusiones: memoria del asistente (~/.claude/projects/), el propio
//     catálogo/investigación (docs/research/) donde las señales se citan a
//     propósito, y scratchpads temporales.
//   - Fail-safe total: cualquier error → exit 0 sin output (jamás rompe un Write).

'use strict';

const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');
observe('ai-text-warn');

const PROSE_EXTENSIONS = new Set(['.md', '.tex', '.txt', '.rst']);
const EXCLUDED_PATH_PARTS = [
  '/.claude/projects/',   // memoria del asistente (no es prosa del usuario)
  '/docs/research/',      // catálogo e investigación: cita señales a propósito
  '/scratchpad/',
  '/node_modules/',
  '/.tmp/',
];
const MAX_EXAMPLES = 5;

function readStdinSync() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extractNewText(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolName === 'Write') return String(toolInput.content || '');
  if (toolName === 'Edit') {
    if (Array.isArray(toolInput.edits)) {
      return toolInput.edits.map((e) => String((e && e.new_string) || '')).join('\n');
    }
    return String(toolInput.new_string || '');
  }
  return '';
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readStdinSync() || '{}');
  } catch {
    return; // stdin ilegible → silencio
  }

  const toolName = payload.tool_name || payload.toolName || '';
  if (toolName !== 'Write' && toolName !== 'Edit') return;

  const toolInput = payload.tool_input || payload.toolInput || {};
  const filePath = String(toolInput.file_path || '');
  if (!filePath) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!PROSE_EXTENSIONS.has(ext)) return;

  const normalized = filePath.replace(/\\/g, '/');
  if (EXCLUDED_PATH_PARTS.some((part) => normalized.includes(part))) return;

  const text = extractNewText(toolName, toolInput);
  if (!text.trim()) return;

  const { scan } = require('./lib/ai-text-detector');
  const report = scan(text);
  if (!report.matches.length) return; // texto limpio → silencio total

  const examples = report.matches.slice(0, MAX_EXAMPLES).map((m) => {
    const fix = m.correction ? ` → ${m.correction}` : '';
    return `  - [${m.pattern}] ${m.rule} · "…${m.evidence}…"${fix}`;
  });
  const extra = report.matches.length > MAX_EXAMPLES
    ? `\n  (+${report.matches.length - MAX_EXAMPLES} señales más — pestaña Lab del Control Center para el detalle)`
    : '';

  const context =
    `[detector-IA] ${path.basename(filePath)}: ${report.matches.length} señal(es) de texto-IA ` +
    `en ${report.patterns_hit} patrón(es) — densidad ${report.density_per_100w.toFixed(1)}/100 palabras. ` +
    `El texto recién escrito puede CANTAR a IA:\n${examples.join('\n')}${extra}\n` +
    `Acción: reescribir las frases señaladas con las correcciones del catálogo antes de dar el texto por bueno.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: context,
      },
    }),
  );
}

try {
  main();
} catch (err) {
  try { logHookError('ai-text-warn', err); } catch { /* nunca romper el Write */ }
} finally {
  process.exitCode = 0;
}
