#!/usr/bin/env node
// hooks/scripts/lib/jsonl-log.js — shared bounded JSONL appender (cat15.4).
//
// Single source of truth for "append one JSONL record, with size-based log
// rotation". Replaces the copy-pasted rotateLogIfNeeded() that several hooks
// reimplemented locally and that the rest lacked entirely (so their .jsonl grew
// without bound). Pure Node stdlib, fully fail-safe: logging must NEVER throw or
// break a hook body.
//
// Rotation policy: single generation. When <file> exceeds maxBytes it is renamed
// to <file>.1 (overwriting the previous .1). Bounded disk = at most 2x maxBytes
// per stream. Matches the existing notify-relay/subagent-harvest convention.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Rotate <file> -> <file>.1 when it exceeds maxBytes. Fail-safe (no throw). */
function rotateIfNeeded(file, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return;
    fs.renameSync(file, file + '.1');
  } catch {
    /* missing file (nothing to rotate) or rename race -> ignore */
  }
}

/**
 * Append one JSONL record to <file>, rotating first if oversized. A `ts` ISO
 * timestamp is added when the record lacks one. Never throws.
 * @param {string} file       absolute path to the .jsonl
 * @param {object} obj        record to serialize
 * @param {number} [maxBytes] rotation threshold (default 1 MiB)
 */
function appendJsonl(file, obj, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, maxBytes);
    const rec = obj && typeof obj === 'object' && obj.ts ? obj : { ts: new Date().toISOString(), ...obj };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    /* logging must never break a hook */
  }
}

module.exports = { appendJsonl, rotateIfNeeded, DEFAULT_MAX_BYTES };
