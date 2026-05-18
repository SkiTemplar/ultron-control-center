#!/usr/bin/env python3
# === maintainer-only as of v15.5.16 (folded into stop-memory-sync.{ps1,sh}) ===
"""
ULTRON HOOK · session-log · v1.0  (DEPRECATED for live hook use)

As of v15.5.16 (internal-review-note consolidation) this script is NO LONGER wired into
the Stop hook chain. Its single behavior — appending one human-readable line
per session-end to `~/.ultron/sessions/YYYY-MM-DD.md` — is now inlined at the
top of `scripts/hooks/stop-memory-sync.{ps1,sh}` so the Stop chain spends one
fewer Python process per session.

The script is kept on disk so it can still be invoked manually by maintainers
when backfilling a missing per-day log, and so any out-of-tree dotfile that
references it does not break. See `docs/MAINTAINERS.md`.

Original wiring (pre-v15.5.16):
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "python %USERPROFILE%/.ultron/scripts/hooks/session-log.py"
      }]
    }]
  }
}
"""
import json
import sys
from datetime import datetime
from pathlib import Path


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    today = datetime.now().strftime("%Y-%m-%d")
    sessions_dir = Path.home() / ".ultron" / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    log_file = sessions_dir / f"{today}.md"

    # Si el archivo no existe, crear header
    if not log_file.exists():
        log_file.write_text(f"# Sessions log — {today}\n\n", encoding="utf-8")

    timestamp = datetime.now().strftime("%H:%M:%S")
    cwd = input_data.get("cwd", "?")
    session_id = input_data.get("session_id", "?")[:8]

    entry = f"- {timestamp} · session {session_id} · cwd `{cwd}`\n"

    with log_file.open("a", encoding="utf-8") as f:
        f.write(entry)


if __name__ == "__main__":
    main()
