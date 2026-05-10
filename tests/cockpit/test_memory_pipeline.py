"""
Tests for the critical memory pipeline scripts.
These are smoke/import tests — no vault or API calls required.
They catch syntax errors, missing imports, and broken CLI interfaces
before the scripts reach the Stop hook in production.
"""
from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

COCKPIT = Path(__file__).parent.parent.parent / "scripts" / "cockpit"
HOOKS_DIR = Path(__file__).parent.parent.parent / "scripts" / "hooks"

PIPELINE_SCRIPTS = [
    "memory_sync.py",
    "brain_index.py",
    "session_compactor.py",
    "decay_queue.py",
    "registry_sync.py",
    "news_html_generator.py",
    "research_premium.py",
    "memory_bridge.py",
    "skill_manifest.py",
    "vault_migrator.py",
]

HOOK_SCRIPTS = [
    "mode-trigger.py",
    "auto-approve-readonly.py",
    "block-dangerous-bash.py",
    "routing-telemetry.py",
    "session-log.py",
]


# ── Syntax checks ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("script_name", PIPELINE_SCRIPTS)
def test_pipeline_script_syntax(script_name: str) -> None:
    path = COCKPIT / script_name
    assert path.exists(), f"{script_name} not found at {path}"
    source = path.read_bytes().decode("utf-8")
    ast.parse(source)  # raises SyntaxError if broken


@pytest.mark.parametrize("hook_name", HOOK_SCRIPTS)
def test_hook_script_syntax(hook_name: str) -> None:
    path = HOOKS_DIR / hook_name
    assert path.exists(), f"Hook {hook_name} not found at {path}"
    source = path.read_bytes().decode("utf-8")
    ast.parse(source)


# ── UTF-8 encoding checks ──────────────────────────────────────────────────────

@pytest.mark.parametrize("script_name", PIPELINE_SCRIPTS + HOOK_SCRIPTS)
def test_script_utf8_valid(script_name: str) -> None:
    base = COCKPIT if script_name.endswith(".py") and not script_name.startswith("mode-") else HOOKS_DIR
    # Resolve correct dir
    if (COCKPIT / script_name).exists():
        path = COCKPIT / script_name
    else:
        path = HOOKS_DIR / script_name
    raw = path.read_bytes()
    raw.decode("utf-8")  # raises UnicodeDecodeError if broken


# ── CLI interface checks ───────────────────────────────────────────────────────

def _run(script: Path, *args: str) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(script), *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=10)


def test_memory_sync_help() -> None:
    r = _run(COCKPIT / "memory_sync.py", "--help")
    assert r.returncode == 0
    assert "status" in r.stdout or "usage" in r.stdout.lower()


def test_brain_index_help() -> None:
    r = _run(COCKPIT / "brain_index.py", "--help")
    assert r.returncode == 0
    assert "build" in r.stdout or "query" in r.stdout


def test_registry_sync_help() -> None:
    r = _run(COCKPIT / "registry_sync.py", "--help")
    assert r.returncode == 0
    assert "status" in r.stdout
    assert "propagate" in r.stdout


def test_registry_sync_aliases_expand() -> None:
    """Aliases must expand before argparse — not produce 'invalid choice' errors."""
    r = _run(COCKPIT / "registry_sync.py", "s")  # s → status
    # Should run (even if vault dirs don't exist) — not raise argparse error
    assert "invalid choice" not in r.stderr
    assert "unrecognized arguments" not in r.stderr


def test_news_html_generator_help() -> None:
    r = _run(COCKPIT / "news_html_generator.py", "--help")
    assert r.returncode == 0
    assert "--model" in r.stdout


def test_session_compactor_help() -> None:
    r = _run(COCKPIT / "session_compactor.py", "--help")
    assert r.returncode == 0


def test_memory_bridge_help() -> None:
    r = _run(COCKPIT / "memory_bridge.py", "--help")
    assert r.returncode == 0
    assert "ingest" in r.stdout
    assert "repair-wikilinks" in r.stdout


def test_memory_bridge_status_no_crash() -> None:
    r = _run(COCKPIT / "memory_bridge.py", "status")
    assert r.returncode == 0
    assert "Traceback" not in r.stderr


def test_skill_manifest_help() -> None:
    r = _run(COCKPIT / "skill_manifest.py", "--help")
    assert r.returncode == 0
    assert "rebuild" in r.stdout
    assert "sync-prompt" in r.stdout


def test_skill_manifest_rebuild_no_crash() -> None:
    r = _run(COCKPIT / "skill_manifest.py", "rebuild")
    assert r.returncode == 0
    assert "Traceback" not in r.stderr
    assert any(kw in r.stdout for kw in ("Rebuilt", "manifest sync", "Total entries"))


def test_vault_migrator_help() -> None:
    r = _run(COCKPIT / "vault_migrator.py", "--help")
    assert r.returncode == 0
    assert "migrate" in r.stdout
    assert "audit" in r.stdout


def test_vault_migrator_audit_no_crash() -> None:
    r = _run(COCKPIT / "vault_migrator.py", "audit")
    assert r.returncode == 0
    assert "Traceback" not in r.stderr


# ── mode-trigger hook — unit logic ────────────────────────────────────────────

def test_mode_trigger_imports_cleanly() -> None:
    """Import the hook module without side effects."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "mode_trigger", HOOKS_DIR / "mode-trigger.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert hasattr(mod, "_detect_mode")


def test_mode_trigger_detects_slash_high() -> None:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "mode_trigger", HOOKS_DIR / "mode-trigger.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert mod._detect_mode("Ultron /high resuelve este bug") == "HIGH"
    assert mod._detect_mode("Ultron /ultra arquitectura") == "ULTRA"
    assert mod._detect_mode("Ultron /learn analiza esto") == "LEARN"
    assert mod._detect_mode("/HIGH fix bug") == "HIGH"  # case-insensitive
    assert mod._detect_mode("fix this normal bug") is None
    assert mod._detect_mode("guarda en memoria que X") == "HIGH"  # auto-HIGH
    assert mod._detect_mode("recuerda que el vault es en ~/.ultron-vault") == "HIGH"
