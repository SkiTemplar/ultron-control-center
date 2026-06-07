#!/usr/bin/env node
/**
 * routing-dispatcher.v3.js — Semantic fallback layer over v2.
 *
 * DESIGN
 * ------
 * v3 extends v2 without modifying it.  It requires('./routing-dispatcher.v2.js')
 * for all deterministic scoring logic and adds a single new code-path:
 *
 *   When the top deterministic candidate has confidence < SEMANTIC_FALLBACK_THRESHOLD
 *   (default 0.80), v3 queries the `ultron_skills` Qdrant collection for top-3
 *   semantically similar skills and appends them as a supplementary hint.
 *
 * INTEGRATION WITH embed_skills.py
 * ----------------------------------
 * embed_skills.py exposes a CLI sub-command that always outputs JSON by default:
 *   uv run python ~/.ultron/scripts/cockpit/embed_skills.py query "<text>" --top 3
 *
 * NOTE: do NOT pass --json — that flag does not exist; the script exits with
 * code 2 on unrecognized arguments, causing querySemanticSkills to return null.
 *
 * v3 spawns this as a child process bounded by the shared deadline.  If the
 * process times out, returns a non-zero exit code, or produces unparseable
 * output the semantic hint is silently omitted — the deterministic routing
 * hint from v2 is always emitted regardless.
 *
 * WHY A SUBPROCESS INSTEAD OF DIRECT QDRANT CALL
 * -----------------------------------------------
 * The hook runs inside the Claude Code Node.js process.  Loading the
 * sentence-transformers model and qdrant-client from Node would require
 * either a heavy native addon or an HTTP call.  The subprocess approach:
 *   - Reuses the already-cached Python model (paraphrase-multilingual-mpnet-base-v2).
 *   - Keeps the Node hook dependency-free (no npm install required).
 *   - Adds ~200-800 ms latency on a warm Python + model cache (OS disk cache hot).
 *   - Degrades gracefully: any failure is swallowed in a try/catch.
 *
 * COLD-START WARNING
 * ------------------
 * The first subprocess call after a system reboot can take 9-12 s because
 * sentence-transformers loads a ~400 MB model from disk.  The shared deadline
 * fires, the semantic hint is silently skipped, and the hook still emits the
 * deterministic result within 5 s.  Subsequent calls within the same OS
 * session hit the disk page cache and complete in < 1 s.
 *
 * TIMEOUT BUDGET — SHARED DEADLINE
 * ----------------------------------
 * See WARNING comment near HOOK_DEADLINE_MS below for the full invariant.
 *   Total hook budget  : 5 000 ms (Claude Code hard limit)
 *   All async I/O      : <= 4 500 ms (HOOK_DEADLINE_MS, shared across branches)
 *   v2 deterministic   : < 50 ms
 *   Safety margin      : ~450 ms
 *
 * OUTPUT FORMAT
 * -------------
 * When semantic results are appended the additionalContext gains a section:
 *
 *   [semantic-fallback: top-3 by similarity]
 *   1. <skill-name> (score: 0.83) — <description truncated to 120 chars>
 *   2. ...
 *   3. ...
 *   (Activate with /use <skill-name> or mention its name explicitly.)
 *
 * ACTIVATION
 * ----------
 * Same as v2 — copy to ~/.claude/scripts/routing-dispatcher.js after review:
 *
 *   cp cockpit/skill-lazy/routing-dispatcher.v3.js \
 *      ~/.claude/scripts/routing-dispatcher.js
 *
 * node --check ~/.claude/scripts/routing-dispatcher.js
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * v3 re-exports every symbol that v2 exports so existing unit-tests pass
 * unchanged.  The semantic path is an additive annotation only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();

// ---------------------------------------------------------------------------
// v2 re-export (all deterministic logic lives there)
// ---------------------------------------------------------------------------
const v2 = require('./routing-dispatcher.v2.js');

// Re-export everything from v2 so unit-tests that import v3 still pass.
Object.assign(module.exports, v2);

// ---------------------------------------------------------------------------
// Semantic fallback constants
// ---------------------------------------------------------------------------

/**
 * Confidence threshold below which the semantic fallback is triggered.
 * When the deterministic top candidate scores >= this value the extra Qdrant
 * query is skipped entirely (it would add latency for no benefit).
 */
const SEMANTIC_FALLBACK_THRESHOLD = 0.80;

/**
 * Maximum prompt characters fed to the normalizer before lazy injection.
 * Mirrors v2's MAX_PROMPT_CHARS (which is not exported). Kept in sync so the
 * normalized prompt handed to v2.fetchLazySkillContent matches what v2.main()
 * would have produced.
 */
const MAX_PROMPT_CHARS = 4000;

/**
 * Hard deadline for ALL async I/O in this hook (ms from the moment mainV3 starts).
 *
 * WARNING — TIMING INVARIANT:
 *   Claude Code's UserPromptSubmit hook has a hard 5 000 ms wall-clock limit.
 *   v3 has TWO potentially expensive async branches:
 *     A) Lazy skill injection  (runs when topConfidence >= SEMANTIC_FALLBACK_THRESHOLD)
 *     B) Semantic Qdrant query (runs when topConfidence <  SEMANTIC_FALLBACK_THRESHOLD)
 *
 *   Today both thresholds equal 0.80, so A and B are mutually exclusive.
 *   BUT if either threshold is changed they could BOTH execute sequentially,
 *   potentially spending up to (lazy timeout + semantic timeout) ≈ 9 s — far
 *   exceeding the 5 s budget and causing the hook to be killed mid-flight.
 *
 *   FIX: a single shared deadline of HOOK_DEADLINE_MS is established once at
 *   the start of mainV3().  Each async branch receives only its remaining time
 *   slice (remainingMs = deadline - Date.now()).  If remaining time <= 0 the
 *   branch is skipped entirely.  This guarantees the total wall-clock cost of
 *   all I/O can never exceed HOOK_DEADLINE_MS, regardless of threshold values.
 *
 *   Budget breakdown (worst case — both branches run):
 *     v2 deterministic scoring : <  50 ms
 *     Lazy inject (branch A)   : <= remainingMs (capped, typically ~500 ms warm)
 *     Semantic query (branch B): <= remainingMs (capped, typically ~800 ms warm)
 *     Output serialisation     : <  10 ms
 *     Safety margin            : ~440 ms
 *   Total guaranteed max       : 4 500 ms  (HOOK_DEADLINE_MS)
 */
const HOOK_DEADLINE_MS = 4500;

/**
 * Default maximum milliseconds to wait for the embed_skills.py subprocess.
 * Overridden at runtime by the shared deadline — this value is only used as
 * an absolute upper bound when no deadline context is available.
 */
const SEMANTIC_TIMEOUT_MS = 4000;

/** Number of semantic candidates to request from Qdrant. */
const SEMANTIC_TOP_N = 3;

/**
 * Absolute path to the embed_skills.py script.
 * Resolved once at module load time.
 */
const EMBED_SKILLS_PY = path.join(
  HOME, '.ultron', 'scripts', 'cockpit', 'embed_skills.py'
);

/**
 * Python executable: prefer 'uv' so the correct virtual-env is used.
 * Falls back to plain 'python' for environments where uv is absent.
 */
const UV_BIN = 'uv';

// ---------------------------------------------------------------------------
// Semantic query helper
// ---------------------------------------------------------------------------

/**
 * Query ultron_skills Qdrant collection for top-N semantically similar skills.
 *
 * Spawns: uv run python <embed_skills.py> query "<text>" --top N
 * (No --json flag — the script outputs a JSON array to stdout by default.)
 *
 * Returns an array of result objects on success, or null on any failure
 * (timeout, non-zero exit, parse error, Qdrant unreachable).
 *
 * @param {string} promptText        - The user prompt (truncated to 500 chars for speed).
 * @param {number} topN              - Number of results to request.
 * @param {number} [timeoutMs]       - Hard timeout in ms; defaults to SEMANTIC_TIMEOUT_MS.
 *                                     Pass the shared-deadline remainder so the call never
 *                                     exceeds the hook's total budget.
 * @returns {Promise<Array<{name:string, score:number, description:string}>|null>}
 */
function querySemanticSkills(promptText, topN, timeoutMs) {
  const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0)
    ? timeoutMs
    : SEMANTIC_TIMEOUT_MS;

  return new Promise(function (resolve) {
    const queryText = promptText.slice(0, 500);
    // NOTE: embed_skills.py query always outputs JSON to stdout by default.
    // Do NOT pass --json (unrecognized flag → exit code 2 → null result).
    const args = [
      'run', 'python', EMBED_SKILLS_PY,
      'query', queryText,
      '--top', String(topN),
    ];

    let settled = false;

    const timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        // On Windows, child.kill() only signals the immediate `uv` process,
        // not the Python grandchild it spawned.  The grandchild keeps running
        // and Node's event loop stays alive waiting for the child stdio streams
        // to close — delaying process.exit well past the hook deadline.
        // Fix: destroy the stdio streams and call child.unref() so Node stops
        // waiting for the orphaned Python process and can exit on its own.
        try { child.kill(); } catch (_) {}
        try { if (child.stdout) child.stdout.destroy(); } catch (_) {}
        try { if (child.stderr) child.stderr.destroy(); } catch (_) {}
        child.unref();
        resolve(null);
      }
    }, effectiveTimeout);

    const child = execFile(UV_BIN, args, { encoding: 'utf8', windowsHide: true }, function (err, out) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (err) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse((out || '').trim());
        if (!Array.isArray(parsed)) { resolve(null); return; }
        resolve(parsed);
      } catch (_) {
        resolve(null);
      }
    });

    child.on('error', function () {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    });
  });
}

// ---------------------------------------------------------------------------
// Format semantic results into a context hint block
// ---------------------------------------------------------------------------

/**
 * Build the semantic fallback hint appended after the deterministic routing hint.
 *
 * @param {Array<{name:string, score:number, description:string}>} results
 * @returns {string}
 */
function buildSemanticHint(results) {
  if (!results || results.length === 0) return '';

  const lines = [
    '',
    '[semantic-fallback: top-' + results.length + ' by similarity]',
  ];
  results.forEach(function (r, i) {
    const desc = (r.description || '').slice(0, 120).replace(/\n/g, ' ');
    const score = typeof r.score === 'number' ? r.score.toFixed(3) : '?';
    const rerank = typeof r.rerank_score === 'number' ? ' rerank=' + r.rerank_score.toFixed(3) : '';
    lines.push(
      (i + 1) + '. ' + (r.name || '?') + ' (score: ' + score + rerank + ')' +
      (desc ? ' — ' + desc : '')
    );
  });
  lines.push('(Activate with /use <skill-name> or mention its name explicitly.)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Logging (reuses v2's safeLog via the module boundary)
// ---------------------------------------------------------------------------

/**
 * Safe logger that mirrors v2's safeLog shape.
 * We re-open the same log file rather than importing the private function.
 */
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'routing-dispatcher.jsonl');

function safeLogV3(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf8'
    );
  } catch (_) {
    // never throw
  }
}

// ---------------------------------------------------------------------------
// v3 main — wraps v2 main with semantic augmentation
// ---------------------------------------------------------------------------

/**
 * Read stdin, run v2 deterministic scoring, optionally augment with semantic
 * results, emit the combined additionalContext.
 *
 * This function intentionally mirrors v2's main() structure so it can replace
 * it directly in the hook file.
 */
async function mainV3() {
  // Shared deadline: ALL async I/O in this function must finish before this
  // timestamp.  Each branch receives only the remaining slice so the combined
  // wall-clock cost is bounded to HOOK_DEADLINE_MS regardless of how many
  // branches execute (see WARNING comment near HOOK_DEADLINE_MS above).
  const hookStart = Date.now();
  const deadlineAt = hookStart + HOOK_DEADLINE_MS;

  // Advance v2's process-wide invocation counter. v3 reuses v2's lazy-injection
  // machinery (fetchLazySkillContent -> isCoolingDown / recordInjection) but
  // does NOT call v2.main(), which is the only place v2 normally bumps the
  // counter. Without this bump the counter stays at 0 across every mainV3 call
  // and the cooldown window collapses to a no-op. Harmless in production (the
  // hook is an ephemeral one-process-per-prompt invocation, so the counter and
  // _injectionHistory always start fresh) but correct for any host that reuses
  // the process. The guard keeps v3 forward/backward compatible with v2 builds
  // that predate this export.
  if (typeof v2._incrementInvocationCounter === 'function') {
    v2._incrementInvocationCounter();
  }

  /** Returns ms remaining before the shared deadline (minimum 0). */
  function remainingMs() {
    return Math.max(0, deadlineAt - Date.now());
  }

  // Replicate v2's stdin reading + payload parsing
  let stdinRaw = '';
  try {
    stdinRaw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    stdinRaw = '';
  }

  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    emitContextV3('');
    return;
  }

  const prompt = String(payload.prompt || payload.user_prompt || '').trim();
  if (!prompt) {
    emitContextV3('');
    return;
  }

  // --- Step 1: Run v2 deterministic ranking (synchronous, < 50 ms) ---
  const ranked = v2.rankCandidates(prompt);
  const top = ranked[0] || null;
  const second = ranked[1] || null;

  // HIGH_THRESHOLD is intentionally bound to SEMANTIC_FALLBACK_THRESHOLD so the
  // two cannot drift apart: branch A (lazy inject) runs when confidence >= T and
  // branch B (semantic fallback) runs when confidence < T. Sharing a single T
  // keeps A and B mutually exclusive (see the HOOK_DEADLINE_MS WARNING above).
  const HIGH_THRESHOLD = SEMANTIC_FALLBACK_THRESHOLD;
  const MED_THRESHOLD = 0.50;

  let deterministicText = '';
  const topConfidence = top ? top.confidence : 0;

  // iter-10 FASE 7: for genuinely ambiguous prompts (topConfidence < 0.50,
  // typical of vague planning requests) widen the semantic fallback so it casts
  // a broader net (TOP_N 5) at a lower effective threshold (0.65). For clearer
  // prompts the original 0.80 / TOP_N 3 behavior is preserved unchanged.
  //
  // INVARIANT: branch A (lazy) still requires topConfidence >= HIGH_THRESHOLD
  // (0.80); the effective threshold below only ever LOWERS branch B's bar for
  // conf < 0.50, so 0.50 <= effective <= 0.80 always sits below 0.80 and A/B
  // remain mutually exclusive. The shared HOOK_DEADLINE_MS budget is untouched.
  const ambiguousPrompt = topConfidence < MED_THRESHOLD;
  const effectiveSemanticThreshold = ambiguousPrompt
    ? 0.65
    : SEMANTIC_FALLBACK_THRESHOLD;
  const effectiveSemanticTopN = ambiguousPrompt ? 5 : SEMANTIC_TOP_N;

  if (top && topConfidence >= HIGH_THRESHOLD) {
    deterministicText = buildHighContextV3(top);
    safeLogV3({
      level: 'info', msg: 'high_confidence_routing',
      top: formatLabelV3(top), score: top.score, confidence: topConfidence,
    });
  } else if (top && topConfidence >= MED_THRESHOLD) {
    deterministicText = buildMediumContextV3(top, second);
    safeLogV3({
      level: 'info', msg: 'medium_confidence_routing',
      top: formatLabelV3(top),
      second: second ? formatLabelV3(second) : null,
      score: top.score, confidence: topConfidence,
    });
  } else {
    if (top) {
      safeLogV3({
        level: 'info', msg: 'low_confidence_skip',
        top: formatLabelV3(top), score: top.score, confidence: topConfidence,
      });
    } else {
      safeLogV3({ level: 'info', msg: 'no_match', prompt_chars: prompt.length });
    }
  }

  // --- Step 2: Lazy skill injection (branch A — only when high confidence) ---
  // WARNING: branch A and branch B both consume from the shared deadline.
  // If both thresholds are changed so that A and B can run sequentially, the
  // deadline still caps total I/O to HOOK_DEADLINE_MS.  If remainingMs() is
  // already 0 when a branch is reached, it is skipped entirely.
  let lazyBlock = '';
  if (topConfidence >= HIGH_THRESHOLD) {
    const lazyBudget = remainingMs();
    if (lazyBudget > 50) {  // skip if < 50 ms left — not worth the syscall
      try {
        // v2.fetchLazySkillContent uses its own internal LAZY_READ_TIMEOUT_MS
        // (5 000 ms).  Wrap with Promise.race so it cannot exceed our budget.
        const lazyRaceTimeout = new Promise(function (resolve) {
          setTimeout(function () { resolve(new Map()); }, lazyBudget);
        });
        // BUGFIX (Kirkardo R7): pass the normalized prompt as the second arg.
        // v2.fetchLazySkillContent(candidates, promptNorm) needs promptNorm to
        // run the ECC on-demand lookup (matchBestEccSkill). Calling it without
        // promptNorm silently disabled all ECC lazy injection. Mirror v2.main():
        // normalize(prompt).slice(0, MAX_PROMPT_CHARS).
        const promptNorm = v2.normalize(prompt).slice(0, MAX_PROMPT_CHARS);
        const injected = await Promise.race([
          v2.fetchLazySkillContent(ranked, promptNorm),
          lazyRaceTimeout,
        ]);
        if (injected.size > 0) {
          lazyBlock = v2.buildInjectionBlock(injected);
          safeLogV3({
            level: 'info', msg: 'lazy_skill_injected',
            skills: Array.from(injected.keys()),
            elapsed_ms: Date.now() - hookStart,
          });
        }
      } catch (_err) {
        safeLogV3({ level: 'warn', msg: 'lazy_injection_failed', error: String(_err && _err.message) });
      }
    } else {
      safeLogV3({ level: 'warn', msg: 'lazy_injection_skipped_deadline', remaining_ms: lazyBudget });
    }
  }

  // --- Step 3: Semantic fallback (branch B — only when low confidence) ---
  let semanticBlock = '';
  if (topConfidence < effectiveSemanticThreshold) {
    const semBudget = remainingMs();
    if (semBudget > 50) {  // skip if < 50 ms left
      try {
        const semResults = await querySemanticSkills(prompt, effectiveSemanticTopN, semBudget);
        if (semResults && semResults.length > 0) {
          semanticBlock = buildSemanticHint(semResults);
          safeLogV3({
            level: 'info',
            msg: 'semantic_fallback_triggered',
            // Deterministic context: what the rule-based router found (or didn't)
            deterministic_top_id: top ? top.id : null,
            deterministic_top_kind: top ? top.kind : null,
            deterministic_confidence: topConfidence,
            // Top-3 semantic candidates for diagnostic of semantic_fallback_rate
            semantic_top3: semResults.slice(0, 3).map(function (r) {
              return {
                name: r.name || '?',
                score: typeof r.score === 'number' ? parseFloat(r.score.toFixed(4)) : null,
                rerank_score: typeof r.rerank_score === 'number'
                  ? parseFloat(r.rerank_score.toFixed(4))
                  : undefined,
              };
            }),
            semantic_count: semResults.length,
            elapsed_ms: Date.now() - hookStart,
          });
        } else {
          safeLogV3({
            level: 'info', msg: 'semantic_fallback_empty',
            deterministic_confidence: topConfidence,
            elapsed_ms: Date.now() - hookStart,
          });
        }
      } catch (_err) {
        safeLogV3({ level: 'warn', msg: 'semantic_fallback_error', error: String(_err && _err.message) });
      }
    } else {
      safeLogV3({ level: 'warn', msg: 'semantic_fallback_skipped_deadline', remaining_ms: semBudget });
    }
  }

  safeLogV3({
    level: 'debug', msg: 'v3_hook_complete',
    total_elapsed_ms: Date.now() - hookStart,
    had_lazy: lazyBlock.length > 0,
    had_semantic: semanticBlock.length > 0,
  });

  // --- Assemble final output ---
  const fullText = (deterministicText + lazyBlock + semanticBlock).trim();
  emitContextV3(fullText);
}

// ---------------------------------------------------------------------------
// Output helper (identical to v2's emitContext but standalone)
// ---------------------------------------------------------------------------

function emitContextV3(text) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text || '',
    },
  };
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Context-building helpers (mirrors of v2's private functions)
// These are duplicated here so v3 can run standalone without depending on
// v2's unexported private state (HIGH_THRESHOLD, etc.).
// ---------------------------------------------------------------------------

function formatLabelV3(c) {
  if (c.kind === 'persona') return 'persona:' + (c.persona || c.id);
  if (c.kind === 'agent')   return 'agent:' + c.id;
  return 'skill:' + c.id;
}

function buildHighContextV3(top) {
  const matchedSummary = top.matched.slice(0, 3).join(', ');
  return [
    '[auto-routing: ' + Math.round(top.confidence * 100) + '% confidence]',
    'Suggested: ' + formatLabelV3(top) + ' -- signals matched: ' + matchedSummary,
    'If this routing is wrong, ignore this hint and proceed with your judgement.',
  ].join('\n');
}

function buildMediumContextV3(top, second) {
  const lines = [
    '[auto-routing: medium confidence ~' + Math.round(top.confidence * 100) + '%]',
    'Two candidates matched the prompt:',
    '  1) ' + formatLabelV3(top) + ' (score ' + top.score + ', signals: ' + top.matched.slice(0, 2).join(', ') + ')',
  ];
  if (second) {
    lines.push('  2) ' + formatLabelV3(second) + ' (score ' + second.score + ', signals: ' + second.matched.slice(0, 2).join(', ') + ')');
  }
  lines.push('Pick the one that matches your interpretation of the request, or ignore.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  mainV3().catch(function (err) {
    safeLogV3({ level: 'error', msg: 'v3_unhandled_async', error: String(err && err.message) });
    emitContextV3('');
  }).finally(function () {
    process.exitCode = 0;
  });
}

// Exported for unit tests — includes all v2 symbols plus v3-specific ones.
module.exports.querySemanticSkills = querySemanticSkills;
module.exports.buildSemanticHint = buildSemanticHint;
module.exports.SEMANTIC_FALLBACK_THRESHOLD = SEMANTIC_FALLBACK_THRESHOLD;
module.exports.SEMANTIC_TIMEOUT_MS = SEMANTIC_TIMEOUT_MS;
module.exports.HOOK_DEADLINE_MS = HOOK_DEADLINE_MS;
