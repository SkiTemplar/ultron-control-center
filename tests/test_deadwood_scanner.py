"""Pytest suite for ULTRON v14 GENESIS deadwood scanner (Phase 1)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "deadwood"

if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import deadwood_scanner as ds  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _scan_fixture(name: str) -> list[ds.Finding]:
    return ds._scan_one(FIXTURES / name)


def _by_pattern(findings: list[ds.Finding], pattern: str) -> list[ds.Finding]:
    return [f for f in findings if f.pattern == pattern]


# ---------------------------------------------------------------------------
# Stage 1 — Sentinel
# ---------------------------------------------------------------------------


def test_valid_sentinel_is_info_when_remove_after_in_future():
    findings = _scan_fixture("stub_with_sentinel.ps1")
    sentinels = [f for f in findings if f.kind == "sentinel"]
    assert len(sentinels) == 1
    s = sentinels[0]
    assert s.pattern == "ULTRON-DEPRECATED"
    assert s.severity == "info"
    assert s.fields["version"] == "14.0.0"
    assert s.fields["missing"] == []
    # Sentinel block spans lines 6-15 in the fixture
    assert s.line_start == 6 and s.line_end == 15


def test_expired_sentinel_promotes_to_blocking():
    findings = _scan_fixture("expired_sentinel.py")
    sentinels = [f for f in findings if f.kind == "sentinel"]
    assert len(sentinels) == 1
    assert sentinels[0].severity == "blocking"
    assert sentinels[0].fields["remove-after"] == "2020-01-01"


def test_incomplete_sentinel_warns_with_missing_fields():
    findings = _scan_fixture("incomplete_sentinel.py")
    sentinels = [f for f in findings if f.kind == "sentinel"]
    assert len(sentinels) == 1
    s = sentinels[0]
    assert s.severity == "warn"
    assert "replaced-by" in s.fields["missing"]


def test_unterminated_sentinel_warns():
    findings = _scan_fixture("unterminated.py")
    unterm = [f for f in findings if f.pattern == "UNTERMINATED-DEPRECATED"]
    assert len(unterm) == 1
    assert unterm[0].severity == "warn"


# ---------------------------------------------------------------------------
# Stage 2 — Heuristics
# ---------------------------------------------------------------------------


def test_heuristics_fire_on_expected_lines():
    findings = _scan_fixture("heuristics.py")
    patterns = {f.pattern for f in findings if f.kind == "heuristic"}
    assert "removed_in_v" in patterns
    assert "todo_remove" in patterns
    assert "legacy_marker" in patterns
    assert "dead_suffix" in patterns
    assert "deprecated_word" in patterns


def test_docstring_mask_suppresses_module_doc():
    findings = _scan_fixture("heuristics.py")
    # Module docstring is lines 1-3; nothing inside should fire.
    inside_module_doc = [f for f in findings if 1 <= f.line_start <= 3]
    assert inside_module_doc == [], (
        f"Heuristics fired inside module docstring: {inside_module_doc}"
    )


def test_clean_file_produces_no_findings():
    findings = _scan_fixture("clean.py")
    assert findings == []


def test_sentinel_block_suppresses_heuristics_inside_it(tmp_path: Path):
    """Lines inside an @ULTRON-DEPRECATED block must NOT also generate
    heuristic findings — the sentinel is the canonical signal."""
    src = tmp_path / "wrapped.py"
    src.write_text(
        "def live():\n"
        "    return 1\n"
        "\n"
        "# @ULTRON-DEPRECATED:14.0.0\n"
        "#   reason: replaced by structlog\n"
        "#   replaced-by: ultron.logger.get_logger()\n"
        "#   remove-after: 2099-12-31\n"
        "def old_path():\n"
        "    return 'removed in v12.5'  # would normally trigger heuristic\n"
        "# @ULTRON-DEPRECATED-END\n",
        encoding="utf-8",
    )
    findings = ds._scan_one(src)
    heuristics = [f for f in findings if f.kind == "heuristic"]
    sentinels = [f for f in findings if f.kind == "sentinel"]
    assert len(sentinels) == 1
    assert heuristics == [], (
        f"Heuristic fired inside sentinel block: {heuristics}"
    )


# ---------------------------------------------------------------------------
# Stage 3 — Cross-reference (with isolated fakes)
# ---------------------------------------------------------------------------


def test_xref_ultron_ps1_detects_stub_dispatch(tmp_path: Path):
    fake = tmp_path / "fake_ultron.ps1"
    fake.write_text(
        "# fake dispatch\n"
        "switch ($cmd) {\n"
        '    "live" {\n'
        '        Write-Host "live cmd"\n'
        "    }\n"
        '    "auth" {\n'
        '        Write-Host "ultron auth: removed in v12.5" -ForegroundColor Yellow\n'
        "        exit 1\n"
        "    }\n"
        "}\n",
        encoding="utf-8",
    )
    findings = ds._xref_ultron_ps1(fake)
    stubs = [f for f in findings if f.pattern == "STUB_DISPATCH"]
    assert len(stubs) == 1
    assert stubs[0].fields["command"] == "auth"


def test_xref_stub_demotes_to_info_when_sentinel_wraps_case(tmp_path: Path):
    """Already-annotated stubs should be reported as INFO, not WARN —
    avoids double-counting the sentinel signal."""
    fake = tmp_path / "wrapped_stub.ps1"
    fake.write_text(
        "switch ($cmd) {\n"
        "    # @ULTRON-DEPRECATED:14.0.0\n"
        "    #   reason: dropped in v12.5\n"
        "    #   replaced-by: native command\n"
        "    #   remove-after: 2099-01-01\n"
        '    "auth" {\n'
        '        Write-Host "ultron auth: removed in v12.5"\n'
        "        exit 1\n"
        "    }\n"
        "    # @ULTRON-DEPRECATED-END\n"
        "}\n",
        encoding="utf-8",
    )
    findings = ds._xref_ultron_ps1(fake)
    stubs = [f for f in findings if f.pattern == "STUB_DISPATCH"]
    assert len(stubs) == 1
    assert stubs[0].severity == "info"
    assert stubs[0].fields["sentinel_wrapped"] is True


def test_xref_settings_hooks_flags_missing_path(tmp_path: Path):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {
            "PreToolUse": [
                {"matcher": "*", "hooks": [
                    {"type": "command", "command": "python " + str(tmp_path / "ghost.py")},
                ]},
            ],
        },
    }), encoding="utf-8")
    findings = ds._xref_settings_hooks(settings)
    missing = [f for f in findings if f.pattern == "HOOK_PATH_MISSING"]
    assert len(missing) == 1
    assert missing[0].severity == "blocking"


def test_xref_settings_hooks_handles_quoted_paths_with_spaces(tmp_path: Path):
    """H1 from code review: paths with spaces inside quotes must NOT be
    truncated by the bare-path regex. Without the quoted-first pass,
    'python "C:\\Program Files\\python.exe"' would match
    'C:\\Program' as the hook path and false-positive HOOK_PATH_MISSING.
    """
    real = tmp_path / "Program Files" / "real_hook.py"
    real.parent.mkdir(parents=True)
    real.write_text("# real", encoding="utf-8")
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {
            "Stop": [
                {"matcher": "*", "hooks": [
                    {"type": "command", "command": f'python "{real}"'},
                ]},
            ],
        },
    }), encoding="utf-8")
    findings = ds._xref_settings_hooks(settings)
    assert findings == [], (
        f"False positive on quoted path with space: {findings}")


def test_extract_path_candidates_quoted_first(tmp_path: Path):
    """Unit test for the helper used by _xref_settings_hooks."""
    cmd = 'python "C:\\Program Files\\app.py" --flag /usr/bin/script.sh'
    out = ds._extract_path_candidates(cmd)
    assert "C:\\Program Files\\app.py" in out
    assert "/usr/bin/script.sh" in out


def test_xref_settings_hooks_passes_when_path_exists(tmp_path: Path):
    real = tmp_path / "real_hook.py"
    real.write_text("# real", encoding="utf-8")
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {
            "Stop": [
                {"matcher": "*", "hooks": [
                    {"type": "command", "command": f"python {real}"},
                ]},
            ],
        },
    }), encoding="utf-8")
    findings = ds._xref_settings_hooks(settings)
    assert findings == []


def test_xref_health_unparseable_emits_warning(tmp_path: Path):
    """M4: a syntactically broken health.py used to silently return [].
    Now it surfaces a HEALTH_PY_UNPARSEABLE warn so the broken state
    can't ship undetected."""
    cockpit = tmp_path / "cockpit"
    cockpit.mkdir()
    health = cockpit / "health.py"
    health.write_text("EXPECTED_SCRIPTS = [\n  'a.py',\n  # missing close bracket\n",
                       encoding="utf-8")
    findings = ds._xref_health_expected_scripts(health, cockpit)
    pats = [f.pattern for f in findings]
    assert "HEALTH_PY_UNPARSEABLE" in pats
    f = next(f for f in findings if f.pattern == "HEALTH_PY_UNPARSEABLE")
    assert f.severity == "warn"


def test_stray_deprecated_end_warns(tmp_path: Path):
    """L1: an @ULTRON-DEPRECATED-END without matching open used to be
    silently ignored. Now it emits STRAY-DEPRECATED-END."""
    src = tmp_path / "stray.py"
    src.write_text(
        "def live():\n"
        "    return 1\n"
        "# @ULTRON-DEPRECATED-END\n",
        encoding="utf-8",
    )
    findings = ds._scan_one(src)
    pats = [f.pattern for f in findings]
    assert "STRAY-DEPRECATED-END" in pats


def test_xref_ultron_ps1_handles_single_quoted_and_default_case(tmp_path: Path):
    """M5: PS1_CASE regex used to only match double-quoted cases.
    Single-quoted, default, and * cases are now also recognised."""
    fake = tmp_path / "fake.ps1"
    fake.write_text(
        "switch ($cmd) {\n"
        "    'auth' {\n"
        '        Write-Host "removed in v12.5"\n'
        "    }\n"
        "    default {\n"
        '        Write-Host "ok"\n'
        "    }\n"
        "}\n",
        encoding="utf-8",
    )
    findings = ds._xref_ultron_ps1(fake)
    stub_cmds = {f.fields["command"] for f in findings if f.pattern == "STUB_DISPATCH"}
    assert "auth" in stub_cmds


def test_xref_health_expected_scripts_drift(tmp_path: Path):
    cockpit = tmp_path / "cockpit"
    cockpit.mkdir()
    (cockpit / "alpha.py").write_text("# present\n", encoding="utf-8")
    (cockpit / "beta.py").write_text("# present\n", encoding="utf-8")
    (cockpit / "gamma.py").write_text("# present\n", encoding="utf-8")
    health = cockpit / "health.py"
    health.write_text(
        "EXPECTED_SCRIPTS = {\n"
        '    "alpha.py",\n'
        "}\n",
        encoding="utf-8",
    )
    findings = ds._xref_health_expected_scripts(health, cockpit)
    drift = [f for f in findings if f.pattern == "HEALTH_EXPECTED_SCRIPTS_DRIFT"]
    assert len(drift) == 1
    sample = drift[0].fields["sample"]
    assert "beta.py" in sample
    assert "gamma.py" in sample
    assert "alpha.py" not in sample


# ---------------------------------------------------------------------------
# Orchestration / determinism
# ---------------------------------------------------------------------------


def test_run_scan_is_idempotent(tmp_path: Path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "mod.py").write_text(
        "# TODO: remove this once feature ships\n"
        "OLD_FLAG = True  # LEGACY -- needs cleanup\n",
        encoding="utf-8",
    )
    a = ds.run_scan([src])
    b = ds.run_scan([src])
    assert [(f.file, f.line_start, f.pattern, f.severity) for f in a] == \
           [(f.file, f.line_start, f.pattern, f.severity) for f in b]


def test_exit_code_promotion():
    blocking = [ds.Finding("x", 1, 1, "sentinel", "blocking", "X")]
    warning = [ds.Finding("x", 1, 1, "heuristic", "warn", "X")]
    info = [ds.Finding("x", 1, 1, "heuristic", "info", "X")]
    assert ds.exit_code(blocking) == 2
    assert ds.exit_code(warning) == 1
    assert ds.exit_code(info) == 0
    assert ds.exit_code([]) == 0


def test_fixtures_dir_is_walkable_when_passed_as_root():
    """Regression guard: 'fixtures' is in _SKIP_DIRS, so the scanner used to
    skip the dir entirely. The walker must now allow it as a root."""
    files = ds._iter_targets([FIXTURES])
    assert any(p.name == "heuristics.py" for p in files)
    assert any(p.name == "stub_with_sentinel.ps1" for p in files)


def test_render_markdown_groups_by_severity():
    findings = [
        ds.Finding("/x/a.py", 1, 1, "sentinel", "blocking", "X"),
        ds.Finding("/x/b.py", 2, 2, "heuristic", "warn", "Y"),
        ds.Finding("/x/c.py", 3, 3, "heuristic", "info", "Z"),
    ]
    md = ds.render_markdown(findings)
    assert "BLOCKING (1)" in md
    assert "WARN (1)" in md
    assert "INFO (1)" in md
    # Order: blocking before warn before info
    assert md.index("BLOCKING") < md.index("WARN") < md.index("INFO")


# ---------------------------------------------------------------------------
# CLI smoke
# ---------------------------------------------------------------------------


def test_cli_main_runs_quiet_on_empty_root(tmp_path: Path, capsys):
    empty = tmp_path / "empty"
    empty.mkdir()
    rc = ds.main(["--roots", str(empty), "--quiet"])
    captured = capsys.readouterr()
    # Cross-reference stages still scan the real ULTRON paths, which can
    # legitimately surface warnings. The CLI smoke test only asserts that
    # the scanner does not crash and respects --quiet.
    assert rc in (0, 1)
    assert captured.out == ""
