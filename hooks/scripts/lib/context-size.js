'use strict';

/**
 * lib/context-size.js — tamano del contexto de una sesion de Claude Code y
 * resumen barato de su actividad reciente, leyendo SOLO la cola del transcript
 * (hay transcripts de decenas de MB; context-guard corre en cada prompt).
 *
 * Contexto actual = `usage` del ultimo mensaje assistant del hilo principal:
 * input_tokens + cache_read_input_tokens + cache_creation_input_tokens (lo que
 * se envio al modelo en esa llamada). Si despues hay un `compact_boundary`,
 * manda su `compactMetadata.postTokens`: tras /compact el ultimo `usage` es el
 * de ANTES de compactar y bloquearia el primer prompt de un contexto ya limpio.
 *
 * Fail-safe: cualquier error -> null (el llamante calla).
 */

const fs = require('fs');

const TAIL_STEPS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];

/** Ultimos `maxBytes` del fichero como lineas completas (descarta la primera parcial). */
function tailLines(file, maxBytes) {
  const size = fs.statSync(file).size;
  if (!size) return { lines: [], whole: true };
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return { lines, whole: start === 0 };
}

function usageTotal(u) {
  if (!u || typeof u !== 'object') return 0;
  return (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
}

/**
 * Busca hacia atras la ultima senal de tamano en `lines`.
 * @returns {{tokens:number, source:'usage'|'compact'}|null}
 */
function scanLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    // Filtro textual antes de JSON.parse: la mayoria de lineas no interesan.
    const isUsage = l.includes('"usage"') && l.includes('"assistant"');
    const isCompact = l.includes('"compact_boundary"');
    if (!isUsage && !isCompact) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const post = Number(o.compactMetadata && o.compactMetadata.postTokens);
      if (post > 0) return { tokens: post, source: 'compact' };
      continue;
    }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const m = o.message || {};
    if (m.model === '<synthetic>') continue; // errores/limites: usage a cero
    const t = usageTotal(m.usage);
    if (t > 0) return { tokens: t, source: 'usage' };
  }
  return null;
}

/**
 * Contexto actual de la sesion en tokens, o null si no se puede saber.
 * Lee 256 KB de cola; solo amplia si ahi no hay ningun mensaje con usage
 * (p.ej. un tool_result enorme justo al final).
 */
function currentContextTokens(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    for (const step of TAIL_STEPS) {
      const { lines, whole } = tailLines(transcriptPath, step);
      const hit = scanLines(lines);
      if (hit) return hit;
      if (whole) return null;
    }
  } catch {
    /* fail-safe */
  }
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Actividad reciente para el evaluador: ultimos prompts reales del usuario,
 * recuento de herramientas y ficheros tocados. Solo la cola (2 MB).
 */
function recentActivity(transcriptPath, opts = {}) {
  const maxPrompts = opts.maxPrompts || 8;
  const promptChars = opts.promptChars || 400;
  const out = { prompts: [], tools: {}, files: [], commands: [] };
  let lines;
  try {
    ({ lines } = tailLines(transcriptPath, opts.maxBytes || 2 * 1024 * 1024));
  } catch {
    return out;
  }
  const files = new Set();
  for (const l of lines) {
    if (!l) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.isSidechain || o.isMeta) continue;
    const content = o.message && o.message.content;
    if (o.type === 'user') {
      const hasToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
      const text = textOf(content).trim();
      if (!hasToolResult && text && !text.startsWith('<')) out.prompts.push(text.slice(0, promptChars));
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        out.tools[b.name] = (out.tools[b.name] || 0) + 1;
        const inp = b.input || {};
        const f = inp.file_path || inp.notebook_path || inp.path;
        if (typeof f === 'string') {
          files.delete(f);
          files.add(f);
        }
        if (b.name === 'Bash' && typeof inp.command === 'string') out.commands.push(inp.command.slice(0, 120));
      }
    }
  }
  out.prompts = out.prompts.slice(-maxPrompts);
  out.files = [...files].slice(-25);
  out.commands = out.commands.slice(-8);
  return out;
}

module.exports = { currentContextTokens, recentActivity, scanLines, usageTotal, tailLines };
