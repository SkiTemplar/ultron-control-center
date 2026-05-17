"""ULTRON v15.1 Bus Foundation — file-based storage layer (sub-fase 1.1).

Storage backend for the cross-session bus. The MCP server (sub-fase 1.2) wraps
this module's API as JSON-RPC tools, but the storage layer is independently
testable and importable from CLI tools (`ultron bus`) and hooks.

Layout:
    ~/.ultron/bus/
        sessions.json                # registry, mutable, locked write
        <session_id>/
            inbox.jsonl              # append-only, messages this session received
            outbox.jsonl             # append-only, messages this session sent (log)
            read_cursor.json         # last_read_ts per consumer
        cancelled.jsonl              # append-only, cancelled message IDs
        dedup.json                   # locked write, hash ring for 5-min dedup
        .lock                        # exclusive create lock-file (pattern from
                                     # pending_actions._FileLock)

Concurrency:
    sessions.json + dedup.json: read-modify-write with _FileLock + tmp+rename.
    inbox/outbox: append-only, OS atomic writes <4KB on Windows/POSIX.
    Multiple sessions can read/append concurrently without lock; only the
    registry mutations are serialized.

Pruning thresholds (per session label):
    interactive:        5 min   (live ←→ dead)
    worker/supervisor: 30 min   (long-running, sparse heartbeats)
    mobile:            10 min
    default:            5 min
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _bus_root() -> Path:
    root = Path.home() / ".ultron" / "bus"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _sessions_file() -> Path:
    return _bus_root() / "sessions.json"


def _dedup_file() -> Path:
    return _bus_root() / "dedup.json"


def _cancelled_file() -> Path:
    return _bus_root() / "cancelled.jsonl"


def _lock_file() -> Path:
    return _bus_root() / ".lock"


def _session_dir(session_id: str) -> Path:
    d = _bus_root() / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Constants ──────────────────────────────────────────────────────────────────


SCHEMA_VERSION = 1
DEFAULT_TTL_S = 14_400          # 4 h (overnight-friendly, configurable per send)
DEDUP_WINDOW_S = 300            # 5 min
LOCK_TIMEOUT_S = 5.0
PRIORITIES = ("low", "normal", "high")
DEAD_THRESHOLDS_S = {
    "interactive": 300,         # 5 min
    "mobile":      600,         # 10 min
    "worker":     1800,         # 30 min
    "supervisor": 1800,         # 30 min
    "_default":    300,
}


# ── File lock (pattern reused from pending_actions._FileLock) ─────────────────


class _FileLock:
    """Exclusive-create lock-file with timeout. Stale locks recovered by unlink."""

    def __init__(self, path: Path, timeout: float = LOCK_TIMEOUT_S):
        self.path = path
        self.timeout = timeout
        self._acquired = False

    def __enter__(self) -> "_FileLock":
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd = self.path.open("x")  # exclusive create — atomic
                fd.close()
                self._acquired = True
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    # Treat as stale; delete and retry once.
                    try:
                        self.path.unlink(missing_ok=True)
                    except OSError:
                        pass
                    continue  # one retry, then either succeed or raise
                time.sleep(0.025)

    def __exit__(self, *_exc) -> None:
        if self._acquired:
            try:
                self.path.unlink(missing_ok=True)
            except OSError:
                pass


# ── Atomic write helper ────────────────────────────────────────────────────────


def _atomic_write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return default


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _gen_msg_id() -> str:
    """Sortable unique ID: <ts_ns_hex><rand_hex>. ULID-like without dependency.

    Random suffix is 8 bytes (64 bits) — previously 4 bytes (32 bits) which
    occasionally collided in test_concurrent_sends_no_corruption when Windows'
    coarse time_ns() granularity (100ns ticks) lined two concurrent calls up
    into the same nanosecond window. Birthday math for 20 messages with the
    old 32-bit suffix gave ~4e-8 collision probability per pair; bumping to
    64 bits removes the failure mode entirely (kirkardo audit cleanup
    v15.4.21).
    """
    return f"{time.time_ns():016x}{secrets.token_hex(8)}"


# ── Sessions registry API ─────────────────────────────────────────────────────


def _load_sessions() -> dict:
    payload = _read_json(_sessions_file(), default={})
    if not isinstance(payload, dict) or "sessions" not in payload:
        return {"schema_version": SCHEMA_VERSION, "sessions": {}}
    return payload


def register_session(
    session_id: str,
    pid: int,
    labels: Optional[list[str]] = None,
    current_skill: Optional[str] = None,
) -> dict:
    """Register or refresh a session in the registry. Idempotent."""
    if not session_id:
        raise ValueError("session_id required")
    now = _utc_now_iso()
    with _FileLock(_lock_file()):
        data = _load_sessions()
        data.setdefault("schema_version", SCHEMA_VERSION)
        sessions = data.setdefault("sessions", {})
        existing = sessions.get(session_id, {})
        sessions[session_id] = {
            "session_id":     session_id,
            "pid":            int(pid),
            "started_at":     existing.get("started_at", now),
            "last_heartbeat": now,
            "status":         "live",
            "current_skill":  current_skill,
            "labels":         list(labels or existing.get("labels") or ["interactive"]),
            "subscriptions":  existing.get("subscriptions", []),
        }
        _atomic_write_json(_sessions_file(), data)
        return dict(sessions[session_id])


def update_heartbeat(session_id: str, current_skill: Optional[str] = None) -> bool:
    """Bump last_heartbeat. Returns False if session unknown."""
    with _FileLock(_lock_file()):
        data = _load_sessions()
        s = data.get("sessions", {}).get(session_id)
        if not s:
            return False
        s["last_heartbeat"] = _utc_now_iso()
        if current_skill:
            s["current_skill"] = current_skill
        s["status"] = "live"
        _atomic_write_json(_sessions_file(), data)
        return True


def mark_closed(session_id: str, reason: Optional[str] = None) -> bool:
    """Flag a session as closed. Reason kept for telemetry."""
    with _FileLock(_lock_file()):
        data = _load_sessions()
        s = data.get("sessions", {}).get(session_id)
        if not s:
            return False
        s["status"] = "closed"
        s["closed_at"] = _utc_now_iso()
        if reason:
            s["closed_reason"] = reason
        _atomic_write_json(_sessions_file(), data)
        return True


def list_sessions(status_filter: str = "live") -> list[dict]:
    """status_filter ∈ {'live', 'all', 'dead', 'closed'}."""
    data = _load_sessions()
    out = []
    now = datetime.now(timezone.utc)
    for s in data.get("sessions", {}).values():
        s_copy = dict(s)
        # Compute live/dead based on heartbeat age
        try:
            hb = datetime.fromisoformat(s["last_heartbeat"])
            if hb.tzinfo is None:
                hb = hb.replace(tzinfo=timezone.utc)
            age_s = (now - hb).total_seconds()
        except (ValueError, KeyError, TypeError):
            age_s = float("inf")
        s_copy["last_heartbeat_age_s"] = round(age_s, 1)
        if status_filter == "all":
            out.append(s_copy)
        elif status_filter == "live" and s.get("status") == "live":
            threshold = _threshold_for_session(s)
            if age_s <= threshold:
                out.append(s_copy)
        elif status_filter == "dead":
            threshold = _threshold_for_session(s)
            if age_s > threshold or s.get("status") == "dead":
                out.append(s_copy)
        elif status_filter == "closed" and s.get("status") == "closed":
            out.append(s_copy)
    return out


def _threshold_for_session(session: dict) -> float:
    labels = session.get("labels") or ["_default"]
    return min(
        DEAD_THRESHOLDS_S.get(lbl, DEAD_THRESHOLDS_S["_default"])
        for lbl in labels
    )


def prune_dead_sessions(now: Optional[datetime] = None) -> list[str]:
    """Mark sessions whose heartbeat exceeded the threshold as 'dead'.
    Returns the list of session_ids that were transitioned."""
    pruned: list[str] = []
    now_dt = now or datetime.now(timezone.utc)
    with _FileLock(_lock_file()):
        data = _load_sessions()
        for sid, s in list(data.get("sessions", {}).items()):
            if s.get("status") != "live":
                continue
            try:
                hb = datetime.fromisoformat(s["last_heartbeat"])
                if hb.tzinfo is None:
                    hb = hb.replace(tzinfo=timezone.utc)
                age_s = (now_dt - hb).total_seconds()
            except (ValueError, KeyError, TypeError):
                continue
            if age_s > _threshold_for_session(s):
                s["status"] = "dead"
                s["dead_detected_at"] = now_dt.isoformat(timespec="seconds")
                pruned.append(sid)
        if pruned:
            _atomic_write_json(_sessions_file(), data)
    return pruned


# ── Subscriptions ─────────────────────────────────────────────────────────────


def subscribe(session_id: str, pattern: str) -> bool:
    """Register a glob-style topic subscription for a session."""
    with _FileLock(_lock_file()):
        data = _load_sessions()
        s = data.get("sessions", {}).get(session_id)
        if not s:
            return False
        subs = s.setdefault("subscriptions", [])
        if pattern not in subs:
            subs.append(pattern)
            _atomic_write_json(_sessions_file(), data)
        return True


# ── Messages: send + read ─────────────────────────────────────────────────────


def _content_hash(from_id: str, to_id: str, kind: str, content: dict) -> str:
    blob = json.dumps(
        {"from": from_id, "to": to_id, "kind": kind, "content": content},
        sort_keys=True, ensure_ascii=False,
    )
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def _check_dedup(content_hash: str) -> bool:
    """Returns True if message is a duplicate within the dedup window."""
    now_ns = time.time_ns()
    cutoff_ns = now_ns - DEDUP_WINDOW_S * 1_000_000_000
    with _FileLock(_lock_file()):
        data = _read_json(_dedup_file(), default={})
        if not isinstance(data, dict):
            data = {}
        # Prune expired entries opportunistically
        data = {h: ts for h, ts in data.items() if int(ts) > cutoff_ns}
        if content_hash in data:
            _atomic_write_json(_dedup_file(), data)
            return True
        data[content_hash] = now_ns
        _atomic_write_json(_dedup_file(), data)
        return False


def send_message(
    from_id: str,
    to_id: str,
    kind: str,
    content: dict,
    *,
    ttl_s: int = DEFAULT_TTL_S,
    priority: str = "normal",
    reply_to: Optional[str] = None,
) -> Optional[str]:
    """Append a message to target session's inbox. Returns message_id, or None
    if the message was deduplicated within the 5-minute window."""
    if priority not in PRIORITIES:
        raise ValueError(f"priority must be one of {PRIORITIES}")
    if not from_id or not to_id or not kind:
        raise ValueError("from_id, to_id, kind required")
    if not isinstance(content, dict):
        raise TypeError("content must be a dict")

    h = _content_hash(from_id, to_id, kind, content)
    if _check_dedup(h):
        return None

    msg_id = _gen_msg_id()
    msg = {
        "id":            msg_id,
        "ts":            _utc_now_iso(),
        "from":          from_id,
        "to":            to_id,
        "kind":          kind,
        "content":       content,
        "ttl_s":         int(ttl_s),
        "priority":      priority,
        "reply_to":      reply_to,
        "content_hash":  h,
    }
    inbox = _session_dir(to_id) / "inbox.jsonl"
    outbox = _session_dir(from_id) / "outbox.jsonl"
    line = json.dumps(msg, ensure_ascii=False) + "\n"
    # Append-only writes; OS-atomic for <4KB (typical message).
    with inbox.open("a", encoding="utf-8") as f:
        f.write(line)
    with outbox.open("a", encoding="utf-8") as f:
        f.write(line)
    return msg_id


def read_inbox(
    session_id: str,
    *,
    since_ts: Optional[str] = None,
    limit: int = 50,
    update_cursor: bool = True,
) -> list[dict]:
    """Read messages from the session inbox. since_ts is exclusive (returns
    messages strictly newer). When None, reads from last_read_ts cursor."""
    inbox = _session_dir(session_id) / "inbox.jsonl"
    cursor_path = _session_dir(session_id) / "read_cursor.json"
    if not inbox.exists():
        return []

    if since_ts is None:
        cursor = _read_json(cursor_path, default={})
        since_ts = cursor.get("last_read_ts") if isinstance(cursor, dict) else None

    cancelled = _load_cancelled_ids()
    now_ts_s = time.time()
    out: list[dict] = []
    last_seen_ts: Optional[str] = None

    for raw in inbox.read_text(encoding="utf-8", errors="replace").splitlines():
        if not raw.strip():
            continue
        try:
            m = json.loads(raw)
        except json.JSONDecodeError:
            continue
        m_ts = m.get("ts")
        if since_ts and m_ts and m_ts <= since_ts:
            continue
        if m.get("id") in cancelled:
            continue
        # TTL expiry check
        try:
            m_ts_dt = datetime.fromisoformat(m_ts) if m_ts else None
            if m_ts_dt:
                if m_ts_dt.tzinfo is None:
                    m_ts_dt = m_ts_dt.replace(tzinfo=timezone.utc)
                if (now_ts_s - m_ts_dt.timestamp()) > m.get("ttl_s", DEFAULT_TTL_S):
                    continue
        except (ValueError, TypeError):
            pass
        out.append(m)
        last_seen_ts = m_ts
        if len(out) >= limit:
            break

    if update_cursor and last_seen_ts:
        _atomic_write_json(cursor_path, {"last_read_ts": last_seen_ts})

    return out


def cancel_message(message_id: str) -> bool:
    """Mark a message as cancelled. Future reads will skip it."""
    if not message_id:
        return False
    line = json.dumps({"id": message_id, "ts": _utc_now_iso()}, ensure_ascii=False) + "\n"
    with _cancelled_file().open("a", encoding="utf-8") as f:
        f.write(line)
    return True


def _load_cancelled_ids() -> set[str]:
    p = _cancelled_file()
    if not p.exists():
        return set()
    out: set[str] = set()
    for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
            mid = row.get("id")
            if mid:
                out.add(mid)
        except json.JSONDecodeError:
            continue
    return out


# ── Status snapshot ───────────────────────────────────────────────────────────


@dataclass
class BusStatus:
    bus_root: str
    schema_version: int
    live_sessions: int
    dead_sessions: int
    closed_sessions: int
    total_inbox_messages: int
    cancelled_messages: int
    dedup_window_s: int

    def to_dict(self) -> dict:
        return self.__dict__


def status() -> BusStatus:
    sessions_data = _load_sessions().get("sessions", {})
    live = dead = closed = 0
    inbox_total = 0
    now = datetime.now(timezone.utc)
    for s in sessions_data.values():
        st = s.get("status")
        if st == "closed":
            closed += 1
        else:
            try:
                hb = datetime.fromisoformat(s["last_heartbeat"])
                if hb.tzinfo is None:
                    hb = hb.replace(tzinfo=timezone.utc)
                age_s = (now - hb).total_seconds()
            except (ValueError, KeyError, TypeError):
                age_s = float("inf")
            if age_s > _threshold_for_session(s) or st == "dead":
                dead += 1
            else:
                live += 1
        inbox_path = _session_dir(s["session_id"]) / "inbox.jsonl"
        if inbox_path.exists():
            inbox_total += sum(1 for ln in inbox_path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip())
    return BusStatus(
        bus_root=str(_bus_root()),
        schema_version=SCHEMA_VERSION,
        live_sessions=live,
        dead_sessions=dead,
        closed_sessions=closed,
        total_inbox_messages=inbox_total,
        cancelled_messages=len(_load_cancelled_ids()),
        dedup_window_s=DEDUP_WINDOW_S,
    )


# ── CLI entry (smoke tests) ───────────────────────────────────────────────────


def _cli() -> int:
    import argparse
    p = argparse.ArgumentParser(prog="bus_storage.py", description="Bus storage smoke CLI")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    s_ls = sub.add_parser("list")
    s_ls.add_argument("--filter", default="live")
    s_send = sub.add_parser("send")
    s_send.add_argument("--from", dest="from_id", required=True)
    s_send.add_argument("--to", required=True)
    s_send.add_argument("--kind", required=True)
    s_send.add_argument("--content", default="{}", help="JSON string")
    s_read = sub.add_parser("read")
    s_read.add_argument("--for", dest="for_id", required=True)
    s_read.add_argument("--limit", type=int, default=20)
    args = p.parse_args()

    if args.cmd == "status":
        print(json.dumps(status().to_dict(), indent=2))
    elif args.cmd == "list":
        print(json.dumps(list_sessions(args.filter), indent=2, ensure_ascii=False))
    elif args.cmd == "send":
        msg_id = send_message(args.from_id, args.to, args.kind,
                              json.loads(args.content))
        print(json.dumps({"sent": msg_id}, indent=2))
    elif args.cmd == "read":
        msgs = read_inbox(args.for_id, limit=args.limit)
        print(json.dumps(msgs, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
