"""ULTRON v14 Sprint 5 Sub-pilar A — MCP health prober.

Runs once per session start (via session-init.ps1) and on demand from
`ultron mcp health`. Probes every MCP defined in ~/.claude/settings.json,
classifies each as ``ok`` | ``degraded`` | ``missing``, atomically writes
``~/.ultron/.tmp/mcp-health.json``, and emits an alert per non-ok server
(deduped within a 4-hour window).

DESIGN INVARIANTS
-----------------
1. **Pure stdlib.** Only ``yaml`` is optional (try/except import — falls back
   to a regex parser tailored to the simple schema of mcp-fallbacks.yaml).
2. **Silent on success.** No stdout unless ``--verbose`` (errors) or
   ``--json`` (results dict).
3. **Always exit 0.** This script feeds a hook; non-zero would surface as a
   session-start error to the user. PILAR I: silent failure mode.
4. **Bounded wall time.** All MCPs probed in parallel via ThreadPoolExecutor
   (max_workers=min(N, 9)) plus an overall deadline of ``timeout_s + 1s``.
   Anything still pending at the deadline is marked degraded — predictable
   bound for the doctor health-check call site.
5. **Subprocess hygiene.** Every child process is spawned via
   ``silent_exec.silent_popen`` (CREATE_NO_WINDOW on Windows) and terminated
   on probe completion or timeout — no zombie npx processes after probing.
6. **Atomic writes.** Health file uses temp + os.replace so a concurrent
   reader (the hook) never sees partial JSON.

PROBE PROTOCOL
--------------
- **stdio MCPs** — spawn ``command`` + ``args``, write a JSON-RPC
  ``initialize`` request to stdin, expect a JSON-RPC response with no
  ``error`` field within the timeout.
- **sse MCPs** — open a urllib GET to ``cfg["url"]`` with Accept:
  ``text/event-stream``; any 2xx response (or stream open) → ``ok``.

CLI
---
  python mcp_health_check.py [--timeout SECS] [--quiet] [--json] [--verbose]

Exit codes: always 0 (per session-start contract).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as _dt
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Cockpit dir on sys.path so silent_exec / alerts imports resolve cleanly
# whether this is launched as `python mcp_health_check.py` or via uv.
_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

from silent_exec import silent_popen, silent_run  # noqa: E402
import alerts as _alerts  # noqa: E402

__all__ = [
    "check_all",
    "write_health_file",
    "emit_alerts",
    "STATUS_OK",
    "STATUS_DEGRADED",
    "STATUS_MISSING",
]

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------

_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
_FALLBACKS_PATH = Path.home() / ".ultron" / "config" / "mcp-fallbacks.yaml"
_HEALTH_PATH = Path.home() / ".ultron" / ".tmp" / "mcp-health.json"

STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_MISSING = "missing"

# Dedupe window for emitted alerts. If a degraded alert for the same MCP
# already exists unacked from the last 4h, we do NOT emit a duplicate.
_ALERT_DEDUPE_WINDOW_SECONDS = 4 * 3600

# Default timeout per MCP probe (seconds). Tuned so total wall time stays
# under the session-start budget even when several MCPs hang.
_DEFAULT_TIMEOUT_S = 3.0

# Initialize payload sent over stdin to stdio MCPs. Newline-terminated; the
# server is supposed to respond with a single JSON-RPC line.
_INIT_PAYLOAD = (
    json.dumps({
        "jsonrpc": "2.0",
        "method": "initialize",
        "id": 1,
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ultron-mcp-health", "version": "1.0"},
        },
    })
    + "\n"
).encode("utf-8")


# ---------------------------------------------------------------------------
# Settings & fallbacks loaders
# ---------------------------------------------------------------------------

def _load_settings_mcps() -> dict[str, dict[str, Any]]:
    """Read settings.json and return the mcpServers mapping (or {} on error)."""
    try:
        with _SETTINGS_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    mcps = data.get("mcpServers", {})
    if not isinstance(mcps, dict):
        return {}
    # Only keep entries that are themselves dicts; ignore weird shapes.
    return {k: v for k, v in mcps.items() if isinstance(v, dict)}


def _load_fallbacks() -> dict[str, dict[str, Any]]:
    """Load mcp-fallbacks.yaml as a dict keyed by mcp_name.

    Tries PyYAML first (preferred). Falls back to a minimal stdlib parser
    that handles the exact list-of-mappings schema we ship — same approach
    skill_manifest.py uses when yaml is unavailable.
    """
    if not _FALLBACKS_PATH.exists():
        return {}
    try:
        import yaml  # type: ignore[import-not-found]
        with _FALLBACKS_PATH.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        if not isinstance(data, list):
            return {}
        out: dict[str, dict[str, Any]] = {}
        for entry in data:
            if isinstance(entry, dict) and "mcp_name" in entry:
                out[str(entry["mcp_name"])] = entry
        return out
    except ImportError:
        pass

    # Stdlib fallback parser — handles the schema we author by hand. Each
    # entry begins with `- mcp_name: <id>` and the remaining fields are
    # `  <key>: <value>` two-space indented. Quoted strings (single or
    # double) have their quotes stripped; `null` becomes None.
    out_min: dict[str, dict[str, Any]] = {}
    current: dict[str, Any] | None = None
    try:
        with _FALLBACKS_PATH.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.rstrip("\n")
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if line.startswith("- "):
                    if current and "mcp_name" in current:
                        out_min[str(current["mcp_name"])] = current
                    current = {}
                    rest = line[2:].strip()
                    if ":" in rest:
                        k, _, v = rest.partition(":")
                        current[k.strip()] = _coerce_yaml_scalar(v.strip())
                elif current is not None and ":" in stripped:
                    k, _, v = stripped.partition(":")
                    current[k.strip()] = _coerce_yaml_scalar(v.strip())
        if current and "mcp_name" in current:
            out_min[str(current["mcp_name"])] = current
    except OSError:
        return {}
    return out_min


def _coerce_yaml_scalar(value: str) -> Any:
    """Strip surrounding quotes; map ``null``/empty to None."""
    if not value:
        return None
    if value.lower() == "null":
        return None
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


# ---------------------------------------------------------------------------
# Probe helpers
# ---------------------------------------------------------------------------

def _resolve_command(cmd: str) -> str | None:
    """Return absolute path of ``cmd`` if it exists on disk or PATH; else None.

    Settings.json may store commands as Windows-style absolute paths
    (``C:\\Program Files\\nodejs\\npx.cmd``) OR as bare names that rely on
    PATH lookup (``node``, ``npx``). We accept either.
    """
    if not cmd:
        return None
    p = Path(cmd)
    if p.is_absolute() and p.exists():
        return str(p)
    found = shutil.which(cmd)
    return found


# Codex S5-A H1 fix: settings.json stores secrets as ``${VAR}`` placeholders
# (e.g. ``GEMINI_API_KEY: "${GEMINI_API_KEY}"``). Claude Code expands these
# before launching the MCP for real use. Our probe must do the same or it
# falsely flags working MCPs as degraded.
_ENV_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand_env_placeholder(value: str) -> str:
    """Replace every ``${VAR}`` in *value* with ``os.environ[VAR]`` (empty
    string if unset). Mirrors Claude Code's substitution semantics."""
    if not isinstance(value, str):
        return value
    return _ENV_PLACEHOLDER.sub(lambda m: os.environ.get(m.group(1), ""), value)


# Codex S5-A C1 fix: on Windows, npx.cmd → node → MCP server is a 3-deep
# process tree. ``proc.kill()`` only kills the cmd shell; node and the MCP
# child linger. After 9 probes that adds up. ``taskkill /T /F`` walks the
# tree by PID and terminates all descendants.
def _kill_tree(proc: Any) -> None:
    """Best-effort kill of *proc* and all its descendants. Idempotent."""
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            return
    except Exception:
        return
    if sys.platform == "win32":
        try:
            silent_run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                timeout=2,
            )
        except Exception:
            pass
    try:
        proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=1.0)
    except Exception:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            proc.wait(timeout=0.5)
        except Exception:
            pass


def _probe_stdio(name: str, cfg: dict[str, Any], timeout_s: float) -> str:
    """Spawn the MCP, send initialize, parse the first JSON-RPC line.

    Returns one of STATUS_OK / STATUS_DEGRADED. ``missing`` is decided by
    ``check_all`` BEFORE this is called (so we never spawn known-broken
    binaries).

    The child is always terminated before this returns — even on success —
    so we don't leave zombie npx/node processes around after the probe.
    """
    cmd = cfg.get("command", "")
    args = cfg.get("args", []) or []
    env = os.environ.copy()
    extra_env = cfg.get("env", {}) or {}
    if isinstance(extra_env, dict):
        for k, v in extra_env.items():
            if isinstance(v, str):
                env[str(k)] = _expand_env_placeholder(v)

    full_cmd = [cmd, *list(args)]

    proc = None
    try:
        proc = silent_popen(
            full_cmd,
            stdin=__import__("subprocess").PIPE,
            stdout=__import__("subprocess").PIPE,
            stderr=__import__("subprocess").PIPE,
            env=env,
        )
    except (OSError, FileNotFoundError, ValueError):
        return STATUS_DEGRADED

    deadline = time.monotonic() + timeout_s
    try:
        # Write initialize. If the child died already, this raises
        # BrokenPipeError; that's a degraded signal.
        try:
            assert proc.stdin is not None
            proc.stdin.write(_INIT_PAYLOAD)
            proc.stdin.flush()
        except (OSError, ValueError, AssertionError):
            return STATUS_DEGRADED

        # Read up to one line of stdout within the remaining budget. We use
        # communicate() with a hard timeout to keep this simple — partial
        # reads with select() on Windows pipes are unreliable. communicate
        # closes stdin which is what most MCP servers expect anyway.
        remaining = max(0.05, deadline - time.monotonic())
        try:
            stdout_b, _stderr_b = proc.communicate(timeout=remaining)
        except __import__("subprocess").TimeoutExpired:
            return STATUS_DEGRADED
        except (OSError, ValueError):
            return STATUS_DEGRADED

        if not stdout_b:
            return STATUS_DEGRADED

        # Parse first non-empty line as JSON-RPC. Some MCPs print logs
        # before the response; scan up to a few lines.
        for raw_line in stdout_b.splitlines()[:8]:
            line = raw_line.strip()
            if not line or not line.startswith(b"{"):
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("jsonrpc") != "2.0":
                continue
            if msg.get("error"):
                return STATUS_DEGRADED
            # Either a result or a notification — both indicate the server
            # is alive and speaking JSON-RPC.
            return STATUS_OK
        return STATUS_DEGRADED
    finally:
        # Codex S5-A C1: must kill the entire process tree on Windows —
        # npx.cmd → node → MCP server. Killing only the cmd leaks node + child.
        _kill_tree(proc)


def _probe_sse(name: str, cfg: dict[str, Any], timeout_s: float) -> str:
    """Open the SSE URL via urllib and check for a 2xx response.

    Connection refused / timeout / DNS failure → STATUS_DEGRADED.
    """
    url = cfg.get("url", "")
    if not url:
        return STATUS_DEGRADED
    req = urllib.request.Request(url, method="GET", headers={
        "Accept": "text/event-stream",
        "User-Agent": "ultron-mcp-health/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            status = getattr(resp, "status", 0) or resp.getcode()
            if 200 <= int(status) < 300:
                return STATUS_OK
            return STATUS_DEGRADED
    except urllib.error.HTTPError as exc:
        # 4xx/5xx — server is up but unhappy. Treat as degraded so the
        # fallback message kicks in.
        if 200 <= exc.code < 300:
            return STATUS_OK
        return STATUS_DEGRADED
    except (urllib.error.URLError, TimeoutError, OSError, ConnectionError):
        return STATUS_DEGRADED
    except Exception:
        return STATUS_DEGRADED


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def _probe_one(name: str, cfg: dict[str, Any], timeout_s: float) -> str:
    """Dispatch by transport type. Used as ThreadPoolExecutor target."""
    mcp_type = (cfg.get("type") or "").lower()
    if mcp_type == "sse" or "url" in cfg:
        return _probe_sse(name, cfg, timeout_s)
    # Default to stdio for any other shape (matches MCP convention).
    return _probe_stdio(name, cfg, timeout_s)


def check_all(timeout_s: float = _DEFAULT_TIMEOUT_S) -> dict[str, str]:
    """Probe every MCP in settings.json in parallel. Returns name → status.

    MCPs whose configured ``command`` does not resolve on disk or PATH are
    classified as ``missing`` without spawning anything. Everything else is
    probed concurrently with a worker pool capped at 4 (CPU-light, mostly
    I/O-bound). Total wall time is bounded by ``timeout_s`` plus a small
    constant for thread scheduling.
    """
    mcps = _load_settings_mcps()
    if not mcps:
        return {}

    # Pre-flight: split into "probe these" vs "obviously missing".
    to_probe: dict[str, dict[str, Any]] = {}
    results: dict[str, str] = {}
    for name, cfg in mcps.items():
        mcp_type = (cfg.get("type") or "").lower()
        if mcp_type == "sse" or "url" in cfg:
            # SSE MCPs are validated by reaching the URL — no on-disk check.
            to_probe[name] = cfg
            continue
        cmd = cfg.get("command", "")
        if not cmd or _resolve_command(cmd) is None:
            results[name] = STATUS_MISSING
            continue
        to_probe[name] = cfg

    if to_probe:
        # Codex S5-A M1: max_workers scales with probe count (cap 9), and
        # we add an overall deadline so doctor / health calls have a
        # predictable bound (≈ timeout_s + 1s scheduling slack) instead of
        # the previous ceil(N/4) × timeout_s worst case.
        max_workers = max(1, min(len(to_probe), 9))
        overall_deadline = time.monotonic() + timeout_s + 1.0
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(_probe_one, name, cfg, timeout_s): name
                for name, cfg in to_probe.items()
            }
            try:
                remaining = max(0.0, overall_deadline - time.monotonic())
                for fut in concurrent.futures.as_completed(futures, timeout=remaining):
                    name = futures[fut]
                    try:
                        results[name] = fut.result()
                    except Exception:
                        results[name] = STATUS_DEGRADED
            except concurrent.futures.TimeoutError:
                pass
            # Anything still pending after the deadline is degraded by definition.
            for fut, name in futures.items():
                if name not in results:
                    results[name] = STATUS_DEGRADED
                    try:
                        fut.cancel()
                    except Exception:
                        pass

    return results


# ---------------------------------------------------------------------------
# Output: health file + alerts
# ---------------------------------------------------------------------------

def write_health_file(results: dict[str, str], duration_ms: int,
                       out_path: Path = _HEALTH_PATH) -> None:
    """Atomic write of the health JSON. Same temp+os.replace pattern as
    skill_manifest._save_yaml — never expose a partial file to the hook.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "checked_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_ms": int(duration_ms),
        "results": results,
    }
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    # Codex S5-A C2: flush+fsync the temp before the rename so a crash
    # between write() and os.replace() never exposes a 0-byte tmp that
    # then becomes the canonical health file on the next reboot.
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            # Some filesystems / mocked file objects in tests don't support
            # fsync — flushing is the realistic best-effort guarantee.
            pass
    os.replace(str(tmp), str(out_path))


def emit_alerts(results: dict[str, str],
                 fallbacks: dict[str, dict[str, Any]],
                 dedupe_window_seconds: int = _ALERT_DEDUPE_WINDOW_SECONDS) -> int:
    """Write an alert for every MCP whose status is not ``ok``, deduped.

    Returns the count of alerts actually written (after dedupe). The
    check-then-write is delegated to :func:`alerts.write_dedupe` so it
    happens inside a single lock — two concurrent health-checks cannot
    both write a duplicate (Codex S5-A H2 fix).
    """
    written = 0
    for name, status in results.items():
        if status == STATUS_OK:
            continue
        meta = fallbacks.get(name, {})
        severity = str(meta.get("alert_severity") or "info").lower()
        if severity not in ("info", "warn", "blocking"):
            severity = "info"
        msg = meta.get("fallback_message") or f"MCP '{name}' is {status}; no fallback registered."
        # Trim very long fallback messages so the alerts table stays readable.
        if len(msg) > 240:
            msg = msg[:237] + "..."
        try:
            aid = _alerts.write_dedupe(
                severity=severity,
                source="mcp_health_check.py",
                message=f"MCP '{name}' status={status}. {msg}",
                dedupe_tag=f"mcp:{name}",
                window_seconds=dedupe_window_seconds,
                tags=[f"status:{status}", "s5"],
            )
            if aid is not None:
                written += 1
        except Exception:
            # alerts bus is best-effort — never let a write failure crash
            # the health check.
            continue
    return written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _format_table(results: dict[str, str]) -> str:
    if not results:
        return "(no MCPs configured)"
    rows = ["{:<20} {}".format("MCP", "STATUS"), "-" * 32]
    for name in sorted(results):
        rows.append("{:<20} {}".format(name, results[name]))
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="mcp_health_check.py",
        description="Probe ULTRON MCP servers and write ~/.ultron/.tmp/mcp-health.json.",
    )
    parser.add_argument(
        "--timeout", type=float, default=_DEFAULT_TIMEOUT_S,
        help=f"Per-probe timeout in seconds (default: {_DEFAULT_TIMEOUT_S})",
    )
    parser.add_argument("--quiet", action="store_true",
                         help="Suppress all stdout (for hook/cron use).")
    parser.add_argument("--json", action="store_true",
                         help="Print results as JSON (overrides --quiet).")
    parser.add_argument("--verbose", action="store_true",
                         help="Print errors to stderr.")
    parser.add_argument("--no-alerts", action="store_true",
                         help="Skip alert emission (testing / dry-run).")
    args = parser.parse_args(argv)

    t0 = time.perf_counter()
    try:
        results = check_all(timeout_s=args.timeout)
    except Exception as exc:
        if args.verbose:
            print(f"[mcp_health_check] check_all crashed: {exc!r}", file=sys.stderr)
        results = {}
    duration_ms = int((time.perf_counter() - t0) * 1000)

    try:
        write_health_file(results, duration_ms)
    except Exception as exc:
        if args.verbose:
            print(f"[mcp_health_check] write_health_file failed: {exc!r}",
                   file=sys.stderr)

    if not args.no_alerts and results:
        try:
            fallbacks = _load_fallbacks()
            emit_alerts(results, fallbacks)
        except Exception as exc:
            if args.verbose:
                print(f"[mcp_health_check] emit_alerts failed: {exc!r}",
                       file=sys.stderr)

    if args.json:
        out = {
            "checked_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "duration_ms": duration_ms,
            "results": results,
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif not args.quiet:
        # Human-friendly when run interactively. Show only non-ok rows by
        # default — silent on success — unless every row is OK and the user
        # wants confirmation.
        bad = {k: v for k, v in results.items() if v != STATUS_OK}
        if bad:
            print(_format_table(results))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
