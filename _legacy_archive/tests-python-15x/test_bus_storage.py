"""Tests for v15.1 Bus Foundation — sub-fase 1.1 storage layer.

Each test redirects Path.home() to a tmp_path so the real ~/.ultron/bus is
untouched. The module's path helpers compute the bus root lazily on each call,
so monkeypatching Path.home before importing bus_storage isolates state.
"""
from __future__ import annotations

import importlib
import json
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def bus(tmp_path, monkeypatch):
    """Reload bus_storage with Path.home() pointing at tmp_path."""
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    if "bus_storage" in sys.modules:
        del sys.modules["bus_storage"]
    mod = importlib.import_module("bus_storage")
    importlib.reload(mod)
    return mod


# ── Registry ───────────────────────────────────────────────────────────────────


def test_register_creates_entry(bus):
    info = bus.register_session("sess-A", pid=111, labels=["interactive"])
    assert info["session_id"] == "sess-A"
    assert info["pid"] == 111
    assert info["status"] == "live"
    assert info["labels"] == ["interactive"]
    assert "started_at" in info and "last_heartbeat" in info


def test_register_idempotent_preserves_started_at(bus):
    bus.register_session("sess-A", pid=111)
    started = bus._load_sessions()["sessions"]["sess-A"]["started_at"]
    time.sleep(0.05)
    bus.register_session("sess-A", pid=222)
    sessions = bus._load_sessions()["sessions"]
    assert sessions["sess-A"]["started_at"] == started     # preserved
    assert sessions["sess-A"]["pid"] == 222                # updated


def test_heartbeat_updates_timestamp(bus):
    bus.register_session("sess-A", pid=111)
    hb1 = bus._load_sessions()["sessions"]["sess-A"]["last_heartbeat"]
    time.sleep(1.1)  # bus uses second-precision timestamps; need >1s
    assert bus.update_heartbeat("sess-A") is True
    hb2 = bus._load_sessions()["sessions"]["sess-A"]["last_heartbeat"]
    assert hb2 > hb1


def test_heartbeat_unknown_session(bus):
    assert bus.update_heartbeat("ghost") is False


def test_mark_closed(bus):
    bus.register_session("sess-A", pid=111)
    assert bus.mark_closed("sess-A", reason="stop_event") is True
    s = bus._load_sessions()["sessions"]["sess-A"]
    assert s["status"] == "closed"
    assert s["closed_reason"] == "stop_event"


# ── Pruning ────────────────────────────────────────────────────────────────────


def _backdate_heartbeat(bus, session_id: str, age_seconds: float):
    """Rewrite last_heartbeat to simulate an old session."""
    data = bus._load_sessions()
    target = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    data["sessions"][session_id]["last_heartbeat"] = target.isoformat(timespec="seconds")
    bus._atomic_write_json(bus._sessions_file(), data)


def test_prune_respects_threshold_interactive(bus):
    bus.register_session("sess-A", pid=111, labels=["interactive"])
    _backdate_heartbeat(bus, "sess-A", age_seconds=400)   # > 300s threshold
    pruned = bus.prune_dead_sessions()
    assert "sess-A" in pruned
    assert bus._load_sessions()["sessions"]["sess-A"]["status"] == "dead"


def test_prune_respects_threshold_worker(bus):
    bus.register_session("sess-W", pid=222, labels=["worker"])
    _backdate_heartbeat(bus, "sess-W", age_seconds=400)   # < 1800s worker threshold
    pruned = bus.prune_dead_sessions()
    assert "sess-W" not in pruned
    assert bus._load_sessions()["sessions"]["sess-W"]["status"] == "live"


def test_prune_skips_already_closed(bus):
    bus.register_session("sess-A", pid=111)
    bus.mark_closed("sess-A")
    _backdate_heartbeat(bus, "sess-A", age_seconds=9999)
    pruned = bus.prune_dead_sessions()
    assert "sess-A" not in pruned                          # closed != live, skip


# ── Messages ───────────────────────────────────────────────────────────────────


def test_send_appends_inbox_and_outbox(bus):
    msg_id = bus.send_message("sess-A", "sess-B", "task.assigned",
                              {"task": "T1"})
    assert msg_id is not None
    inbox = (bus._session_dir("sess-B") / "inbox.jsonl").read_text(encoding="utf-8")
    outbox = (bus._session_dir("sess-A") / "outbox.jsonl").read_text(encoding="utf-8")
    assert msg_id in inbox and msg_id in outbox
    parsed = json.loads(inbox.strip())
    assert parsed["kind"] == "task.assigned"
    assert parsed["content"] == {"task": "T1"}
    assert parsed["priority"] == "normal"
    assert parsed["ttl_s"] == bus.DEFAULT_TTL_S


def test_send_dedup_within_window_returns_none(bus):
    first = bus.send_message("sess-A", "sess-B", "task.assigned", {"task": "T1"})
    second = bus.send_message("sess-A", "sess-B", "task.assigned", {"task": "T1"})
    assert first is not None
    assert second is None                                  # deduped


def test_send_different_content_not_deduped(bus):
    first = bus.send_message("sess-A", "sess-B", "task.assigned", {"task": "T1"})
    second = bus.send_message("sess-A", "sess-B", "task.assigned", {"task": "T2"})
    assert first is not None and second is not None
    assert first != second


def test_send_invalid_priority_raises(bus):
    with pytest.raises(ValueError):
        bus.send_message("sess-A", "sess-B", "task.assigned", {},
                         priority="urgent")


def test_send_non_dict_content_raises(bus):
    with pytest.raises(TypeError):
        bus.send_message("sess-A", "sess-B", "task.assigned", "not-a-dict")


# ── Read inbox ─────────────────────────────────────────────────────────────────


def test_read_inbox_returns_unread_only(bus):
    bus.send_message("sess-A", "sess-B", "k", {"i": 1})
    bus.send_message("sess-A", "sess-B", "k", {"i": 2})
    first_read = bus.read_inbox("sess-B")
    assert len(first_read) == 2
    second_read = bus.read_inbox("sess-B")             # cursor advanced
    assert second_read == []


def test_read_inbox_since_ts_explicit(bus):
    bus.send_message("sess-A", "sess-B", "k", {"i": 1})
    time.sleep(1.1)
    bus.send_message("sess-A", "sess-B", "k", {"i": 2})
    msgs = bus.read_inbox("sess-B", update_cursor=False)
    cutoff = msgs[0]["ts"]
    later = bus.read_inbox("sess-B", since_ts=cutoff, update_cursor=False)
    assert len(later) == 1
    assert later[0]["content"] == {"i": 2}


def test_read_inbox_skips_cancelled(bus):
    msg_id = bus.send_message("sess-A", "sess-B", "k", {"i": 1})
    bus.cancel_message(msg_id)
    msgs = bus.read_inbox("sess-B")
    assert all(m["id"] != msg_id for m in msgs)


def test_read_inbox_skips_expired_ttl(bus):
    bus.send_message("sess-A", "sess-B", "k", {"i": 1}, ttl_s=1)
    time.sleep(1.5)
    msgs = bus.read_inbox("sess-B")
    assert msgs == []


def test_read_inbox_limit(bus):
    for i in range(10):
        bus.send_message("sess-A", "sess-B", "k", {"i": i})
    msgs = bus.read_inbox("sess-B", limit=3)
    assert len(msgs) == 3


# ── Subscriptions ─────────────────────────────────────────────────────────────


def test_subscribe_persists_pattern(bus):
    bus.register_session("sess-A", pid=111)
    assert bus.subscribe("sess-A", "task.*") is True
    subs = bus._load_sessions()["sessions"]["sess-A"]["subscriptions"]
    assert "task.*" in subs


def test_subscribe_unknown_session(bus):
    assert bus.subscribe("ghost", "task.*") is False


def test_subscribe_dedups(bus):
    bus.register_session("sess-A", pid=111)
    bus.subscribe("sess-A", "task.*")
    bus.subscribe("sess-A", "task.*")
    subs = bus._load_sessions()["sessions"]["sess-A"]["subscriptions"]
    assert subs.count("task.*") == 1


# ── List + status ─────────────────────────────────────────────────────────────


def test_list_sessions_live_filter(bus):
    bus.register_session("sess-A", pid=111)
    bus.register_session("sess-B", pid=222)
    bus.mark_closed("sess-B")
    live = bus.list_sessions("live")
    closed = bus.list_sessions("closed")
    assert any(s["session_id"] == "sess-A" for s in live)
    assert not any(s["session_id"] == "sess-B" for s in live)
    assert any(s["session_id"] == "sess-B" for s in closed)


def test_status_snapshot_counts(bus):
    bus.register_session("sess-A", pid=111)
    bus.send_message("sess-X", "sess-A", "k", {"i": 1})
    snap = bus.status().to_dict()
    assert snap["live_sessions"] >= 1
    assert snap["total_inbox_messages"] >= 1


# ── Concurrency ───────────────────────────────────────────────────────────────


def test_concurrent_sends_no_corruption(bus):
    """4 threads × 5 sends each. sessions.json must remain valid JSON
    and inbox should contain all 20 messages with unique IDs."""
    bus.register_session("sess-target", pid=555)

    def worker(tid: int):
        for i in range(5):
            bus.send_message(f"sess-src-{tid}", "sess-target", "k",
                             {"thread": tid, "i": i})

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # sessions.json remained parseable
    data = bus._load_sessions()
    assert "schema_version" in data
    # inbox holds all 20 unique messages
    inbox_lines = (bus._session_dir("sess-target") / "inbox.jsonl") \
        .read_text(encoding="utf-8").splitlines()
    parsed = [json.loads(ln) for ln in inbox_lines if ln.strip()]
    ids = {m["id"] for m in parsed}
    assert len(ids) == 20


def test_concurrent_register_no_corruption(bus):
    def worker(tid: int):
        bus.register_session(f"sess-{tid}", pid=tid)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    data = bus._load_sessions()
    assert len(data["sessions"]) == 8
