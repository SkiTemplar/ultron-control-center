#!/usr/bin/env python3
"""
ULTRON HOOK · session-log · v1.0
Append una línea por sesión a `~/.ultron/sessions/YYYY-MM-DD.md` cuando termina (Stop event).

Uso en ~/.claude/settings.json:
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
