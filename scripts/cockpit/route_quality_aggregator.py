#!/usr/bin/env python3
"""
ULTRON v12.4 — Route Quality Aggregator (N2 fix)

Reads ~/.ultron/sessions/*/routing.jsonl and populates route_quality.json
with observed skill-transition data (consecutive Skill tool calls = an edge).

Called from Stop hook to process the current day; or run manually.

Commands:
    aggregate           Process all unprocessed routing.jsonl files
    aggregate --today   Process only today's file
    status              Show edge coverage
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SESSIONS_DIR   = Path.home() / ".ultron" / "sessions"
CACHE_DIR      = Path.home() / ".ultron" / "skill_cache"
QUALITY_FILE   = CACHE_DIR / "route_quality.json"
WATERMARK_FILE = CACHE_DIR / "aggregator_watermark.json"

WINDOW_SECONDS = 600  # 10-min window: if two Skills are called within this, it's a transition

# Canonical names for Agent subagent_type values (handles plugin-namespaced variants)
_AGENT_CANONICAL: dict[str, str] = {
    "agent-skills:code-reviewer":         "code-reviewer",
    "agent-skills:README":                "README",
    "agent-skills:security-auditor":      "security-auditor",
    "agent-skills:test-engineer":         "test-engineer",
    "feature-dev:code-explorer":          "feature-dev-explorer",
    "feature-dev:code-architect":         "feature-dev-architect",
    "feature-dev:code-reviewer":          "feature-dev-reviewer",
    "pr-review-toolkit:code-reviewer":    "pr-code-reviewer",
    "pr-review-toolkit:code-simplifier":  "pr-code-simplifier",
    "pr-review-toolkit:comment-analyzer": "pr-comment-analyzer",
    "pr-review-toolkit:pr-test-analyzer": "pr-test-analyzer",
    "pr-review-toolkit:silent-failure-hunter": "pr-silent-failure-hunter",
    "pr-review-toolkit:type-design-analyzer":  "pr-type-analyzer",
    "superpowers:code-reviewer":          "superpowers-reviewer",
    "hookify:conversation-analyzer":      "hookify-analyzer",
}


def _canonical_agent(name: str) -> str:
    return _AGENT_CANONICAL.get(name, name)


def _empty_edge(from_s: str, to_s: str) -> dict:
    return {
        "from": from_s, "to": to_s,
        "runs": 0, "successes": 0, "fallbacks": 0, "corrections": 0,
        "avg_token_cost": 0, "avg_duration_sec": 0,
        "last_outcome": "unknown", "last_used": None,
    }


# ── I/O helpers ───────────────────────────────────────────────────────────────

def load_quality() -> dict:
    if QUALITY_FILE.exists():
        try:
            # utf-8-sig strips the UTF-8 BOM that PowerShell Set-Content adds by default
            return json.loads(QUALITY_FILE.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            print(f"[WARN] route_quality.json parse error (data lost): {exc}", file=sys.stderr)
        except OSError as exc:
            print(f"[WARN] route_quality.json read error: {exc}", file=sys.stderr)
    return {"version": "1.0", "updated": "", "edges": {}}


def save_quality(data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    data["updated"] = datetime.now().isoformat()
    QUALITY_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8-sig"
    )


def load_watermark() -> dict:
    if WATERMARK_FILE.exists():
        try:
            return json.loads(WATERMARK_FILE.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[WARN] watermark load failed ({exc}), resetting — historical data may recount", file=sys.stderr)
    return {"processed": [], "last_run": None}


def save_watermark(w: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    WATERMARK_FILE.write_text(json.dumps(w, indent=2), encoding="utf-8")


def read_jsonl(path: Path) -> list[dict]:
    entries: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except OSError:
        pass
    return entries


# ── Core logic ────────────────────────────────────────────────────────────────

def _node_label(entry: dict) -> str:
    """Convert a routing entry into the canonical node label used in edge keys.

    Skill targets pass through (e.g. "ultron", "alfred").
    Agent targets get the "agent:" prefix + canonicalization (e.g. "agent:Explore",
    "agent:feature-dev-reviewer"). This namespacing prevents collisions when a
    Skill and Agent share a name (e.g. Skill "code-reviewer" vs Agent
    "agent-skills:code-reviewer" → "agent:code-reviewer").
    """
    tool   = entry.get("tool", "")
    target = (entry.get("target") or "").strip()
    if not target:
        return ""
    if tool == "Skill":
        return target
    if tool == "Agent":
        return "agent:" + _canonical_agent(target)
    return ""


def process_entries(entries: list[dict], quality: dict) -> int:
    """Find consecutive transitions across ALL tools (Skill + Agent) and increment
    edge counters.

    Open-world for both Skill→Skill and Agent→Agent (Auditor 3 finding —
    closed-world Skill seeding only covered 11/373 sources, dropping 95% of
    real transitions silently). Edges are namespaced: agent nodes get the
    "agent:" prefix to avoid collisions with same-named skills.

    Cross-tool transitions (Skill→Agent and Agent→Skill, the handoff between
    ULTRON and a delegated agent) are NOW captured — previously they were
    silently invisible because the per-tool split processed each list in
    isolation.

    Parallel-dispatch (3 Agent calls in <1s) collapses to a single edge from
    the previous step (since same-target consecutive calls are deduped via
    same_node guard).

    Dedup: each edge key counted at most once per session pass.

    Returns number of edges updated.
    """
    updated = 0

    # Group by session_id
    by_session: dict[str, list[dict]] = {}
    for e in entries:
        by_session.setdefault(e.get("session_id", "?"), []).append(e)

    for session_entries in by_session.values():
        # Single time-sorted list across BOTH tools — captures cross-tool transitions
        all_calls = sorted(
            (e for e in session_entries if e.get("tool") in ("Skill", "Agent")),
            key=lambda x: x.get("ts", ""),
        )

        seen_this_session: set[str] = set()
        prev_label: str = ""
        prev_ts:    str = ""

        for entry in all_calls:
            label = _node_label(entry)
            if not label:
                continue
            ts = entry.get("ts", "")

            # Skip self-loops (same node consecutively, including parallel dispatch)
            if not prev_label or label == prev_label:
                prev_label = label
                prev_ts    = ts
                continue

            # Time window check
            try:
                ta = datetime.fromisoformat(prev_ts)
                tb = datetime.fromisoformat(ts)
                if not (0 <= (tb - ta).total_seconds() <= WINDOW_SECONDS):
                    prev_label = label
                    prev_ts    = ts
                    continue
            except (ValueError, TypeError):
                prev_label = label
                prev_ts    = ts
                continue

            key = f"{prev_label}→{label}"
            if key not in seen_this_session:
                if key not in quality["edges"]:
                    quality["edges"][key] = _empty_edge(prev_label, label)
                edge = quality["edges"][key]
                edge["runs"]         = edge.get("runs", 0) + 1
                edge["successes"]    = edge.get("successes", 0) + 1
                edge["last_outcome"] = "success"
                edge["last_used"]    = ts
                seen_this_session.add(key)
                updated += 1

            prev_label = label
            prev_ts    = ts

    return updated


# ── Commands ──────────────────────────────────────────────────────────────────

def aggregate(today_only: bool = False) -> None:
    if not SESSIONS_DIR.exists():
        print("No sessions directory — nothing to aggregate")
        return

    watermark    = load_watermark()
    processed    = set(watermark.get("processed", []))
    # Track which session_ids from today have already been counted (idempotency guard)
    today_processed_sids: set[str] = set(
        watermark.get("today_sessions", {}).get(
            datetime.now().strftime("%Y-%m-%d"), []
        )
    )
    quality      = load_quality()
    total_updated = 0
    newly_done: list[str] = []
    today_str = datetime.now().strftime("%Y-%m-%d")

    for day_dir in sorted(SESSIONS_DIR.iterdir()):
        if not day_dir.is_dir():
            continue
        if today_only and day_dir.name != today_str:
            continue

        routing_file = day_dir / "routing.jsonl"
        if not routing_file.exists():
            continue

        file_key = f"{day_dir.name}/routing.jsonl"
        is_today = day_dir.name == today_str

        # Past days: skip if already processed.
        if file_key in processed and not is_today:
            continue

        entries = read_jsonl(routing_file)

        if is_today:
            # Only process sessions not yet counted to prevent double-counting on same-day re-runs
            new_entries = [e for e in entries
                           if e.get("session_id", "?") not in today_processed_sids]
            n = process_entries(new_entries, quality)
            # Record all session_ids now present in today's file
            all_today_sids = {e.get("session_id", "?") for e in entries}
            watermark.setdefault("today_sessions", {})[today_str] = sorted(
                today_processed_sids | all_today_sids
            )
            # Prune today_sessions to last 14 days
            cutoff = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
            watermark["today_sessions"] = {
                k: v for k, v in watermark["today_sessions"].items() if k >= cutoff
            }
        else:
            n = process_entries(entries, quality)
            newly_done.append(file_key)

        total_updated += n
        if n > 0:
            print(f"  {day_dir.name}: {n} edge update(s)")

    # Always save watermark
    watermark["processed"] = sorted(processed | set(newly_done))
    watermark["last_run"] = datetime.now().isoformat()
    save_watermark(watermark)

    if total_updated > 0:
        save_quality(quality)
        print(f"Total: {total_updated} edge update(s) written to route_quality.json")
    else:
        print("No skill-transition data found yet "
              "(edges populate when Skill tool is invoked consecutively in a session)")

    # Show current coverage
    edges = quality.get("edges", {})
    active = sum(1 for e in edges.values() if e.get("runs", 0) > 0)
    print(f"Coverage: {active}/{len(edges)} edges have real data")


def status() -> None:
    quality = load_quality()
    edges   = quality.get("edges", {})
    total   = len(edges)
    active  = sum(1 for e in edges.values() if e.get("runs", 0) > 0)
    pct     = int(100 * active / total) if total else 0
    print(f"Route quality: {active}/{total} edges with real data ({pct}%)")

    if active > 0:
        print("\nTop edges by runs:")
        top = sorted(edges.items(), key=lambda x: x[1].get("runs", 0), reverse=True)
        for key, edge in top[:10]:
            print(f"  {key}: runs={edge['runs']} success={edge.get('successes',0)} "
                  f"last={(edge.get('last_used') or 'never')[:19]}")

    wm = load_watermark()
    print(f"\nLast aggregator run: {wm.get('last_run', 'never')}")
    print(f"Processed files:     {len(wm.get('processed', []))}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "aggregate":
        aggregate("--today" in sys.argv)
    elif cmd == "status":
        status()
    else:
        print(f"Unknown command: {cmd}. Use: aggregate [--today] | status")
        sys.exit(1)


if __name__ == "__main__":
    main()
