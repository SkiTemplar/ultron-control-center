"""ULTRON v14.4 TOKEN HUNTER — Phase 2 prompt cache telemetry.

Reads Claude Code transcript JSONL files in ~/.claude/projects/*/<session>.jsonl
and aggregates `message.usage` cache statistics per session, project, and
sliding 24h window.

Per-turn fields extracted (from assistant events):
  - input_tokens                    (new uncached input)
  - cache_read_input_tokens         (cache hit volume)
  - cache_creation_input_tokens     (new cache writes)
  - cache_creation.ephemeral_5m_input_tokens
  - cache_creation.ephemeral_1h_input_tokens
  - output_tokens

Hit rate definition:
    hit_rate = cache_read / (cache_read + cache_creation + input)

CLI:
  cache_telemetry.py snapshot                # write hit rate snapshot to telemetry/
  cache_telemetry.py aggregate [--days N]   # roll up per project, sliding window
  cache_telemetry.py budget                 # current vs threshold

Outputs:
  ~/.ultron/telemetry/cache-events.jsonl    (per-turn rows)
  ~/.ultron/.tmp/cache-snapshot.json        (latest aggregate)

Read-only. No subprocess. No network.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _projects_root() -> Path:
    return _user_home() / ".claude" / "projects"


def _telemetry_dir() -> Path:
    return _user_home() / ".ultron" / "telemetry"


def _events_file() -> Path:
    return _telemetry_dir() / "cache-events.jsonl"


def _snapshot_file() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "cache-snapshot.json"


# ── Constants ──────────────────────────────────────────────────────────────────

# Tri-level thresholds aligned with Research-2 audit recommendation:
#   PASS     ≥ 0.60  (matches Phase 2 acceptance gate)
#   WARN  0.30..0.60 (degradation from normal floor; investigate)
#   BLOCKING < 0.30  (catastrophic regression; cache effectively dead)
PASS_THRESHOLD = 0.60
WARN_THRESHOLD = 0.30
DEFAULT_WINDOW_DAYS = 14
MIN_TURNS_FOR_VERDICT = 10


# ── Data shape ─────────────────────────────────────────────────────────────────


@dataclass
class TurnUsage:
    """Per-turn cache usage row, joinable by (project, session, ts)."""

    timestamp: str
    project: str
    session_id: str
    is_subagent: bool
    input_tokens: int
    cache_read: int
    cache_creation: int
    cache_5m: int
    cache_1h: int
    output_tokens: int

    @property
    def total_input(self) -> int:
        return self.input_tokens + self.cache_read + self.cache_creation

    @property
    def hit_rate(self) -> float:
        denom = self.total_input
        return self.cache_read / denom if denom > 0 else 0.0


@dataclass
class Aggregate:
    """Roll-up across turns. Ratios computed from sums."""

    turns: int = 0
    input_tokens: int = 0
    cache_read: int = 0
    cache_creation: int = 0
    cache_5m: int = 0
    cache_1h: int = 0
    output_tokens: int = 0

    def add(self, turn: TurnUsage) -> None:
        self.turns += 1
        self.input_tokens += turn.input_tokens
        self.cache_read += turn.cache_read
        self.cache_creation += turn.cache_creation
        self.cache_5m += turn.cache_5m
        self.cache_1h += turn.cache_1h
        self.output_tokens += turn.output_tokens

    @property
    def hit_rate(self) -> float:
        denom = self.input_tokens + self.cache_read + self.cache_creation
        return self.cache_read / denom if denom > 0 else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            **asdict(self),
            "hit_rate": round(self.hit_rate, 4),
            "cache_total": self.cache_read + self.cache_creation,
        }


# ── Transcript parsing ─────────────────────────────────────────────────────────


def _parse_iso(ts_str: str) -> datetime | None:
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except (TypeError, ValueError, AttributeError):
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def parse_transcript_event(
    event: dict[str, Any],
    *,
    project: str,
    is_subagent: bool,
) -> TurnUsage | None:
    """Convert a single JSONL line dict to TurnUsage. Returns None if not assistant."""
    if event.get("type") != "assistant":
        return None
    message = event.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None

    cc = usage.get("cache_creation") or {}
    return TurnUsage(
        timestamp=str(event.get("timestamp") or ""),
        project=project,
        session_id=str(event.get("sessionId") or ""),
        is_subagent=is_subagent,
        input_tokens=int(usage.get("input_tokens") or 0),
        cache_read=int(usage.get("cache_read_input_tokens") or 0),
        cache_creation=int(usage.get("cache_creation_input_tokens") or 0),
        cache_5m=int(cc.get("ephemeral_5m_input_tokens") or 0),
        cache_1h=int(cc.get("ephemeral_1h_input_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or 0),
    )


def iter_turns(
    *,
    window_days: int | None = DEFAULT_WINDOW_DAYS,
    include_subagents: bool = False,
) -> Iterable[TurnUsage]:
    """Yield TurnUsage rows from all transcript JSONL files.

    window_days=None means all-time; otherwise filter by event timestamp.
    """
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=window_days)
        if window_days is not None else None
    )
    root = _projects_root()
    if not root.exists():
        return

    for jsonl in root.rglob("*.jsonl"):
        # Determine project (top-level dir under projects/)
        try:
            rel = jsonl.relative_to(root)
        except ValueError:
            continue
        parts = rel.parts
        project = parts[0] if parts else "unknown"
        is_subagent = "subagents" in parts

        if is_subagent and not include_subagents:
            continue

        try:
            text = jsonl.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            turn = parse_transcript_event(
                event, project=project, is_subagent=is_subagent
            )
            if turn is None:
                continue
            if cutoff is not None:
                ts = _parse_iso(turn.timestamp)
                if ts is None or ts < cutoff:
                    continue
            yield turn


# ── Aggregation ────────────────────────────────────────────────────────────────


def aggregate_by_project(
    turns: Iterable[TurnUsage],
) -> dict[str, Aggregate]:
    out: dict[str, Aggregate] = {}
    for turn in turns:
        agg = out.setdefault(turn.project, Aggregate())
        agg.add(turn)
    return out


def aggregate_global(turns: Iterable[TurnUsage]) -> Aggregate:
    agg = Aggregate()
    for turn in turns:
        agg.add(turn)
    return agg


# ── Snapshot writers ───────────────────────────────────────────────────────────


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(path)


def write_snapshot(
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    include_subagents: bool = False,
) -> dict[str, Any]:
    turns = list(iter_turns(
        window_days=window_days, include_subagents=include_subagents,
    ))
    by_proj = aggregate_by_project(turns)
    overall = aggregate_global(turns)
    payload = {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "window_days": window_days,
        "include_subagents": include_subagents,
        "global": overall.to_dict(),
        "per_project": {p: a.to_dict() for p, a in sorted(by_proj.items())},
    }
    _atomic_write_json(_snapshot_file(), payload)
    return payload


def append_events(turns: Iterable[TurnUsage]) -> int:
    """Append turns to ~/.ultron/telemetry/cache-events.jsonl. Returns count."""
    out = _events_file()
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("a", encoding="utf-8") as f:
        for t in turns:
            f.write(json.dumps(asdict(t), ensure_ascii=False) + "\n")
            n += 1
    return n


# ── Detector helpers ───────────────────────────────────────────────────────────


def classify_hit_rate(
    hit_rate: float,
    turns: int,
    *,
    pass_threshold: float = PASS_THRESHOLD,
    warn_threshold: float = WARN_THRESHOLD,
    min_turns: int = MIN_TURNS_FOR_VERDICT,
) -> str:
    """Tri-level classification: insufficient / blocking / warn / pass."""
    if turns < min_turns:
        return "insufficient"
    if hit_rate < warn_threshold:
        return "blocking"
    if hit_rate < pass_threshold:
        return "warn"
    return "pass"


def detector_status(
    *,
    pass_threshold: float = PASS_THRESHOLD,
    warn_threshold: float = WARN_THRESHOLD,
    window_days: int = DEFAULT_WINDOW_DAYS,
) -> dict[str, Any]:
    """Compute D24 detector verdict from current state."""
    turns = list(iter_turns(window_days=window_days, include_subagents=False))
    overall = aggregate_global(turns)
    verdict = classify_hit_rate(
        overall.hit_rate, overall.turns,
        pass_threshold=pass_threshold, warn_threshold=warn_threshold,
    )
    return {
        "hit_rate": round(overall.hit_rate, 4),
        "pass_threshold": pass_threshold,
        "warn_threshold": warn_threshold,
        "turns_observed": overall.turns,
        "window_days": window_days,
        "verdict": verdict,
    }


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_snapshot(args: argparse.Namespace) -> int:
    payload = write_snapshot(
        window_days=args.days, include_subagents=args.include_subagents,
    )
    overall = payload["global"]
    print(json.dumps({
        "saved": str(_snapshot_file()),
        "window_days": args.days,
        "turns": overall["turns"],
        "hit_rate": overall["hit_rate"],
    }, indent=2))
    return 0


def _cmd_aggregate(args: argparse.Namespace) -> int:
    turns = list(iter_turns(
        window_days=args.days, include_subagents=args.include_subagents,
    ))
    by_proj = aggregate_by_project(turns)
    overall = aggregate_global(turns)
    rows = sorted(
        ((p, a.turns, a.hit_rate, a.cache_read) for p, a in by_proj.items()),
        key=lambda r: -r[1],
    )
    print(f"{'project':<40} {'turns':>6} {'hit_rate':>9} {'read_tok':>14}")
    print("-" * 75)
    for p, turns_n, hr, read in rows[: args.limit]:
        print(f"{p[:40]:<40} {turns_n:>6} {hr*100:>8.1f}% {read:>14,}")
    print("-" * 75)
    print(
        f"{'GLOBAL':<40} {overall.turns:>6} "
        f"{overall.hit_rate*100:>8.1f}% {overall.cache_read:>14,}"
    )
    return 0


def _cmd_budget(args: argparse.Namespace) -> int:
    status = detector_status(
        pass_threshold=args.pass_threshold,
        warn_threshold=args.warn_threshold,
        window_days=args.days,
    )
    print(json.dumps(status, indent=2))
    # Exit code: 0 pass/insufficient, 1 warn, 2 blocking
    return {"pass": 0, "insufficient": 0, "warn": 1, "blocking": 2}[status["verdict"]]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cache_telemetry.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_snap = sub.add_parser("snapshot", help="write hit rate snapshot")
    p_snap.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS)
    p_snap.add_argument("--include-subagents", action="store_true")
    p_snap.set_defaults(func=_cmd_snapshot)

    p_agg = sub.add_parser("aggregate", help="per-project hit rate table")
    p_agg.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS)
    p_agg.add_argument("--limit", type=int, default=15)
    p_agg.add_argument("--include-subagents", action="store_true")
    p_agg.set_defaults(func=_cmd_aggregate)

    p_bud = sub.add_parser("budget", help="D24 detector status")
    p_bud.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS)
    p_bud.add_argument("--pass-threshold", type=float, default=PASS_THRESHOLD)
    p_bud.add_argument("--warn-threshold", type=float, default=WARN_THRESHOLD)
    p_bud.set_defaults(func=_cmd_budget)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
