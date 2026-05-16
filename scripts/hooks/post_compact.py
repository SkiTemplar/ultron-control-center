#!/usr/bin/env python3
"""ULTRON PostCompact hook.

Fires after Claude Code finishes context compaction. We log the event so
the timeline shows when it happened, and print a short recovery roadmap so
the model has a clear "where to look to rebuild state" right after the
summary lands.

Intentionally short — the model already has the compacted summary, plus
whatever pre_compact.py dumped into the conversation. We just nudge it
toward the right next step.
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
SESSION_LOG_DIR = ULTRON / "sessions"


def _log_event() -> None:
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        dir_ = SESSION_LOG_DIR / today
        dir_.mkdir(parents=True, exist_ok=True)
        path = dir_ / "compaction-log.jsonl"
        entry = json.dumps({
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": "context_compaction",
            "source": "post_compact_hook",
        }, ensure_ascii=False)
        with path.open("a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except OSError:
        pass


def main() -> int:
    try:
        _ = sys.stdin.read()
    except Exception:  # noqa: BLE001
        pass

    _log_event()

    print("=== ULTRON POST-COMPACTION RECOVERY ===")
    print("Context was just compacted. To rebuild full working state:")
    print("- Read ~/.ultron/.tmp/context.md (the L0 primer).")
    print("- Check the Control Center Plans tab for in-progress items.")
    print("- If you were mid-task, the pre-compact dump above lists the")
    print("  open plans, recent routing decisions and critical alerts.")
    print("=== END ===")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        try:
            sys.stderr.write(f"[post_compact] non-fatal error: {exc}\n")
        except Exception:  # noqa: BLE001
            pass
        sys.exit(0)
