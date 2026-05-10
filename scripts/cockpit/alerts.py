"""ULTRON Alerts Bus — append-only persistent alert channel.

Sprint 1 (v13.4.0 SILENT + ALERTS). Schema, API and CLI documented in
`~/.ultron/docs/alerts-bus.md`.

DESIGN INVARIANTS
-----------------
1. **Append-only.** alerts.jsonl never gets rewritten. Acks are NEW lines,
   not mutations. This eliminates write-race / truncation risk entirely.
2. **Atomic single-line writes.** `os.O_APPEND` + one ``write()`` per line.
   On Windows, NTFS provides similar atomicity for writes <= sector size; we
   pad each record to a single line ending in ``\n``. Concurrent writers
   never interleave bytes.
3. **Silent.** No console output unless ``--verbose`` is passed to the CLI.
4. **Fail-safe.** Any failure in write/read returns gracefully — alerts must
   never block the caller.

SEVERITY LADDER: ``info`` < ``warn`` < ``blocking``. Default surface
threshold for SessionStart injection is ``warn``.

ID FORMAT: ``a-YYYY-MM-DD-NNN`` — 3-digit counter resets per day, computed
by reading existing entries for that date.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    import msvcrt  # type: ignore[import-not-found]
else:
    import fcntl  # type: ignore[import-not-found]

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
ALERTS_FILE = ULTRON_HOME / "alerts.jsonl"
ARCHIVE_DIR = ULTRON_HOME / "alerts" / "archive"

SEVERITY_ORDER = {"info": 0, "warn": 1, "blocking": 2}
VALID_SEVERITIES = ("info", "warn", "blocking")

# In-process lock — serializes writers within a single Python process so the
# (id-compute, append) sequence is atomic and never produces duplicate ids.
# Cross-process safety is provided by an OS-level file lock on a sidecar
# `.lock` file (msvcrt on Windows, fcntl elsewhere).
_PROCESS_LOCK = threading.Lock()
_LOCK_TIMEOUT_S = 5.0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _ensure_file() -> None:
    """Make sure alerts.jsonl exists. Idempotent."""
    ULTRON_HOME.mkdir(parents=True, exist_ok=True)
    if not ALERTS_FILE.exists():
        ALERTS_FILE.touch()


def _read_lines() -> list[dict[str, Any]]:
    """Return all parsed JSON records from alerts.jsonl. Skips malformed lines."""
    _ensure_file()
    out: list[dict[str, Any]] = []
    try:
        with ALERTS_FILE.open("r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    # malformed line — skip silently (alerts bus must not
                    # block on bad data; doctor can flag corruption later).
                    continue
    except OSError:
        return []
    return out


def _next_id(today: str | None = None) -> str:
    """Compute next a-YYYY-MM-DD-NNN id by counting today's records."""
    if today is None:
        today = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d")
    prefix = f"a-{today}-"
    count = 0
    seen_ids: set[str] = set()
    for rec in _read_lines():
        rid = rec.get("id", "")
        if not isinstance(rid, str):
            continue
        if rid.startswith(prefix) and rid not in seen_ids:
            seen_ids.add(rid)
            count += 1
    return f"{prefix}{count + 1:03d}"


def _atomic_append(record: dict[str, Any]) -> None:
    """Append one JSON line via O_APPEND (atomic on POSIX & Windows for <PIPE_BUF).

    Note: this primitive is safe for byte-interleaving but the *id assignment*
    still requires a higher-level lock — see `_locked_section`.
    """
    _ensure_file()
    payload = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    data = payload.encode("utf-8")
    # os.O_APPEND guarantees the kernel positions the offset to EOF for each
    # write atomically — no interleaving across concurrent writers as long as
    # the write is one syscall and small (typical alerts < 1KB).
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    fd = os.open(str(ALERTS_FILE), flags, 0o644)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


class _LockedSection:
    """Context manager: in-process threading.Lock + cross-process file lock.

    The cross-process lock uses a sidecar `.lock` file (msvcrt on Windows,
    fcntl on POSIX). Best-effort with timeout; on lock timeout we degrade to
    "in-process lock only" rather than blocking the caller indefinitely —
    the alerts bus must never hang the user's session.
    """

    def __init__(self) -> None:
        self._fd: int | None = None
        self._held_threading = False
        self._held_oslock = False

    def __enter__(self) -> "_LockedSection":
        _PROCESS_LOCK.acquire()
        self._held_threading = True
        try:
            ULTRON_HOME.mkdir(parents=True, exist_ok=True)
            lock_path = ULTRON_HOME / "alerts.jsonl.lock"
            self._fd = os.open(
                str(lock_path),
                os.O_WRONLY | os.O_CREAT | (os.O_BINARY if hasattr(os, "O_BINARY") else 0),
                0o644,
            )
            deadline = time.monotonic() + _LOCK_TIMEOUT_S
            while True:
                try:
                    if sys.platform == "win32":
                        msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._held_oslock = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        # degrade gracefully: in-process lock still held
                        break
                    time.sleep(0.01)
        except OSError:
            # If we cannot open the lock file at all, proceed with only the
            # threading lock — better than blocking startup paths.
            self._fd = None
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            if self._fd is not None and self._held_oslock:
                try:
                    if sys.platform == "win32":
                        msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(self._fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            if self._fd is not None:
                try:
                    os.close(self._fd)
                except OSError:
                    pass
        finally:
            if self._held_threading:
                _PROCESS_LOCK.release()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def write(severity: str, source: str, message: str,
          tags: list[str] | None = None) -> str:
    """Append one alert. Returns the id. Silent.

    Args:
        severity: one of 'info' | 'warn' | 'blocking'
        source:   originating script/component (e.g. 'session-init.ps1')
        message:  human-readable summary, single line preferred
        tags:     optional list of free-form tags

    Returns:
        the alert id (a-YYYY-MM-DD-NNN)
    """
    if severity not in VALID_SEVERITIES:
        raise ValueError(f"severity must be one of {VALID_SEVERITIES}, got {severity!r}")
    # Critical: id-compute + append must be atomic with respect to other
    # writers, otherwise two concurrent calls can produce the same id.
    with _LockedSection():
        now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).replace(microsecond=0)
        today = now.strftime("%Y-%m-%d")
        aid = _next_id(today)
        rec = {
            "id": aid,
            "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "severity": severity,
            "source": source,
            "message": message,
            "tags": list(tags) if tags else [],
            "ack": False,
            "ack_ts": None,
        }
        _atomic_append(rec)
    return aid


def write_dedupe(severity: str, source: str, message: str,
                  dedupe_tag: str, window_seconds: int,
                  tags: list[str] | None = None) -> str | None:
    """Write an alert ONLY if no unacked alert tagged with *dedupe_tag* has
    been written in the last *window_seconds*. Returns the new alert id if
    one was written, or ``None`` if deduped.

    The check-and-write happens atomically inside the same lock used by
    :func:`write`, so two concurrent callers cannot both pass the check and
    both append duplicate alerts (Codex S5-A H2 fix).

    *dedupe_tag* is automatically added to the final tag list if not already
    present, so a follow-up call with the same tag finds this record.

    A ``window_seconds <= 0`` value disables dedupe (always writes), which
    keeps the function usable as a drop-in replacement for :func:`write`.
    """
    if severity not in VALID_SEVERITIES:
        raise ValueError(f"severity must be one of {VALID_SEVERITIES}, got {severity!r}")
    if not isinstance(dedupe_tag, str) or not dedupe_tag:
        raise ValueError("dedupe_tag must be a non-empty string")

    with _LockedSection():
        if window_seconds > 0:
            try:
                state = _fold(_read_lines())
            except Exception:
                state = {}
            cutoff = (
                _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
                - _dt.timedelta(seconds=window_seconds)
            )
            cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
            for rec in state.values():
                if rec.get("ack"):
                    continue
                ts = rec.get("ts", "")
                if not isinstance(ts, str) or ts < cutoff_iso:
                    continue
                rec_tags = rec.get("tags") or []
                if isinstance(rec_tags, list) and dedupe_tag in rec_tags:
                    return None

        # No recent match — write atomically inside the same lock.
        now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).replace(microsecond=0)
        today = now.strftime("%Y-%m-%d")
        aid = _next_id(today)
        all_tags = list(tags) if tags else []
        if dedupe_tag not in all_tags:
            all_tags.append(dedupe_tag)
        rec = {
            "id": aid,
            "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "severity": severity,
            "source": source,
            "message": message,
            "tags": all_tags,
            "ack": False,
            "ack_ts": None,
        }
        _atomic_append(rec)
    return aid


def ack(alert_id: str) -> bool:
    """Append a NEW line marking the alert acked.

    The original line is NEVER mutated. ``read_unacked`` folds the latest
    state per id. Returns True if an alert with this id has been seen at
    least once (even if already acked); False if id is unknown.
    """
    with _LockedSection():
        seen = any(rec.get("id") == alert_id for rec in _read_lines())
        if not seen:
            return False
        now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).replace(microsecond=0)
        rec = {
            "id": alert_id,
            "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ack": True,
            "ack_ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        _atomic_append(rec)
    return True


def _fold(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Collapse multi-line records per id to latest known state."""
    state: dict[str, dict[str, Any]] = {}
    for rec in records:
        rid = rec.get("id")
        if not isinstance(rid, str):
            continue
        if rid not in state:
            # First time we see this id — must be the original (has severity etc.)
            state[rid] = dict(rec)
        else:
            # Subsequent line — merge ack fields if present.
            if rec.get("ack") is True:
                state[rid]["ack"] = True
                state[rid]["ack_ts"] = rec.get("ack_ts")
    return state


def read_unacked(severity_min: str = "info",
                 limit: int | None = None) -> list[dict[str, Any]]:
    """Return unacked alerts >= severity_min, oldest first.

    Args:
        severity_min: minimum severity to surface ('info', 'warn', 'blocking')
        limit: optional cap on number returned (most recent N — i.e. last in time)
    """
    if severity_min not in SEVERITY_ORDER:
        raise ValueError(f"severity_min must be one of {VALID_SEVERITIES}")
    threshold = SEVERITY_ORDER[severity_min]
    state = _fold(_read_lines())
    out: list[dict[str, Any]] = []
    for rid, rec in state.items():
        if rec.get("ack"):
            continue
        sev = rec.get("severity")
        if sev not in SEVERITY_ORDER:
            continue
        if SEVERITY_ORDER[sev] < threshold:
            continue
        out.append(rec)
    # sort by timestamp ascending (oldest first)
    out.sort(key=lambda r: r.get("ts", ""))
    if limit is not None and limit > 0:
        # Keep the *most recent* N (tail) so the agent sees latest state.
        out = out[-limit:]
    return out


def archive_older_than(days: int = 30) -> int:
    """Move alerts (acked or unacked) older than N days to monthly archive.

    Returns count of records moved. Idempotent: archive files are appended.
    The main alerts.jsonl is rewritten ONLY here (the single mutating op).
    """
    if days < 0:
        raise ValueError("days must be >= 0")
    cutoff = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None) - _dt.timedelta(days=days)
    cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    records = _read_lines()
    keep: list[dict[str, Any]] = []
    moved_by_month: dict[str, list[dict[str, Any]]] = {}
    moved_count = 0
    for rec in records:
        ts = rec.get("ts", "")
        if isinstance(ts, str) and ts and ts < cutoff_iso:
            month_key = ts[:7]  # YYYY-MM
            moved_by_month.setdefault(month_key, []).append(rec)
            moved_count += 1
        else:
            keep.append(rec)

    if moved_count == 0:
        return 0

    # Append moved records to monthly archive files.
    for month, recs in moved_by_month.items():
        arc = ARCHIVE_DIR / f"{month}.jsonl"
        with arc.open("a", encoding="utf-8") as fh:
            for r in recs:
                fh.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")

    # Rewrite main file with kept records (atomic via tempfile + replace).
    tmp = ALERTS_FILE.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for r in keep:
            fh.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(str(tmp), str(ALERTS_FILE))
    return moved_count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _format_markdown(alerts: list[dict[str, Any]]) -> str:
    """Render alerts as a compact markdown bullet list for context.md."""
    if not alerts:
        return ""
    lines: list[str] = []
    for a in alerts:
        sev = a.get("severity", "info").upper()
        src = a.get("source", "?")
        msg = a.get("message", "")
        aid = a.get("id", "?")
        lines.append(f"- **[{sev}]** `{src}` — {msg} _(id: {aid})_")
    return "\n".join(lines)


def _format_table(alerts: list[dict[str, Any]]) -> str:
    if not alerts:
        return "(no alerts)"
    out: list[str] = []
    out.append(f"{'ID':<22} {'SEV':<9} {'SOURCE':<28} MESSAGE")
    out.append("-" * 90)
    for a in alerts:
        out.append(
            f"{a.get('id','?'):<22} "
            f"{a.get('severity','?'):<9} "
            f"{(a.get('source','?') or '')[:28]:<28} "
            f"{a.get('message','')}"
        )
    return "\n".join(out)


def _cli_write(args: argparse.Namespace) -> int:
    tags = [t.strip() for t in args.tags.split(",")] if args.tags else None
    aid = write(args.severity, args.source, args.message, tags=tags)
    if args.verbose:
        print(aid)
    else:
        # always print id to stdout — callers may want it; this is data, not noise
        print(aid)
    return 0


def _cli_read_unacked(args: argparse.Namespace) -> int:
    alerts = read_unacked(severity_min=args.severity_min, limit=args.limit)
    if args.format == "json":
        print(json.dumps(alerts, ensure_ascii=False, indent=2))
    elif args.format == "markdown":
        out = _format_markdown(alerts)
        if out:
            print(out)
    else:
        print(_format_table(alerts))
    return 0


def _cli_list(args: argparse.Namespace) -> int:
    state = _fold(_read_lines())
    rows = list(state.values())
    if args.unacked:
        rows = [r for r in rows if not r.get("ack")]
    if args.severity:
        rows = [r for r in rows if r.get("severity") == args.severity]
    rows.sort(key=lambda r: r.get("ts", ""))
    if args.limit and args.limit > 0:
        rows = rows[-args.limit:]
    if args.format == "json":
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print(_format_table(rows))
    return 0


def _cli_ack(args: argparse.Namespace) -> int:
    ok = ack(args.alert_id)
    if args.verbose:
        print("OK" if ok else "NOT_FOUND")
    return 0 if ok else 1


def _cli_purge(args: argparse.Namespace) -> int:
    raw = args.older_than
    days = 30
    if raw:
        s = str(raw).strip().lower()
        if s.endswith("d"):
            s = s[:-1]
        try:
            days = int(s)
        except ValueError:
            print(f"ERROR: invalid --older-than value: {raw!r}", file=sys.stderr)
            return 2
    moved = archive_older_than(days=days)
    if args.verbose:
        print(f"archived={moved}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="alerts.py",
        description="ULTRON alerts bus (append-only).",
    )
    p.add_argument("--verbose", action="store_true", help="emit human messages on stdout")
    sub = p.add_subparsers(dest="cmd", required=True)

    w = sub.add_parser("write", help="append one alert")
    w.add_argument("--severity", "-s", required=True, choices=VALID_SEVERITIES)
    w.add_argument("--source", required=True)
    w.add_argument("--message", "-m", required=True)
    w.add_argument("--tags", "-t", default="", help="comma-separated tags")
    w.set_defaults(func=_cli_write)

    r = sub.add_parser("read-unacked", help="read unacked alerts")
    r.add_argument("--severity-min", default="info", choices=VALID_SEVERITIES)
    r.add_argument("--limit", type=int, default=None)
    r.add_argument("--format", default="table", choices=("table", "json", "markdown"))
    r.set_defaults(func=_cli_read_unacked)

    li = sub.add_parser("list", help="list alerts")
    li.add_argument("--severity", default=None, choices=VALID_SEVERITIES)
    li.add_argument("--unacked", action="store_true")
    li.add_argument("--limit", type=int, default=None)
    li.add_argument("--format", default="table", choices=("table", "json"))
    li.set_defaults(func=_cli_list)

    a = sub.add_parser("ack", help="ack one alert by id")
    a.add_argument("alert_id")
    a.set_defaults(func=_cli_ack)

    pr = sub.add_parser("purge", help="archive alerts older than N days")
    pr.add_argument("--older-than", default="30d", help="e.g. 30d (days)")
    pr.set_defaults(func=_cli_purge)

    ns = p.parse_args(argv)
    return ns.func(ns)


if __name__ == "__main__":
    raise SystemExit(main())
