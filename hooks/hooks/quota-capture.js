#!/usr/bin/env node
// quota-capture.js — PostToolUse hook
//
// Detects Claude subscription quota warnings from Claude Code stdout/stderr
// and writes the result to ~/.ultron/cockpit/quota-state.json so the
// quota_watchdog background thread picks it up within 60 seconds.
//
// Registration (add to ~/.claude/settings.json under "hooks"):
// {
//   "hooks": {
//     "PostToolUse": [
//       {
//         "matcher": "",
//         "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/quota-capture.js" }]
//       }
//     ]
//   }
// }
//
// Data sources (in priority order):
//   1. ANTHROPIC_RATE_LIMIT_REMAINING env var (set by a proxy layer)
//   2. ANTHROPIC_QUOTA_PCT_USED env var (alternative proxy convention)
//   3. Pattern-match on hook input JSON (tool_response.output field)
//
// Output file: ~/.ultron/cockpit/quota-state.json
// Atomic write: tmp + rename so a crash mid-write never corrupts the file.
//
// The hook reads the tool invocation event from stdin (Claude Code hook
// protocol). On PostToolUse the payload is a JSON object with at least:
//   { "tool_name": "...", "tool_input": {...}, "tool_response": { "output": "..." } }

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const QUOTA_STATE_PATH = path.join(
  os.homedir(),
  ".ultron",
  "cockpit",
  "quota-state.json"
);

// ---------------------------------------------------------------------------
// Warning patterns Claude Code surfaces in tool output when quota is near
// ---------------------------------------------------------------------------

const WARNING_PATTERNS = [
  // Official Claude rate-limit messages
  /you are approaching.*usage limit/i,
  /approaching.*5.?h.*window/i,
  /approaching.*rate.?limit/i,
  /usage limit.*will.*reset/i,
  /you have used.*(\d+)%.*of your/i,
  // Claude Code internal messages
  /\brate.?limit\b.*remaining/i,
  /quota.*(\d+)%/i,
  /(\d+)%.*quota/i,
  /token.*limit.*reached/i,
  /exceeded.*usage.*limit/i,
  // Anthropic API 429 body
  /"type":"rate_limit_error"/i,
  // KIRKARDO R11.1 FIX-10: also catch raw API-level 429s and credit-balance
  // errors when a tool (Bash+curl, fetch, etc) hits the Anthropic/OpenAI/
  // Gemini APIs directly and surfaces the response in tool_response. The
  // previous patterns only covered Claude Code's internal usage messages.
  /credit balance is too low/i,
  /credit_balance_too_low/i,
  /\brate_limit_error\b/i,
  /429\s+too many requests/i,
  /\binsufficient_quota\b/i,
  /\bresource_exhausted\b/i,
  /you exceeded your current quota/i,
];

// Patterns that carry an explicit percentage we can extract.
const PCT_EXTRACTORS = [
  // "you have used 98% of your..."
  /you have used\s+(\d+(?:\.\d+)?)\s*%/i,
  // "quota 98%"
  /quota\s+(\d+(?:\.\d+)?)\s*%/i,
  // "98% quota"
  /(\d+(?:\.\d+)?)\s*%\s+quota/i,
  // generic "N% of your"
  /(\d+(?:\.\d+)?)\s*%\s+of your/i,
];

// ---------------------------------------------------------------------------
// Parse reset timestamp from Claude messages like
// "limit will reset at 2026-05-27T15:30:00Z"
// ---------------------------------------------------------------------------
const RESET_AT_PATTERN = /reset(?:\s+at)?\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCurrentState() {
  try {
    if (!fs.existsSync(QUOTA_STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  const dir = path.dirname(QUOTA_STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = QUOTA_STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, QUOTA_STATE_PATH);
}

function extractPctFromText(text) {
  for (const rx of PCT_EXTRACTORS) {
    const m = text.match(rx);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

function extractResetAt(text) {
  const m = text.match(RESET_AT_PATTERN);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function containsWarning(text) {
  return WARNING_PATTERNS.some((rx) => rx.test(text));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Read hook payload from stdin (Claude Code PostToolUse protocol).
  // KIRKARDO R11.1 FIX-10: use FD 0 instead of "/dev/stdin" so the hook
  // works on Windows MINGW64 / Git Bash where the /dev/stdin device path
  // does not exist. Previously the readFileSync threw and the hook exited
  // silently, never persisting quota state on Windows.
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    // Not piped — nothing to do.
    process.exit(0);
  }

  // --- Priority 1: proxy-injected env vars ---
  const remainingStr = process.env.ANTHROPIC_RATE_LIMIT_REMAINING;
  const pctUsedStr = process.env.ANTHROPIC_QUOTA_PCT_USED;

  let pctUsed = null;
  let resetAt = null;

  if (pctUsedStr) {
    const n = parseFloat(pctUsedStr);
    if (Number.isFinite(n)) pctUsed = Math.max(0, Math.min(100, n));
  } else if (remainingStr) {
    // REMAINING is tokens left out of an assumed 1,000,000 window.
    // Convert to pct_used = (1 - remaining/1_000_000) * 100.
    const remaining = parseInt(remainingStr, 10);
    if (Number.isFinite(remaining) && remaining >= 0) {
      pctUsed = Math.max(0, Math.min(100, (1 - remaining / 1_000_000) * 100));
    }
  }

  // --- Priority 2: pattern-match on tool output ---
  if (pctUsed === null) {
    let outputText = "";
    try {
      const payload = JSON.parse(raw);
      // Claude Code delivers tool output under several possible keys.
      const response = payload?.tool_response ?? payload?.result ?? {};
      outputText =
        (typeof response === "string" ? response : response?.output ?? "") +
        "\n" +
        (payload?.tool_input
          ? JSON.stringify(payload.tool_input).slice(0, 2000)
          : "");
    } catch {
      outputText = raw.slice(0, 4000);
    }

    if (containsWarning(outputText)) {
      pctUsed = extractPctFromText(outputText) ?? 98.0;
      resetAt = extractResetAt(outputText);
    }
  }

  if (pctUsed === null) {
    // No quota signal found — nothing to write.
    process.exit(0);
  }

  const CRITICAL_THRESHOLD = 98.0;
  const critical = pctUsed >= CRITICAL_THRESHOLD;

  const existing = readCurrentState();
  // Preserve reset_at from existing state if we didn't extract a new one.
  const finalResetAt =
    resetAt ??
    existing?.reset_at ??
    null;

  const state = {
    claude_pct_used: pctUsed,
    claude_critical: critical,
    reset_at: finalResetAt,
    last_check: new Date().toISOString(),
  };

  try {
    writeState(state);
    if (critical) {
      process.stderr.write(
        `[quota-capture] CRITICAL — Claude quota at ${pctUsed.toFixed(1)}%. ` +
          `Wrote quota-state.json. AI Router will skip Claude providers.\n`
      );
    }
  } catch (err) {
    process.stderr.write(`[quota-capture] failed to write state: ${err}\n`);
  }

  process.exit(0);
}

main();
