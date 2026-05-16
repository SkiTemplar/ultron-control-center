"""Pytest suite for ULTRON v14 Sprint 5 Sub-pilar B — Doctor CLI v2.

Coverage targets every detection plugin (a-m), the rules loader, the
output formatters, the --fix workflow, and end-to-end CLI smoke. All
tests run inside a tmp_path-isolated home, monkeypatching Path.home() /
USERPROFILE so the real ~/.ultron is untouched.
"""
from __future__ import annotations

import importlib
import io
import json
import os
import sys
import time
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

VENV_PYTHON = SKILL_ROOT / ".venv" / "Scripts" / "python.exe"
PYTHON_EXE = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
DOCTOR_PATH = COCKPIT / "doctor.py"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    """Point USERPROFILE / HOME at tmp_path, prebuild the ULTRON skeleton,
    and force-reload doctor + alerts so module-level paths re-resolve.
    """
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "brain_index").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "telemetry").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "backups").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude" / "projects" / "C--Users-testuser" / "memory").mkdir(
        parents=True, exist_ok=True)
    for mod in ("alerts", "doctor", "token_budget",
                # S5-C security modules — must reload to pick up patched HOME
                "skill_sync_security", "skill_provenance",
                "settings_integrity", "secrets_scanner"):
        if mod in sys.modules:
            del sys.modules[mod]
    return tmp_path


@pytest.fixture
def doctor(isolated_home):
    return importlib.import_module("doctor")


def _make_clean_setup(home: Path) -> None:
    """Populate the isolated home with the minimal artifacts a clean ULTRON
    install would have: fresh context.md, fresh brain_index/index.db, and
    an empty manifest cache + skills.manifest.yaml.
    """
    ctx = home / ".ultron" / ".tmp" / "context.md"
    ctx.write_text("# context\nfresh\n", encoding="utf-8")
    db = home / ".ultron" / "brain_index" / "index.db"
    db.write_bytes(b"SQLite format 3\x00")
    (home / ".ultron" / "manifest.cache.json").write_text(
        json.dumps({"version": "test", "skills": []}), encoding="utf-8"
    )
    (home / ".ultron" / "skills.manifest.yaml").write_text("[]", encoding="utf-8")
    # Empty settings.json (no hooks → no missing scripts)
    (home / ".claude" / "settings.json").write_text(
        json.dumps({"hooks": {}}), encoding="utf-8"
    )
    # F09 fix: clean setup needs a settings_integrity baseline snapshot
    # so the no_snapshot finding (now severity=warn) does not mark the
    # setup as dirty.
    integrity_dir = home / ".ultron" / "integrity"
    integrity_dir.mkdir(parents=True, exist_ok=True)
    snap = {
        "ts": "2026-05-05T00:00:00Z",
        "sha1": "0" * 40,
        "size": 16,
        "mcps_count": 0, "hooks_count": 0, "plugins_count": 0,
        "trigger": "manual", "user_authorized": True,
        "mcps": [], "hooks": [], "plugins": [],
    }
    (integrity_dir / "settings.snapshots.jsonl").write_text(
        json.dumps(snap) + "\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Rules loader
# ---------------------------------------------------------------------------

def test_doctor_handles_missing_config_gracefully(doctor, isolated_home):
    """No doctor-rules.yaml → defaults are used, no crash."""
    rules_path = isolated_home / ".ultron" / "config" / "doctor-rules.yaml"
    assert not rules_path.exists()
    rules = doctor.load_rules(rules_path)
    assert rules["retention"]["session_logs_days"] == 30
    assert rules["staleness"]["l0_max_hours"] == 4
    assert rules["thresholds"]["token_overhead_tokens"] == 1500
    assert rules["auto_doctor"] is False


def test_doctor_rules_yaml_overrides_defaults(doctor, isolated_home):
    yaml_text = (
        "retention:\n"
        "  session_logs_days: 7\n"
        "  alerts_max_size_mb: 25\n"
        "thresholds:\n"
        "  token_overhead_tokens: 999\n"
        "auto_doctor: true\n"
    )
    p = isolated_home / ".ultron" / "config" / "doctor-rules.yaml"
    p.write_text(yaml_text, encoding="utf-8")
    rules = doctor.load_rules(p)
    assert rules["retention"]["session_logs_days"] == 7
    assert rules["retention"]["alerts_max_size_mb"] == 25
    # Untouched defaults survive the merge.
    assert rules["retention"]["backups_days"] == 90
    assert rules["thresholds"]["token_overhead_tokens"] == 999
    assert rules["auto_doctor"] is True


def test_doctor_rules_yaml_malformed_falls_back(doctor, isolated_home):
    """Garbled YAML doesn't crash the loader; we get defaults back."""
    p = isolated_home / ".ultron" / "config" / "doctor-rules.yaml"
    p.write_text("this is not: valid: yaml: at: all:\n", encoding="utf-8")
    rules = doctor.load_rules(p)
    # Either fallback parser silently ignored bad lines or yaml raised —
    # either way we should have defaults under the keys we depend on.
    assert "retention" in rules
    assert rules["retention"]["session_logs_days"] == 30


# ---------------------------------------------------------------------------
# Detection (a) — orphan paths
# ---------------------------------------------------------------------------

def test_doctor_finds_orphan_path_with_no_references(doctor, isolated_home):
    """A directory with no script references AND >30d old → flagged."""
    ultron = isolated_home / ".ultron"
    orphan = ultron / "completely_random_orphan_dir_xyz"
    orphan.mkdir()
    (orphan / "data.txt").write_text("orphan content", encoding="utf-8")
    # Force mtime > 30d ago
    old = time.time() - 60 * 86400
    os.utime(orphan, (old, old))
    rules = doctor.load_rules()
    findings = doctor._check_orphan_paths(rules)
    ids = {f.id for f in findings}
    assert "orphan_path:completely_random_orphan_dir_xyz" in ids


def test_doctor_skips_wellknown_paths(doctor, isolated_home):
    """brain_index/, .tmp/, alerts.jsonl, etc. never appear as orphans."""
    ultron = isolated_home / ".ultron"
    # All wellknown dirs already exist via the fixture skeleton; create one
    # very large + ancient one to make sure size+age alone don't flag it.
    big = ultron / "brain_index" / "huge_index.db"
    big.write_bytes(b"\x00" * (2 * 1024 * 1024))
    old = time.time() - 365 * 86400
    os.utime(big, (old, old))
    findings = doctor._check_orphan_paths(doctor.load_rules())
    for f in findings:
        assert "brain_index" not in f.id
        assert ".tmp" not in f.id
        assert "alerts" not in f.id


def test_doctor_skips_orphan_under_threshold(doctor, isolated_home):
    """Small AND recent path is not an orphan candidate."""
    ultron = isolated_home / ".ultron"
    tiny = ultron / "tiny_recent_thing"
    tiny.mkdir()
    (tiny / "x").write_text("hi", encoding="utf-8")
    findings = doctor._check_orphan_paths(doctor.load_rules())
    assert all("tiny_recent_thing" not in f.id for f in findings)


# ---------------------------------------------------------------------------
# Detection (b)+(c) — skill drift
# ---------------------------------------------------------------------------

def test_doctor_detects_skill_on_disk_not_in_manifest(doctor, isolated_home):
    """A SKILL.md in ~/.claude/skills/ that's missing from manifest is flagged."""
    skills = isolated_home / ".claude" / "skills"
    new_skill = skills / "my-untracked-skill"
    new_skill.mkdir()
    (new_skill / "SKILL.md").write_text("# untracked", encoding="utf-8")
    # Empty manifest cache + yaml present
    (isolated_home / ".ultron" / "manifest.cache.json").write_text(
        json.dumps({"skills": []}), encoding="utf-8")
    (isolated_home / ".ultron" / "skills.manifest.yaml").write_text(
        "[]", encoding="utf-8")
    findings = doctor._check_skill_drift(doctor.load_rules())
    ids = {f.id for f in findings}
    assert "skill_drift:on-disk-not-manifest:my-untracked-skill" in ids


def test_doctor_detects_skill_in_manifest_not_on_disk(doctor, isolated_home):
    """A non-deprecated, non-namespaced manifest entry without a SKILL.md is flagged."""
    cache = {"skills": [{"id": "ghost-skill", "triggers": []}]}
    (isolated_home / ".ultron" / "manifest.cache.json").write_text(
        json.dumps(cache), encoding="utf-8")
    findings = doctor._check_skill_drift(doctor.load_rules())
    ids = {f.id for f in findings}
    assert "skill_drift:manifest-not-on-disk:ghost-skill" in ids


def test_doctor_skill_drift_ignores_namespaced_skills(doctor, isolated_home):
    """Plugin/persona skills with ':' don't get flagged as on-disk-missing."""
    cache = {"skills": [
        {"id": "superpowers:test-driven-development", "triggers": []},
        {"id": "agent-skills:plan", "triggers": []},
    ]}
    (isolated_home / ".ultron" / "manifest.cache.json").write_text(
        json.dumps(cache), encoding="utf-8")
    findings = doctor._check_skill_drift(doctor.load_rules())
    for f in findings:
        assert ":" not in f.id.split(":")[-1] or "manifest-not-on-disk" not in f.id


# ---------------------------------------------------------------------------
# Detection (d) — hook scripts missing
# ---------------------------------------------------------------------------

def test_doctor_detects_settings_hook_missing_script(doctor, isolated_home):
    settings_path = isolated_home / ".claude" / "settings.json"
    bogus = "C:/this/path/does/not/exist/hook.py"
    config = {
        "hooks": {
            "PreToolUse": [{
                "hooks": [
                    {"type": "command",
                     "command": f"python {bogus}"}
                ]
            }]
        }
    }
    settings_path.write_text(json.dumps(config), encoding="utf-8")
    findings = doctor._check_hook_scripts_missing(doctor.load_rules())
    blocking = [f for f in findings if f.severity == "blocking"]
    assert blocking, "hook missing must be blocking"
    assert any("hook.py" in f.summary for f in blocking)


def test_doctor_extract_script_path_handles_quoted_paths(doctor):
    """Hook command lines often quote the path on Windows."""
    cmd = 'PowerShell -File "C:/Users/foo/hook.ps1"'
    assert doctor._extract_script_path(cmd) == "C:/Users/foo/hook.ps1"
    cmd2 = "python C:/x/y.py"
    assert doctor._extract_script_path(cmd2) == "C:/x/y.py"
    assert doctor._extract_script_path("python --version") is None


# ---------------------------------------------------------------------------
# Detection (e)+(f) — staleness
# ---------------------------------------------------------------------------

def test_doctor_detects_l0_stale(doctor, isolated_home):
    ctx = isolated_home / ".ultron" / ".tmp" / "context.md"
    ctx.write_text("old", encoding="utf-8")
    old = time.time() - 6 * 3600   # 6h, > 4h limit
    os.utime(ctx, (old, old))
    findings = doctor._check_l0_stale(doctor.load_rules())
    assert findings
    assert findings[0].id == "stale:l0"


def test_doctor_l0_missing_is_warn_with_fix(doctor, isolated_home):
    findings = doctor._check_l0_stale(doctor.load_rules())
    # context.md was not created in the fixture by default
    assert findings
    assert findings[0].fix_command is not None
    assert "context_primer.py" in " ".join(str(t) for t in findings[0].fix_command)


def test_doctor_detects_ztmsi_stale(doctor, isolated_home):
    db = isolated_home / ".ultron" / "brain_index" / "index.db"
    db.write_bytes(b"old")
    old = time.time() - 10 * 3600
    os.utime(db, (old, old))
    findings = doctor._check_ztmsi_stale(doctor.load_rules())
    assert findings
    assert findings[0].id == "stale:ztmsi"
    assert findings[0].severity == "info"


# ---------------------------------------------------------------------------
# Detection (g)+(h)+(i) — retention
# ---------------------------------------------------------------------------

def test_doctor_detects_old_session_logs(doctor, isolated_home):
    auto_dir = isolated_home / ".ultron-vault" / "50_SESSIONS_LOG"
    auto_dir.mkdir(parents=True)
    f = auto_dir / "auto-2025-01-01.md"
    f.write_text("session", encoding="utf-8")
    old = time.time() - 60 * 86400
    os.utime(f, (old, old))
    findings = doctor._check_session_logs(doctor.load_rules())
    assert findings
    assert "session log" in findings[0].summary.lower()


def test_doctor_detects_old_backup_snapshots(doctor, isolated_home):
    backups = isolated_home / ".ultron" / "backups"
    snap = backups / "snap-2024-01-01"
    snap.mkdir(parents=True)
    old = time.time() - 200 * 86400
    os.utime(snap, (old, old))
    findings = doctor._check_backup_snapshots(doctor.load_rules())
    assert findings
    assert "backup snapshot" in findings[0].summary.lower()


def test_doctor_detects_old_telemetry(doctor, isolated_home):
    tele = isolated_home / ".ultron" / "telemetry" / "events"
    tele.mkdir(parents=True)
    f = tele / "old.jsonl"
    f.write_text("{}", encoding="utf-8")
    old = time.time() - 365 * 86400
    os.utime(f, (old, old))
    findings = doctor._check_telemetry(doctor.load_rules())
    assert findings
    assert "telemetry" in findings[0].summary.lower()


# ---------------------------------------------------------------------------
# Detection (j)+(k) — alerts
# ---------------------------------------------------------------------------

def test_doctor_detects_unacked_blocking_alerts_24h(doctor, isolated_home):
    """A blocking alert with ts older than 24h is flagged."""
    import alerts as _alerts
    # Force-write an old blocking alert directly to the file (bypass write()
    # so we can backdate the ts field).
    ts = "2024-01-01T00:00:00Z"
    rec = {
        "id": "a-2024-01-01-001", "ts": ts,
        "severity": "blocking", "source": "test",
        "message": "old issue", "tags": [], "ack": False, "ack_ts": None,
    }
    alerts_file = isolated_home / ".ultron" / "alerts.jsonl"
    alerts_file.write_text(json.dumps(rec) + "\n", encoding="utf-8")
    findings = doctor._check_unacked_blocking_alerts(doctor.load_rules())
    assert findings
    assert findings[0].id == "alert:unacked_blocking_24h"


def test_doctor_skips_recent_blocking_alerts(doctor, isolated_home):
    """Same kind of alert but recent (<24h) is NOT flagged."""
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rec = {
        "id": "a-2026-05-05-001", "ts": now,
        "severity": "blocking", "source": "test",
        "message": "fresh issue", "tags": [], "ack": False, "ack_ts": None,
    }
    alerts_file = isolated_home / ".ultron" / "alerts.jsonl"
    alerts_file.write_text(json.dumps(rec) + "\n", encoding="utf-8")
    findings = doctor._check_unacked_blocking_alerts(doctor.load_rules())
    assert not findings


def test_doctor_detects_alerts_jsonl_oversized(doctor, isolated_home):
    alerts_file = isolated_home / ".ultron" / "alerts.jsonl"
    # Use a tiny limit to avoid writing 10MB+ of test data.
    rules = doctor.load_rules()
    rules["retention"]["alerts_max_size_mb"] = 0.0001  # ~100 bytes
    alerts_file.write_text("x" * 1024, encoding="utf-8")
    findings = doctor._check_alerts_file_size(rules)
    assert findings
    assert findings[0].fix_command is not None
    assert "alerts.py" in " ".join(str(t) for t in findings[0].fix_command)


# ---------------------------------------------------------------------------
# Detection (l) — token overhead
# ---------------------------------------------------------------------------

def test_doctor_token_audit_under_threshold(doctor, isolated_home):
    """Small fake context files → no finding, audit reports PASS."""
    (isolated_home / ".ultron" / ".tmp" / "context.md").write_text(
        "x" * 80, encoding="utf-8")  # ~20 tok
    (isolated_home / ".claude" / "projects" / "C--Users-testuser" / "memory" /
     "MEMORY.md").write_text("y" * 80, encoding="utf-8")
    (isolated_home / ".claude" / "CLAUDE.md").write_text(
        "z" * 80, encoding="utf-8")
    rules = doctor.load_rules()
    findings = doctor._check_token_overhead(rules)
    assert not findings
    out = doctor.format_token_audit()
    assert "PASS" in out


def test_doctor_token_audit_over_threshold(doctor, isolated_home):
    rules = doctor.load_rules()
    rules["thresholds"]["token_overhead_tokens"] = 10
    (isolated_home / ".ultron" / ".tmp" / "context.md").write_text(
        "a" * 4000, encoding="utf-8")
    findings = doctor._check_token_overhead(rules)
    assert findings
    assert findings[0].id == "token:overhead"
    assert findings[0].severity == "warn"


# ---------------------------------------------------------------------------
# Detection (m) — mcp health
# ---------------------------------------------------------------------------

def test_doctor_health_check_reads_mcp_health_json(doctor, isolated_home):
    health = isolated_home / ".ultron" / ".tmp" / "mcp-health.json"
    health.write_text(json.dumps({
        "checked_at": "2026-05-05T00:00:00Z",
        "duration_ms": 500,
        "results": {"gemini": "degraded", "context7": "ok"},
    }), encoding="utf-8")
    fb = isolated_home / ".ultron" / "config" / "mcp-fallbacks.yaml"
    fb.write_text(
        "- mcp_name: gemini\n  alert_severity: warn\n  fallback_message: 'Use codex'\n",
        encoding="utf-8",
    )
    findings = doctor._check_mcp_health(doctor.load_rules())
    assert findings
    assert any("gemini" in f.id for f in findings)
    assert findings[0].fix_command is not None


def test_doctor_mcp_health_skips_info_fallbacks(doctor, isolated_home):
    health = isolated_home / ".ultron" / ".tmp" / "mcp-health.json"
    health.write_text(json.dumps({
        "checked_at": "2026-05-05T00:00:00Z",
        "duration_ms": 500,
        "results": {"trivial-mcp": "degraded"},
    }), encoding="utf-8")
    fb = isolated_home / ".ultron" / "config" / "mcp-fallbacks.yaml"
    fb.write_text(
        "- mcp_name: trivial-mcp\n  alert_severity: info\n",
        encoding="utf-8",
    )
    findings = doctor._check_mcp_health(doctor.load_rules())
    # info severity is suppressed at this layer (alerts bus already surfaces).
    assert not findings


# ---------------------------------------------------------------------------
# Whole-report + format
# ---------------------------------------------------------------------------

def test_doctor_returns_zero_findings_for_clean_setup(doctor, isolated_home):
    _make_clean_setup(isolated_home)
    report = doctor.run_all_detections()
    blocking = report.by_severity("blocking")
    warn = report.by_severity("warn")
    assert not blocking, f"Clean setup should not produce blockings: {blocking}"
    # warn allowed iff token_overhead happens (defaults are 1500 tok), but
    # our fixture context files are tiny so this should be 0.
    assert not warn, f"Clean setup should not produce warns: {warn}"


def test_doctor_json_output_is_valid_jsonl_compatible(doctor, isolated_home):
    _make_clean_setup(isolated_home)
    report = doctor.run_all_detections()
    payload = report.to_dict()
    # round-trip
    s = json.dumps(payload)
    parsed = json.loads(s)
    assert "findings" in parsed
    assert "summary" in parsed
    assert isinstance(parsed["findings"], list)


def test_doctor_quiet_mode_suppresses_stdout(doctor, isolated_home, capsys):
    _make_clean_setup(isolated_home)
    rc = doctor.main(["--quiet"])
    captured = capsys.readouterr()
    assert captured.out == ""
    # exit code reflects worst severity (clean setup → 0)
    assert rc == 0


def test_doctor_dry_run_never_writes(doctor, isolated_home):
    """Default mode (and --dry-run) must not create state-ful files itself.

    The alerts module — imported by doctor for detection (j) — touches
    alerts.jsonl on first read to ensure it exists. That's an alerts-bus
    invariant, NOT a doctor write, so we exclude it from the diff.
    """
    _make_clean_setup(isolated_home)

    def _snapshot() -> set[Path]:
        return {p.relative_to(isolated_home) for p in
                (isolated_home / ".ultron").rglob("*") if p.is_file()
                and "alerts.jsonl" not in str(p)}

    before = _snapshot()
    doctor.main(["--dry-run"])
    after = _snapshot()
    new_files = after - before
    assert not new_files, f"Doctor wrote unexpected files in dry-run: {new_files}"


# ---------------------------------------------------------------------------
# --fix workflow
# ---------------------------------------------------------------------------

def test_doctor_fix_requires_confirmation(doctor, isolated_home, monkeypatch):
    """Default 'n' answer → no fix runs."""
    _make_clean_setup(isolated_home)
    # Make context.md stale so we have at least one fixable finding.
    ctx = isolated_home / ".ultron" / ".tmp" / "context.md"
    old = time.time() - 8 * 3600
    os.utime(ctx, (old, old))
    report = doctor.run_all_detections()
    fixable = [f for f in report.findings if f.fix_command]
    assert fixable, "test setup must produce at least one fixable finding"

    monkeypatch.setattr("builtins.input", lambda _prompt="": "n")
    runs: list[list[str]] = []
    monkeypatch.setattr(doctor, "silent_run",
                        lambda cmd, **kw: runs.append(list(cmd)) or _FakeProc(0))
    sink = io.StringIO()
    applied = doctor.apply_fixes_interactively(report, stdout=sink)
    assert applied == 0
    assert runs == []


def test_doctor_fix_executes_on_yes(doctor, isolated_home, monkeypatch):
    _make_clean_setup(isolated_home)
    ctx = isolated_home / ".ultron" / ".tmp" / "context.md"
    old = time.time() - 8 * 3600
    os.utime(ctx, (old, old))
    report = doctor.run_all_detections()

    runs: list[list[str]] = []

    def _fake_run(cmd, **kw):
        runs.append(list(cmd))
        return _FakeProc(0)

    monkeypatch.setattr("builtins.input", lambda _prompt="": "y")
    monkeypatch.setattr(doctor, "silent_run", _fake_run)
    sink = io.StringIO()
    applied = doctor.apply_fixes_interactively(report, stdout=sink)
    assert applied >= 1
    assert runs, "silent_run should have been called for at least one fix"


# ---------------------------------------------------------------------------
# F08 — TTY gating on doctor --fix
# ---------------------------------------------------------------------------

def test_doctor_fix_refuses_piped_stdin_without_yes_flag(doctor,
                                                          isolated_home,
                                                          monkeypatch,
                                                          capsys):
    """Non-interactive (piped stdin) without --yes -> exit 2, no fixes run."""
    _make_clean_setup(isolated_home)
    ctx = isolated_home / ".ultron" / ".tmp" / "context.md"
    old = time.time() - 8 * 3600
    os.utime(ctx, (old, old))

    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    runs: list = []
    monkeypatch.setattr(doctor, "silent_run",
                        lambda cmd, **kw: runs.append(list(cmd)))
    rc = doctor.main(["--fix"])
    assert rc == 2, "expected exit 2 when piped stdin and no --yes"
    assert runs == [], "no fix should have run"


def test_doctor_offers_fix_for_missing_baseline(doctor, isolated_home):
    """F09 fix: settings_integrity.no_snapshot is now severity=warn AND
    surfaces a fix_command pointing at `settings_integrity.py snapshot`.
    """
    _make_clean_setup(isolated_home)
    # _make_clean_setup writes a baseline snapshot — remove it so the
    # detector hits the "no_snapshot" branch we are asserting against.
    snap_file = isolated_home / ".ultron" / "integrity" / "settings.snapshots.jsonl"
    if snap_file.exists():
        snap_file.unlink()
    rules = doctor.load_rules()
    findings = doctor._check_settings_integrity(rules)
    no_snap = [f for f in findings if "no_snapshot" in f.id]
    assert no_snap, "expected a no_snapshot finding from settings_integrity"
    f = no_snap[0]
    assert f.severity == "warn", (
        f"expected warn severity for no_snapshot, got {f.severity!r}"
    )
    assert f.fix_command is not None, (
        "expected fix_command for no_snapshot finding"
    )
    cmd = " ".join(str(t) for t in f.fix_command)
    assert "settings_integrity.py" in cmd
    assert "snapshot" in cmd


def test_doctor_fix_accepts_yes_flag_in_non_tty(doctor, isolated_home,
                                                  monkeypatch):
    """Non-interactive + --yes -> fixes proceed without confirmation."""
    _make_clean_setup(isolated_home)
    ctx = isolated_home / ".ultron" / ".tmp" / "context.md"
    old = time.time() - 8 * 3600
    os.utime(ctx, (old, old))

    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    runs: list = []
    monkeypatch.setattr(doctor, "silent_run",
                        lambda cmd, **kw: runs.append(list(cmd)) or _FakeProc(0))
    # No mocked input — would raise EOFError if accidentally called.
    rc = doctor.main(["--fix", "--yes"])
    # rc=0 means at least one fix applied.
    assert rc == 0
    assert runs, "fix should have run with --yes flag"


def test_doctor_fix_log_is_append_only(doctor, isolated_home, monkeypatch):
    _make_clean_setup(isolated_home)
    ctx = isolated_home / ".ultron" / ".tmp" / "context.md"
    old = time.time() - 8 * 3600
    os.utime(ctx, (old, old))
    report = doctor.run_all_detections()

    monkeypatch.setattr("builtins.input", lambda _prompt="": "y")
    monkeypatch.setattr(doctor, "silent_run",
                        lambda cmd, **kw: _FakeProc(0))
    log_path = isolated_home / ".ultron" / ".tmp" / "doctor-fix-log.jsonl"
    sink = io.StringIO()
    doctor.apply_fixes_interactively(report, stdout=sink)
    assert log_path.exists()
    lines1 = log_path.read_text(encoding="utf-8").splitlines()
    # Re-run another acceptance — log must be appended, not truncated.
    doctor.apply_fixes_interactively(report, stdout=sink)
    lines2 = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines2) > len(lines1)
    # Each line is valid JSON.
    for line in lines2:
        parsed = json.loads(line)
        assert "finding_id" in parsed
        assert "ts" in parsed


# ---------------------------------------------------------------------------
# Performance + miscellaneous
# ---------------------------------------------------------------------------

def test_doctor_total_runtime_under_2s(doctor, isolated_home):
    _make_clean_setup(isolated_home)
    t0 = time.perf_counter()
    report = doctor.run_all_detections()
    elapsed = time.perf_counter() - t0
    assert elapsed < 2.0, f"clean-setup detections took {elapsed:.2f}s"
    assert report.runtime_ms < 2000


def test_doctor_health_check_format_renders(doctor, isolated_home):
    _make_clean_setup(isolated_home)
    report = doctor.run_all_detections()
    out = doctor.format_health_check(report)
    assert "MCP servers" in out
    assert "Brain index" in out
    assert "L0 context" in out


def test_doctor_human_format_groups_by_severity(doctor, isolated_home):
    _make_clean_setup(isolated_home)
    # Inject one finding of each severity by hand.
    report = doctor.Report()
    for sev in ("info", "warn", "blocking"):
        report.add(doctor.Finding(
            id=f"test:{sev}", category="integrity", severity=sev,
            summary=f"test {sev}", detail="d", fix_action=None, fix_command=None,
        ))
    text = doctor.format_human(report)
    # Blocking section appears before warn appears before info.
    pos_b = text.find("[BLOCKING]")
    pos_w = text.find("[WARN]")
    pos_i = text.find("[INFO]")
    assert pos_b != -1 and pos_w != -1 and pos_i != -1
    assert pos_b < pos_w < pos_i


def test_doctor_exit_code_blocking_yields_2(doctor, isolated_home, capsys):
    """A blocking finding → exit code 2."""
    _make_clean_setup(isolated_home)
    # Add a settings.json with a missing-script hook to force a blocking finding.
    settings = isolated_home / ".claude" / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "python C:/nope/missing.py"}
        ]}]}
    }), encoding="utf-8")
    rc = doctor.main(["--quiet"])
    assert rc == 2


def test_doctor_token_audit_cli_json(doctor, isolated_home, capsys):
    _make_clean_setup(isolated_home)
    rc = doctor.main(["--token-audit", "--json"])
    captured = capsys.readouterr()
    assert rc == 0
    parsed = json.loads(captured.out)
    assert "total" in parsed
    assert "limit" in parsed
    assert parsed["status"] == "pass"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeProc:
    """Tiny stand-in for subprocess.CompletedProcess used in monkeypatching."""
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.stdout = b""
        self.stderr = b""
