#!/usr/bin/env node
/**
 * response-meter.js — Stop hook (async). ULTRON 4, F4.2/7.3: mide la
 * respuesta que acaba de terminar y la registra en logs/response-meter.jsonl.
 *
 * Toma del transcript todo el texto del asistente posterior al ultimo mensaje
 * humano (lo que el usuario lee en el turno, incluidos los textos intermedios
 * entre herramientas), lo mide con lib/response-meter.measure y apunta una
 * linea. No habla al modelo: la cifra la pinta el resume de SessionStart.
 *
 * Fail-safe: exit 0 siempre; traza de errores en hook-errors.jsonl.
 * Override (selftest): RESPONSE_METER_PROJECT, RESPONSE_METER_LOG.
 */
'use strict';

const fs = require('fs');
const { observe, logHookError } = require('./lib/hook-obs');
const { projectIdFromCwd } = require('./lib/ultron-memory-cli');
const { isSystemTurnPrompt } = require('./lib/system-turn');
const meter = require('./lib/response-meter');

observe('response-meter');

const TAIL_BYTES = 2 * 1024 * 1024;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function readTail(p) {
  let fd = null;
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* nada */ }
    }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ');
}

function isHuman(message) {
  if (!message || message.role !== 'user' || !message.content) return false;
  if (Array.isArray(message.content) && message.content.some((p) => p && p.type === 'tool_result')) return false;
  const text = textOf(message.content).trim();
  if (!text || isSystemTurnPrompt(text)) return false;
  return !(/^<system-reminder>|^<command-name>|^\[Request interrupted|^<local-command-stdout>/.test(text));
}

// Texto del asistente del turno que termina (tras el ultimo mensaje humano).
function lastTurnText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  const entries = [];
  for (const line of readTail(transcriptPath).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch (_) { /* linea partida */ }
  }
  let lastHuman = -1;
  for (let i = 0; i < entries.length; i++) {
    if (isHuman(entries[i].message || entries[i])) lastHuman = i;
  }
  const parts = [];
  for (let i = lastHuman + 1; i < entries.length; i++) {
    const m = entries[i].message || entries[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) parts.push(p.text.trim());
    }
  }
  return parts.join('\n');
}

function main() {
  const payload = readStdin();
  const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
  const text = lastTurnText(transcriptPath);
  if (!text) return;
  const cwd = payload.cwd || process.cwd();
  const project = process.env.RESPONSE_METER_PROJECT || projectIdFromCwd(cwd) || null;
  meter.appendEntry({
    ts: new Date().toISOString(),
    session_id: payload.session_id || 'unknown',
    project,
    ...meter.measure(text),
  });
}

try {
  main();
} catch (err) {
  logHookError('response-meter', err);
} finally {
  process.exitCode = 0;
}
