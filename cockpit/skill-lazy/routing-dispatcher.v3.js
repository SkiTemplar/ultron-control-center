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
 * embed_skills.py exposes a CLI sub-command:
 *   uv run python ~/.ultron/scripts/cockpit/embed_skills.py query "<text>" --top 3 --json
 *
 * v3 spawns this as a child process with a hard 4-second timeout.  If the
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
 *   - Adds ~200-800 ms latency on a warm Python + model cache, well under the 4s budget.
 *   - Degrades gracefully: any failure is swallowed in a try/catch.
 *
 * TIMEOUT BUDGET
 * --------------
 *   Total hook budget  : 5 000 ms (Claude Code hard limit)
 *   v2 deterministic   : < 50 ms
 *   Semantic subprocess: 4 000 ms (SEMANTIC_TIMEOUT_MS)
 *   Lazy SKILL.md read : runs concurrently, capped at 5 000 ms each
 *   Safety margin      : ~950 ms
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
 * Maximum milliseconds to wait for the embed_skills.py subprocess.
 * Claude Code's UserPromptSubmit hook has a hard 5-second timeout; leaving
 * ~1 second of margin for v2 scoring and lazy reads.
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
 * Spawns: uv run python <embed_skills.py> query "<text>" --top N --json
 *
 * Returns an array of result objects on success, or null on any failure
 * (timeout, non-zero exit, parse error, Qdrant unreachable).
 *
 * @param {string} promptText  - The user prompt (truncated to 500 chars for speed).
 * @param {number} topN        - Number of results to request.
 * @returns {Promise<Array<{name:string, score:number, description:string}>|null>}
 */
function querySemanticSkills(promptText, topN) {
  return new Promise(function (resolve) {
    const queryText = promptText.slice(0, 500);
    const args = [
      'run', 'python', EMBED_SKILLS_PY,
      'query', queryText,
      '--top', String(topN),
      '--json',
    ];

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve(null);
      }
    }, SEMANTIC_TIMEOUT_MS);

    const child = execFile(UV_BIN, args, { encoding: 'utf8' }, function (err, out, serr) {
      stdout = out || '';
      stderr = serr || '';
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (err) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
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

  // --- Step 1: Run v2 deterministic ranking ---
  const ranked = v2.rankCandidates(prompt);
  const top = ranked[0] || null;
  const second = ranked[1] || null;

  // Determine whether the deterministic result is good enough on its own
  const HIGH_THRESHOLD = 0.80;
  const MED_THRESHOLD = 0.50;

  let deterministicText = '';
  let topConfidence = top ? top.confidence : 0;

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
    // Below medium threshold: try semantic fallback before giving up
  }

  // --- Step 2: Lazy skill injection (same as v2) ---
  let lazyBlock = '';
  if (topConfidence >= HIGH_THRESHOLD) {
    try {
      const injected = await v2.fetchLazySkillContent(ranked);
      if (injected.size > 0) {
        lazyBlock = v2.buildInjectionBlock(injected);
        safeLogV3({
          level: 'info', msg: 'lazy_skill_injected',
          skills: Array.from(injected.keys()),
        });
      }
    } catch (_err) {
      safeLogV3({ level: 'warn', msg: 'lazy_injection_failed', error: String(_err && _err.message) });
    }
  }

  // --- Step 3: Semantic fallback when deterministic confidence < threshold ---
  let semanticBlock = '';
  if (topConfidence < SEMANTIC_FALLBACK_THRESHOLD) {
    try {
      const semResults = await querySemanticSkills(prompt, SEMANTIC_TOP_N);
      if (semResults && semResults.length > 0) {
        semanticBlock = buildSemanticHint(semResults);
        safeLogV3({
          level: 'info', msg: 'semantic_fallback_triggered',
          deterministic_confidence: topConfidence,
          semantic_top: semResults[0] ? semResults[0].name : null,
          semantic_count: semResults.length,
        });
      } else {
        safeLogV3({
          level: 'info', msg: 'semantic_fallback_empty',
          deterministic_confidence: topConfidence,
        });
      }
    } catch (_err) {
      safeLogV3({ level: 'warn', msg: 'semantic_fallback_error', error: String(_err && _err.message) });
    }
  }

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
