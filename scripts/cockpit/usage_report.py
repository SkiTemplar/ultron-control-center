#!/usr/bin/env python3
"""
ULTRON v12.4 — Skill Usage Detection Report (Task 10D)

Scans session replay files and telemetry to build a usage report:
which skills/personas were invoked, how often, and last used date.

Commands:
    usage_report.py show [--days N]   Show usage report (default: last 7 days)
    usage_report.py top [--n N]       Top N most-used skills
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SESSIONS_DIR  = Path.home() / ".ultron" / "sessions"
ROUTE_QUALITY = Path.home() / ".ultron" / "skill_cache" / "route_quality.json"


def _collect_from_replays(days: int) -> dict[str, dict]:
    """Scan routing.jsonl files for the last N days and tally tool/target invocations.

    Note: schema is from hooks/routing-telemetry.py — fields are 'tool', 'target',
    'kind', 'session_id'. (Originally referenced 'replay.jsonl' with persona/mode
    fields — that pipeline never existed; the actual telemetry is routing.jsonl.)
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    cutoff_date = cutoff.strftime("%Y-%m-%d")
    counts: dict[str, dict] = defaultdict(lambda: {"invocations": 0, "last_used": None, "modes": set()})

    if not SESSIONS_DIR.exists():
        return counts

    for session_dir in SESSIONS_DIR.iterdir():
        if not session_dir.is_dir():
            continue
        # Skip directories older than cutoff (dir name is YYYY-MM-DD)
        if session_dir.name < cutoff_date:
            continue
        routing = session_dir / "routing.jsonl"
        if not routing.exists():
            continue
        for raw in routing.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            ts_str = ev.get("ts", "")
            try:
                ts = datetime.fromisoformat(ts_str)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                if ts < cutoff:
                    continue
            except (ValueError, TypeError):
                continue
            target = (ev.get("target") or "").strip()
            if not target or target == "?":
                continue
            entry = counts[target]
            entry["invocations"] += 1
            entry["modes"].add(ev.get("kind", "?"))
            last = entry["last_used"]
            if last is None or ts_str > last:
                entry["last_used"] = ts_str[:10]

    return counts


def _collect_from_route_quality() -> dict[str, dict]:
    """Pull run counts from route_quality.json edges."""
    counts: dict[str, dict] = defaultdict(lambda: {"runs": 0, "successes": 0, "last_used": None})
    if not ROUTE_QUALITY.exists():
        return counts
    try:
        data = json.loads(ROUTE_QUALITY.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return counts

    for edge_key, edge in data.get("edges", {}).items():
        from_skill = edge.get("from", "")
        if not from_skill:
            continue
        entry = counts[from_skill]
        entry["runs"] += edge.get("runs", 0)
        entry["successes"] += edge.get("successes", 0)
        last = edge.get("last_used")
        if last and (entry["last_used"] is None or last > entry["last_used"]):
            entry["last_used"] = last[:10]
    return counts


def _recommended_action(runs: int, successes: int) -> str:
    if runs == 0:
        return "no_data"
    rate = successes / runs
    if runs < 5:
        return "collect_data"
    if rate >= 0.80:
        return "promote"
    if rate < 0.40:
        return "review"
    return "keep"


def _merge_usage(replay: dict, routes: dict) -> dict[str, dict]:
    all_skills = set(replay.keys()) | set(routes.keys())
    merged = {}
    for sk in all_skills:
        r = replay.get(sk, {})
        q = routes.get(sk, {})
        runs    = q.get("runs", 0)
        success = q.get("successes", 0)
        merged[sk] = {
            "invocations":        r.get("invocations", 0),
            "route_runs":         runs,
            "route_success":      success,
            "recommended_action": _recommended_action(runs, success),
            "modes":              sorted(r.get("modes", set())),
            "last_used":          max(
                filter(None, [r.get("last_used"), q.get("last_used")]),
                default=None
            ),
        }
    return merged


def cmd_show(args) -> int:
    days = getattr(args, "days", 7)
    replay_data  = _collect_from_replays(days)
    route_data   = _collect_from_route_quality()
    merged       = _merge_usage(replay_data, route_data)

    if not merged:
        print(f"[usage] No usage data for the last {days} days.")
        return 0

    # Sort by total activity (invocations + route_runs)
    ranked = sorted(
        merged.items(),
        key=lambda x: x[1]["invocations"] + x[1]["route_runs"],
        reverse=True
    )

    print(f"\nSkill Usage Report  [last {days} days]  {len(merged)} skills")
    print("=" * 80)
    print(f"  {'Skill':<30} {'Invoc':>6} {'Runs':>6} {'Succ':>6} {'Action':<14} {'Last Used'}")
    print(f"  {'-'*30} {'------':>6} {'------':>6} {'------':>6} {'-'*14} {'-'*10}")
    for name, data in ranked:
        inv  = data["invocations"]
        runs = data["route_runs"]
        succ = data["route_success"]
        last = data["last_used"] or "—"
        action = data["recommended_action"]
        total = inv + runs
        if total == 0:
            continue
        print(f"  {name:<30} {inv:>6} {runs:>6} {succ:>6} {action:<14} {last}")

    # Highlight actionable skills
    actionable = [(n, d) for n, d in merged.items() if d["recommended_action"] in ("promote", "review")]
    if actionable:
        print("\n  Actionable:")
        for name, data in sorted(actionable, key=lambda x: x[1]["recommended_action"]):
            runs = data["route_runs"]
            succ = data["route_success"]
            rate = f"{succ/runs*100:.0f}%" if runs else "—"
            print(f"    [{data['recommended_action'].upper():<7}] {name}  ({succ}/{runs} = {rate})")

    print(f"\n  Total tracked: {len([s for s in merged if merged[s]['invocations'] + merged[s]['route_runs'] > 0])}")
    print()
    return 0


def cmd_top(args) -> int:
    n = getattr(args, "n", 10)
    replay_data  = _collect_from_replays(30)
    route_data   = _collect_from_route_quality()
    merged       = _merge_usage(replay_data, route_data)

    ranked = sorted(
        [(name, d["invocations"] + d["route_runs"]) for name, d in merged.items()],
        key=lambda x: -x[1]
    )[:n]

    print(f"\nTop {n} skills (last 30 days)")
    for i, (name, total) in enumerate(ranked, 1):
        print(f"  {i:>2}. {name:<35} {total} calls")
    print()
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.4 Skill Usage Report")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("show", help="Show usage report")
    sp.add_argument("--days", type=int, default=7)

    tp = sub.add_parser("top", help="Top N most-used skills")
    tp.add_argument("--n", type=int, default=10)

    args = p.parse_args()
    if args.cmd == "show": return cmd_show(args)
    if args.cmd == "top":  return cmd_top(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
