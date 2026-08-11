#!/usr/bin/env node
/**
 * ULTRON HOOK · deny-secrets · v2.0 (port Node del deny-secrets.py v1.0)
 *
 * PreToolUse hook that blocks Read / Edit / Write / NotebookEdit / Bash access
 * to credential files: .env, private keys / keystores, anything under an
 * `.ssh/` directory, `~/.aws/credentials`, and `secrets.json` /
 * `credentials.json` / `service-account*.json`.
 *
 * Critical when ULTRON runs with `--dangerously-skip-permissions`: it is the
 * tripwire that stops an agent from reading the user's secrets.
 *
 * Port 2026-08-11 (audit 08-09 #4): reescrito de Python a Node para eliminar
 * los ~200ms de arranque `uv run python` que pagaba CADA tool call del matcher
 * (Read|Edit|Write|NotebookEdit|Bash, hook sincrono en el hot path). Mismas
 * reglas y mismo contrato JSON que el .py; el selftest hermano
 * (deny-secrets.selftest.mjs) fija el comportamiento con casos deny Y allow.
 *
 * Design — SPECIFIC patterns, not a generic `*secret*` substring. A substring
 * match would flag legit code (`secrets_scanner.py`) and blow the "<1% false
 * positive" target. Every rule targets a real credential-file shape.
 *
 * Defense in depth — single-user offline system; this is a tripwire, NOT a
 * primary boundary. The hook never throws and always exits 0.
 */

'use strict';

// Tools whose tool_input carries a file path.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

// Extensions that are private keys / keystores by definition.
const KEY_EXTS = new Set(['pem', 'pfx', 'p12', 'key', 'keystore', 'jks']);

// .env.<x> suffixes that are SAFE — examples / templates carry no real secret.
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

// SSH private-key basename prefixes.
const SSH_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'];

// Exact credential-file basenames (dotfile variants included).
const CRED_BASENAMES = new Set([
  'secrets.json',
  'credentials.json',
  '.secrets.json',
  '.credentials.json',
]);

/** Return a block reason for a credential file path, or null if safe. */
function classifyPath(p) {
  if (!p || typeof p !== 'string') return null;
  const norm = p
    .replace(/\\/g, '/')
    .trim()
    .replace(/^["']+|["']+$/g, '');
  if (!norm) return null;
  const segments = norm.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const basename = segments[segments.length - 1];
  const baseLow = basename.toLowerCase();
  const segLow = new Set(segments.map((s) => s.toLowerCase()));
  const ext = baseLow.includes('.') ? baseLow.split('.').pop() : '';

  // 1. .env credential file (but NOT .env.example / .sample / .template)
  if (baseLow === '.env' || baseLow.startsWith('.env.')) {
    if (!SAFE_ENV_SUFFIXES.some((s) => baseLow.endsWith(s))) {
      return 'dotenv credential file';
    }
  }

  // 2. private key / keystore by extension
  if (KEY_EXTS.has(ext)) return `private key / keystore (.${ext})`;

  // 3. SSH private key by basename
  if (SSH_KEY_PREFIXES.some((pre) => baseLow.startsWith(pre))) {
    return 'SSH private key';
  }

  // 4. anything inside an .ssh directory
  if (segLow.has('.ssh')) return 'file inside an .ssh directory';

  // 5. ~/.aws/credentials
  if (segLow.has('.aws') && baseLow === 'credentials') {
    return 'AWS credentials file';
  }

  // 6. secrets.json / credentials.json / service-account*.json
  if (CRED_BASENAMES.has(baseLow)) return 'credentials/secrets file';
  if (baseLow.startsWith('service-account') && ext === 'json') {
    return 'service-account key file';
  }

  return null;
}

/** Scan a shell command for tokens that reference a credential file. */
function classifyBash(command) {
  if (!command || typeof command !== 'string') return null;
  for (const raw of command.split(/\s+/).filter(Boolean)) {
    const token = raw.replace(/^["';|&<>()`]+|["';|&<>()`]+$/g, '');
    // Only treat path-ish tokens as candidates (skip bare flags/words).
    if (!token.includes('/') && !token.startsWith('.')) continue;
    const reason = classifyPath(token);
    if (reason) return `command accesses a ${reason}`;
  }
  return null;
}

/** Return a block reason for this tool call, or null if it is allowed. */
function classify(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (FILE_TOOLS.has(toolName)) {
    const p = toolInput.file_path || toolInput.notebook_path || '';
    return classifyPath(p);
  }
  if (toolName === 'Bash') return classifyBash(toolInput.command || '');
  return null;
}

function handle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || '').replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || data.hook_event_name !== 'PreToolUse') {
    return null;
  }

  let reason;
  try {
    reason = classify(data.tool_name || '', data.tool_input || {});
  } catch (exc) {
    // Fail-CLOSED: this is a security gate. If the classifier itself crashes
    // we cannot prove the access is safe, so we DENY rather than silently
    // letting the call through. The catch still swallows the exception so
    // the hook never crashes the tool flow.
    process.stderr.write(`deny-secrets: classify() threw, failing closed: ${exc}\n`);
    reason = 'classifier error (failing closed for safety)';
  }

  if (!reason) return null;
  return JSON.stringify({
    systemMessage:
      `ULTRON deny-secrets blocked: ${reason}. Credential files are ` +
      `off-limits to the agent — open it from a manual shell if ` +
      `genuinely needed.`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `BLOCKED (deny-secrets): ${reason}`,
    },
  });
}

// Export para el selftest; ejecucion real solo como script principal.
module.exports = { classify, classifyPath, classifyBash, handle };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    const out = handle(raw);
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
  });
}
