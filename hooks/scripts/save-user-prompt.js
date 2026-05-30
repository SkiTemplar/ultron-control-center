#!/usr/bin/env node
/**
 * User prompt auto-saver — UserPromptSubmit hook.
 *
 * Problem: USER dice algo importante en una sesión y se pierde.
 * MEMORY.md solo se actualiza si Claude la guarda explícitamente,
 * pero muchas veces el knowledge crítico está SOLO en el mensaje
 * que USER escribió.
 *
 * Fix: este hook escribe cada UserPromptSubmit a un inbox markdown
 * agrupado por día. Skip mensajes triviales (< 30 chars). Marca
 * con etiquetas las frases con keywords críticos (recuerda, objetivo,
 * importante, siempre, nunca, no quiero, no me gusta).
 *
 * El inbox se procesa después (manualmente o via skill consolidate-memory)
 * para extraer lessons y promoverlas a MEMORY.md.
 *
 * Path: ~/.claude/memory/inbox/<YYYY-MM-DD>.md
 *
 * Fail-safe: cualquier error → exit(0). Nunca bloquea el envío.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const INBOX_DIR = path.join(HOME, '.claude', 'memory', 'inbox');
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'save-user-prompt.jsonl');

const MIN_PROMPT_CHARS = 30;
const MAX_PROMPT_CHARS = 4000;

const KEYWORDS = [
  'recuerda', 'recordar', 'objetivo', 'goal',
  'importante', 'critico', 'critical', 'crítico',
  'siempre', 'nunca', 'never', 'always',
  'no quiero', 'no me gusta', 'no me sirve',
  'preferencia', 'preferencia', 'preferences',
  'feedback', 'siempre que', 'cuando trabajes',
];

function safeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf8'
    );
  } catch (_) {
    /* ignore */
  }
}

function emitPayload() {
  // UserPromptSubmit hook doesn't need to return any context; just signal OK.
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
    }));
  } catch (_) {
    /* ignore */
  }
}

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function hhmm() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0');
}

function detectKeywords(prompt) {
  const hay = prompt.toLowerCase();
  const hits = [];
  for (const k of KEYWORDS) {
    if (hay.includes(k)) hits.push(k);
  }
  return Array.from(new Set(hits));
}

function appendEntry(prompt, tags, cwd) {
  const stamp = todayStamp();
  const file = path.join(INBOX_DIR, stamp + '.md');
  fs.mkdirSync(INBOX_DIR, { recursive: true });

  const isNew = !fs.existsSync(file);
  let block = '';
  if (isNew) {
    block += '# Inbox ' + stamp + '\n\n';
    block += 'Auto-saved user prompts. Process with `consolidate-memory` to promote relevant items to MEMORY.md.\n\n';
    block += '---\n\n';
  }

  block += '## ' + hhmm() + (tags.length ? ' [' + tags.join(', ') + ']' : '') + '\n';
  block += '*cwd: `' + (cwd || 'unknown') + '`*\n\n';

  const truncated = prompt.length > MAX_PROMPT_CHARS
    ? prompt.slice(0, MAX_PROMPT_CHARS) + '\n[truncated]'
    : prompt;
  block += truncated + '\n\n';

  fs.appendFileSync(file, block, 'utf8');
  return file;
}

function main() {
  const stdinRaw = readStdinSafe();
  let stdinPayload = {};
  try {
    stdinPayload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    return emitPayload();
  }

  const prompt = String(stdinPayload.prompt || stdinPayload.user_prompt || '').trim();
  if (!prompt) {
    safeLog({ level: 'debug', msg: 'empty_prompt' });
    return emitPayload();
  }
  if (prompt.length < MIN_PROMPT_CHARS) {
    safeLog({ level: 'debug', msg: 'short_prompt_skipped', len: prompt.length });
    return emitPayload();
  }

  // Skip prompts that are obviously commands or system noise.
  if (prompt.startsWith('/') && !prompt.includes(' ')) {
    safeLog({ level: 'debug', msg: 'slash_only_skipped' });
    return emitPayload();
  }

  const tags = detectKeywords(prompt);
  const cwd = process.cwd();

  try {
    const file = appendEntry(prompt, tags, cwd);
    safeLog({
      level: 'info',
      msg: 'saved',
      file,
      chars: prompt.length,
      tags,
      cwd,
    });
  } catch (err) {
    safeLog({ level: 'error', msg: 'write_failed', error: String(err && err.message) });
  }

  emitPayload();
}

try {
  main();
} catch (err) {
  safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
    }));
  } catch (_) {}
}

process.exitCode = 0;
