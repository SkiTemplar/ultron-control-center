"""Token budget enforcement primitives for ULTRON memory layers (S3-A).

All functions are pure stdlib — no third-party deps. Import is safe at any
import site including inside the tight 40ms dispatcher budget.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

# GPT-style approximation: 1 token ≈ 4 characters (same heuristic as brain_index).
TOKENS_PER_CHAR = 4

_TOKEN_LOG = Path.home() / ".ultron" / ".tmp" / "token-usage.jsonl"


def measure(content: str) -> int:
    """Fast token estimate: len(content) // TOKENS_PER_CHAR."""
    return len(content) // TOKENS_PER_CHAR


def enforce(content: str, limit: int, priority_prefix: str | None = None) -> str:
    """Truncate *content* so its token estimate fits within *limit* tokens.

    Algorithm
    ---------
    1. If measure(content) <= limit → return as-is (fast path).
    2. Split content into lines.
    3. If *priority_prefix* is set:
       a. Separate ``priority_lines`` (lines starting with prefix) from
          ``normal_lines`` (all others).
       b. Place priority_lines first (all kept, in order). Fill remaining
          budget with normal_lines until adding the next line would exceed
          the limit.
    4. If no *priority_prefix*: simple line-by-line truncation from the start.
    5. Final guard: if priority_lines alone exceed *limit*, truncate the LAST
       priority line at character level so we never exceed *limit* tokens.

    Returns the reassembled string (lines joined with newline, no trailing
    newline added beyond what was in the original content).
    """
    if measure(content) <= limit:
        return content

    lines = content.split("\n")
    char_limit = limit * TOKENS_PER_CHAR

    if priority_prefix is None:
        # Simple truncation: keep lines from start until budget used.
        kept: list[str] = []
        total_chars = 0
        for line in lines:
            cost = len(line) + 1  # +1 for the \n separator
            if total_chars + cost > char_limit:
                break
            kept.append(line)
            total_chars += cost
        return "\n".join(kept)

    # Partition into priority and normal.
    priority_lines: list[str] = []
    normal_lines: list[str] = []
    for line in lines:
        if line.startswith(priority_prefix):
            priority_lines.append(line)
        else:
            normal_lines.append(line)

    # Compute chars used by all priority lines (with newline separators).
    priority_chars = sum(len(l) + 1 for l in priority_lines)

    # Guard: priority alone overflows → truncate last priority line at char level.
    if priority_chars > char_limit:
        result_lines: list[str] = []
        running = 0
        for i, line in enumerate(priority_lines):
            cost = len(line) + 1
            if running + cost <= char_limit:
                result_lines.append(line)
                running += cost
            else:
                # Fit as many chars from this line as possible.
                remaining_chars = char_limit - running
                if remaining_chars > 0:
                    result_lines.append(line[:remaining_chars])
                break
        return "\n".join(result_lines)

    # Fill remaining budget with normal lines.
    remaining_chars = char_limit - priority_chars
    normal_kept: list[str] = []
    for line in normal_lines:
        cost = len(line) + 1
        if remaining_chars - cost < 0:
            break
        normal_kept.append(line)
        remaining_chars -= cost

    return "\n".join(priority_lines + normal_kept)


def log(layer: str, tokens: int, limit: int) -> None:
    """Append a JSONL token-usage event to ~/.ultron/.tmp/token-usage.jsonl.

    Schema: {"ts": iso8601, "layer": str, "tokens": int, "limit": int}

    Failures are completely silent — this is a best-effort logging utility.
    """
    try:
        _TOKEN_LOG.parent.mkdir(parents=True, exist_ok=True)
        event = {
            "ts": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "layer": layer,
            "tokens": tokens,
            "limit": limit,
        }
        with _TOKEN_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass
