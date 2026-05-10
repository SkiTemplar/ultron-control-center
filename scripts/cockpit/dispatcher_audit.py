"""ULTRON v14 — dispatcher telemetry analyzer.

Reads ``~/.ultron/telemetry/dispatcher-events.jsonl`` (5,000+ events
accumulated organically) and reports:

  - Total event count, time span
  - Routing rate (% with non-null route)
  - Top routes by hit count
  - No-route prompts (where the dispatcher decided not to suggest)
  - Latency distribution: p50 / p95 / p99 / max
  - Source breakdown: rules vs ztmsi vs slash vs none

This is the quantitative signal that complements E2 (manual ≥80%
accuracy evaluation). Runs in <1s on the live file. Pure stdlib.

Usage:
    uv run python dispatcher_audit.py                    # human report
    uv run python dispatcher_audit.py --json             # machine-readable
    uv run python dispatcher_audit.py --since 2026-05-01 # filter window
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from pathlib import Path
from collections import Counter
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_EVENTS_PATH = Path(
    os.environ.get("USERPROFILE", os.path.expanduser("~"))
) / ".ultron" / "telemetry" / "dispatcher-events.jsonl"


def _parse_ts(ts: str) -> _dt.datetime | None:
    """Parse ISO-Z timestamp; return None on garbage."""
    if not isinstance(ts, str):
        return None
    try:
        return _dt.datetime.fromisoformat(ts.rstrip("Z"))
    except ValueError:
        return None


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Plain index-based percentile (no interpolation). Fast enough."""
    if not sorted_values:
        return 0.0
    idx = int(len(sorted_values) * pct / 100)
    idx = min(idx, len(sorted_values) - 1)
    return sorted_values[idx]


def load_events(path: Path = _EVENTS_PATH,
                 since: _dt.datetime | None = None) -> list[dict[str, Any]]:
    """Return parsed events, oldest first. Skips malformed lines silently."""
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(rec, dict):
                continue
            if since is not None:
                ts = _parse_ts(rec.get("ts", ""))
                if ts is None or ts < since:
                    continue
            out.append(rec)
    return out


def analyze(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute the report dict from a list of events."""
    if not events:
        return {
            "total": 0,
            "first_ts": None,
            "last_ts": None,
            "routes": [],
            "sources": {},
            "no_route_count": 0,
            "no_route_rate": 0.0,
            "latency": {"p50": 0, "p95": 0, "p99": 0, "max": 0, "mean": 0},
        }

    total = len(events)
    first_ts = events[0].get("ts")
    last_ts = events[-1].get("ts")

    route_counter: Counter[str] = Counter()
    source_counter: Counter[str] = Counter()
    no_route = 0
    latencies: list[float] = []

    for rec in events:
        route = rec.get("route")
        source = str(rec.get("source") or "none")
        latency = rec.get("latency_ms")

        if route is None or route == "":
            no_route += 1
        else:
            route_counter[str(route)] += 1
        source_counter[source] += 1

        if isinstance(latency, (int, float)):
            latencies.append(float(latency))

    latencies.sort()
    lat_summary = {
        "p50": _percentile(latencies, 50),
        "p95": _percentile(latencies, 95),
        "p99": _percentile(latencies, 99),
        "max": latencies[-1] if latencies else 0,
        "mean": (sum(latencies) / len(latencies)) if latencies else 0,
    }

    return {
        "total": total,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "routes": route_counter.most_common(15),
        "sources": dict(source_counter),
        "no_route_count": no_route,
        "no_route_rate": round(no_route / total * 100, 2) if total else 0.0,
        "latency": lat_summary,
    }


def format_human(report: dict[str, Any]) -> str:
    """Render a compact human-readable report (≤30 lines)."""
    if report["total"] == 0:
        return "No dispatcher events found."

    lines: list[str] = []
    lines.append("ULTRON DISPATCHER AUDIT")
    lines.append("=" * 32)
    lines.append("")
    lines.append(f"  Events                    {report['total']:>8}")
    lines.append(f"  First                     {report['first_ts']}")
    lines.append(f"  Last                      {report['last_ts']}")
    lines.append(f"  No-route                  {report['no_route_count']:>8}  ({report['no_route_rate']}%)")
    lines.append(f"  Routed                    {report['total'] - report['no_route_count']:>8}  ({100 - report['no_route_rate']}%)")
    lines.append("")
    lines.append("LATENCY (ms)")
    lat = report["latency"]
    lines.append(f"  p50                       {lat['p50']:>8.1f}")
    lines.append(f"  p95                       {lat['p95']:>8.1f}")
    lines.append(f"  p99                       {lat['p99']:>8.1f}")
    lines.append(f"  max                       {lat['max']:>8.1f}")
    lines.append(f"  mean                      {lat['mean']:>8.2f}")
    lines.append("")
    lines.append("SOURCE BREAKDOWN")
    for source, count in sorted(report["sources"].items(), key=lambda x: -x[1]):
        pct = count / report["total"] * 100
        lines.append(f"  {source:<24}  {count:>8}  ({pct:5.1f}%)")
    lines.append("")
    lines.append("TOP ROUTES")
    routed = report["total"] - report["no_route_count"]
    if routed == 0:
        lines.append("  (no routed events)")
    else:
        for route, count in report["routes"]:
            pct = count / routed * 100
            lines.append(f"  {route:<35}  {count:>6}  ({pct:5.1f}%)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dispatcher_audit.py",
        description="Quantitative report on intent-dispatcher telemetry.",
    )
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--since", type=str, default=None,
                         help="Filter to events on/after YYYY-MM-DD")
    args = parser.parse_args(argv)

    since = None
    if args.since:
        try:
            since = _dt.datetime.fromisoformat(args.since)
        except ValueError:
            print(f"[dispatcher_audit] invalid --since: {args.since}",
                   file=sys.stderr)
            return 1

    events = load_events(since=since)
    report = analyze(events)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(format_human(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
