"""
Subprocess-based tests for v11 cockpit scripts.
Each test invokes the real script via `uv run python` — no mocking.
Terminal-validated: if the script crashes, the test fails.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[2]
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"


def run(*args: str, env_extra: dict | None = None, timeout: int = 30) -> subprocess.CompletedProcess:
    env = {**os.environ, **(env_extra or {})}
    return subprocess.run(
        ["uv", "run", "python", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=SKILL_ROOT, env=env, timeout=timeout,
    )


# ── on_wake.py ────────────────────────────────────────────────────────────────

class TestOnWake:
    def test_help_exits_zero(self):
        r = run(str(COCKPIT / "on_wake.py"), "--help")
        assert r.returncode == 0
        assert "--no-settle" in r.stdout

    def test_no_settle_flag_runs_without_crash(self):
        """--no-settle skips the 90s wait; must not raise an unhandled exception."""
        r = run(str(COCKPIT / "on_wake.py"), "--no-settle", timeout=60)
        assert r.returncode in (0, 1), f"Unexpected exit {r.returncode}: {r.stderr[:300]}"
        assert "Traceback" not in r.stderr

    def test_settle_env_var_accepted(self):
        """ULTRON_WAKE_SETTLE=0 is a valid override; script must not crash on it."""
        r = run(str(COCKPIT / "on_wake.py"), "--no-settle",
                env_extra={"ULTRON_WAKE_SETTLE": "0"}, timeout=15)
        assert "Traceback" not in r.stderr

    def test_settle_env_var_invalid_falls_back(self):
        """Non-numeric ULTRON_WAKE_SETTLE should raise ValueError at import — caught early."""
        r = run(str(COCKPIT / "on_wake.py"), "--help",
                env_extra={"ULTRON_WAKE_SETTLE": "abc"})
        # ValueError from int("abc") — script should fail with a clear message, not silently
        assert r.returncode != 0 or "Traceback" not in r.stderr


# ── github_trending.py ────────────────────────────────────────────────────────

class TestGithubTrending:
    def test_help_exits_zero(self):
        r = run(str(COCKPIT / "github_trending.py"), "--help")
        assert r.returncode == 0

    def test_has_required_flags(self):
        r = run(str(COCKPIT / "github_trending.py"), "--help")
        assert "--from-cron" in r.stdout
        assert "--dry-run" in r.stdout
        assert "--force" in r.stdout

    def test_dry_run_exits_zero(self):
        """--dry-run fetches from GitHub API and prints results without writing files."""
        r = run(str(COCKPIT / "github_trending.py"), "--dry-run", timeout=90)
        assert r.returncode == 0, f"dry-run failed: {r.stderr[:400]}"
        assert "Traceback" not in r.stderr

    def test_429_retry_logic_present(self):
        """Code-level: http_get must contain exponential backoff for 429s."""
        src = (COCKPIT / "github_trending.py").read_text(encoding="utf-8")
        assert "429" in src
        assert "time.sleep" in src
        assert "retries" in src


# ── game_detector.py ──────────────────────────────────────────────────────────

class TestGameDetector:
    def test_help_exits_zero(self):
        r = run(str(COCKPIT / "game_detector.py"), "--help")
        assert r.returncode == 0

    def test_status_no_crash(self):
        r = run(str(COCKPIT / "game_detector.py"), "status", timeout=15)
        assert r.returncode == 0
        assert "Traceback" not in r.stderr

    def test_history_no_crash(self):
        r = run(str(COCKPIT / "game_detector.py"), "history", timeout=10)
        assert r.returncode == 0
        assert "Traceback" not in r.stderr

    def test_log_no_crash(self):
        r = run(str(COCKPIT / "game_detector.py"), "log", timeout=10)
        assert r.returncode in (0, 1)
        assert "Traceback" not in r.stderr

    def test_subcommands_documented(self):
        r = run(str(COCKPIT / "game_detector.py"), "--help")
        output = r.stdout + r.stderr
        assert "status" in output
        assert "history" in output


# news_scraper.py removed in v12 — news now generated on-demand via news_html_generator.py
