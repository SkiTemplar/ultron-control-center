#!/usr/bin/env node
/**
 * Stop hook — compress current session into structured facts (decisions, next
 * steps, bugs) and capture them to the canonical store (brain.db) through the
 * single-writer pipeline.
 *
 * KIRKARDO 14 — Paso 2: stop hook compresor.
 *
 * Flow:
 *   1. Read the transcript JSONL path from stdin payload (field: transcript_path).
 *   2. Parse last N turns (MAX_TURNS = 60) from the JSONL.
 *   3. Invoke Haiku 4.5 (Anthropic) / Groq to extract 3-5 structured facts.
 *      Falls back to rule-based extraction when no API key is available.
 *   4. Append captured decisions to the project's pending queue
 *      (appendPendingDecisions) for the Control Center "Decisions" panel.
 *   5. Exits 0 always — hook failures must never interrupt user workflow.
 *
 * NOTE: the legacy upsert to the RETIRED Qdrant `ultron_sessions` collection
 * (384-d BGE) was removed (OLA A/B 2026-06-04) — brain.db (governed by
 * MemoryService) is the single source of truth. The dead embedding/qdrant
 * helpers were deleted (2026-06-22).
 *
 * Configuration via env vars:
 *   ANTHROPIC_API_KEY / GROQ_API_KEY — for AI extraction; falls back to heuristic
 *   STOP_COMPRESS_DISABLED=1  — opt-out
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// cat15.1 — observabilidad de duración: registra elapsed_ms en hook-timing.jsonl
// cat9.5  — logHookError en catch top-level: deja rastro sin romper fail-safe
// ---------------------------------------------------------------------------
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
observe('stop-compress-session');

// ---------------------------------------------------------------------------
// Shared security helpers — lib/security-helpers.js (extraidos del antiguo
// mem0-sync.js, borrado 2026-06-08; el require roto degradaba a stubs y
// desactivaba la extraccion AI para siempre — fix Kirkardo Pass1 C5).
// Fallback gracioso: si el require falla, stubs + fail-closed (sin egress).
// ---------------------------------------------------------------------------

let redactSecrets = (s) => String(s == null ? '' : s);
let loadOptOut = () => ({ projects: [], cwd_patterns: [] });
let isOptedOut = () => false;
let detectProjectName = (cwd) => path.basename(cwd || process.cwd() || 'unknown');
// FAIL-CLOSED: only true once the real security helpers loaded. When false we
// must NOT send anything to the cloud LLM (would post unredacted text + skip
// project opt-out). The local Qdrant write still happens (no egress).
let securityHelpersLoaded = false;

try {
  const sec = require('./lib/security-helpers.js');
  if (
    typeof sec.redactSecrets === 'function' &&
    typeof sec.isOptedOut === 'function' &&
    typeof sec.loadOptOut === 'function'
  ) {
    redactSecrets = sec.redactSecrets;
    loadOptOut = sec.loadOptOut;
    isOptedOut = sec.isOptedOut;
    if (typeof sec.detectProjectName === 'function') detectProjectName = sec.detectProjectName;
    if (typeof sec.setLogger === 'function') sec.setLogger((e) => safeLog(e));
    securityHelpersLoaded = true;
  }
} catch (_) {
  // security-helpers.js unavailable — stubs + securityHelpersLoaded=false
  // (fail-closed: no cloud egress below).
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'stop-compress-session.jsonl');
const MAX_TURNS = 60;

// ---------------------------------------------------------------------------
// Logging (rotating via shared appendJsonl)
// ---------------------------------------------------------------------------

function safeLog(entry) {
  appendJsonl(LOG_PATH, entry);
}

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// JSONL transcript parser
// ---------------------------------------------------------------------------

/**
 * Extract the last MAX_TURNS messages from a JSONL transcript.
 * Returns an array of { role, text } objects.
 */
function parseTurns(jsonlPath) {
  let raw;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch (_) { return []; }

  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const tail = lines.slice(-MAX_TURNS);
  const turns = [];

  for (const line of tail) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }

    const type = obj.type || '';
    if (type !== 'user' && type !== 'assistant') continue;

    // Extract first text block (mirrors recall.rs logic).
    const msg = obj.message || obj;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) { text = block.text; break; }
      }
    }
    if (text.trim()) turns.push({ role: type, text: text.trim().slice(0, 800) });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Git head SHA (best-effort)
// ---------------------------------------------------------------------------

function gitHeadSha(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, encoding: 'utf8'
    }).trim();
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// HTTP helper (no external deps)
// ---------------------------------------------------------------------------

function httpRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Anthropic Haiku extraction
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a technical memory assistant. Given a conversation transcript, extract 3 to 5 key facts worth remembering for future sessions.

Return ONLY valid JSON with this exact shape:
{"facts":[{"text":"<concise fact>","kind":"decision|bug|feature|todo|file","importance":0.0-1.0}]}

Rules:
- "text": one sentence, max 120 chars, in the same language as the conversation
- "kind": one of decision, bug, feature, todo, file
- "importance": float 0-1 (1 = critical architectural decision, 0.1 = minor note)
- For "decision" facts, set importance >= 0.7 — an architectural/design/tooling
  choice ("we decided X over Y", "we'll use Z") is always worth remembering
- Return between 3 and 5 facts
- Focus on decisions made, bugs fixed, files created/changed, todos left

Transcript (last turns):
`;

async function extractFactsWithAI(turns) {
  // Redact secrets from every turn BEFORE sending to ANY provider.
  // The transcript leaves the machine here — this is the critical boundary.
  const transcript = turns
    .map(t => `[${t.role}]: ${redactSecrets(t.text)}`)
    .join('\n')
    .slice(0, 6000);
  const content = EXTRACTION_PROMPT + transcript;

  // Proveedor preferente: Groq (free tier, OpenAI-compat) — la suscripcion
  // Anthropic directa suele no tener saldo (400 credit balance too low). Si no
  // hay GROQ_API_KEY, cae a Anthropic; si tampoco, devuelve null (heuristico).
  // fix 2026-05-30: antes solo usaba Anthropic y fallaba por saldo.
  const groqKey = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  async function tryGroq() {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    });
    const res = await httpRequest('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
    }, body);
    if (res.status !== 200) {
      safeLog({ level: 'warn', msg: 'groq_non200', status: res.status, body: res.body.slice(0, 200) });
      return null;
    }
    return JSON.parse(res.body)?.choices?.[0]?.message?.content || '';
  }

  async function tryAnthropic() {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content }],
    });
    const res = await httpRequest('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
    }, body);
    if (res.status !== 200) {
      safeLog({ level: 'warn', msg: 'anthropic_non200', status: res.status, body: res.body.slice(0, 200) });
      return null;
    }
    return JSON.parse(res.body)?.content?.[0]?.text || '';
  }

  try {
    let text = null;
    if (groqKey) text = await tryGroq();
    if (text == null && anthropicKey) text = await tryAnthropic();
    if (text == null) return null;

    // Extract JSON block — model may wrap it in markdown fences.
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts.facts)) return null;
    return facts.facts;
  } catch (e) {
    safeLog({ level: 'error', msg: 'ai_extract_failed', error: String(e && e.message) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic fact extraction (fallback when no API key)
// ---------------------------------------------------------------------------

function extractFactsHeuristic(turns) {
  const facts = [];
  const seen = new Set();

  for (const turn of turns.slice(-20)) {
    // Redact secrets before storing — these texts land in Qdrant payloads.
    const safeText = redactSecrets(turn.text);
    const lower = safeText.toLowerCase();
    let kind = 'feature';
    let importance = 0.4;

    if (lower.includes('bug') || lower.includes('error') || lower.includes('fix')) {
      kind = 'bug'; importance = 0.7;
    } else if (lower.includes('todo') || lower.includes('pendiente') || lower.includes('falta')) {
      kind = 'todo'; importance = 0.6;
    } else if (lower.match(/decidimos|decision|vamos a|usaremos|implementamos/)) {
      kind = 'decision'; importance = 0.8;
    } else if (lower.match(/\.rs|\.ts|\.js|\.py|\.json|archivo|file|created|wrote/)) {
      kind = 'file'; importance = 0.5;
    }

    const key = safeText.slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);

    facts.push({
      text: safeText.slice(0, 120),
      kind,
      importance,
    });

    if (facts.length >= 5) break;
  }

  // Ensure at least one fact exists.
  if (facts.length === 0) {
    facts.push({ text: 'Session completed (no extractable facts)', kind: 'feature', importance: 0.1 });
  }

  return facts;
}


// ---------------------------------------------------------------------------
// Project name heuristic
// ---------------------------------------------------------------------------

function projectName(cwd) {
  return path.basename(cwd || process.cwd() || 'unknown');
}

// ---------------------------------------------------------------------------
// Decision auto-capture (Control Center "Decisions" panel)
// ---------------------------------------------------------------------------
// Resolve the authoritative project_id used by the Control Center by matching
// cwd against the registered project paths in cockpit/projects.json. Falls back
// to the cwd basename with a leading dot stripped (".ultron" -> "ultron").

function resolveProjectId(cwd) {
  try {
    const reg = JSON.parse(
      fs.readFileSync(path.join(HOME, '.ultron', 'cockpit', 'projects.json'), 'utf8'),
    );
    const projects = (reg && reg.projects) || [];
    const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
    const target = norm(cwd || process.cwd());
    let best = null;
    for (const p of projects) {
      if (!p || !p.path || !p.id) continue;
      const pp = norm(p.path);
      if (target === pp) return p.id;
      if (target.startsWith(pp + '\\') || target.startsWith(pp + '/')) {
        if (!best || pp.length > best.len) best = { id: p.id, len: pp.length };
      }
    }
    if (best) return best.id;
  } catch (_) {
    // fall through to basename fallback
  }
  return path.basename(cwd || process.cwd() || 'unknown').replace(/^\./, '');
}

// Append decision-kind facts to the per-project pending file. The Control
// Center drains this into proposed decisions (tag: auto-captured) on panel
// load. Best-effort: never throws into the hot path.
// Threshold to surface a decision-kind fact as a pending decision. Kept LOW
// (0.5) on purpose: a fact the extractor already classified as kind="decision"
// is worth a human glance, and the user filters it with Accept/Reject anyway.
// A false negative loses the decision forever; a false positive is one click.
// The Groq route systematically under-scores decisions (~0.3-0.5), so the old
// 0.7 gate captured nothing — see version_propagate sibling audit 2026-05-30.
const PENDING_DECISION_MIN_IMPORTANCE = 0.5;

function appendPendingDecisions(projectId, facts, sessionId, date) {
  try {
    const decisionFacts = (facts || []).filter(
      (f) =>
        f &&
        f.kind === 'decision' &&
        (f.importance || 0) >= PENDING_DECISION_MIN_IMPORTANCE &&
        f.text &&
        f.text.trim().length >= 5,
    );
    if (decisionFacts.length === 0) return;
    const dir = path.join(HOME, '.ultron', 'cockpit', 'projects', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'decisions-pending.jsonl');
    for (const f of decisionFacts) {
      appendJsonl(file, {
        decision: f.text.slice(0, 120),
        rationale: `Captado automaticamente del Stop hook (sesion ${sessionId}, ${date}). Revisar y aceptar o rechazar.`,
        session_id: sessionId,
        date,
        tags: ['auto-captured'],
        source: 'stop-compress-session',
      });
    }
    safeLog({ level: 'info', msg: 'pending_decisions_written', count: decisionFacts.length, projectId, sessionId });
  } catch (e) {
    safeLog({ level: 'warn', msg: 'pending_decisions_failed', error: String(e && e.message) });
  }
}

// ---------------------------------------------------------------------------
// cat17.1 — Structured compact output (>=4 of 8 outputs)
// Writes cockpit/projects/{projectId}/sessions/{session_id}/compact.json with:
//   human    — prose summary for humans
//   machine  — counters/metrics object for tooling
//   decisions — list of decision-kind facts (reuses what appendPendingDecisions already extracts)
//   next     — list of todo-kind facts as next steps
//   bugs     — list of bug-kind facts (if any)
//   arch_delta — recent git commits during the session window (best-effort)
//
// Fail-safe: any error is logged and swallowed. Never throws into main().
// ---------------------------------------------------------------------------

function gitLogRecent(cwd, maxCommits) {
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', '--oneline', '--no-decorate', `-${maxCommits}`],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, encoding: 'utf8' }
    ).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

function writeCompact(projectId, sessionId, cwd, turns, facts, date) {
  try {
    const sessionDir = path.join(HOME, '.ultron', 'cockpit', 'projects', projectId, 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const outPath = path.join(sessionDir, 'compact.json');

    // human: prosa — primer prompt del usuario + resumen de turno
    const firstUser = turns.find(t => t.role === 'user');
    const firstPrompt = firstUser ? firstUser.text.slice(0, 300) : '(sin prompt)';
    const human = `Sesión ${sessionId} del ${date} (${turns.length} turnos). Tema: ${firstPrompt}`;

    // machine: métricas de la sesión
    const userTurns = turns.filter(t => t.role === 'user').length;
    const assistantTurns = turns.filter(t => t.role === 'assistant').length;
    const machine = {
      session_id: sessionId,
      date,
      project: projectId,
      turns_total: turns.length,
      turns_user: userTurns,
      turns_assistant: assistantTurns,
      facts_extracted: (facts || []).length,
      sha_head: gitHeadSha(cwd) || null,
      generated_at: new Date().toISOString(),
    };

    // decisions: reutiliza los mismos facts filtrados por kind=decision
    const decisions = (facts || [])
      .filter(f => f && f.kind === 'decision' && f.text)
      .map(f => ({ text: f.text.slice(0, 120), importance: f.importance || 0 }));

    // next: todos como próximos pasos
    const next = (facts || [])
      .filter(f => f && f.kind === 'todo' && f.text)
      .map(f => f.text.slice(0, 120));

    // bugs: bugs detectados
    const bugs = (facts || [])
      .filter(f => f && f.kind === 'bug' && f.text)
      .map(f => ({ text: f.text.slice(0, 120), importance: f.importance || 0 }));

    // arch_delta: últimos commits de la sesión (best-effort, max 10)
    const arch_delta = gitLogRecent(cwd, 10);

    const compact = {
      schema_version: 1,
      session_id: sessionId,
      date,
      human,
      machine,
      decisions,
      next,
      bugs,
      arch_delta,
    };

    fs.writeFileSync(outPath, JSON.stringify(compact, null, 2), 'utf8');
    safeLog({ level: 'info', msg: 'compact_written', path: outPath, sessionId });
  } catch (e) {
    safeLog({ level: 'warn', msg: 'compact_write_failed', error: String(e && e.message), sessionId });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.STOP_COMPRESS_DISABLED === '1' || process.env.CLAUDE_NO_HOOKS === '1') {
    safeLog({ level: 'info', msg: 'opt_out_via_env' });
    return;
  }

  const stdinRaw = readStdinSync();
  let stdin = {};
  try { stdin = stdinRaw ? JSON.parse(stdinRaw) : {}; } catch (_) {}

  const transcriptPath = stdin.transcript_path || stdin.transcriptPath || '';
  const sessionId = stdin.session_id || stdin.sessionId
    || (transcriptPath ? path.basename(transcriptPath).replace(/\.jsonl$/i, '') : '')
    || crypto.randomUUID();
  const cwd = stdin.cwd || process.cwd();
  const project = projectName(cwd);

  // Per-project opt-out: financial projects and any project listed in
  // ~/.ultron/.mem0-opt-out.json will not send data to external services.
  // Checked early — opted-out sessions do zero network I/O.
  if (isOptedOut(detectProjectName(cwd), cwd, loadOptOut())) {
    safeLog({ level: 'info', msg: 'opted_out_by_project', project, sessionId });
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const sha = gitHeadSha(cwd);

  safeLog({ level: 'info', msg: 'start', sessionId, project, transcriptPath: transcriptPath || '(none)' });

  // Parse transcript.
  const turns = transcriptPath ? parseTurns(transcriptPath) : [];
  if (turns.length === 0) {
    safeLog({ level: 'info', msg: 'no_turns_skip', sessionId });
    return;
  }

  // Extract facts. FAIL-CLOSED: only call the cloud LLM (extractFactsWithAI ->
  // POST to api.anthropic.com) when the redaction/opt-out helpers loaded.
  // Otherwise stay fully local (heuristic -> Qdrant only, no egress).
  let facts = securityHelpersLoaded ? await extractFactsWithAI(turns) : null;
  const usedAI = facts !== null;
  if (!facts) {
    if (!securityHelpersLoaded) {
      safeLog({ level: 'warn', msg: 'security_helpers_unavailable_local_only', sessionId });
    }
    facts = extractFactsHeuristic(turns);
  }

  safeLog({ level: 'info', msg: 'facts_extracted', count: facts.length, usedAI, sessionId });

  const projectId = resolveProjectId(cwd);

  // cat17.1 — escribe compact.json con >=4 outputs estructurados (human/machine/decisions/next/bugs/arch_delta).
  writeCompact(projectId, sessionId, cwd, turns, facts, date);

  // Auto-capture decisions for the Control Center "Decisions" panel. Runs
  // before the Qdrant path so decisions are still captured if Qdrant is down.
  appendPendingDecisions(projectId, facts, sessionId, date);

  // OLA write-path (2026-06-04): propose GOVERNED memory candidates via the
  // `ultron-memory capture` sidecar. The sidecar re-runs extraction through the
  // AI Router (which populates router telemetry with the user's keys) and applies
  // redaction inside create_candidate, landing candidates in the governed inbox
  // for human approval (never auto-promoted). Aditive + fail-safe: a sidecar
  // failure never breaks the Stop hook. NOTE: extraction currently runs twice
  // (here via the router + extractFactsWithAI above) — unify in a follow-up.
  try {
    const memBin = path.join(os.homedir(), '.ultron', 'bin', 'ultron-memory.exe');
    if (fs.existsSync(memBin)) {
      const transcriptText = turns
        .map((t) => (typeof t === 'string' ? t : `${t.role || ''}: ${t.text || t.content || ''}`))
        .join('\n')
        .slice(-8000);
      const cap = spawnSync(memBin, ['capture', '--project', projectId], {
        input: transcriptText,
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 1024 * 1024,
      });
      safeLog({
        level: 'info',
        msg: 'memory_capture',
        sessionId,
        code: cap.status,
        out: (cap.stdout || '').slice(0, 200),
      });
    }
  } catch (e) {
    safeLog({
      level: 'warn',
      msg: 'memory_capture_failed',
      sessionId,
      error: String(e && e.message),
    });
  }

  // OLA A/B (2026-06-04): the legacy upsert to the RETIRED Qdrant `ultron_sessions`
  // collection (384-d BGE) was REMOVED. It wrote memory OUTSIDE the canonical
  // store (brain.db, governed by MemoryService) and used an embedding dimension
  // incompatible with the canonical `ultron_memory` (E5 1024-d). Session capture
  // now flows through `appendPendingDecisions` (above) and, going forward, the
  // Stop -> `ultron-memory candidate` path (single-writer). The dead
  // qdrant*/computeEmbedding helpers were deleted (2026-06-22).
  // See cockpit/memory-rework/STATE-RECONCILIATION-2026-06-04.md (P0-1).
  safeLog({
    level: 'info',
    msg: 'session_compressed',
    note: 'ultron_sessions upsert retired (SoT = brain.db); decisions captured',
    count: facts.length,
    sessionId,
    project,
  });
}

main().catch(err => {
  safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
  // cat9.5: rastro en hook-errors.jsonl para que el orquestador detecte fallos silenciosos.
  logHookError('stop-compress-session', err);
});

process.exitCode = 0;
