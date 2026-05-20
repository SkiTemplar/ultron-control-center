"""Pytest suite for ULTRON v14 Sprint 5 Sub-pilar A — MCP resilience.

Covers the three deliverables:
  1. mcp-fallbacks.yaml — schema sanity
  2. mcp_health_check.py — probe correctness, parallelism, atomic write,
                              alert dedupe
  3. mcp-resilience.py PreToolUse hook — silent on missing/healthy, injects
                              on degraded, exit-0 always, latency budget

Tests run in isolated tmp_path — never touch the real ~/.ultron/.
"""
from __future__ import annotations

import http.server
import importlib
import json
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

# Make cockpit modules importable.
SKILL_ROOT = Path(__file__).resolve().parent.parent
COCKPIT = SKILL_ROOT / "scripts" / "cockpit"
HOOKS = SKILL_ROOT / "scripts" / "hooks"
if str(COCKPIT) not in sys.path:
    sys.path.insert(0, str(COCKPIT))

VENV_PYTHON = SKILL_ROOT / ".venv" / "Scripts" / "python.exe"
PYTHON_EXE = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
HOOK_PATH = HOOKS / "mcp-resilience.py"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    """Point USERPROFILE / HOME at tmp_path so all module-level paths
    resolve there. Fresh-imports the cockpit modules so they pick up the
    new home.
    """
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    # Pre-create the ULTRON dirs the modules expect.
    (tmp_path / ".ultron" / ".tmp").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".ultron" / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".claude").mkdir(parents=True, exist_ok=True)
    # Force fresh imports so module-level Path.home() / USERPROFILE
    # references re-resolve to tmp_path.
    for mod in ("alerts", "mcp_health_check"):
        if mod in sys.modules:
            del sys.modules[mod]
    return tmp_path


@pytest.fixture
def mhc(isolated_home):
    """The mcp_health_check module imported with isolated paths."""
    return importlib.import_module("mcp_health_check")


@pytest.fixture
def real_fallbacks_path():
    """Absolute path to the canonical mcp-fallbacks.yaml shipped in the repo."""
    return Path.home() / ".ultron" / "config" / "mcp-fallbacks.yaml"


# ---------------------------------------------------------------------------
# 1. fallbacks YAML schema
# ---------------------------------------------------------------------------

def test_load_fallbacks_returns_all_configured_mcps(real_fallbacks_path):
    """The shipped mcp-fallbacks.yaml lists every MCP server in settings.json
    with the required schema fields.
    """
    # Use the SHIPPED file in the real ~/.ultron/config (we don't isolate
    # here — this asserts the canonical config has correct schema).
    if not real_fallbacks_path.exists():
        pytest.skip(f"shipped fallbacks file missing: {real_fallbacks_path}")

    # Reuse the loader by importing the canonical module fresh (no path
    # isolation — we want the real file).
    sys.path.insert(0, str(COCKPIT))
    if "mcp_health_check" in sys.modules:
        del sys.modules["mcp_health_check"]
    mod = importlib.import_module("mcp_health_check")

    fallbacks = mod._load_fallbacks()

    settings_path = Path.home() / ".claude" / "settings.json"
    if not settings_path.exists():
        pytest.skip(f"settings file missing: {settings_path}")
    settings = json.loads(settings_path.read_text(encoding="utf-8-sig"))
    expected = set((settings.get("mcpServers") or {}).keys())
    assert expected, "settings.json has no configured MCP servers"
    assert set(fallbacks.keys()) >= expected, (
        f"missing MCPs in fallbacks: {expected - set(fallbacks.keys())}"
    )
    for name in expected:
        entry = fallbacks[name]
        assert "fallback_message" in entry, f"{name}: missing fallback_message"
        assert "alert_severity" in entry, f"{name}: missing alert_severity"
        assert entry["alert_severity"] in ("info", "warn", "blocking"), (
            f"{name}: invalid severity {entry['alert_severity']!r}"
        )
        assert isinstance(entry["fallback_message"], str)
        assert len(entry["fallback_message"]) > 10


# ---------------------------------------------------------------------------
# 2. _probe_stdio
# ---------------------------------------------------------------------------

def test_probe_stdio_with_unreachable_command_returns_degraded(mhc, tmp_path):
    """Pointing at a non-existent binary returns degraded (Popen raises OSError)."""
    cfg = {"command": str(tmp_path / "definitely_not_a_real_binary.exe"), "args": []}
    status = mhc._probe_stdio("ghost", cfg, timeout_s=1.0)
    assert status == mhc.STATUS_DEGRADED


def test_probe_stdio_with_silent_child_returns_degraded(mhc):
    """A valid command that prints nothing within the timeout → degraded."""
    if sys.platform == "win32":
        cfg = {"command": "cmd.exe", "args": ["/c", "ping -n 5 127.0.0.1 >nul"]}
    else:
        cfg = {"command": "sleep", "args": ["5"]}
    status = mhc._probe_stdio("silent", cfg, timeout_s=0.5)
    assert status == mhc.STATUS_DEGRADED


# ---------------------------------------------------------------------------
# 3. _probe_sse
# ---------------------------------------------------------------------------

def _free_port() -> int:
    """Allocate an unused TCP port (best-effort, classic SO_REUSEADDR dance)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_probe_sse_with_unreachable_url_returns_degraded(mhc):
    port = _free_port()  # nothing's listening here
    cfg = {"url": f"http://127.0.0.1:{port}/sse", "type": "sse"}
    status = mhc._probe_sse("ghost-sse", cfg, timeout_s=1.0)
    assert status == mhc.STATUS_DEGRADED


def test_probe_sse_with_responding_url_returns_ok(mhc):
    """Spin up an http.server on 127.0.0.1:<ephemeral> that responds 200."""
    port = _free_port()

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — stdlib API
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b": ok\n\n")

        def log_message(self, *_args):  # silence test stderr
            return

    httpd = socketserver.TCPServer(("127.0.0.1", port), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        cfg = {"url": f"http://127.0.0.1:{port}/sse", "type": "sse"}
        status = mhc._probe_sse("live-sse", cfg, timeout_s=2.0)
        assert status == mhc.STATUS_OK
    finally:
        httpd.shutdown()
        httpd.server_close()


# ---------------------------------------------------------------------------
# 4. parallel orchestration
# ---------------------------------------------------------------------------

def test_check_all_runs_in_parallel(mhc, isolated_home, monkeypatch):
    """check_all uses a ThreadPoolExecutor — total time must be much less
    than the sum of individual probe times.
    """
    # Inject a fake settings.json with 4 SSE entries pointing at dead ports.
    settings = {
        "mcpServers": {
            f"fake-{i}": {"type": "sse", "url": f"http://127.0.0.1:{_free_port()}/sse"}
            for i in range(4)
        }
    }
    settings_path = isolated_home / ".claude" / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings), encoding="utf-8")
    monkeypatch.setattr(mhc, "_SETTINGS_PATH", settings_path)

    per_probe_s = 0.6  # short enough to not block test runs
    t0 = time.perf_counter()
    results = mhc.check_all(timeout_s=per_probe_s)
    elapsed = time.perf_counter() - t0

    assert len(results) == 4
    # Sequential cost would be 4 × per_probe_s = 2.4s. Parallel with
    # max_workers=4 should complete in roughly per_probe_s + slack.
    sequential_budget = 4 * per_probe_s
    assert elapsed < sequential_budget * 0.7, (
        f"check_all took {elapsed:.2f}s (expected << {sequential_budget:.2f}s)"
    )


# ---------------------------------------------------------------------------
# 5. write_health_file atomicity
# ---------------------------------------------------------------------------

def test_write_health_file_is_atomic(mhc, isolated_home):
    """The temp+rename code path is exercised, file is always parseable."""
    out = isolated_home / ".ultron" / ".tmp" / "mcp-health.json"
    mhc.write_health_file({"foo": "ok", "bar": "degraded"}, duration_ms=1234, out_path=out)
    assert out.exists()
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["results"] == {"foo": "ok", "bar": "degraded"}
    assert payload["duration_ms"] == 1234
    assert "checked_at" in payload
    # Temp file must be gone after replace.
    assert not out.with_suffix(out.suffix + ".tmp").exists()

    # Overwrite with a different result set — the replace must succeed
    # cleanly even when the target already exists.
    mhc.write_health_file({"foo": "degraded"}, duration_ms=42, out_path=out)
    payload2 = json.loads(out.read_text(encoding="utf-8"))
    assert payload2["results"] == {"foo": "degraded"}


# ---------------------------------------------------------------------------
# 6. alert dedupe
# ---------------------------------------------------------------------------

def test_emit_alerts_dedupes_within_4h(mhc, isolated_home):
    """If a recent unacked alert tagged mcp:<name> exists, do not re-emit."""
    fallbacks = {
        "gemini": {
            "mcp_name": "gemini",
            "fallback_message": "Fall back to manual peer review.",
            "alert_severity": "warn",
        }
    }
    results = {"gemini": "degraded"}

    # First call writes one alert.
    n1 = mhc.emit_alerts(results, fallbacks)
    assert n1 == 1

    # Second call within 4h is deduped.
    n2 = mhc.emit_alerts(results, fallbacks)
    assert n2 == 0

    # Window=0 disables dedupe — useful sanity check on the logic.
    n3 = mhc.emit_alerts(results, fallbacks, dedupe_window_seconds=0)
    assert n3 == 1


def test_emit_alerts_skips_ok(mhc, isolated_home):
    """Healthy MCPs never produce alerts."""
    fallbacks = {"gemini": {"mcp_name": "gemini", "alert_severity": "warn",
                              "fallback_message": "x"}}
    results = {"gemini": "ok"}
    assert mhc.emit_alerts(results, fallbacks) == 0


def test_emit_alerts_suppresses_expected_offline_info(mhc, isolated_home):
    """Expected-offline info MCPs stay in health JSON but do not notify."""
    fallbacks = {
        "unity": {
            "mcp_name": "unity",
            "alert_severity": "info",
            "fallback_message": "Unity Editor is offline.",
            "expected_offline": True,
        }
    }
    results = {"unity": "degraded"}
    assert mhc.emit_alerts(results, fallbacks) == 0


# ---------------------------------------------------------------------------
# 7. hook contract
# ---------------------------------------------------------------------------

def _invoke_hook(stdin_payload: dict, env_overrides: dict | None = None,
                  timeout: float = 5.0) -> subprocess.CompletedProcess:
    """Spawn mcp-resilience.py with a JSON stdin payload."""
    import os as _os
    env = _os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        [PYTHON_EXE, str(HOOK_PATH)],
        input=json.dumps(stdin_payload).encode("utf-8"),
        capture_output=True,
        timeout=timeout,
        env=env,
    )


def test_hook_returns_silent_when_mcp_health_missing(tmp_path):
    """No health file → exit 0, empty stdout, even for an MCP tool name."""
    payload = {
        "hook_event_name": "PreToolUse",
        "tool_name": "mcp__gemini__query",
    }
    # Point HOME at a tmp dir with no health file.
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8", errors="replace").strip() == ""


def test_hook_skips_non_mcp_tools(tmp_path):
    """Non-MCP tools (Read, Bash, etc.) produce no output."""
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text(
        json.dumps({"results": {"gemini": "degraded"}}), encoding="utf-8"
    )
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Read"}
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8", errors="replace").strip() == ""


def test_hook_injects_when_mcp_degraded(tmp_path):
    """Health file says gemini=degraded, tool is mcp__gemini__query → inject."""
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text(
        json.dumps({
            "checked_at": "2026-05-05T12:00:00Z",
            "duration_ms": 100,
            "results": {"gemini": "degraded"},
        }), encoding="utf-8"
    )
    cfg_dir = tmp_path / ".ultron" / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "mcp-fallbacks.yaml").write_text(
        "- mcp_name: gemini\n"
        "  fallback_message: \"Fall back to manual peer review.\"\n"
        "  alert_severity: warn\n"
        "  fallback_skill: second-opinion\n",
        encoding="utf-8",
    )
    payload = {"hook_event_name": "PreToolUse", "tool_name": "mcp__gemini__query"}
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    stdout = proc.stdout.decode("utf-8", errors="replace")
    assert stdout.strip() != "", f"expected injection, got empty stdout"

    # Output is the JSON envelope.
    parsed = json.loads(stdout.strip().splitlines()[-1])
    assert parsed["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    msg = parsed["hookSpecificOutput"]["additionalContext"]
    assert "MCP-DEGRADED" in msg
    assert "gemini" in msg
    assert "manual peer review" in msg


def test_hook_silent_when_mcp_ok(tmp_path):
    """Healthy MCP → no injection, exit 0."""
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text(
        json.dumps({"results": {"gemini": "ok"}}), encoding="utf-8"
    )
    payload = {"hook_event_name": "PreToolUse", "tool_name": "mcp__gemini__query"}
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8", errors="replace").strip() == ""


def test_hook_normalizes_dashed_server_names(tmp_path):
    """`mcp__gemini_flash__query` must match `gemini-flash` in fallbacks."""
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text(
        json.dumps({"results": {"gemini-flash": "degraded"}}), encoding="utf-8"
    )
    cfg_dir = tmp_path / ".ultron" / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "mcp-fallbacks.yaml").write_text(
        "- mcp_name: gemini-flash\n"
        "  fallback_message: \"Use the gemini CLI with --model flag.\"\n"
        "  alert_severity: info\n"
        "  fallback_skill: null\n",
        encoding="utf-8",
    )
    payload = {"hook_event_name": "PreToolUse", "tool_name": "mcp__gemini_flash__query"}
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    stdout = proc.stdout.decode("utf-8", errors="replace").strip()
    assert stdout != ""
    parsed = json.loads(stdout.splitlines()[-1])
    msg = parsed["hookSpecificOutput"]["additionalContext"]
    assert "gemini-flash" in msg
    assert "gemini CLI" in msg


def test_hook_silent_for_unknown_mcp(tmp_path):
    """If a tool's MCP server isn't in the health file, stay silent."""
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text(
        json.dumps({"results": {"gemini": "ok"}}), encoding="utf-8"
    )
    payload = {"hook_event_name": "PreToolUse", "tool_name": "mcp__unknownserver__foo"}
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8", errors="replace").strip() == ""


def test_hook_handles_malformed_health_file(tmp_path):
    """Garbage health file → silent, exit 0 (must not crash)."""
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text("{not json", encoding="utf-8")
    payload = {"hook_event_name": "PreToolUse", "tool_name": "mcp__gemini__query"}
    proc = _invoke_hook(payload, env_overrides={
        "USERPROFILE": str(tmp_path),
        "HOME": str(tmp_path),
    })
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8", errors="replace").strip() == ""


def test_hook_latency_under_40ms_p95(tmp_path):
    """100 in-process invocations: p95 latency < 40ms.

    Measures hook BODY latency (load health, look up fallback, emit JSON)
    without subprocess startup. The hook fires on every tool call so this
    is the real budget — Python startup is unavoidable but consistent.
    """
    # Write health + fallbacks once.
    health_dir = tmp_path / ".ultron" / ".tmp"
    health_dir.mkdir(parents=True, exist_ok=True)
    (health_dir / "mcp-health.json").write_text(
        json.dumps({"results": {"gemini": "degraded"}}), encoding="utf-8"
    )
    cfg_dir = tmp_path / ".ultron" / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "mcp-fallbacks.yaml").write_text(
        "- mcp_name: gemini\n"
        "  fallback_message: \"x\"\n"
        "  alert_severity: warn\n"
        "  fallback_skill: null\n",
        encoding="utf-8",
    )

    # Import the hook as a module and call its internal functions in-process.
    import importlib.util
    spec = importlib.util.spec_from_file_location("mcp_resilience_hook", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Monkey-patch the path resolution to point at tmp_path. Since the
    # module computes paths at import time, we override post-load.
    mod._HEALTH_PATH = health_dir / "mcp-health.json"
    mod._FALLBACKS_PATH = cfg_dir / "mcp-fallbacks.yaml"

    # Simulate the in-hook hot path: load_health + find_canonical + load_fallback.
    latencies = []
    for _ in range(100):
        t0 = time.perf_counter()
        results = mod._load_health()
        sanitized = mod._extract_mcp_server_from_tool("mcp__gemini__query")
        canonical = mod._find_canonical_name(sanitized, results) if results else None
        if canonical:
            mod._load_fallback_for(canonical)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        latencies.append(elapsed_ms)

    latencies.sort()
    p95 = latencies[int(len(latencies) * 0.95)]
    p_max = latencies[-1]
    print(f"\n[mcp-resilience hot path] p95={p95:.3f}ms max={p_max:.3f}ms")
    assert p95 < 40, (
        f"hot path p95 {p95:.3f}ms exceeds 40ms budget — hook will slow every tool call"
    )


def test_hook_exit0_on_malformed_stdin(tmp_path):
    """Empty/garbage stdin → exit 0, no output (defensive contract)."""
    proc = subprocess.run(
        [PYTHON_EXE, str(HOOK_PATH)],
        input=b"this is not json at all",
        capture_output=True,
        timeout=5.0,
        env={**__import__("os").environ, "USERPROFILE": str(tmp_path),
              "HOME": str(tmp_path)},
    )
    assert proc.returncode == 0
    assert proc.stdout.decode("utf-8", errors="replace").strip() == ""


# ---------------------------------------------------------------------------
# 8. extras
# ---------------------------------------------------------------------------

def test_load_settings_mcps_handles_missing_file(mhc, isolated_home):
    """No settings.json → empty dict, no crash."""
    # isolated_home creates ~/.claude/ but not settings.json
    assert mhc._load_settings_mcps() == {}


def test_load_settings_mcps_handles_garbage(mhc, isolated_home):
    """Malformed JSON → empty dict."""
    p = isolated_home / ".claude" / "settings.json"
    p.write_text("not json {{{", encoding="utf-8")
    assert mhc._load_settings_mcps() == {}
