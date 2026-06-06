#!/usr/bin/env node
/**
 * Stop hook → sync session to mem0 (cloud memory MCP).
 *
 * Reads JSON payload from stdin (Claude Code Stop hook contract):
 *   { session_id, transcript_path, cwd, hook_event_name, ... }
 *
 * Extracts:
 *   - Last 5 user messages from transcript JSONL
 *   - List of files modified in this session (Edit/Write tool_use entries)
 *
 * Posts to mem0 via JSON-RPC `add_memory` (singular). API key read from
 * ~/.claude/settings.json → mcpServers.mem0.headers.Authorization.
 *
 * Failure mode: any error logged to ~/.claude/logs/mem0-sync.jsonl, exit(0).
 * Hook MUST NOT block the session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { URL } = require('url');

const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'mem0-sync.jsonl');
const MEM0_URL = 'https://mcp.mem0.ai/mcp/';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_USER_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 1200;
const MAX_FILES_TRACKED = 40;
const MAX_TEXT_CHARS = 8000;

function safeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {
    // Swallow — never fail the hook for logging.
  }
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// Lee MEM0_API_KEY de ~/.ultron/.env (sin dependencias). Devuelve '' si no.
function tokenFromUltronEnv() {
  try {
    const p = require('path').join(require('os').homedir(), '.ultron', '.env');
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/^\s*MEM0_API_KEY\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch (_) {
    return '';
  }
}

function loadApiToken() {
  // Fuentes en orden de prioridad:
  //   1. settings.json -> mcpServers.mem0.{headers.Authorization | env.MEM0_API_KEY}
  //   2. process.env.MEM0_API_KEY (el hook hereda el entorno de usuario)
  //   3. ~/.ultron/.env (el .env que lee el backend Tauri via dotenvy)
  // Antes solo miraba (1), por eso decia "no token" aunque la key estuviera
  // en el entorno/.env (fix 2026-05-30).
  let token = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const mem0 = (cfg && cfg.mcpServers && cfg.mcpServers.mem0) || {};
    const headers = mem0.headers || {};
    const env = mem0.env || {};
    token = headers.Authorization || headers.authorization || env.MEM0_API_KEY || '';
  } catch (err) {
    safeLog({ level: 'warn', msg: 'failed_to_load_settings', error: String(err && err.message) });
  }
  if (!String(token).trim()) token = process.env.MEM0_API_KEY || '';
  if (!String(token).trim()) token = tokenFromUltronEnv();

  token = String(token).trim();
  if (!token) return null;
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, '').trim();
  return token;
}

function clamp(str, max) {
  const s = String(str == null ? '' : str);
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function asciiSanitize(str) {
  // mem0 server has returned 500s on some non-ASCII byte sequences.
  // Keep printable ASCII + common whitespace; replace the rest with a space.
  return String(str || '').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ');
}

// ---------------------------------------------------------------------------
// Secret redaction (card-sec-mem0-project-optout)
// ---------------------------------------------------------------------------
//
// Everything posted to Mem0 leaves the machine for a third-party cloud. User
// prompts and tool I/O can contain pasted API keys, JWTs, IBANs or card
// numbers. We strip those BEFORE building the request body. Mirrors (and
// extends with IBAN/JWT/Luhn) the patterns in
// ~/.ultron/scripts/cockpit/secrets_scanner.py.

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS = [
  // PEM private key blocks FIRST (multi-line, before single-line patterns).
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI (incl. sk-proj-/sk-ant-) & generic sk-
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub PAT / OAuth / refresh / server
  /m0-[A-Za-z0-9_-]{20,}/g, // Mem0
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /whsec_[A-Za-z0-9]{16,}/g, // Stripe webhook secret
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /(?:SK|AC)[0-9a-fA-F]{32}/g, // Twilio
  /dop_v1_[a-f0-9]{64}/g, // DigitalOcean
  /(?:secret_[A-Za-z0-9]{40,}|ntn_[A-Za-z0-9]{20,})/g, // Notion
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, // IBAN
];

function redactSecrets(input) {
  let s = String(input == null ? '' : input);
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, '[REDACTED]');
  }
  // Credit-card-like digit runs: redact only when Luhn-valid to avoid eating
  // ordinary long numbers (timestamps, ids, hashes of digits).
  s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return luhnValid(digits) ? '[REDACTED]' : m;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Per-project opt-out (card-sec-mem0-project-optout)
// ---------------------------------------------------------------------------
//
// A project listed here NEVER syncs to Mem0 cloud. Financial projects are
// opted out by DEFAULT so they stay private even if the user never creates the
// config file. Extra projects / cwd regexes come from
// ~/.ultron/.mem0-opt-out.json: { "projects": [], "cwd_patterns": [] }.

const OPT_OUT_PATH = path.join(HOME, '.ultron', '.mem0-opt-out.json');
const DEFAULT_OPT_OUT_PROJECTS = ['bank', 'finanzas', 'finance'];
// basename matching misses C:/x/Bank-personal/subdir (basename=subdir). Match
// any path segment that looks financial as a default cwd regex too.
const DEFAULT_OPT_OUT_CWD_PATTERNS = [
  '[\\\\/](bank|finanzas|finance|tax|payroll|salary|nomina|hacienda)[\\\\/-]',
];

function loadOptOut() {
  let projects = DEFAULT_OPT_OUT_PROJECTS.slice();
  let cwdPatterns = DEFAULT_OPT_OUT_CWD_PATTERNS.slice();
  try {
    const cfg = JSON.parse(fs.readFileSync(OPT_OUT_PATH, 'utf8'));
    if (Array.isArray(cfg.projects)) {
      projects = projects.concat(cfg.projects.map((p) => String(p)));
    }
    if (Array.isArray(cfg.cwd_patterns)) {
      // concat (not overwrite) so user patterns ADD to the financial defaults.
      cwdPatterns = cwdPatterns.concat(cfg.cwd_patterns.map((p) => String(p)));
    }
  } catch (_) {
    // No file (or malformed) — defaults still apply.
  }
  return {
    projects: projects.map((p) => p.toLowerCase()),
    cwd_patterns: cwdPatterns,
  };
}

function isOptedOut(project, cwd, optOut) {
  const proj = String(project || '').toLowerCase();
  if (optOut.projects.includes(proj)) return true;
  const c = String(cwd || '');
  for (const pat of optOut.cwd_patterns) {
    try {
      if (new RegExp(pat, 'i').test(c)) return true;
    } catch (err) {
      // Don't crash the hook on a bad user regex, but DO surface it — a silent
      // skip would give a false sense of opt-out.
      safeLog({ level: 'warn', msg: 'invalid_cwd_pattern', pattern: pat, error: String(err && err.message) });
    }
  }
  return false;
}

function extractContentString(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'tool_result' && part.content) {
          return extractContentString(part.content);
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function parseTranscript(transcriptPath) {
  const userMessages = [];
  const filesTouched = new Set();

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { userMessages, filesTouched: [] };
  }

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    safeLog({ level: 'warn', msg: 'transcript_read_failed', error: String(err && err.message) });
    return { userMessages, filesTouched: [] };
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    const message = entry.message || entry;
    const role = message && message.role;

    if (role === 'user' && message.content) {
      const text = extractContentString(message.content).trim();
      // Skip synthetic system reminders / tool results wrapped as user role.
      if (
        text &&
        !text.startsWith('<system-reminder>') &&
        !text.startsWith('<command-name>') &&
        !text.startsWith('[Request interrupted')
      ) {
        userMessages.push(clamp(text, MAX_MESSAGE_CHARS));
      }
    }

    if (role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || part.type !== 'tool_use') continue;
        const toolName = String(part.name || '').toLowerCase();
        if (toolName !== 'edit' && toolName !== 'write' && toolName !== 'multiedit') continue;
        const input = part.input || {};
        const fp = input.file_path || input.filePath || input.path;
        if (typeof fp === 'string' && fp) {
          filesTouched.add(fp);
        }
      }
    }
  }

  const recentUser = userMessages.slice(-MAX_USER_MESSAGES);
  return {
    userMessages: recentUser,
    filesTouched: Array.from(filesTouched).slice(0, MAX_FILES_TRACKED),
  };
}

function detectProjectName(cwd) {
  if (!cwd) return 'unknown';
  return path.basename(cwd);
}

function buildMemoryText(payload, extracted) {
  const cwd = payload.cwd || process.cwd() || '';
  const project = detectProjectName(cwd);
  const sessionId = payload.session_id || 'unknown';

  const lines = [];
  lines.push(`Claude Code session summary (project: ${project}, session: ${sessionId})`);
  lines.push(`Worktree: ${cwd}`);

  if (extracted.userMessages.length) {
    lines.push('');
    lines.push('Recent user prompts:');
    extracted.userMessages.forEach((msg, idx) => {
      lines.push(`${idx + 1}. ${msg.replace(/\s+/g, ' ').trim()}`);
    });
  }

  if (extracted.filesTouched.length) {
    lines.push('');
    lines.push('Files modified:');
    for (const file of extracted.filesTouched) {
      lines.push(`- ${file}`);
    }
  }

  // Redact secrets BEFORE clamping/sanitising so a key split across the clamp
  // boundary can't survive, then ascii-sanitise for the mem0 server.
  return asciiSanitize(clamp(redactSecrets(lines.join('\n')), MAX_TEXT_CHARS));
}

function postToMem0(token, body) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let url;
    try {
      url = new URL(MEM0_URL);
    } catch (err) {
      finish({ ok: false, error: 'invalid_url: ' + (err && err.message) });
      return;
    }

    const data = Buffer.from(body, 'utf8');
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + (url.search || ''),
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json, text/event-stream',
        'Content-Length': data.length,
        'User-Agent': 'claude-mem0-sync/1.0',
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: clamp(text, 1500),
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', (err) => {
      finish({ ok: false, error: String(err && err.message) });
    });

    req.write(data);
    req.end();
  });
}

async function main() {
  const stdinRaw = readStdinSync();
  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (err) {
    safeLog({ level: 'warn', msg: 'stdin_parse_failed', error: String(err && err.message) });
  }

  const token = loadApiToken();
  if (!token) {
    // KIRKARDO R11.2 FIX-8: degradar a silent-skip cuando Mem0 nunca se ha
    // configurado. Antes spameaba "mem0_token_missing" en cada Stop hook,
    // ensuciando logs y dando la impresión de un error real. Si el usuario
    // decide activar Mem0 en el futuro: setear MEM0_API_KEY en
    // ~/.ultron/.env (loaded por dotenvy) o exportarlo al shell. Logueo
    // info-level una vez por proceso para que el opt-in quede trazable.
    if (!process.env.MEM0_DISABLED && !global.__mem0SkipLogged) {
      global.__mem0SkipLogged = true;
      safeLog({
        level: 'info',
        msg: 'mem0_disabled_no_token',
        hint: 'Set MEM0_API_KEY in ~/.ultron/.env to enable cloud memory sync',
      });
    }
    return;
  }

  // Per-project opt-out: financial projects (and anything in
  // ~/.ultron/.mem0-opt-out.json) never leave the machine. Checked BEFORE we
  // even read the transcript so opted-out projects do zero work and zero I/O.
  const cwdEarly = payload.cwd || process.cwd() || '';
  const projectEarly = detectProjectName(cwdEarly);
  if (isOptedOut(projectEarly, cwdEarly, loadOptOut())) {
    safeLog({
      level: 'info',
      msg: 'opted_out_by_project',
      project: projectEarly,
      session_id: payload.session_id || null,
    });
    return;
  }

  const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
  const extracted = parseTranscript(transcriptPath);

  if (extracted.userMessages.length === 0 && extracted.filesTouched.length === 0) {
    safeLog({
      level: 'info',
      msg: 'no_content_to_sync',
      session_id: payload.session_id || null,
    });
    return;
  }

  const text = buildMemoryText(payload, extracted);
  const project = detectProjectName(payload.cwd || process.cwd() || '');

  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'add_memory',
      arguments: {
        text,
        user_id: 'default',
        metadata: {
          session_id: payload.session_id || 'unknown',
          project,
          cwd: redactSecrets(payload.cwd || ''),
          source: 'claude-code-stop-hook',
          hook_event: payload.hook_event_name || 'Stop',
          ts: new Date().toISOString(),
        },
      },
    },
  });

  const result = await postToMem0(token, requestBody);

  safeLog({
    level: result.ok ? 'info' : 'error',
    msg: result.ok ? 'mem0_sync_ok' : 'mem0_sync_failed',
    session_id: payload.session_id || null,
    project,
    user_messages: extracted.userMessages.length,
    files: extracted.filesTouched.length,
    text_chars: text.length,
    status: result.status || null,
    error: result.error || null,
    body_preview: result.body || null,
  });
}

function run() {
  // Hard cap on runtime; never block Stop.
  const watchdog = setTimeout(() => {
    safeLog({ level: 'warn', msg: 'watchdog_exit' });
    process.exit(0);
  }, REQUEST_TIMEOUT_MS + 3000);
  watchdog.unref();

  main()
    .catch((err) => {
      safeLog({ level: 'error', msg: 'unhandled_exception', error: String(err && err.message) });
    })
    .finally(() => {
      process.exitCode = 0;
    });
}

// Only auto-run as a hook; when `require`d (tests) just expose the internals.
if (require.main === module) {
  run();
}

module.exports = {
  redactSecrets,
  luhnValid,
  loadOptOut,
  isOptedOut,
  buildMemoryText,
  detectProjectName,
  DEFAULT_OPT_OUT_PROJECTS,
};
