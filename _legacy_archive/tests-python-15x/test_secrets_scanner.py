"""Tests for ULTRON v14 S5-C — secrets_scanner."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

import secrets_scanner as ss  # noqa: E402


def _scan(tmp_path: Path, content: str, name: str = "f.json") -> list:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return ss.scan_paths([p])


def test_secrets_scanner_catches_openai_key(tmp_path):
    findings = _scan(tmp_path, '{"key": "sk-' + "A" * 30 + '"}')
    assert any(f.label == "openai_key" for f in findings)


def test_secrets_scanner_catches_anthropic_key(tmp_path):
    findings = _scan(tmp_path,
                     '{"k": "sk-ant-' + "x" * 30 + '"}')
    assert any(f.label == "anthropic_key" for f in findings)


def test_secrets_scanner_catches_google_api_key(tmp_path):
    findings = _scan(tmp_path,
                     '{"google_api_key": "AIza' + "X" * 35 + '"}')
    assert any(f.label == "google_api_key" for f in findings)


def test_secrets_scanner_catches_github_token(tmp_path):
    findings = _scan(tmp_path,
                     '{"t": "ghp_' + "Y" * 36 + '"}')
    assert any(f.label == "github_token" for f in findings)


def test_secrets_scanner_catches_slack_token(tmp_path):
    findings = _scan(tmp_path,
                     '{"t": "xoxb-' + "1" * 12 + '-abcdef"}')
    assert any(f.label == "slack_token" for f in findings)


def test_secrets_scanner_catches_aws_access_key(tmp_path):
    findings = _scan(tmp_path,
                     '{"aws": "AKIA' + "ABCDEFGHIJKLMNOP" + '"}')
    assert any(f.label == "aws_access_key" for f in findings)


def test_secrets_scanner_skips_env_placeholder(tmp_path):
    findings = _scan(tmp_path, '{"GEMINI_API_KEY": "${GEMINI_API_KEY}"}')
    assert findings == []


def test_secrets_scanner_skips_sha_reference(tmp_path):
    findings = _scan(tmp_path, '{"hash": "sha1:' + "a" * 40 + '"}')
    assert findings == []


def test_secrets_scanner_excerpt_does_not_leak_full_secret(tmp_path):
    findings = _scan(tmp_path, '{"k": "sk-' + "Z" * 40 + '"}')
    assert findings
    assert "Z" * 30 not in findings[0].excerpt
    assert "***" in findings[0].excerpt


def test_secrets_scanner_high_entropy_value(tmp_path):
    # A clearly high-entropy random-ish value next to a *_secret key.
    val = "s7Kj9$Lq2mNp3zXq8bRtWvY1cDfH4iJ5kLm6nOpQ"
    findings = _scan(tmp_path, f'{{"my_secret": "{val}"}}')
    # Must catch via S007 high-entropy heuristic
    assert any(f.rule_id == "S007" for f in findings)


def test_scan_directory_recurses(tmp_path):
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "leak.json").write_text(
        '{"k": "sk-' + "M" * 30 + '"}', encoding="utf-8"
    )
    findings = ss.scan_paths([tmp_path])
    assert any(f.label == "openai_key" for f in findings)


def test_skips_provenance_file_by_design(tmp_path):
    # provenance/integrity files contain sha1s by design — must not be flagged.
    fake = tmp_path / "skill-provenance.json"
    fake.write_text('{"k": "sk-' + "M" * 30 + '"}', encoding="utf-8")
    findings = ss.scan_paths([tmp_path])
    assert findings == []
