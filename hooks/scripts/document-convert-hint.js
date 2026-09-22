#!/usr/bin/env node
'use strict';

/**
 * document-convert-hint.js — PreToolUse (matcher: Read): cuando el fichero a
 * leer es un binario que `Read` no interpreta bien (.docx/.pptx/.xlsx/.epub,
 * o un .pdf de mas de 5 MB) sugiere `markitdown "<ruta>"` (CLI instalada
 * como uv tool, verificado 2026-09-22) para convertirlo a Markdown por
 * stdout ANTES de leerlo. SINCRONO a proposito: un hook async descarta su
 * stdout (ver rules/common/hooks.md).
 *
 * NUNCA bloquea: solo additionalContext, el propio Read sigue su curso (y
 * fallara o devolvera basura binaria por su cuenta si el modelo lo ignora,
 * que es la senal que ya tenia antes de este hook).
 *
 * Un .pdf pequeño (<=5MB) no dispara el aviso: Read ya maneja PDFs
 * razonablemente via su extractor de texto; el umbral es para los que se
 * quedarian a medias o gastarian de mas.
 *
 * Fail-safe: cualquier error -> exit 0 sin output.
 * Opt-out: CLAUDE_NO_HOOKS=1.
 */

const fs = require('fs');
const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');

const OFFICE_EXT = new Set(['.docx', '.pptx', '.xlsx', '.epub']);
const PDF_SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Decide si el fichero merece el aviso. Pura, testeada: `sizeBytes` puede
 * ser `NaN` (stat fallido) — un .pdf sin tamano legible NUNCA dispara, solo
 * los office/epub que no dependen del tamano.
 */
function shouldSuggestMarkitdown(filePath, sizeBytes) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (OFFICE_EXT.has(ext)) return true;
  if (ext === '.pdf' && Number.isFinite(sizeBytes) && sizeBytes > PDF_SIZE_THRESHOLD_BYTES) return true;
  return false;
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: context,
      },
    }),
  );
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1') return;
  observe('document-convert-hint');

  let payload = {};
  try {
    payload = JSON.parse(readStdinSync() || '{}');
  } catch {
    return; // stdin ilegible -> silencio
  }

  const toolName = payload.tool_name || payload.toolName || '';
  if (toolName !== 'Read') return;

  const toolInput = payload.tool_input || payload.toolInput || {};
  const filePath = String(toolInput.file_path || '');
  if (!filePath) return;

  let sizeBytes = NaN;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    return; // fichero inexistente/inaccesible: deja que Read falle por su cuenta
  }

  if (!shouldSuggestMarkitdown(filePath, sizeBytes)) return;

  const context =
    `[markitdown] ${path.basename(filePath)} es un documento binario que Read no interpreta ` +
    `bien. Antes de leerlo, considera: markitdown "${filePath}" (convierte PDF/DOCX/PPTX/XLSX/` +
    'HTML/EPUB a Markdown por stdout).';
  emit(context);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    try { logHookError('document-convert-hint', e); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = { shouldSuggestMarkitdown, PDF_SIZE_THRESHOLD_BYTES };
}
