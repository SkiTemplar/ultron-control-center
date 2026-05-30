#!/usr/bin/env node
/**
 * SessionStart hook — semantic recall context from Qdrant.
 *
 * KIRKARDO Round 7 fix #3: replaces the `/scroll` payload-filter path with
 * true vector similarity search using the `ultron-embed` sidecar binary.
 *
 * Flow:
 *   1. Compose a query string from project name + cwd + last user prompt (if
 *      present in stdin).
 *   2. Spawn `ultron-embed.exe` with the query on stdin to get a 384-d
 *      BGE-small-EN-v1.5 vector (JSON array).
 *   3. POST to Qdrant `/points/search` with the vector + project filter.
 *   4. Render top-K hits as a <recent_context> XML block in additionalContext.
 *
 * Fallback:
 *   If `ultron-embed.exe` is not found (release not built yet) or returns a
 *   non-array, the hook falls back to the original `/scroll` approach and logs
 *   a warning. This keeps `SessionStart` functional during development.
 *
 * Configuration:
 *   QDRANT_URL                — default http://localhost:6333
 *   ULTRON_EMBED_BIN          — override path to ultron-embed.exe
 *   SESSION_RECALL_DISABLED=1 — opt-out entirely
 *   SESSION_RECALL_K=5        — number of results (default 5, max 10)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'session-recall-inject.jsonl');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const QDRANT_URL = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '');
const COLLECTION = 'ultron_sessions';
const K = Math.min(10, Math.max(1, parseInt(process.env.SESSION_RECALL_K || '5', 10) || 5));

// Candidate paths for the ultron-embed sidecar, in priority order.
// ULTRON_EMBED_BIN env var lets the user pin an explicit path.
const EMBED_BIN_CANDIDATES = [
  process.env.ULTRON_EMBED_BIN,
  path.join(HOME, '.ultron', 'bin', 'ultron-embed.exe'),
  path.join(HOME, '.ultron', 'control-center', 'src-tauri', 'target', 'release', 'ultron-embed.exe'),
  // non-Windows (future)
  path.join(HOME, '.ultron', 'bin', 'ultron-embed'),
].filter(Boolean);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < LOG_MAX_BYTES) return;
    const rotated = LOG_PATH + '.1';
    try { fs.unlinkSync(rotated); } catch (_) {}
    fs.renameSync(LOG_PATH, rotated);
  } catch (_) {}
}

function safeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf8'
    );
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpPost(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Sidecar: ultron-embed
// ---------------------------------------------------------------------------

/**
 * Find the first existing candidate binary path.
 * Returns null when none is found.
 */
function findEmbedBin() {
  for (const p of EMBED_BIN_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {}
  }
  return null;
}

/**
 * Call `ultron-embed` with `queryText` on stdin.
 * Returns a number[] (384 floats) on success, or null on any failure.
 *
 * Uses spawnSync with a 6-second timeout so startup never blocks more than
 * that even if the ONNX model is cold-loading for the first time.
 */
function computeEmbedding(binPath, queryText) {
  try {
    const result = spawnSync(binPath, [], {
      input: queryText,
      encoding: 'utf8',
      timeout: 6000,
      maxBuffer: 1024 * 1024, // 1 MB — a 384-float JSON array is ~3 KB
    });

    if (result.error) {
      safeLog({ level: 'warn', msg: 'embed_spawn_error', error: String(result.error) });
      return null;
    }
    if (result.status !== 0) {
      safeLog({ level: 'warn', msg: 'embed_nonzero_exit', code: result.status, stderr: (result.stderr || '').trim() });
      return null;
    }

    const parsed = JSON.parse(result.stdout.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) {
      safeLog({ level: 'warn', msg: 'embed_bad_output', stdout: result.stdout.slice(0, 80) });
      return null;
    }

    return parsed;
  } catch (e) {
    safeLog({ level: 'warn', msg: 'embed_exception', error: String(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Qdrant vector search
// ---------------------------------------------------------------------------

/**
 * POST /collections/{col}/points/search with the given 384-d vector.
 * Filters to the given project name for precision.
 * Returns array of payload objects on success, [] on any error.
 */
async function recallBySemantic(vector, project) {
  const body = {
    vector,
    limit: K,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [{ key: 'project', match: { value: project } }],
    },
  };

  try {
    const res = await httpPost(
      `${QDRANT_URL}/collections/${COLLECTION}/points/search`,
      body,
      5000
    );

    if (res.status === 404) return []; // collection not yet created
    if (res.status !== 200) {
      safeLog({ level: 'warn', msg: 'qdrant_search_non200', status: res.status, body: res.body.slice(0, 200) });
      return [];
    }

    const parsed = JSON.parse(res.body);
    // Qdrant search response: { result: [ { id, score, payload } ] }
    const hits = parsed?.result || [];
    return hits.map(h => h.payload).filter(Boolean);
  } catch (e) {
    safeLog({ level: 'info', msg: 'qdrant_unavailable', hint: 'Qdrant not running — recall skipped' });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Qdrant scroll fallback — filter by project name, no vector required
// ---------------------------------------------------------------------------

/**
 * Fallback path used when `ultron-embed` is not available.
 * Fetches top-K facts via the scroll endpoint (payload filter only).
 * Returns array of payload objects or [] on any error.
 */
async function recallByScroll(project) {
  const body = {
    filter: {
      must: [{ key: 'project', match: { value: project } }],
    },
    limit: K,
    with_payload: true,
    with_vector: false,
    order_by: { key: 'importance', direction: 'desc' },
  };

  try {
    const res = await httpPost(
      `${QDRANT_URL}/collections/${COLLECTION}/points/scroll`,
      body,
      4000
    );

    if (res.status === 404) return [];
    if (res.status !== 200) {
      safeLog({ level: 'warn', msg: 'qdrant_scroll_non200', status: res.status });
      return [];
    }

    const parsed = JSON.parse(res.body);
    const points = parsed?.result?.points || [];
    return points.map(p => p.payload).filter(Boolean);
  } catch (e) {
    safeLog({ level: 'info', msg: 'qdrant_unavailable', hint: 'Qdrant not running — recall skipped' });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Context block renderer
// ---------------------------------------------------------------------------

/**
 * Render fact payloads as an XML block following Anthropic's structured-data
 * guidance (same pattern used by workday-session-linker for git commits).
 */
function renderContextBlock(project, facts, mode) {
  const lines = [
    `<recent_context source="qdrant_sessions" project="${escapeXml(project)}" search="${mode}" trust="system">`,
    `### Facts from recent sessions (top ${facts.length})`,
    '',
  ];

  for (const f of facts) {
    const text = String(f.text || '').trim().slice(0, 200);
    const kind = String(f.kind || 'feature').trim();
    const imp = typeof f.importance === 'number' ? f.importance.toFixed(2) : '?';
    const date = String(f.date || '').trim();
    lines.push(`- [${kind}|imp:${imp}${date ? `|${date}` : ''}] ${text}`);
  }

  lines.push('</recent_context>');
  return lines.join('\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Stdin / stdout helpers
// ---------------------------------------------------------------------------

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function emitPayload(additionalContext) {
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: additionalContext || '',
      },
    }));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.SESSION_RECALL_DISABLED === '1' || process.env.CLAUDE_NO_HOOKS === '1') {
    safeLog({ level: 'info', msg: 'opt_out_via_env' });
    return emitPayload('');
  }

  // Parse stdin — carries session metadata including last user prompt.
  const stdinRaw = readStdinSync();
  let stdin = {};
  try { stdin = stdinRaw ? JSON.parse(stdinRaw) : {}; } catch (_) {}

  const source = String(stdin.source || '').toLowerCase();
  // Skip resume/compact — only inject on fresh startup.
  if (source && source !== 'startup') {
    safeLog({ level: 'info', msg: 'skip_non_startup', source });
    return emitPayload('');
  }

  const cwd = process.cwd();
  const project = path.basename(cwd || 'unknown');

  // Compose query: project + cwd tail + optional last user prompt.
  // The last user prompt (if available in the hook payload) dramatically
  // improves recall relevance for task-specific sessions.
  const lastPrompt = String(stdin.prompt || stdin.userPrompt || '').trim().slice(0, 300);
  const queryParts = [project, path.basename(cwd)];
  if (lastPrompt) queryParts.push(lastPrompt);
  const queryText = queryParts.join(' ');

  safeLog({ level: 'info', msg: 'start', project, cwd, k: K, queryLen: queryText.length });

  // --- Attempt semantic vector search ---
  const binPath = findEmbedBin();
  let facts = [];
  let mode = 'scroll_fallback';

  if (binPath) {
    safeLog({ level: 'info', msg: 'embed_bin_found', path: binPath });
    const vector = computeEmbedding(binPath, queryText);

    if (vector && vector.length === 384) {
      facts = await recallBySemantic(vector, project);
      mode = 'vector_search';
      safeLog({ level: 'info', msg: 'semantic_search_done', project, hits: facts.length });
    } else {
      safeLog({ level: 'warn', msg: 'embed_failed_falling_back', project });
      facts = await recallByScroll(project);
    }
  } else {
    // ultron-embed not built yet — warn once and use scroll path.
    safeLog({
      level: 'warn',
      msg: 'embed_bin_not_found',
      hint: 'Build with: cargo build --release --bin ultron-embed --features qdrant',
      candidates: EMBED_BIN_CANDIDATES,
    });
    facts = await recallByScroll(project);
  }

  if (facts.length === 0) {
    safeLog({ level: 'info', msg: 'no_facts', project, mode });
    return emitPayload('');
  }

  const contextBlock = renderContextBlock(project, facts, mode);
  safeLog({ level: 'info', msg: 'injected', project, count: facts.length, mode });

  emitPayload(contextBlock);
}

main().catch(err => {
  safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
  emitPayload('');
});

process.exitCode = 0;
