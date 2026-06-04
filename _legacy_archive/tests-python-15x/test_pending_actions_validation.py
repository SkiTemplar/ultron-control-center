"""SI-P0-2 — Corpus de inyección + validation para pending_actions.

Cubre:
  - Timestamps en el futuro (más allá de FUTURE_SKEW)
  - Entries sin campos requeridos
  - Severities/status inválidos
  - IDs adversariales (NUL bytes, longitudes desorbitadas)
  - producer obligatorio en add_action()
  - Backward-compat con entries legacy sin producer
  - Atomic save + lock behavior

Run: uv run pytest tests/test_pending_actions_validation.py -v
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# Add cockpit to path so we can import pending_actions cleanly.
_COCKPIT = Path(__file__).resolve().parent.parent / "scripts" / "cockpit"
sys.path.insert(0, str(_COCKPIT))

import pending_actions as pa  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_queue(tmp_path, monkeypatch):
    """Cada test recibe un QUEUE limpio bajo tmp_path."""
    queue = tmp_path / "pending_actions.json"
    lock = queue.with_suffix(".lock")
    monkeypatch.setattr(pa, "QUEUE", queue)
    monkeypatch.setattr(pa, "LOCK_FILE", lock)
    yield queue


def _write_queue(queue: Path, actions: list[dict]) -> None:
    """Helper: escribe un queue JSON crudo (saltándose add_action)."""
    payload = {"version": 2, "updated_at": pa._now(), "actions": actions}
    queue.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _base_entry(**overrides) -> dict:
    """Entry válida mínima — sobrescribe campos para testear cada validador."""
    base = {
        "id": "TEST-1",
        "severity": "medium",
        "title": "test action",
        "source_audit": "test",
        "producer": "test-suite",
        "created_at": pa._now(),
        "status": "open",
        "resolved_at": None,
        "description": "",
        "deadline": None,
        "blocking": False,
        "notes": [],
    }
    base.update(overrides)
    return base


# ── add_action public API ─────────────────────────────────────────────────────

def test_add_action_rejects_empty_producer():
    with pytest.raises(ValueError, match="producer"):
        pa.add_action("X-1", "medium", "title",
                       source_audit="audit", producer="")


def test_add_action_rejects_oversized_producer():
    with pytest.raises(ValueError, match="producer"):
        pa.add_action("X-1", "medium", "title",
                       source_audit="audit", producer="x" * 101)


def test_add_action_rejects_invalid_severity():
    with pytest.raises(ValueError, match="severity"):
        pa.add_action("X-1", "made-up-sev", "title",
                       source_audit="audit", producer="test")


def test_add_action_persists_producer():
    entry = pa.add_action("X-1", "high", "test",
                            source_audit="audit", producer="repo-evaluator")
    assert entry["producer"] == "repo-evaluator"
    # Reload y verifica
    data = pa._load()
    assert data["actions"][0]["producer"] == "repo-evaluator"


# ── _validate_entry — campos requeridos ───────────────────────────────────────

def test_validate_missing_required():
    entry = _base_entry()
    del entry["severity"]
    ok, reason = pa._validate_entry(entry)
    assert not ok
    assert "missing" in reason


def test_validate_invalid_severity():
    entry = _base_entry(severity="MEGA-CRITICAL")
    ok, reason = pa._validate_entry(entry)
    assert not ok
    assert "severity" in reason


def test_validate_invalid_status():
    entry = _base_entry(status="zombie-state")
    ok, reason = pa._validate_entry(entry)
    assert not ok
    assert "status" in reason


def test_validate_id_nul_byte():
    entry = _base_entry(id="evil\x00path")
    ok, reason = pa._validate_entry(entry)
    assert not ok
    assert "id" in reason


def test_validate_id_oversized():
    entry = _base_entry(id="x" * 201)
    ok, reason = pa._validate_entry(entry)
    assert not ok


def test_validate_not_dict():
    ok, reason = pa._validate_entry("not a dict")  # type: ignore[arg-type]
    assert not ok
    assert "dict" in reason


# ── _is_valid_timestamp — futuro / skew ───────────────────────────────────────

def test_timestamp_now_is_valid():
    assert pa._is_valid_timestamp(pa._now(), allow_none=False)


def test_timestamp_past_is_valid():
    past = (datetime.now() - timedelta(days=30)).isoformat(timespec="seconds")
    assert pa._is_valid_timestamp(past, allow_none=False)


def test_timestamp_within_skew_is_valid():
    within = (datetime.now() + timedelta(seconds=60)).isoformat(timespec="seconds")
    assert pa._is_valid_timestamp(within, allow_none=False)


def test_timestamp_far_future_rejected():
    far = (datetime.now() + timedelta(hours=1)).isoformat(timespec="seconds")
    assert not pa._is_valid_timestamp(far, allow_none=False)


def test_timestamp_year_3000_rejected():
    far = "3000-01-01T00:00:00"
    assert not pa._is_valid_timestamp(far, allow_none=False)


def test_timestamp_malformed_rejected():
    assert not pa._is_valid_timestamp("not-a-date", allow_none=False)
    assert not pa._is_valid_timestamp("2026-13-99", allow_none=False)


def test_timestamp_none_allowed_for_resolved_at():
    assert pa._is_valid_timestamp(None, allow_none=True)


def test_timestamp_none_rejected_for_created_at():
    assert not pa._is_valid_timestamp(None, allow_none=False)


# ── _load() integration — quarantine de entries inyectadas ────────────────────

def test_load_quarantines_future_timestamp(isolated_queue, capsys):
    far_future = (datetime.now() + timedelta(days=10)).isoformat(timespec="seconds")
    _write_queue(isolated_queue, [
        _base_entry(id="LEGIT", created_at=pa._now()),
        _base_entry(id="INJECTED", created_at=far_future),
    ])
    data = pa._load()
    ids = [a["id"] for a in data["actions"]]
    assert "LEGIT" in ids
    assert "INJECTED" not in ids
    captured = capsys.readouterr()
    assert "rejected" in captured.err.lower()


def test_load_quarantines_invalid_severity(isolated_queue, capsys):
    _write_queue(isolated_queue, [
        _base_entry(id="LEGIT"),
        _base_entry(id="EVIL", severity="GOD-MODE"),
    ])
    data = pa._load()
    ids = [a["id"] for a in data["actions"]]
    assert "LEGIT" in ids
    assert "EVIL" not in ids


def test_load_quarantines_missing_producer_treats_as_legacy(isolated_queue):
    """Backward-compat: entries pre-v2 sin producer reciben producer='legacy'."""
    legacy = _base_entry(id="LEGACY-1")
    del legacy["producer"]
    _write_queue(isolated_queue, [legacy])
    data = pa._load()
    assert len(data["actions"]) == 1
    assert data["actions"][0]["producer"] == "legacy"


def test_load_quarantines_id_with_nul(isolated_queue):
    _write_queue(isolated_queue, [
        _base_entry(id="legit-id"),
        _base_entry(id="hack\x00bypass"),
    ])
    data = pa._load()
    ids = [a["id"] for a in data["actions"]]
    assert "legit-id" in ids
    assert all("\x00" not in i for i in ids)


def test_load_handles_corrupt_json(isolated_queue):
    isolated_queue.write_text("{not valid json", encoding="utf-8")
    data = pa._load()
    assert data["actions"] == []


def test_load_handles_non_list_actions(isolated_queue):
    isolated_queue.write_text(
        json.dumps({"version": 2, "actions": "not a list"}), encoding="utf-8")
    data = pa._load()
    assert data["actions"] == []


def test_load_handles_non_dict_root(isolated_queue):
    isolated_queue.write_text(json.dumps(["just", "an", "array"]),
                                encoding="utf-8")
    data = pa._load()
    assert data["actions"] == []


# ── End-to-end: add → list → resolve preserva integridad ─────────────────────

def test_e2e_add_resolve_preserves_producer(isolated_queue):
    pa.add_action("E2E-1", "critical", "test e2e",
                   source_audit="repo-evaluator-2026", producer="test-suite")
    pa.resolve_action("E2E-1", note="resolved in test")
    data = pa._load()
    entry = data["actions"][0]
    assert entry["producer"] == "test-suite"
    assert entry["status"] == "resolved"
    assert entry["resolved_at"] is not None


def test_e2e_update_existing_preserves_creation_metadata(isolated_queue):
    a = pa.add_action("E2E-2", "high", "v1",
                       source_audit="audit", producer="prod-A")
    original_created = a["created_at"]
    # Re-add with different producer — debe preservar created_at
    pa.add_action("E2E-2", "high", "v2 updated title",
                   source_audit="audit", producer="prod-B")
    data = pa._load()
    entry = data["actions"][0]
    assert entry["created_at"] == original_created
    assert entry["title"] == "v2 updated title"
    assert entry["producer"] == "prod-B"  # nuevo producer reemplaza
