"""Tests for hooks/auto-approve-readonly.py v2.0.

Three groups:
- BENIGN_AUTO_APPROVED: read-only ops that should be silently allowed.
- DENY_PATHS: sensitive paths that must abstain (fall to user prompt).
- WEBFETCH_DENIED: hosts that must be hard-denied (metadata IPs, localhost).
- WEBFETCH_ABSTAIN: hosts NOT in allowlist (should fall to user prompt).
- WEBFETCH_ALLOWED: hosts in allowlist (auto-approved).
"""
from __future__ import annotations

import pytest


BENIGN_AUTO_APPROVED = [
    ("Read",   {"file_path": "/tmp/ultron-test/.ultron/INDEX.md"}),
    ("Read",   {"file_path": "C:/projects/app/README.md"}),
    ("Glob",   {"pattern": "**/*.py"}),
    ("Glob",   {"pattern": "src/**/*.ts"}),
    ("Grep",   {"pattern": "TODO", "path": "src/"}),
    ("Grep",   {"pattern": "import", "path": "C:/projects/app/"}),
    ("WebSearch", {"query": "python asyncio best practices"}),
]


SENSITIVE_PATHS_ABSTAIN = [
    # SSH/cloud creds dirs
    "/tmp/ultron-test/.ssh/id_rsa",
    "/tmp/ultron-test/.ssh/known_hosts",
    "/tmp/ultron-test/.aws/credentials",
    "/tmp/ultron-test/.aws/config",
    "/tmp/ultron-test/.gcp/credentials.json",
    "/tmp/ultron-test/.kube/config",
    # ULTRON-specific token caches
    "/tmp/ultron-test/.codex/auth.json",
    "/tmp/ultron-test/.gemini/oauth_creds.json",
    "/tmp/ultron-test/.claude/.credentials.json",
    "/tmp/ultron-test/.claude/history.jsonl",
    # tmp drive sync (can carry stale secrets)
    "/tmp/ultron-test/.ultron/.tmp.driveupload/somefile",
    "/tmp/ultron-test/.claude/.tmp.drivedownload/somefile",
    # pattern-based
    "C:/projects/app/.env",
    "C:/projects/app/.env.local",
    "C:/projects/app/credentials.json",
    "C:/projects/app/auth-token.txt",
    "C:/projects/app/api-secret.yaml",
    "C:/projects/app/private-key.pem",
    "C:/Users/foo/.ssh/id_rsa",
    "C:/Users/foo/.ssh/id_ed25519",
]


WEBFETCH_DENIED = [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata.azure.com/metadata/instance",
    "http://localhost:8080/admin",
    "http://127.0.0.1/api",
    "http://0.0.0.0:9999/x",
    "http://[::1]/internal",
]


WEBFETCH_ALLOWED = [
    "https://anthropic.com/docs",
    "https://docs.anthropic.com/api",
    "https://github.com/anthropics/claude",
    "https://raw.githubusercontent.com/foo/bar/main/README.md",
    "https://docs.python.org/3/library/asyncio.html",
    "https://stackoverflow.com/questions/12345",
    "https://developer.mozilla.org/en-US/docs/Web/API",
    "https://pypi.org/project/anthropic/",
    "https://docs.unrealengine.com/5.0/en-US/",
    "https://platform.openai.com/docs",
]


WEBFETCH_ABSTAIN = [
    # Not in allowlist nor denylist — should abstain (user prompt)
    "https://crates.io/crates/serde",       # Rust ecosystem missing from allowlist
    "https://learn.microsoft.com/en-us/",   # Microsoft docs
    "https://huggingface.co/models",        # HF
    "https://example.com/foo",
    "https://random-blog.dev/post",
]


# ───── Tests ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("tool,tool_input",
                          BENIGN_AUTO_APPROVED,
                          ids=[f"{t}-{str(i)[:30]}" for t, i in BENIGN_AUTO_APPROVED])
def test_benign_readonly_allowed(auto_approve, tool, tool_input):
    """Read/Glob/Grep/WebSearch on safe inputs must be auto-approved."""
    decision = auto_approve(tool, tool_input)
    assert decision == "allow", (
        f"{tool} on {tool_input} should be auto-approved, got '{decision}'"
    )


@pytest.mark.parametrize("path",
                          SENSITIVE_PATHS_ABSTAIN,
                          ids=[p.split("/")[-1] for p in SENSITIVE_PATHS_ABSTAIN])
def test_sensitive_path_abstains(auto_approve, path):
    """Read on sensitive paths must abstain (fall to user prompt) — not allow."""
    decision = auto_approve("Read", {"file_path": path})
    assert decision == "abstain", (
        f"Read on sensitive path {path} should abstain, got '{decision}'"
    )


@pytest.mark.parametrize("url",
                          WEBFETCH_DENIED,
                          ids=[u[:40] for u in WEBFETCH_DENIED])
def test_webfetch_metadata_denied(auto_approve, url):
    """WebFetch to metadata IPs / localhost must be hard-denied."""
    decision = auto_approve("WebFetch", {"url": url})
    assert decision == "deny", (
        f"WebFetch to {url} should be denied, got '{decision}'"
    )


@pytest.mark.parametrize("url",
                          WEBFETCH_ALLOWED,
                          ids=[u[:40] for u in WEBFETCH_ALLOWED])
def test_webfetch_allowlist_approved(auto_approve, url):
    """WebFetch to allowlist hosts must be auto-approved."""
    decision = auto_approve("WebFetch", {"url": url})
    assert decision == "allow", (
        f"WebFetch to {url} should be allowed, got '{decision}'"
    )


@pytest.mark.parametrize("url",
                          WEBFETCH_ABSTAIN,
                          ids=[u[:40] for u in WEBFETCH_ABSTAIN])
def test_webfetch_unknown_abstains(auto_approve, url):
    """WebFetch to unknown hosts must abstain (user prompt)."""
    decision = auto_approve("WebFetch", {"url": url})
    assert decision == "abstain", (
        f"WebFetch to unknown host {url} should abstain, got '{decision}'"
    )
