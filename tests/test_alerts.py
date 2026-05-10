"""Pytest suite for ULTRON alerts bus (~/.ultron/alerts.jsonl).

Tests run in isolated tmp_path — never touch the real ~/.ultron/alerts.jsonl.
"""
from __future__ import annotations

import datetime as _dt
import importlib
import json
import os
import sys
import threading
from pathlib import Path

import pytest

# Make the cockpit dir importable.
COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))


@pytest.fixture
def alerts_module(tmp_path, monkeypatch):
    """Import alerts.py with ALERTS_FILE/ARCHIVE_DIR pointed at tmp_path."""
    # Point USERPROFILE at the temp dir so module-level paths resolve there.
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    # Force a fresh import each test so module-level paths re-resolve.
    if "alerts" in sys.modules:
        del sys.modules["alerts"]
    mod = importlib.import_module("alerts")
    # Sanity check
    assert str(tmp_path) in str(mod.ALERTS_FILE)
    return mod


def test_write_returns_id_format(alerts_module):
    aid = alerts_module.write("info", "test", "hello")
    today = _dt.datetime.utcnow().strftime("%Y-%m-%d")
    assert aid == f"a-{today}-001"
    aid2 = alerts_module.write("warn", "test", "second")
    assert aid2 == f"a-{today}-002"


def test_write_persists_record(alerts_module):
    alerts_module.write("warn", "src.py", "msg one", tags=["t1", "t2"])
    raw = alerts_module.ALERTS_FILE.read_text(encoding="utf-8").strip()
    rec = json.loads(raw)
    assert rec["severity"] == "warn"
    assert rec["source"] == "src.py"
    assert rec["message"] == "msg one"
    assert rec["tags"] == ["t1", "t2"]
    assert rec["ack"] is False
    assert rec["ack_ts"] is None


def test_concurrent_writes_no_corruption(alerts_module):
    """3 threads x 100 writes = 300 valid JSON lines, no interleaving."""
    N_THREADS = 3
    N_PER = 100

    def worker(tid: int):
        for i in range(N_PER):
            alerts_module.write("info", f"thread-{tid}", f"msg-{i}")

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(N_THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = alerts_module.ALERTS_FILE.read_text(encoding="utf-8").splitlines()
    lines = [ln for ln in lines if ln.strip()]
    assert len(lines) == N_THREADS * N_PER, f"expected {N_THREADS * N_PER}, got {len(lines)}"
    # every line is parseable JSON
    for ln in lines:
        rec = json.loads(ln)  # raises if corrupt
        assert "id" in rec and "ts" in rec and "severity" in rec


def test_ack_makes_unacked_empty(alerts_module):
    aid = alerts_module.write("warn", "src", "needs ack")
    pre = alerts_module.read_unacked()
    assert any(r["id"] == aid for r in pre)
    ok = alerts_module.ack(aid)
    assert ok is True
    post = alerts_module.read_unacked()
    assert all(r["id"] != aid for r in post)


def test_ack_unknown_id_returns_false(alerts_module):
    assert alerts_module.ack("a-2099-12-31-999") is False


def test_double_ack_is_idempotent(alerts_module):
    """Acking twice must not corrupt state — same id stays acked."""
    aid = alerts_module.write("warn", "src", "double-ack")
    assert alerts_module.ack(aid) is True
    assert alerts_module.ack(aid) is True
    unacked = alerts_module.read_unacked()
    assert all(r["id"] != aid for r in unacked)


def test_severity_filter(alerts_module):
    alerts_module.write("info", "s", "i")
    alerts_module.write("warn", "s", "w")
    alerts_module.write("blocking", "s", "b")
    assert len(alerts_module.read_unacked(severity_min="info")) == 3
    assert len(alerts_module.read_unacked(severity_min="warn")) == 2
    assert len(alerts_module.read_unacked(severity_min="blocking")) == 1


def test_invalid_severity_raises(alerts_module):
    with pytest.raises(ValueError):
        alerts_module.write("critical", "s", "m")
    with pytest.raises(ValueError):
        alerts_module.read_unacked(severity_min="bogus")


def test_archive_moves_old_records(alerts_module, monkeypatch):
    """Records older than N days move to ~/.ultron/alerts/archive/YYYY-MM.jsonl."""
    # Write fresh record (won't be archived).
    alerts_module.write("info", "fresh", "today")
    # Inject an old record by direct append.
    old = {
        "id": "a-2020-01-01-001",
        "ts": "2020-01-15T12:00:00Z",
        "severity": "info",
        "source": "old",
        "message": "ancient",
        "tags": [],
        "ack": False,
        "ack_ts": None,
    }
    with alerts_module.ALERTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(old) + "\n")

    moved = alerts_module.archive_older_than(days=30)
    assert moved == 1
    arc = alerts_module.ARCHIVE_DIR / "2020-01.jsonl"
    assert arc.exists()
    arc_lines = arc.read_text(encoding="utf-8").strip().splitlines()
    assert len(arc_lines) == 1
    assert json.loads(arc_lines[0])["id"] == "a-2020-01-01-001"
    # Main file no longer contains the old record.
    main_lines = alerts_module.ALERTS_FILE.read_text(encoding="utf-8").strip().splitlines()
    assert all("a-2020-01-01-001" not in ln for ln in main_lines)


def test_read_unacked_limit_returns_most_recent(alerts_module):
    ids = [alerts_module.write("warn", "s", f"m{i}") for i in range(5)]
    out = alerts_module.read_unacked(severity_min="warn", limit=2)
    out_ids = [r["id"] for r in out]
    assert out_ids == ids[-2:]


def test_malformed_line_does_not_crash_reader(alerts_module):
    alerts_module.write("warn", "s", "valid")
    with alerts_module.ALERTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write("not json\n")
        fh.write("{partial broken\n")
    out = alerts_module.read_unacked()
    assert len(out) == 1


def test_ack_record_does_not_register_as_new_alert(alerts_module):
    """Ack lines must not show up as fresh unacked alerts (they have no severity)."""
    aid = alerts_module.write("warn", "s", "m")
    alerts_module.ack(aid)
    out = alerts_module.read_unacked(severity_min="info")
    assert out == []


# ---------------------------------------------------------------------------
# Codex S5-A H2 fix: write_dedupe atomic check-then-write
# ---------------------------------------------------------------------------

def test_write_dedupe_writes_first_call(alerts_module):
    aid = alerts_module.write_dedupe(
        "warn", "src.py", "first", dedupe_tag="mcp:gemini",
        window_seconds=3600, tags=["s5"],
    )
    assert aid is not None
    assert aid.endswith("-001")


def test_write_dedupe_skips_within_window(alerts_module):
    aid1 = alerts_module.write_dedupe(
        "warn", "src.py", "first", dedupe_tag="mcp:gemini",
        window_seconds=3600,
    )
    aid2 = alerts_module.write_dedupe(
        "warn", "src.py", "second", dedupe_tag="mcp:gemini",
        window_seconds=3600,
    )
    assert aid1 is not None
    assert aid2 is None
    # Only one record persisted.
    lines = alerts_module.ALERTS_FILE.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1


def test_write_dedupe_zero_window_disables(alerts_module):
    aid1 = alerts_module.write_dedupe(
        "info", "src.py", "first", dedupe_tag="mcp:gemini", window_seconds=0,
    )
    aid2 = alerts_module.write_dedupe(
        "info", "src.py", "second", dedupe_tag="mcp:gemini", window_seconds=0,
    )
    assert aid1 is not None and aid2 is not None
    assert aid1 != aid2


def test_write_dedupe_writes_after_acked_match(alerts_module):
    """If the previous matching alert is acked, dedupe should NOT block the
    new one — acked alerts are no longer 'pending' so a fresh signal is
    legitimate."""
    aid1 = alerts_module.write_dedupe(
        "warn", "src.py", "first", dedupe_tag="mcp:gemini", window_seconds=3600,
    )
    assert aid1 is not None
    assert alerts_module.ack(aid1) is True
    aid2 = alerts_module.write_dedupe(
        "warn", "src.py", "second", dedupe_tag="mcp:gemini", window_seconds=3600,
    )
    assert aid2 is not None
    assert aid2 != aid1


def test_write_dedupe_concurrent_writers_dedupe(alerts_module):
    """Two threads racing the same dedupe_tag must produce exactly one alert."""
    results: list[str | None] = []
    barrier = threading.Barrier(2)

    def _writer():
        barrier.wait()
        results.append(
            alerts_module.write_dedupe(
                "warn", "race.py", "racey", dedupe_tag="mcp:race",
                window_seconds=3600,
            )
        )

    threads = [threading.Thread(target=_writer) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    written_ids = [r for r in results if r is not None]
    assert len(written_ids) == 1, f"expected exactly one write, got {results!r}"


def test_write_dedupe_rejects_empty_tag(alerts_module):
    with pytest.raises(ValueError):
        alerts_module.write_dedupe(
            "info", "src.py", "msg", dedupe_tag="", window_seconds=3600,
        )


def test_write_dedupe_rejects_invalid_severity(alerts_module):
    with pytest.raises(ValueError):
        alerts_module.write_dedupe(
            "critical", "src.py", "msg", dedupe_tag="t", window_seconds=3600,
        )


def test_write_dedupe_auto_appends_dedupe_tag(alerts_module):
    """If caller passes tags without the dedupe_tag, it should be auto-added
    so a future call can find the record."""
    aid = alerts_module.write_dedupe(
        "info", "src.py", "msg", dedupe_tag="mcp:foo",
        window_seconds=3600, tags=["status:degraded"],
    )
    assert aid is not None
    rec = json.loads(alerts_module.ALERTS_FILE.read_text(encoding="utf-8").strip())
    assert "mcp:foo" in rec["tags"]
    assert "status:degraded" in rec["tags"]


def test_write_dedupe_cross_process_serialization(alerts_module, tmp_path):
    """F07 fix: two PROCESSES racing the same dedupe_tag must produce
    exactly one record. Threads share the in-process lock; processes only
    share the OS-level file lock — so this test proves the cross-process
    contract.

    Uses subprocess.Popen rather than multiprocessing because Windows
    pytest+spawn is fragile. Both child Pythons import alerts under the
    same USERPROFILE, then race on a sentinel file to fire writes nearly
    simultaneously.
    """
    import subprocess
    import time as _time

    cockpit_path = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"

    # Children inherit the alerts_module fixture's USERPROFILE so they
    # write to the same alerts.jsonl as the test.
    env = dict(os.environ)
    env["USERPROFILE"] = str(alerts_module.ULTRON_HOME.parent)
    env["HOME"] = str(alerts_module.ULTRON_HOME.parent)
    env["PYTHONPATH"] = str(cockpit_path)

    alerts_module.ULTRON_HOME.mkdir(parents=True, exist_ok=True)
    sentinel = alerts_module.ULTRON_HOME / "race-go.flag"
    program = (
        "import os, sys, time\n"
        f"sys.path.insert(0, r'{cockpit_path}')\n"
        "import alerts\n"
        f"sentinel = r'{sentinel}'\n"
        "for _ in range(500):\n"
        "    if os.path.exists(sentinel): break\n"
        "    time.sleep(0.005)\n"
        "out = alerts.write_dedupe('warn', 'race', 'racey',\n"
        "                           dedupe_tag='cross_proc_race',\n"
        "                           window_seconds=3600)\n"
        "print(out or 'NONE')\n"
    )

    procs = [subprocess.Popen(
        [sys.executable, "-c", program],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) for _ in range(2)]
    _time.sleep(0.3)
    sentinel.write_text("go", encoding="utf-8")
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=15)
        assert p.returncode == 0, f"child failed: {err.decode(errors='replace')}"
        outs.append(out.decode(errors="replace").strip())

    # Read back the alerts file; exactly ONE record should carry the
    # cross_proc_race tag.
    import os as _os
    raw = alerts_module.ALERTS_FILE.read_text(encoding="utf-8")
    matching = [
        ln for ln in raw.splitlines()
        if ln.strip() and "cross_proc_race" in ln and "\"ack\":false" in ln.lower().replace(' ', '')
    ]
    # Use a tolerant match — JSON spacing varies by writer.
    matching = []
    for ln in raw.splitlines():
        s = ln.strip()
        if not s:
            continue
        try:
            rec = json.loads(s)
        except Exception:
            continue
        tags = rec.get("tags") or []
        if "cross_proc_race" in tags and rec.get("ack") is False:
            matching.append(rec)
    assert len(matching) == 1, (
        f"Expected exactly 1 cross_proc_race record, got {len(matching)}. "
        f"Child outputs: {outs}"
    )


def test_id_counter_resets_per_day(alerts_module, monkeypatch):
    """If we manually inject a record from yesterday, today's counter starts at 001."""
    yesterday = (_dt.datetime.utcnow() - _dt.timedelta(days=1)).strftime("%Y-%m-%d")
    rec = {
        "id": f"a-{yesterday}-005",
        "ts": f"{yesterday}T12:00:00Z",
        "severity": "info",
        "source": "y",
        "message": "yesterday",
        "tags": [],
        "ack": False,
        "ack_ts": None,
    }
    # Make sure the alerts file (and parent dirs) exist before manual append.
    alerts_module.ALERTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    alerts_module.ALERTS_FILE.touch()
    with alerts_module.ALERTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
    today = _dt.datetime.utcnow().strftime("%Y-%m-%d")
    aid = alerts_module.write("info", "today", "first")
    assert aid == f"a-{today}-001"
