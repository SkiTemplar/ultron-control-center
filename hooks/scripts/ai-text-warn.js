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
// Ficheros de INSTRUCCIONES del asistente: son configuracion en Markdown, no
// prosa entregable. El catalogo esta calibrado para texto academico (TFG), asi
// que aqui solo produce ruido — visto 2026-08-14, salto sobre CLAUDE.md marcando
// la negrita Markdown como "artefacto sin adaptar al formato destino".
const EXCLUDED_BASENAMES = new Set(['claude.md', 'agents.md', 'gemini.md']);
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
  if (EXCLUDED_BASENAMES.has(path.basename(normalized).toLowerCase())) return;

  const text = extractNewText(toolName, toolInput);
  if (!text.trim()) return;

  const { scan, MARKDOWN_NATIVE_PATTERNS } = require('./lib/ai-text-detector');
  // En destino .md la negrita y el guion largo son sintaxis del formato: avisar
  // de ellos es ruido y el ruido acaba en que se ignore el detector entero
  // (decidido 2026-08-14). El resto del catalogo sigue aplicandose igual.
  const report = scan(text, null, {
    skipPatterns: ext === '.md' ? MARKDOWN_NATIVE_PATTERNS : [],
  });
  // Solo las señales de rol "senal" disparan el aviso: un patrón "aviso"
  // (tricolon) dispara casi igual en prosa humana que en IA (medido
  // 2026-09-11, ver rol_nota del catálogo) y alarmar solo por él reentrena al
  // autor a ignorar el hook. Si NO hay ninguna señal, silencio total aunque
  // haya avisos sueltos.
  const senales = report.matches.filter((m) => m.rol !== 'aviso');
  const avisos = report.matches.filter((m) => m.rol === 'aviso');
  // Excepción: los patrones con "alerta" en el catálogo (caracteres invisibles)
  // se comunican siempre, haya o no señales (decidido por el usuario
  // 2026-09-16). Siguen sin contar para la densidad ni el veredicto.
  const alertas = avisos.filter((m) => m.alerta);
  if (!senales.length && !alertas.length) return; // sin señales ni alertas → silencio

  const alertaBlock = alertas.length
    ? `  Caracteres invisibles o espacios Unicode no estándar: ${alertas.length}.\n` +
      alertas
        .slice(0, MAX_EXAMPLES)
        .map((m) => `  - "…${visibilizar(m.evidence)}…" → ${m.correction}`)
        .join('\n') +
      '\n'
    : '';

  if (!senales.length) {
    emit(
      `[detector-IA] ${path.basename(filePath)}: sin señales de texto-IA, pero hay caracteres ocultos:\n` +
        `${alertaBlock}Acción: eliminarlos o sustituirlos por espacios normales.`,
    );
    return;
  }

  const examples = senales.slice(0, MAX_EXAMPLES).map((m) => {
    const fix = m.correction ? ` → ${m.correction}` : '';
    return `  - [${m.pattern}] ${m.rule} · "…${m.evidence}…"${fix}`;
  });
  const extra = senales.length > MAX_EXAMPLES
    ? `\n  (+${senales.length - MAX_EXAMPLES} señales más — pestaña Lab del Control Center para el detalle)`
    : '';
  const patronesSenal = new Set(senales.map((m) => m.pattern)).size;
  const avisoLine = avisos.length
    ? `\n  Avisos de estilo aparte (no cuentan como señal de IA): ${avisos.length}.`
    : '';

  const context =
    `[detector-IA] ${path.basename(filePath)}: ${senales.length} señal(es) de texto-IA ` +
    `en ${patronesSenal} patrón(es) — densidad ${report.density_per_100w.toFixed(2)}/100 palabras. ` +
    `El texto recién escrito puede CANTAR a IA:\n${examples.join('\n')}${extra}${avisoLine}\n` +
    alertaBlock +
    `Acción: reescribir las frases señaladas con las correcciones del catálogo antes de dar el texto por bueno.`;

  emit(context);
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

/** Sustituye cada carácter invisible por su código (⟦U+200B⟧) para que la evidencia se pueda leer. */
function visibilizar(texto) {
  return String(texto || '').replace(
    /[ ­ -‏‪-  -⁤⁦-⁩　]/g,
    (c) => `⟦U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`,
  );
}

try {
  main();
} catch (err) {
  try { logHookError('ai-text-warn', err); } catch { /* nunca romper el Write */ }
} finally {
  process.exitCode = 0;
}
