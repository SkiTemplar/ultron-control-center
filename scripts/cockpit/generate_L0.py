"""Generate L0 pinned context for ULTRON sessions (S3-A).

Writes ~/.ultron/.tmp/L0-pinned.md with user identity, current focus,
BLOCKING alerts, and active session mode. Capped at 200 tokens via
token_budget.enforce with "[BLOCKING]" priority prefix.

Usage:
    uv run python generate_L0.py          # writes file, prints path
    uv run python generate_L0.py --print  # writes file + prints content

Fail-soft: any internal exception writes a minimal stub — never crashes
session-init.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
_HOME = Path.home()
_ULTRON = _HOME / ".ultron"
_OUT_PATH = _ULTRON / ".tmp" / "L0-pinned.md"
_FOCUS_JSON = _ULTRON / "memory" / "focus.json"
_ALERTS_JSONL = _ULTRON / "alerts.jsonl"
_SESSION_JSON = _ULTRON / ".tmp" / "current-session.json"

# ── Constants ────────────────────────────────────────────────────────────────
L0_TOKEN_LIMIT = 200
_MAX_ALERTS_BYTES = 1_048_576   # 1 MB read cap
_MAX_ALERTS_LINES = 200
# v15.5.18 review: pull the user identity from ~/.ultron/personal/profile.md
# instead of a hardcoded "User · ..." line. Falls back to a generic ULTRON
# user description when the personal profile is missing so a fresh install
# still gets a sensible L0 primer.
_DEFAULT_USER_LINE = "ULTRON user (set ~/.ultron/personal/profile.md to customise this line)"


def _read_user_line() -> str:
    """Return the first non-empty, non-heading line of personal/profile.md,
    or a neutral default if the file is missing / unreadable.

    The convention: profile.md's first non-heading line is a one-liner bio
    suitable for a session primer. Anything longer than 160 chars is
    truncated to keep L0 tight.
    """
    try:
        from pathlib import Path
        p = Path.home() / ".ultron" / "personal" / "profile.md"
        if not p.is_file():
            return _DEFAULT_USER_LINE
        for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("---"):
                continue
            if line.startswith("> "):
                line = line[2:].strip()
            return line[:160] if line else _DEFAULT_USER_LINE
    except Exception:
        pass
    return _DEFAULT_USER_LINE


_USER_LINE = _read_user_line()


def _read_focus() -> str:
    """Return focus string from focus.json or '—' if missing/invalid."""
    try:
        if _FOCUS_JSON.exists():
            data = json.loads(_FOCUS_JSON.read_text(encoding="utf-8"))
            return str(data.get("focus") or "—").strip() or "—"
    except Exception:
        pass
    return "—"


def _read_mode() -> str:
    """Return session mode from current-session.json or 'MEDIUM' as default."""
    try:
        if _SESSION_JSON.exists():
            data = json.loads(_SESSION_JSON.read_text(encoding="utf-8"))
            return str(data.get("Mode") or data.get("mode") or "MEDIUM").strip().upper()
    except Exception:
        pass
    return "MEDIUM"


def _read_blocking_alerts() -> list[str]:
    """Read alerts.jsonl and return formatted BLOCKING lines (unacked, severity=blocking).

    Bounded read: max 1 MB or first 200 lines. Returns list of strings like
    '[BLOCKING] message text'.
    """
    blocking: list[str] = []
    if not _ALERTS_JSONL.exists():
        return blocking

    try:
        # Track the latest ack status per alert id (JSONL append pattern).
        ack_map: dict[str, bool] = {}
        severity_map: dict[str, str] = {}
        message_map: dict[str, str] = {}

        bytes_read = 0
        lines_read = 0

        with _ALERTS_JSONL.open("r", encoding="utf-8", errors="replace") as fh:
            for raw_line in fh:
                bytes_read += len(raw_line.encode("utf-8", errors="replace"))
                if bytes_read > _MAX_ALERTS_BYTES or lines_read >= _MAX_ALERTS_LINES:
                    break
                lines_read += 1
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except Exception:
                    continue
                alert_id = record.get("id", "")
                if not alert_id:
                    continue
                # Track ack status (last write wins — JSONL append pattern)
                if "ack" in record:
                    ack_map[alert_id] = bool(record["ack"])
                if "severity" in record:
                    severity_map[alert_id] = str(record["severity"]).lower()
                if "message" in record:
                    message_map[alert_id] = str(record["message"])

        for alert_id, severity in severity_map.items():
            if severity == "blocking" and not ack_map.get(alert_id, False):
                msg = message_map.get(alert_id, alert_id)
                blocking.append(f"[BLOCKING] {msg}")

    except Exception:
        pass

    return blocking


def build_content(ts: str, focus: str, mode: str, blocking: list[str]) -> str:
    """Assemble L0 content string (before token enforcement)."""
    lines: list[str] = [
        f"# ULTRON L0 [{ts}]",
        f"👤 {_USER_LINE}",
        f"🎯 Foco: {focus}",
    ]
    # Codex S3 M1 fix: spec says omit BLOCKING line entirely when there are
    # no unacked blocking alerts (saves ~25 tokens of L0 budget for empty
    # padding text). Only emit the section when there's actually something
    # blocking the user.
    if blocking:
        lines.append(f"🚨 BLOCKING: {len(blocking)} alert(s)")
        lines.extend(blocking)
    lines.append(f"⚡ Modo: {mode}")
    return "\n".join(lines)


def generate(print_content: bool = False) -> str:
    """Generate L0 pinned context. Returns output path. Fail-soft."""
    # Ensure output directory exists (idempotent).
    try:
        _OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    try:
        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        focus = _read_focus()
        mode = _read_mode()
        blocking = _read_blocking_alerts()
        content = build_content(ts, focus, mode, blocking)

        # Import token_budget from the same cockpit directory.
        _cockpit = Path(__file__).parent
        sys.path.insert(0, str(_cockpit))
        from token_budget import enforce, log  # noqa: PLC0415

        enforced = enforce(content, L0_TOKEN_LIMIT, "[BLOCKING]")
        # Measure and log actual token count.
        from token_budget import measure  # noqa: PLC0415
        actual_tokens = measure(enforced)
        log("L0", actual_tokens, L0_TOKEN_LIMIT)

    except Exception:
        # Fail-soft: write minimal stub so session-init never crashes.
        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        enforced = f"# ULTRON L0 [{ts}]\n👤 {_USER_LINE}\n[L0 generation partial — see logs]"

    try:
        _OUT_PATH.write_text(enforced, encoding="utf-8")
    except Exception:
        pass

    if print_content:
        _safe_print(enforced)

    return str(_OUT_PATH)


def _safe_print(text: str) -> None:
    """Print text to stdout, encoding-safe on Windows cp1252 consoles."""
    try:
        sys.stdout.buffer.write((text + "\n").encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    except AttributeError:
        # Fallback for StringIO or similar in tests.
        print(text.encode("utf-8", errors="replace").decode("ascii", errors="replace"))


def main() -> None:
    print_content = "--print" in sys.argv
    out = generate(print_content=print_content)
    try:
        print(out)
    except UnicodeEncodeError:
        sys.stdout.buffer.write((out + "\n").encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
