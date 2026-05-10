"""
Tests for ULTRON S2-C — MMFP Bootstrap.

Run from the ultron skill root:
    uv run pytest tests/test_multimodel.py -v

Tests marked @pytest.mark.slow invoke shared-duet.ps1 (actual Codex call).
Skip them with:
    ULTRON_FAST_TESTS=1 uv run pytest tests/test_multimodel.py -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SKILL_ROOT  = Path(__file__).parents[1]
SCRIPTS_DIR = SKILL_ROOT / "scripts"
COCKPIT_DIR = SCRIPTS_DIR / "cockpit"
MULTIMODEL_PY = COCKPIT_DIR / "multimodel.py"
SHARED_DUET   = SCRIPTS_DIR / "shared-duet.ps1"

MMFP_ROOT  = Path.home() / ".ultron" / "multimodel"
REQUESTS   = MMFP_ROOT / "requests"
RESPONSES  = MMFP_ROOT / "responses"
CONSENSUS  = MMFP_ROOT / "consensus"
ARCHIVE    = MMFP_ROOT / "archive"

VENV_PYTHON = SKILL_ROOT / ".venv" / "Scripts" / "python.exe"
PYTHON_EXE  = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable

CREATE_NO_WINDOW = 0x08000000

# Skip slow tests if ULTRON_FAST_TESTS=1
FAST_TESTS = os.environ.get("ULTRON_FAST_TESTS", "0").strip() == "1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_py(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    """Invoke multimodel.py via the venv Python."""
    return subprocess.run(
        [PYTHON_EXE, str(MULTIMODEL_PY)] + list(args),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW,
        timeout=timeout,
    )


def _run_ps(*args: str, timeout: float = 120.0) -> subprocess.CompletedProcess:
    """Invoke shared-duet.ps1 via PowerShell."""
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", str(SHARED_DUET),
    ] + list(args)
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW,
        timeout=timeout,
    )


def _ensure_dirs() -> None:
    for d in (REQUESTS, RESPONSES, CONSENSUS, ARCHIVE):
        d.mkdir(parents=True, exist_ok=True)


def _fake_request(req_id: str, created_at: datetime | None = None) -> Path:
    """Write a fake YAML request file and return its path."""
    _ensure_dirs()
    if created_at is None:
        created_at = datetime.now(tz=timezone.utc)
    ts = created_at.strftime("%Y-%m-%dT%H:%M:%SZ")
    path = REQUESTS / f"{req_id}.yaml"
    path.write_text(
        f'id: "{req_id}"\n'
        f'created_at: "{ts}"\n'
        'peers: "codex"\n'
        'mode: "Mini"\n'
        'rounds: 1\n'
        'prompt: "fake test prompt for MMFP unit tests"\n'
        'prompt_file: null\n'
        'codex_model: "gpt-5.5"\n'
        'gemini_model: "pro"\n'
        'timeout_sec: 60\n'
        'session_ids:\n'
        '  codex: ""\n'
        '  gemini: ""\n'
        'tags: []\n'
        'metadata:\n'
        '  source: "test"\n'
        '  priority: "normal"\n'
        '  session_id: ""\n',
        encoding="utf-8",
    )
    return path


def _fake_response(req_id: str) -> Path:
    """Write a fake JSON response file and return its path."""
    _ensure_dirs()
    path = RESPONSES / f"{req_id}.json"
    path.write_text(
        json.dumps({
            "round": 1,
            "mode": "Mini",
            "peers": "codex",
            "elapsed_s": 5.0,
            "codex": {"verdict": "GREEN", "rationale": "looks good"},
            "gemini": None,
            "session_ids": {"codex": "test-sid-123", "gemini": None},
        }, indent=2),
        encoding="utf-8",
    )
    return path


# ---------------------------------------------------------------------------
# Test 1: -Async writes request YAML
# ---------------------------------------------------------------------------

class TestAsyncWritesYaml:
    """Test 1: invoke shared-duet.ps1 with -Async, assert YAML file created."""

    def test_async_writes_request_yaml(self):
        """shared-duet.ps1 -Async must write a YAML file with valid schema fields."""
        _ensure_dirs()

        result = _run_ps(
            "-Peers", "codex",
            "-Mode", "Mini",
            "-Round", "1",
            "-Prompt", "async test: write yaml file",
            "-CodexModel", "gpt-5.5",
            "-TimeoutSec", "60",
            "-Async",
            timeout=30.0,
        )

        assert result.returncode == 0, (
            f"shared-duet.ps1 -Async exited {result.returncode}.\n"
            f"stderr: {result.stderr[:300]}"
        )

        stdout = result.stdout.strip()
        # Find JSON in stdout (may have [SharedDuet] info lines before it)
        json_line = None
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("{") and '"async"' in line:
                json_line = line
                break

        assert json_line is not None, (
            f"Expected JSON with 'async' in stdout, got:\n{stdout}"
        )

        data = json.loads(json_line)
        assert data.get("async") is True, f"Expected async=true, got: {data}"
        req_id   = data.get("request_id", "")
        req_path = data.get("request_path", "")

        assert req_id.startswith("req-"), f"Expected req_id to start with 'req-', got: {req_id}"
        assert req_path, "Expected non-empty request_path"

        # Verify the file exists
        yaml_path = Path(req_path)
        assert yaml_path.exists(), f"YAML file not found: {yaml_path}"
        assert yaml_path.stat().st_size > 0, "YAML file is empty"

        # Verify required schema fields
        content = yaml_path.read_text(encoding="utf-8")
        for field in ("id:", "created_at:", "peers:", "mode:", "rounds:", "prompt:"):
            assert field in content, f"Missing field '{field}' in YAML:\n{content[:500]}"

        # Cleanup
        try:
            yaml_path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Test 2: -Async returns request_id in JSON
# ---------------------------------------------------------------------------

class TestAsyncReturnsRequestId:
    """Test 2: stdout JSON has async:true and request_id."""

    def test_async_returns_request_id(self):
        """shared-duet.ps1 -Async stdout must include async=true and request_id."""
        _ensure_dirs()

        result = _run_ps(
            "-Peers", "codex",
            "-Mode", "Mini",
            "-Round", "1",
            "-Prompt", "return request id test",
            "-Async",
            timeout=30.0,
        )

        assert result.returncode == 0, (
            f"Exit {result.returncode}. stderr: {result.stderr[:200]}"
        )

        stdout = result.stdout
        # Find the JSON line
        json_obj = None
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    json_obj = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue

        assert json_obj is not None, f"No JSON found in stdout:\n{stdout}"
        assert json_obj.get("async") is True, f"async != true: {json_obj}"
        req_id = json_obj.get("request_id", "")
        assert req_id.startswith("req-"), f"request_id format wrong: {req_id}"

        # Cleanup
        req_path = json_obj.get("request_path", "")
        if req_path:
            try:
                Path(req_path).unlink(missing_ok=True)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Test 3: list --pending shows 2 fake requests
# ---------------------------------------------------------------------------

class TestListPending:
    """Test 3: write 2 fake YAML requests, list should show both as pending."""

    def test_list_pending(self):
        """multimodel list shows pending requests (no response files present)."""
        _ensure_dirs()

        # Create 2 fake requests without responses
        ids = [
            "req-test-list-00000001-aaaaaaaa",
            "req-test-list-00000002-bbbbbbbb",
        ]
        paths = [_fake_request(req_id) for req_id in ids]

        try:
            result = _run_py("list", timeout=15.0)
            assert result.returncode == 0, (
                f"multimodel list exited {result.returncode}. stderr: {result.stderr[:200]}"
            )
            stdout = result.stdout
            for req_id in ids:
                assert req_id in stdout, (
                    f"Expected {req_id} in list output, got:\n{stdout}"
                )
            # Both should be pending
            assert "PENDING" in stdout, f"Expected 'PENDING' in output:\n{stdout}"
        finally:
            for p in paths:
                p.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Test 4: archive --older-than moves old processed requests
# ---------------------------------------------------------------------------

class TestArchiveOlderThan:
    """Test 4: fake request from 10 days ago + response -> archive --older-than 7d moves it."""

    def test_archive_older_than(self):
        """archive --older-than 7d moves processed requests older than 7 days."""
        _ensure_dirs()

        # Create a fake request from 10 days ago
        req_id = "req-test-archive-0000-cccccccc"
        old_ts = datetime.now(tz=timezone.utc) - timedelta(days=10)
        req_path  = _fake_request(req_id, created_at=old_ts)
        resp_path = _fake_response(req_id)

        try:
            result = _run_py("archive", "--older-than", "7d", timeout=15.0)
            assert result.returncode == 0, (
                f"archive exited {result.returncode}. stderr: {result.stderr[:200]}"
            )
            stdout = result.stdout
            # Should report archiving at least 1 item
            assert "Archived 1" in stdout or "1 request" in stdout or req_id in stdout, (
                f"Expected archive confirmation in:\n{stdout}"
            )
            # Request and response should be in archive
            assert (ARCHIVE / f"{req_id}.yaml").exists(), (
                f"Request YAML not found in archive/"
            )
            assert (ARCHIVE / f"{req_id}.json").exists(), (
                f"Response JSON not found in archive/"
            )
        finally:
            # Cleanup archive and any remaining originals
            for p in (req_path, resp_path,
                      ARCHIVE / f"{req_id}.yaml",
                      ARCHIVE / f"{req_id}.json"):
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# Test 5: inline invocation REGRESSION — shared-duet.ps1 without -Async
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestInlineInvocationUnchanged:
    """Test 5 (REGRESSION): shared-duet.ps1 WITHOUT -Async still works correctly.

    This is the safety net: if the -Async insertion broke the inline path,
    this test will fail. Uses Mini mode (single round, fastest possible).

    Skipped when ULTRON_FAST_TESTS=1.

    Codex H2 fix: golden contract — verifies ALL expected keys (round, mode,
    peers, elapsed_s, codex, gemini, session_ids), value types, and that NO
    async/MMFP-related noise leaked into stdout BEFORE the JSON sentinel.
    """

    @pytest.mark.skipif(FAST_TESTS, reason="ULTRON_FAST_TESTS=1 — skipping Codex call")
    def test_inline_invocation_unchanged(self):
        """shared-duet.ps1 inline (no -Async) must exit 0 with full golden contract."""
        result = _run_ps(
            "-Peers", "codex",
            "-Mode", "Mini",
            "-Round", "1",
            "-Prompt", "respond with verdict GREEN. keep it short.",
            "-CodexModel", "gpt-5.5",
            "-TimeoutSec", "90",
            timeout=110.0,
        )

        assert result.returncode == 0, (
            f"shared-duet.ps1 (inline) exited {result.returncode}.\n"
            f"stdout: {result.stdout[:500]}\n"
            f"stderr: {result.stderr[:300]}"
        )

        stdout = result.stdout

        # Codex H2: verify NO async/MMFP-related noise BEFORE the sentinel.
        # Anything indicating the async path was taken would mean the inline
        # branch leaked async behavior.
        pre_sentinel: list[str] = []
        for line in stdout.splitlines():
            if "--- OUTPUT JSON ---" in line:
                break
            pre_sentinel.append(line)
        pre_text = "\n".join(pre_sentinel).lower()
        forbidden_in_pre = ["mmfp", "request_id", '"async"', "async:true"]
        leaked = [k for k in forbidden_in_pre if k in pre_text]
        assert not leaked, (
            f"Inline path leaked async/MMFP markers in pre-sentinel stdout: {leaked}\n"
            f"Pre-sentinel stdout:\n{pre_text[:500]}"
        )

        # Find the JSON after "--- OUTPUT JSON ---" sentinel
        json_obj = None
        found_sentinel = False
        for line in stdout.splitlines():
            if "--- OUTPUT JSON ---" in line:
                found_sentinel = True
                continue
            if found_sentinel and line.strip().startswith("{"):
                try:
                    json_obj = json.loads(line.strip())
                    break
                except json.JSONDecodeError:
                    continue

        assert json_obj is not None, (
            f"No JSON found after '--- OUTPUT JSON ---' sentinel.\n"
            f"Full stdout:\n{stdout}"
        )

        # Codex H2 golden contract: ALL keys expected by callers must be
        # present with correct types. Drift here breaks downstream consumers.
        EXPECTED_KEYS = {
            "round":       int,
            "mode":        str,
            "peers":       str,
            "elapsed_s":   (int, float),
            "codex":       (dict, type(None)),
            "gemini":      (dict, type(None)),
            "session_ids": dict,
        }
        for key, expected_type in EXPECTED_KEYS.items():
            assert key in json_obj, (
                f"Golden contract violated: missing key {key!r}. "
                f"Got keys: {sorted(json_obj.keys())}"
            )
            value = json_obj[key]
            assert isinstance(value, expected_type), (
                f"Golden contract violated: key {key!r} has type "
                f"{type(value).__name__}, expected {expected_type}"
            )

        # Value-level expectations (Mini single-shot, codex-only)
        assert json_obj["round"] == 1,        f"Expected round=1, got: {json_obj['round']}"
        assert json_obj["mode"]  == "Mini",   f"Expected mode=Mini, got: {json_obj['mode']}"
        assert json_obj["peers"] == "codex",  f"Expected peers=codex, got: {json_obj['peers']}"

        # Codex must have responded (not None for a Mini codex-only call)
        assert json_obj["codex"] is not None, "codex field is null — Codex did not respond"
        # session_ids must contain both codex and gemini keys (gemini=null is OK)
        sids = json_obj["session_ids"]
        assert "codex" in sids,  f"session_ids missing 'codex' key: {sids}"
        assert "gemini" in sids, f"session_ids missing 'gemini' key: {sids}"

        # No -Async field in inline output (would indicate async leak)
        assert "async" not in json_obj, (
            f"-Async field leaked into inline response: {json_obj}"
        )
        assert "request_id" not in json_obj, (
            f"request_id field leaked into inline response: {json_obj}"
        )


# ---------------------------------------------------------------------------
# Shortcut 1 close — fast structural regression test for shared-duet.ps1
# ---------------------------------------------------------------------------
# Slow inline test (test_inline_invocation_unchanged) runs in ~5s and is the
# real golden contract gate, but it's @pytest.mark.slow + skippable in CI fast
# mode. This fast structural test runs in <100ms and complements it: it parses
# shared-duet.ps1 as text and asserts the architectural invariants that protect
# the inline path from async leakage. If a future refactor breaks any of these,
# CI fast mode catches it without needing a network call.

def test_shared_duet_async_block_isolated_structurally():
    """Codex Shortcut 1: structural assertions over shared-duet.ps1 source.

    Verifies, without invoking the script, that:
      1. [switch]$Async is declared in the param block.
      2. The Enforce-Cap conditional excludes -Async (`-and -not $Async`).
      3. The `if ($Async)` block ends with `exit 0` (no fall-through to inline).
      4. The async block appears AFTER prompt resolution (so $promptText exists).
      5. The async block appears BEFORE the inline peer invocation helpers.
      6. The inline path's JSON output template is preserved (round, mode,
         peers, elapsed_s, codex, gemini, session_ids — all 7 golden keys
         appear together at least once in the source).
    """
    src = SHARED_DUET.read_text(encoding="utf-8")

    # 1. -Async switch declared
    assert "[switch]$Async" in src, (
        "param block missing [switch]$Async — async path is not declared"
    )

    # 2. Enforce-Cap condition excludes async (Codex H1 fix anchor)
    assert "-not $Async" in src, (
        "Enforce-Cap conditional doesn't exclude async — caps would leak "
        "for async invocations (Codex H1 regression)"
    )
    # Specifically inside the dual-caps gating block
    cap_block_anchor = "if ($Round -eq 1 -and $Mode -ne 'Mini' -and -not $BypassCaps -and -not $Async)"
    assert cap_block_anchor in src, (
        "Enforce-Cap block doesn't have the expected guard — Codex H1 fix "
        "anchor missing or modified"
    )

    # 3. if ($Async) block exists and ends with exit 0
    async_open  = src.find("if ($Async) {")
    assert async_open > 0, "no 'if ($Async) {' block found"
    # Find the matching closing brace by walking braces from open
    depth = 0
    close_idx = -1
    for i, ch in enumerate(src[async_open:], start=async_open):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                close_idx = i
                break
    assert close_idx > 0, "if ($Async) block has unbalanced braces"
    block = src[async_open:close_idx + 1]
    # The async block must terminate with exit 0 (so we never fall through)
    # Look for "exit 0" within the last 100 chars of the block
    tail = block[-150:]
    assert "exit 0" in tail, (
        f"if ($Async) block does not end with 'exit 0' — could fall through "
        f"to inline path. Tail of block:\n{tail}"
    )

    # 4. async block AFTER prompt resolution
    prompt_resolved = src.find("[System.IO.File]::WriteAllText($promptTmp")
    assert prompt_resolved > 0, "prompt resolution anchor missing"
    assert async_open > prompt_resolved, (
        f"if ($Async) block at {async_open} appears BEFORE prompt resolution "
        f"at {prompt_resolved}. Async writes the resolved prompt to YAML — "
        f"if the resolution hasn't happened yet, the YAML will be empty."
    )

    # 5. async block BEFORE the inline peer invocation helpers
    inline_helpers = src.find("function Write-Launcher")
    if inline_helpers < 0:
        inline_helpers = src.find("Hidden process helpers")
    assert inline_helpers > 0, "inline peer helpers anchor missing"
    assert close_idx < inline_helpers, (
        f"async block (closes at {close_idx}) overlaps with inline helpers "
        f"(start at {inline_helpers}) — inline path may be polluted"
    )

    # 6. Inline JSON contract preserved — the 7 golden keys must appear
    # together in the inline output construction
    inline_path = src[close_idx:]
    golden_keys = ["round", "mode", "peers", "elapsed_s", "codex", "gemini", "session_ids"]
    missing = [k for k in golden_keys if k not in inline_path]
    assert not missing, (
        f"Inline path missing golden contract keys: {missing}. "
        f"Downstream consumers depend on these keys."
    )


def _read_caps_counter(caps_file: Path, key: str) -> int:
    """Read an integer counter from a caps JSON file. Returns 0 if absent."""
    if not caps_file.exists():
        return 0
    try:
        return int(json.loads(caps_file.read_text(encoding="utf-8")).get(key, 0))
    except Exception:
        return 0


@pytest.mark.parametrize("peers,mode,caps_to_check", [
    # (peers, mode, [(caps_file_basename, key), ...])
    # Codex Shortcut 1: Dual + codex was already covered.
    # Codex Shortcut 3: ensure Max + both and Triple + gemini also bypass caps.
    ("codex",  "Dual",  [("dual-caps.json",   "dual")]),
    ("both",   "Max",   [("dual-caps.json",   "max"), ("triple-caps.json", "max")]),
    ("gemini", "Max",   [("triple-caps.json", "max")]),
    ("both",   "Triple", [("dual-caps.json",  "dual"), ("triple-caps.json", "triple")]),
])
def test_async_path_does_not_count_caps(peers, mode, caps_to_check):
    """Codex H1 fix verification (FAST): -Async must NOT increment ANY caps.

    Parametrized over all peer/mode combinations that would normally consume
    caps. The fix in shared-duet.ps1 added `-and -not $Async` to the gating
    condition; this test verifies that gate works uniformly for Dual/Max/Triple
    and for codex/gemini/both peers.

    Runs in fast mode because async writes a YAML file and exits immediately —
    no actual peer is called.
    """
    today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    sessions_dir = Path.home() / ".ultron" / "sessions" / today

    # Snapshot all caps counters before the invocation
    before = {
        (basename, key): _read_caps_counter(sessions_dir / basename, key)
        for basename, key in caps_to_check
    }

    result = _run_ps(
        "-Async",
        "-Peers", peers,
        "-Mode", mode,
        "-Round", "1",
        "-Prompt", f"h1 fix smoke (async,{peers},{mode}) — must not count cap",
        "-CodexModel", "gpt-5.5",
        "-GeminiModel", "pro",
        timeout=10.0,
    )
    assert result.returncode == 0, (
        f"async invocation failed for peers={peers} mode={mode}: "
        f"{result.stderr[:300]}"
    )
    # stdout must contain only the JSON answer — no [SharedDuet] Usage lines
    assert "[SharedDuet] Usage" not in result.stdout, (
        f"Async path leaked '[SharedDuet] Usage' line to stdout for "
        f"peers={peers} mode={mode}:\n{result.stdout}"
    )

    # All counters that would normally have been incremented must be unchanged
    for (basename, key), before_val in before.items():
        after_val = _read_caps_counter(sessions_dir / basename, key)
        assert after_val == before_val, (
            f"-Async wrongly incremented {basename}[{key}] for peers={peers} "
            f"mode={mode}: {before_val} -> {after_val}. Async must be cap-free."
        )


# ---------------------------------------------------------------------------
# Bonus: dry-run shows what archive would do
# ---------------------------------------------------------------------------

class TestCleanDryRun:
    """Bonus: multimodel clean --dry-run previews without moving files."""

    def test_clean_dry_run_no_move(self):
        """clean --dry-run must not move any files."""
        _ensure_dirs()

        req_id   = "req-test-dryrun-0000-dddddddd"
        old_ts   = datetime.now(tz=timezone.utc) - timedelta(days=10)
        req_path = _fake_request(req_id, created_at=old_ts)
        resp_path = _fake_response(req_id)

        try:
            result = _run_py("clean", "--dry-run", timeout=15.0)
            assert result.returncode == 0, (
                f"clean --dry-run exited {result.returncode}: {result.stderr[:200]}"
            )
            stdout = result.stdout
            assert "DRY-RUN" in stdout or "dry" in stdout.lower(), (
                f"Expected DRY-RUN label in output:\n{stdout}"
            )
            # Files must NOT have been moved
            assert req_path.exists(), "Request YAML was moved by dry-run (should not be)"
            assert resp_path.exists(), "Response JSON was moved by dry-run (should not be)"
        finally:
            req_path.unlink(missing_ok=True)
            resp_path.unlink(missing_ok=True)
            (ARCHIVE / f"{req_id}.yaml").unlink(missing_ok=True)
            (ARCHIVE / f"{req_id}.json").unlink(missing_ok=True)
