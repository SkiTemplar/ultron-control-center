"""compute-metrics.py — Aggregate routing-dispatcher.jsonl telemetry.

Reads ~/.claude/logs/routing-dispatcher.jsonl and reports:
  - lazy_injection_rate  : fraction of routing events that injected at least one skill
  - confidence distribution : percentile breakdown of routing confidence scores
  - top routed skills/personas/agents
  - eligible-but-zero rate : lazy attempts where eligible > 0 but injected = 0

Usage:
    uv run python compute-metrics.py [--jsonl PATH] [--last N] [--json]

Options:
    --jsonl PATH    Override log file path (default: ~/.claude/logs/routing-dispatcher.jsonl)
    --last N        Analyse only the last N lines (default: all)
    --json          Output as JSON instead of human-readable text
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median, quantiles
from typing import Any


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _load_lines(log_path: Path, last_n: int | None) -> list[dict[str, Any]]:
    """Read JSONL file and return parsed dicts, skipping malformed lines."""
    if not log_path.exists():
        return []
    raw = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    if last_n is not None:
        raw = raw[-last_n:]
    records: list[dict[str, Any]] = []
    for line in raw:
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return records


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def _compute(records: list[dict[str, Any]]) -> dict[str, Any]:
    routing_events: list[dict[str, Any]] = []
    injection_events: list[dict[str, Any]] = []

    for r in records:
        msg = r.get("msg", "")
        if msg in ("high_confidence_routing", "medium_confidence_routing"):
            routing_events.append(r)
        elif msg == "lazy_injection_attempted":
            injection_events.append(r)

    # --- Confidence distribution ---
    confidences = [r["confidence"] for r in routing_events if "confidence" in r]
    conf_stats: dict[str, Any] = {}
    if confidences:
        qs = quantiles(confidences, n=4)  # p25, p50, p75
        conf_stats = {
            "count": len(confidences),
            "mean": round(mean(confidences), 4),
            "median": round(median(confidences), 4),
            "p25": round(qs[0], 4),
            "p75": round(qs[2], 4),
            "min": round(min(confidences), 4),
            "max": round(max(confidences), 4),
            "pct_high": round(sum(1 for c in confidences if c >= 0.80) / len(confidences), 4),
            "pct_medium": round(sum(1 for c in confidences if 0.50 <= c < 0.80) / len(confidences), 4),
        }

    # --- Lazy injection rate ---
    # An injection "attempt" record always has candidates/eligible/injected keys.
    # Filter to records that have these keys (outcome records).
    outcome_records = [r for r in injection_events if "injected" in r]
    inj_rate_stats: dict[str, Any] = {}
    if outcome_records:
        total_attempts = len(outcome_records)
        injected_at_least_one = sum(1 for r in outcome_records if r.get("injected", 0) > 0)
        eligible_but_zero = sum(
            1 for r in outcome_records
            if r.get("eligible", 0) > 0 and r.get("injected", 0) == 0
        )
        total_candidates = sum(r.get("candidates", 0) for r in outcome_records)
        total_eligible = sum(r.get("eligible", 0) for r in outcome_records)
        total_injected = sum(r.get("injected", 0) for r in outcome_records)
        inj_rate_stats = {
            "total_attempts": total_attempts,
            "injected_at_least_one": injected_at_least_one,
            "lazy_injection_rate": round(injected_at_least_one / total_attempts, 4),
            "eligible_but_zero_rate": round(eligible_but_zero / total_attempts, 4),
            "avg_candidates_per_attempt": round(total_candidates / total_attempts, 2),
            "avg_eligible_per_attempt": round(total_eligible / total_attempts, 2),
            "avg_injected_per_attempt": round(total_injected / total_attempts, 2),
        }

    # --- Top routed skills/personas/agents ---
    top_counter: Counter = Counter()
    for r in routing_events:
        top = r.get("top")
        if top:
            top_counter[top] += 1

    # --- Injected skill frequency ---
    injected_counter: Counter = Counter()
    for r in outcome_records:
        for sid in r.get("injected_ids", []):
            injected_counter[sid] += 1

    # --- No-match rate ---
    no_match = sum(1 for r in records if r.get("msg") == "no_match")
    low_conf = sum(1 for r in records if r.get("msg") == "low_confidence_skip")
    total_prompts = len(routing_events) + no_match + low_conf

    return {
        "total_records": len(records),
        "total_prompts_with_routing": total_prompts,
        "no_match_count": no_match,
        "low_confidence_skip_count": low_conf,
        "routing_hit_rate": round(len(routing_events) / total_prompts, 4) if total_prompts else None,
        "confidence_distribution": conf_stats,
        "lazy_injection": inj_rate_stats,
        "top_routed_top20": top_counter.most_common(20),
        "top_injected_skills": injected_counter.most_common(10),
    }


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def _fmt_human(data: dict[str, Any]) -> str:
    lines = [
        "=== routing-dispatcher telemetry ===",
        f"Total log records     : {data['total_records']}",
        f"Total routing prompts : {data['total_prompts_with_routing']}",
        f"No-match              : {data['no_match_count']}",
        f"Low-confidence skip   : {data['low_confidence_skip_count']}",
    ]
    if data.get("routing_hit_rate") is not None:
        lines.append(f"Routing hit rate      : {data['routing_hit_rate']:.1%}")

    cd = data.get("confidence_distribution", {})
    if cd:
        lines += [
            "",
            "--- Confidence distribution ---",
            f"  Count   : {cd['count']}",
            f"  Mean    : {cd['mean']:.3f}",
            f"  Median  : {cd['median']:.3f}",
            f"  p25/p75 : {cd['p25']:.3f} / {cd['p75']:.3f}",
            f"  Min/Max : {cd['min']:.3f} / {cd['max']:.3f}",
            f"  >= 0.80 : {cd['pct_high']:.1%}  (high confidence)",
            f"  0.50-0.80: {cd['pct_medium']:.1%}  (medium confidence)",
        ]

    li = data.get("lazy_injection", {})
    if li:
        lines += [
            "",
            "--- Lazy injection rate ---",
            f"  Attempts              : {li['total_attempts']}",
            f"  Injected >=1 skill    : {li['injected_at_least_one']}",
            f"  lazy_injection_rate   : {li['lazy_injection_rate']:.1%}",
            f"  Eligible but 0 injected: {li['eligible_but_zero_rate']:.1%}",
            f"  Avg candidates/attempt: {li['avg_candidates_per_attempt']:.1f}",
            f"  Avg eligible/attempt  : {li['avg_eligible_per_attempt']:.1f}",
            f"  Avg injected/attempt  : {li['avg_injected_per_attempt']:.2f}",
        ]

    top = data.get("top_routed_top20", [])
    if top:
        lines += ["", "--- Top 20 routed targets ---"]
        for label, count in top:
            lines.append(f"  {count:4d}  {label}")

    inj = data.get("top_injected_skills", [])
    if inj:
        lines += ["", "--- Top 10 injected skills ---"]
        for label, count in inj:
            lines.append(f"  {count:4d}  {label}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="compute-metrics.py",
        description="Aggregate routing-dispatcher.jsonl telemetry.",
    )
    parser.add_argument(
        "--jsonl",
        default=str(Path.home() / ".claude" / "logs" / "routing-dispatcher.jsonl"),
        help="Path to the JSONL log file.",
    )
    parser.add_argument(
        "--last",
        type=int,
        default=None,
        metavar="N",
        help="Analyse only the last N lines.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Output as JSON.",
    )
    args = parser.parse_args(argv)

    log_path = Path(args.jsonl)
    if not log_path.exists():
        sys.stderr.write(f"WARN: log file not found: {log_path}\n")
        sys.stderr.write("No telemetry data available yet. Run some prompts first.\n")
        if args.as_json:
            print(json.dumps({"error": "log_not_found", "path": str(log_path)}, indent=2))
        return 1

    records = _load_lines(log_path, args.last)
    if not records:
        sys.stderr.write("WARN: log file is empty or has no parseable records.\n")
        if args.as_json:
            print(json.dumps({"error": "no_records"}, indent=2))
        return 1

    data = _compute(records)

    if args.as_json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(_fmt_human(data))

    return 0


if __name__ == "__main__":
    sys.exit(main())
