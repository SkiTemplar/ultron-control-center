#!/usr/bin/env python3
"""ULTRON PreCompact hook.

Claude Code calls this right before it compacts the conversation context.
Anything we print to stdout lands in the conversation BEFORE compaction, so
it survives the summarisation step. We use that to preserve the live work
state — the model post-compact then has a roadmap to recover from.

Inspired by donchitos/Claude-Code-Game-Studios pre-compact.sh, adapted to
the ULTRON cockpit (context.md / plans / routing.jsonl / alerts.jsonl).

Hook contract:
- Reads a JSON payload from stdin (Claude Code passes session metadata).
- Prints a structured state dump to stdout — UTF-8, no emoji.
- Always exits 0; we never want to block compaction even if we crash.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~")))
ULTRON = HOME / ".ultron"
CONTEXT_MD = ULTRON / ".tmp" / "context.md"
SESSION_LOG_DIR = ULTRON / "sessions"
PLANS_JSON = ULTRON / "cockpit" / "PLANS.json"
ALERTS_JSONL = ULTRON / "alerts.jsonl"
SESSION_FILE = ULTRON / ".tmp" / "current-session.json"


def _print_section(title: str) -> None:
    print()
    print(f"## {title}")


def _safe_read(path: Path, max_chars: int = 4000) -> str | None:
    try:
        if not path.is_file():
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
        if len(text) > max_chars:
            return text[:max_chars] + f"\n... (truncated, {len(text)} chars total)"
        return text
    except OSError:
        return None


def _read_jsonl_tail(path: Path, n: int) -> list[dict]:
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for raw in lines[-n * 2:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        out.append(obj)
        if len(out) >= n:
            break
    return out[-n:]


def main() -> int:
    # Drain stdin so Claude Code doesn't think we hung on a payload.
    try:
        _ = sys.stdin.read()
    except Exception:  # noqa: BLE001
        pass

    print("=== ULTRON STATE BEFORE COMPACTION ===")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat(timespec='seconds')}")

    # --- L0 context primer ----------------------------------------------------
    ctx = _safe_read(CONTEXT_MD, max_chars=2000)
    if ctx is not None:
        _print_section("Active context primer (.ultron/.tmp/context.md)")
        print(ctx.rstrip())
    else:
        _print_section("Active context primer")
        print("(no context.md found — first session, or hook hasn't generated one yet)")

    # --- Current-session metadata --------------------------------------------
    sess = _safe_read(SESSION_FILE, max_chars=1500)
    if sess is not None:
        _print_section("Current session metadata")
        print(sess.rstrip())

    # --- Plans in progress ----------------------------------------------------
    try:
        if PLANS_JSON.is_file():
            raw = PLANS_JSON.read_text(encoding="utf-8", errors="replace")
            plans = json.loads(raw)
            active = [
                p for p in plans.get("plans", [])
                if p.get("status") in ("in-progress", "blocked")
            ]
            if active:
                _print_section(f"Active plans ({len(active)})")
                for p in active[:10]:
                    pid = p.get("id", "?")
                    title = (p.get("title") or "").strip()
                    status = p.get("status", "?")
                    print(f"- [{status}] {pid}: {title[:120]}")
    except (OSError, json.JSONDecodeError):
        pass

    # --- Critical un-acked alerts --------------------------------------------
    alerts = _read_jsonl_tail(ALERTS_JSONL, 50)
    by_id: dict[str, dict] = {}
    for a in alerts:
        aid = a.get("id")
        if not isinstance(aid, str):
            continue
        if aid not in by_id:
            by_id[aid] = dict(a)
        elif a.get("ack") is True:
            by_id[aid]["ack"] = True
    critical_open = [
        a for a in by_id.values()
        if a.get("severity") in ("blocking", "critical") and not a.get("ack")
    ]
    if critical_open:
        _print_section(f"Critical un-acked alerts ({len(critical_open)})")
        for a in critical_open[:10]:
            ts = a.get("ts") or a.get("timestamp") or "?"
            print(f"- [{a.get('source', '?')}] {ts} {a.get('message', '')[:160]}")

    # --- Latest routing entries ----------------------------------------------
    today = datetime.now().strftime("%Y-%m-%d")
    routing = SESSION_LOG_DIR / today / "routing.jsonl"
    recent = _read_jsonl_tail(routing, 5)
    if recent:
        _print_section("Recent routing decisions (last 5)")
        for r in recent:
            tool = r.get("tool") or r.get("event") or "?"
            target = r.get("target") or r.get("decision") or ""
            print(f"- {r.get('ts', '?')} {tool} {target}"[:200])

    print()
    print("## Recovery hint")
    print("After compaction: re-read context.md, check the Plans tab in the")
    print("Control Center, and resume from the most recent routing entry.")
    print("=== END ULTRON STATE ===")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        # Never block compaction on a hook error.
        try:
            sys.stderr.write(f"[pre_compact] non-fatal error: {exc}\n")
        except Exception:  # noqa: BLE001
            pass
        sys.exit(0)
