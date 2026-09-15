#!/usr/bin/env node
// hooks/scripts/lib/jsonl-tail.js — bounded tail reader for JSONL transcripts.
//
// PERF-03 (auditoria 2026-07-27): varios hooks leian el transcript ENTERO con
// readFileSync solo para quedarse con el tail (hay transcripts de >25 MB).
// Este helper lee SOLO los ultimos maxBytes (statSync + openSync + readSync),
// descarta la primera linea parcial del corte y devuelve las lineas completas.
// Con ficheros pequenos (size <= maxBytes) el resultado es identico al patron
// readFileSync + split(/\r?\n/). Fail-safe: cualquier error => [].

'use strict';

const fs = require('fs');

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Read the last `maxBytes` bytes of `filePath` and return its lines.
 * When the file is larger than maxBytes the first (partial) line of the cut
 * is discarded. Empty lines are NOT filtered — callers keep their own
 * `.filter(l => l.trim())` so behaviour matches the old full-read pattern.
 * @param {string} filePath
 * @param {number} [maxBytes]
 * @returns {string[]} lines ([] on any error)
 */
function readJsonlTail(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    const size = fs.statSync(filePath).size;
    if (!size) return [];
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    if (start > 0) {
      // Descarta la primera linea parcial del corte (y el posible multi-byte
      // UTF-8 troceado que viaja con ella).
      const nl = text.indexOf('\n');
      if (nl < 0) return [];
      text = text.slice(nl + 1);
    }
    return text.split(/\r?\n/);
  } catch (_) {
    return [];
  }
}

module.exports = { readJsonlTail, DEFAULT_MAX_BYTES };
