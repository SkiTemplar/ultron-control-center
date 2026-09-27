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

// ---------------------------------------------------------------------------
// Retencion por TIEMPO (2026-09-27). La rotacion de una generacion garantiza
// disco acotado pero no historia: hook-timing.jsonl pasaba de 1 MiB en 2-13 h
// segun la carga (un dia de agentes lo llena en menos de 2 h), asi que medir
// una semana de latencias era imposible. Aqui el fichero vivo rota a un
// archivo con fecha (<base>.<stamp>.jsonl) y los archivos se podan por EDAD,
// no por numero: la historia retenida no depende del ritmo de escritura.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Archivos rotados de <file>: <dir>/<base>.<stamp>.jsonl, del mas viejo al mas nuevo. */
function retainedArchives(file) {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file, '.jsonl');
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.\\d{8}T\\d{6}Z-\\d+\\.jsonl$');
    return fs
      .readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Todos los ficheros con historia de <file> (archivos + vivo), en orden cronologico. */
function retainedFiles(file) {
  const vivo = fs.existsSync(file) ? [file] : [];
  return [...retainedArchives(file), ...vivo];
}

/**
 * Rota <file> a un archivo con fecha cuando pasa de maxBytes y poda los
 * archivos con mas de retainDays. La poda solo corre al rotar (raro), nunca
 * en cada append. Fail-safe: dos procesos rotando a la vez -> uno gana el
 * rename y el otro lo ignora.
 */
function rotateRetained(file, maxBytes, retainDays, now = Date.now()) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return;
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const archive = path.join(
      path.dirname(file),
      `${path.basename(file, '.jsonl')}.${stamp}-${process.pid}.jsonl`
    );
    fs.renameSync(file, archive);
  } catch {
    return; // sin fichero que rotar, o rename perdido en una carrera
  }
  for (const a of retainedArchives(file)) {
    try {
      if (now - fs.statSync(a).mtimeMs > retainDays * DAY_MS) fs.unlinkSync(a);
    } catch {
      /* ya borrado por otro proceso */
    }
  }
}

/**
 * appendJsonl con retencion por edad: conserva al menos `retainDays` de
 * historia aunque el ritmo de escritura cambie. Never throws.
 * @param {string} file
 * @param {object} obj
 * @param {{maxBytes?: number, retainDays?: number}} [opts]
 */
function appendJsonlRetained(file, obj, opts = {}) {
  const maxBytes = opts.maxBytes || 4 * DEFAULT_MAX_BYTES;
  const retainDays = opts.retainDays || 8;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateRetained(file, maxBytes, retainDays);
    const rec = obj && typeof obj === 'object' && obj.ts ? obj : { ts: new Date().toISOString(), ...obj };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    /* logging must never break a hook */
  }
}

module.exports = {
  appendJsonl,
  rotateIfNeeded,
  DEFAULT_MAX_BYTES,
  appendJsonlRetained,
  rotateRetained,
  retainedFiles,
};
