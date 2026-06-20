"""Pytest suite for the --history mode of audit_personal_data.py.

The HEAD scan (`git ls-files`) cannot see a file that was scrubbed from the
working tree but still lives in an older commit — yet anyone who clones the repo
can recover it with `git show <old-sha>`. The --history scan walks every blob
reachable from any ref (`git rev-list --all` + `git cat-file --batch`) so the
pre-transfer gate catches that leak.

These tests build a throwaway git repo where PII exists in commit 1 and is
deleted in commit 2 (clean HEAD), then assert:
  1. scan() (HEAD) does NOT flag the scrubbed file — the negative case.
  2. scan_history() DOES flag it, with a "path@sha" label.

This also exercises the cat-file --batch byte-offset parser (the part most
likely to desync) against real git output.

NOTE: the personal token is assembled at runtime (never written literally in
this source) so the HEAD PII gate that scans this very file stays green.
"""
from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "cockpit" / "audit_personal_data.py"

# Assembled at import time, kept out of the source as a literal — see module note.
_NAME = "Rod" + "rigo"
_LEAK_LINE = f"home path C:/Users/{_NAME}/secreto.txt\n"


def _load_module():
    spec = importlib.util.spec_from_file_location("audit_personal_data", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


@pytest.fixture
def scrubbed_pii_repo(tmp_path: Path) -> Path:
    """A git repo with a personal path committed then deleted (HEAD is clean)."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "tester")
    _git(repo, "config", "commit.gpgsign", "false")

    leak = repo / "secret.txt"
    leak.write_text(_LEAK_LINE, encoding="utf-8")
    _git(repo, "add", "secret.txt")
    _git(repo, "commit", "-q", "-m", "add secret")

    # Scrub from HEAD: the blob stays reachable through commit 1.
    leak.unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "scrub secret")
    return repo


def test_head_scan_misses_scrubbed_pii(scrubbed_pii_repo: Path, monkeypatch):
    """Negative case: the HEAD scan must NOT flag a file already deleted."""
    mod = _load_module()
    monkeypatch.setattr(mod, "REPO_ROOT", scrubbed_pii_repo)

    findings = mod.scan()
    assert not findings.get("HIGH"), "HEAD scan should not see scrubbed PII"


def test_history_scan_catches_scrubbed_pii(scrubbed_pii_repo: Path, monkeypatch):
    """Positive case: the history scan finds PII still reachable from any ref."""
    mod = _load_module()
    monkeypatch.setattr(mod, "REPO_ROOT", scrubbed_pii_repo)

    findings = mod.scan_history()
    highs = findings.get("HIGH", [])
    assert highs, "history scan must find the scrubbed personal path"

    patterns = {pat for _label, _ln, pat, _snip in highs}
    assert "personal-home-win" in patterns

    labels = {label for label, _ln, _pat, _snip in highs}
    assert any(lbl.startswith("secret.txt@") for lbl in labels), (
        f"label should be path@sha, got: {labels}"
    )


def test_batch_parser_survives_missing_object(scrubbed_pii_repo: Path, monkeypatch):
    """read_blobs_batch must not desync on a non-existent sha (missing line)."""
    mod = _load_module()
    monkeypatch.setattr(mod, "REPO_ROOT", scrubbed_pii_repo)

    blobs = mod.history_blobs()
    assert blobs, "expected at least one blob in history"

    shas = list(blobs.keys()) + ["0" * 40]  # append a deliberately missing object
    contents = mod.read_blobs_batch(shas)
    # The real blobs decode fine; the missing one is simply absent (no crash).
    assert any("secreto.txt" in text for text in contents.values())
    assert ("0" * 40) not in contents
