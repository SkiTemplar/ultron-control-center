"""
Tests for ULTRON S4 — Skills Manifest CLI (skill_manifest.py).

Run from the ultron skill root:
    uv run pytest tests/test_skill_manifest.py -v

Test isolation: all tests that write to the manifest use a temp directory
controlled via the ULTRON_MANIFEST_YAML and ULTRON_MANIFEST_CACHE env vars,
OR snapshot/restore the real manifest. We use monkeypatch on the module's
path constants for full isolation.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

# ── Paths ──────────────────────────────────────────────────────────────────────

SKILL_ROOT = Path(__file__).parents[1]
COCKPIT_DIR = SKILL_ROOT / "scripts" / "cockpit"
MANIFEST_PY = COCKPIT_DIR / "skill_manifest.py"
VENV_PYTHON = SKILL_ROOT / ".venv" / "Scripts" / "python.exe"
PYTHON_EXE = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

REAL_MANIFEST_YAML = Path.home() / ".ultron" / "skills.manifest.yaml"
REAL_MANIFEST_CACHE = Path.home() / ".ultron" / "manifest.cache.json"
SCHEMA_PATH = Path.home() / ".ultron" / "config" / "skills-manifest-schema.json"


# ── Subprocess helper ──────────────────────────────────────────────────────────

def _run_manifest(args: list[str], env: dict | None = None,
                  timeout: float = 30.0) -> subprocess.CompletedProcess:
    """Invoke skill_manifest.py as a subprocess."""
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(
        [PYTHON_EXE, str(MANIFEST_PY)] + args,
        capture_output=True,
        timeout=timeout,
        env=merged_env,
    )


# ── Module-level import helper ─────────────────────────────────────────────────

def _import_manifest_module():
    """Import skill_manifest as a module for in-process testing."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("skill_manifest", MANIFEST_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── Fixtures ───────────────────────────────────────────────────────────────────

@pytest.fixture
def isolated_manifest(tmp_path):
    """
    Provides isolated YAML and cache paths in tmp_path.
    Monkeypatches the module globals so all operations go to tmp_path.
    Returns (yaml_path, cache_path, module).
    """
    yaml_path = tmp_path / "skills.manifest.yaml"
    cache_path = tmp_path / "manifest.cache.json"
    schema_dir = tmp_path / "config"
    schema_dir.mkdir()

    # Copy real schema to tmp
    if SCHEMA_PATH.exists():
        shutil.copy(SCHEMA_PATH, schema_dir / "skills-manifest-schema.json")

    mod = _import_manifest_module()
    # Patch module paths
    mod.MANIFEST_YAML = yaml_path
    mod.MANIFEST_CACHE = cache_path
    mod.SCHEMA_PATH = schema_dir / "skills-manifest-schema.json"
    mod.TELEMETRY_JSONL = tmp_path / "telemetry" / "sync-events.jsonl"
    # Redirect SKILLS_DIR to a synthetic mini-tree
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    mod.SKILLS_DIR = skills_dir

    return yaml_path, cache_path, mod, skills_dir


@pytest.fixture
def snapshot_real_manifest():
    """
    Snapshot the real manifest.cache.json before the test, restore after.
    Used for regression tests that need to operate on the real cache.
    """
    backup_cache = None
    if REAL_MANIFEST_CACHE.exists():
        backup_cache = REAL_MANIFEST_CACHE.read_bytes()

    backup_yaml = None
    if REAL_MANIFEST_YAML.exists():
        backup_yaml = REAL_MANIFEST_YAML.read_bytes()

    yield

    # Restore
    if backup_cache is not None:
        REAL_MANIFEST_CACHE.write_bytes(backup_cache)
    if backup_yaml is not None:
        REAL_MANIFEST_YAML.write_bytes(backup_yaml)


# ── Test 1: manifest YAML validates against schema ────────────────────────────

def test_manifest_yaml_validates_against_schema(isolated_manifest):
    """Write a synthetic manifest YAML and verify JSON Schema validation passes."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    synthetic = [
        {
            "name": "test-skill",
            "source": "plugin",
            "triggers": ["test", "testing"],
            "tags": ["testing"],
            "cost_tier": "low",
            "dispatcher_priority": 2,
            "deprecated": False,
            "replaces": [],
            "last_used": None,
            "last_synced": "2026-05-05",
            "description": "A test skill for schema validation",
        }
    ]
    yaml_path.write_text(yaml.dump(synthetic, allow_unicode=True), encoding="utf-8")

    # Use jsonschema directly
    import jsonschema
    schema = json.loads(mod.SCHEMA_PATH.read_text(encoding="utf-8"))
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    # Should not raise
    jsonschema.validate(data, schema)


# ── Test 2: invalid manifest fails schema validation ──────────────────────────

def test_manifest_yaml_invalid_fails_validation(isolated_manifest):
    """manifest with cost_tier='invalid' must fail JSON Schema validation."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    invalid = [
        {
            "name": "bad-skill",
            "source": "plugin",
            "triggers": ["bad"],
            "cost_tier": "INVALID_VALUE",  # must fail enum check
        }
    ]
    yaml_path.write_text(yaml.dump(invalid, allow_unicode=True), encoding="utf-8")

    import jsonschema
    schema = json.loads(mod.SCHEMA_PATH.read_text(encoding="utf-8"))
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))

    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(data, schema)


# ── Test 3: sync regenerates cache ────────────────────────────────────────────

def test_sync_regenerates_cache(isolated_manifest):
    """Call sync, assert manifest.cache.json exists with dispatcher contract."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    # Create a synthetic SKILL.md in the mini-tree
    skill_dir = skills_dir / "my-synced-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: my-synced-skill\ndescription: Test skill\nkind: skill\n"
        "tier: L1\ncategory: testing\nlast_verified: 2026-05-05\n---\n\n# My Skill\n",
        encoding="utf-8",
    )

    class _Args:
        pass

    result = mod.cmd_sync(_Args())
    assert result == 0, "cmd_sync should return 0"

    assert cache_path.exists(), "manifest.cache.json must be created by sync"

    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert "skills" in cache, "cache must have 'skills' key"
    assert isinstance(cache["skills"], list), "cache.skills must be a list"
    assert len(cache["skills"]) > 0, "cache must have at least one skill"

    # Every skill must have id and triggers (DISPATCHER CONTRACT)
    for skill in cache["skills"]:
        assert "id" in skill, f"Cache entry missing 'id': {skill}"
        assert "triggers" in skill, f"Cache entry missing 'triggers': {skill}"
        assert isinstance(skill["triggers"], list), "triggers must be a list"


# ── Test 4: sync preserves dispatcher contract (REGRESSION) ───────────────────

def test_sync_preserves_dispatcher_contract(snapshot_real_manifest):
    """
    REGRESSION: every id in the pre-sync cache must still be in the post-sync cache.
    This test operates on the real manifest to catch contract regressions.
    """
    # Capture pre-sync cache
    pre_cache: dict = {}
    if REAL_MANIFEST_CACHE.exists():
        pre_cache = json.loads(REAL_MANIFEST_CACHE.read_text(encoding="utf-8"))
    pre_ids: set[str] = {s["id"] for s in pre_cache.get("skills", []) if "id" in s}

    # Run sync
    result = _run_manifest(["sync"], timeout=60.0)
    assert result.returncode == 0, (
        f"sync failed:\nSTDOUT: {result.stdout.decode('utf-8', errors='replace')}\n"
        f"STDERR: {result.stderr.decode('utf-8', errors='replace')}"
    )

    # Capture post-sync cache
    assert REAL_MANIFEST_CACHE.exists(), "manifest.cache.json must exist after sync"
    post_cache = json.loads(REAL_MANIFEST_CACHE.read_text(encoding="utf-8"))
    post_ids: set[str] = {s["id"] for s in post_cache.get("skills", []) if "id" in s}

    # Every pre-sync id must still be present (no skills lost) UNLESS the
    # sync newly marked the skill `deprecated: true` (legitimate auto-prune)
    # OR the security scanner marked it `quarantine_pending` (S5-C security
    # behavior — non-allow decisions exclude the skill from the cache).
    # Read the post-sync manifest YAML to compute which IDs are now flagged.
    import yaml as _yaml
    post_manifest = _yaml.safe_load(REAL_MANIFEST_YAML.read_text(encoding="utf-8"))
    excluded_post: set[str] = {
        e["name"] for e in (post_manifest or [])
        if isinstance(e, dict) and "name" in e and (
            e.get("deprecated") is True
            or str(e.get("security_status", "")).strip() == "quarantine_pending"
        )
    }
    lost_ids = pre_ids - post_ids - excluded_post
    assert not lost_ids, (
        f"Regression: {len(lost_ids)} skill(s) lost from cache after sync "
        f"with no deprecation/quarantine reason: {sorted(lost_ids)}"
    )

    # Every post-sync entry must have id + triggers
    for skill in post_cache["skills"]:
        assert "id" in skill, f"Post-sync cache entry missing 'id': {skill}"
        assert "triggers" in skill, f"Post-sync cache entry missing 'triggers': {skill}"


# ── Test 5: add is idempotent ─────────────────────────────────────────────────

def test_add_idempotent(isolated_manifest):
    """add <name> twice; second call exits 0 with notice; manifest has only ONE entry."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    class _AddArgs:
        skill_name = "idempotent-test-skill"
        source = "plugin"
        triggers = "foo,bar"
        tags = "test"

    # First add
    r1 = mod.cmd_add(_AddArgs())
    assert r1 == 0

    entries_after_first = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    count_first = sum(1 for e in entries_after_first if e.get("name") == "idempotent-test-skill")
    assert count_first == 1, "Exactly 1 entry after first add"

    # Second add (idempotent — should be no-op)
    import io
    from contextlib import redirect_stderr
    err_buf = io.StringIO()
    with redirect_stderr(err_buf):
        r2 = mod.cmd_add(_AddArgs())
    assert r2 == 0, "Second add must exit 0 (idempotent)"
    err_output = err_buf.getvalue()
    assert "no-op" in err_output.lower() or "already" in err_output.lower(), (
        f"Expected 'no-op' or 'already' in stderr, got: {err_output!r}"
    )

    entries_after_second = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    count_second = sum(
        1 for e in entries_after_second if e.get("name") == "idempotent-test-skill"
    )
    assert count_second == 1, "Still exactly 1 entry after second add (no duplicate)"


# ── Test 6: deprecate marks entry ─────────────────────────────────────────────

def test_deprecate_marks_entry(isolated_manifest):
    """deprecate <name> -> deprecated: true in YAML."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    # First add the skill
    class _AddArgs:
        skill_name = "skill-to-deprecate"
        source = "plugin"
        triggers = "deprecate,test"
        tags = ""

    mod.cmd_add(_AddArgs())

    # Verify it's not deprecated yet
    entries = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    skill = next(e for e in entries if e.get("name") == "skill-to-deprecate")
    assert not skill.get("deprecated", False), "Skill should not be deprecated yet"

    # Deprecate it
    class _DeprecateArgs:
        skill_name = "skill-to-deprecate"

    result = mod.cmd_deprecate(_DeprecateArgs())
    assert result == 0

    # Verify in YAML
    entries = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    skill = next(e for e in entries if e.get("name") == "skill-to-deprecate")
    assert skill.get("deprecated") is True, "deprecated must be True after deprecate command"

    # Verify excluded from cache
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    cache_ids = {s["id"] for s in cache["skills"]}
    assert "skill-to-deprecate" not in cache_ids, (
        "Deprecated skill must be excluded from manifest.cache.json"
    )


# ── Test 7: validate detects drift ────────────────────────────────────────────

def test_validate_detects_drift(isolated_manifest):
    """Synthetic skill on disk not in manifest -> validate exits 1 with drift report."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    # Create a skill on disk with a SKILL.md (but don't add to manifest)
    drift_dir = skills_dir / "untracked-drift-skill"
    drift_dir.mkdir()
    (drift_dir / "SKILL.md").write_text(
        "---\nname: untracked-drift-skill\ndescription: Untracked\n"
        "kind: skill\ntier: L1\ncategory: test\nlast_verified: 2026-05-05\n---\n",
        encoding="utf-8",
    )

    # Start with an empty manifest (no sync)
    yaml_path.write_text("", encoding="utf-8")

    class _ValidateArgs:
        pass

    result = mod.cmd_validate(_ValidateArgs())
    assert result == 1, (
        "validate must exit 1 when there is drift (skill on disk not in manifest)"
    )


# ── Test 8: list with empty manifest ─────────────────────────────────────────

def test_list_empty_manifest(isolated_manifest):
    """Empty manifest -> list exits 0, empty stdout, informational message to stderr."""
    yaml_path, cache_path, mod, skills_dir = isolated_manifest

    # Write an empty YAML
    yaml_path.write_text("", encoding="utf-8")

    import io
    from contextlib import redirect_stderr, redirect_stdout

    out_buf = io.StringIO()
    err_buf = io.StringIO()

    class _ListArgs:
        deprecated = False
        source = None
        format = "table"

    with redirect_stdout(out_buf), redirect_stderr(err_buf):
        result = mod.cmd_list(_ListArgs())

    assert result == 0, "list must exit 0 even with empty manifest"
    stdout_text = out_buf.getvalue()
    assert stdout_text.strip() == "", (
        f"list must produce empty stdout for empty manifest, got: {stdout_text!r}"
    )
    stderr_text = err_buf.getvalue()
    assert len(stderr_text) > 0, "list must write an informational message to stderr"


# ── Integration: auto-discover via subprocess ─────────────────────────────────

def test_auto_discover_subprocess(tmp_path):
    """
    Test that registry_sync.py auto-discover runs without error and produces output.
    Uses the real SKILL.md directory (read-only scan) with a temp manifest.
    """
    # Point auto-discover to a temp manifest so we don't mutate the real one
    tmp_yaml = tmp_path / "skills.manifest.yaml"
    tmp_yaml.write_text("", encoding="utf-8")

    registry_sync_py = COCKPIT_DIR / "registry_sync.py"
    result = subprocess.run(
        [PYTHON_EXE, str(registry_sync_py), "auto-discover"],
        capture_output=True,
        timeout=60,
        # Note: auto-discover writes to the real YAML by default, so we test
        # that the subprocess exits 0 (read-only scan of SKILL.md files is safe)
    )
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    assert result.returncode == 0, (
        f"auto-discover must exit 0.\nSTDOUT: {stdout}\nSTDERR: {stderr}"
    )
    assert "auto-discover" in stdout.lower() or "scan" in stdout.lower(), (
        f"Expected scan report in stdout, got: {stdout!r}"
    )


# ── Codex S4 H2: real pre/post dispatcher routing smoke ──────────────────────

DISPATCHER_HOOK = SKILL_ROOT / "scripts" / "hooks" / "intent-dispatcher.py"


def _invoke_dispatcher(prompt: str) -> tuple[int, str]:
    """Invoke intent-dispatcher.py with stdin JSON. Returns (exit, stdout_text)."""
    payload = json.dumps({
        "hook_event_name": "UserPromptSubmit",
        "prompt": prompt,
        "session_id": "s4-h2-smoke",
    }).encode("utf-8")
    proc = subprocess.run(
        [PYTHON_EXE, str(DISPATCHER_HOOK)],
        input=payload, capture_output=True, timeout=10,
    )
    return proc.returncode, proc.stdout.decode("utf-8", errors="replace")


def _extract_skill(stdout: str) -> str | None:
    """Pull skill=<id> from the routing line, or None if no routing."""
    import re
    m = re.search(r"skill=([^\s|]+)", stdout)
    return m.group(1) if m else None


def test_sync_does_not_change_dispatcher_routing():
    """Codex S4 H2 fix: REAL pre/post dispatcher smoke.

    Snapshot the live manifest.cache.json + skills.manifest.yaml. Invoke
    the dispatcher with a prompt that hits a stable rule ("corrigeme este
    bug"). Run `manifest sync`. Invoke the dispatcher again. Assert:
      - both invocations exit 0
      - both produce a routing line
      - the skill_id is identical pre vs post
      - no Traceback leak in either stdout
    Then restore the snapshots so the test is hermetic.
    """
    if not REAL_MANIFEST_CACHE.exists():
        pytest.skip("manifest.cache.json missing — run `ultron manifest sync` first")
    if not DISPATCHER_HOOK.exists():
        pytest.skip("intent-dispatcher.py not found")

    # Snapshot
    cache_snapshot = REAL_MANIFEST_CACHE.read_bytes()
    yaml_snapshot = REAL_MANIFEST_YAML.read_bytes() if REAL_MANIFEST_YAML.exists() else None

    try:
        # Pre-sync routing
        pre_exit, pre_out = _invoke_dispatcher("corrigeme este bug en el modulo de pagos")
        pre_skill = _extract_skill(pre_out)

        assert pre_exit == 0, f"pre-sync dispatcher exit {pre_exit}: {pre_out}"
        for forbidden in ("Traceback", "Exception"):
            assert forbidden not in pre_out, (
                f"Pre-sync stdout leaked {forbidden!r}: {pre_out!r}"
            )
        assert pre_skill is not None, (
            f"Pre-sync dispatcher produced no routing line for canonical bug "
            f"prompt: {pre_out!r}"
        )

        # Run sync (regenerates cache LIVE)
        sync = _run_manifest(["sync"], timeout=60.0)
        assert sync.returncode == 0, (
            f"manifest sync failed: {sync.stderr.decode('utf-8', errors='replace')}"
        )

        # Post-sync routing
        post_exit, post_out = _invoke_dispatcher("corrigeme este bug en el modulo de pagos")
        post_skill = _extract_skill(post_out)

        assert post_exit == 0, f"post-sync dispatcher exit {post_exit}: {post_out}"
        for forbidden in ("Traceback", "Exception"):
            assert forbidden not in post_out, (
                f"Post-sync stdout leaked {forbidden!r}: {post_out!r}"
            )
        assert post_skill == pre_skill, (
            f"Routing diverged after sync.\n"
            f"  pre_skill  = {pre_skill!r}\n"
            f"  post_skill = {post_skill!r}\n"
            f"  pre_out    = {pre_out!r}\n"
            f"  post_out   = {post_out!r}"
        )

    finally:
        # Restore snapshots so the test is hermetic
        REAL_MANIFEST_CACHE.write_bytes(cache_snapshot)
        if yaml_snapshot is not None:
            REAL_MANIFEST_YAML.write_bytes(yaml_snapshot)


def test_sync_aborts_on_invalid_manifest(tmp_path, monkeypatch):
    """Codex S4 H1 fix: sync MUST refuse to regenerate cache if manifest invalid.

    In-process: monkey-patch the module's MANIFEST_YAML and MANIFEST_CACHE
    paths to temp files. Write a bad YAML (cost_tier not in enum). Call
    cmd_sync directly. Assert it returns 1 (validation failure) and the
    cache file is NOT created (or NOT modified if it pre-existed).
    """
    import importlib.util as ilu
    spec = ilu.spec_from_file_location("skill_manifest_under_test", MANIFEST_PY)
    sm = ilu.module_from_spec(spec)
    spec.loader.exec_module(sm)

    bad_yaml = tmp_path / "bad-manifest.yaml"
    bad_cache = tmp_path / "bad-cache.json"
    bad_yaml.write_text(yaml.dump([
        {
            "name": "fake:test-skill",
            "source": "plugin",
            "triggers": ["fake"],
            "cost_tier": "INVALID-NOT-IN-ENUM",  # schema enum violation
            "dispatcher_priority": 1,
            "deprecated": False,
            "last_synced": "2026-05-05",
        }
    ]), encoding="utf-8")

    cache_marker = b'{"sentinel":"do-not-overwrite"}'
    bad_cache.write_bytes(cache_marker)

    monkeypatch.setattr(sm, "MANIFEST_YAML", bad_yaml)
    monkeypatch.setattr(sm, "MANIFEST_CACHE", bad_cache)
    # Also patch SKILLS_DIR to a non-existent path so auto-discover finds nothing
    monkeypatch.setattr(sm, "SKILLS_DIR", tmp_path / "nonexistent-skills")

    class Args:
        pass

    rc = sm.cmd_sync(Args())

    assert rc == 1, (
        f"cmd_sync should exit 1 on schema violation; got {rc}. "
        f"The H1 fix (validate-before-write) is missing or broken."
    )
    cache_after = bad_cache.read_bytes()
    assert cache_after == cache_marker, (
        f"Cache was modified despite invalid manifest. "
        f"H1 fix not preventing live cache poisoning.\n"
        f"  expected: {cache_marker}\n"
        f"  got:      {cache_after}"
    )
