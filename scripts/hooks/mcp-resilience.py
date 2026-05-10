#!/usr/bin/env python3
"""ULTRON v14 Sprint 5 Sub-pilar A — MCP resilience PreToolUse hook.

Fires on every tool call (matcher: ``mcp__.*``). When the user invokes a
tool whose MCP server is currently flagged ``degraded`` / ``missing`` in
``~/.ultron/.tmp/mcp-health.json``, we inject a one-line note into Claude's
context advising the fallback path. The tool call itself is NEVER blocked —
the contract is "warn, don't block": if Claude wants to try anyway, that's
its prerogative.

CONTRACT
--------
* Always exit 0. The hook must never break a tool call.
* No injection unless health file exists AND the targeted MCP is non-ok.
* Silent (zero stdout) for healthy MCPs and non-MCP tools.
* Hard latency budget: <40ms p95 — this hook fires on every tool use.
* No third-party deps. No heavy logic. Read+parse a small JSON file, match,
  emit one line via the additionalContext JSON envelope.

OUTPUT FORMAT
-------------
We use the Claude Code hook JSON output format::

    {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "[ULTRON·MCP-DEGRADED] ..."
    }}

Anything else (text, tracebacks) sent to stdout would pollute the surface
shown to Claude. On any internal failure we fall through to silent exit 0.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

# Paths — resolved once at module load. The hook is a fresh process per
# invocation so no in-process caching is needed (and would not survive).
_HEALTH_PATH = Path.home() / ".ultron" / ".tmp" / "mcp-health.json"
_FALLBACKS_PATH = Path.home() / ".ultron" / "config" / "mcp-fallbacks.yaml"

# Bounded stdin read — same defensive cap as intent-dispatcher.
_MAX_STDIN_BYTES = 1_048_576


def _read_stdin_bounded() -> bytes:
    """Read up to _MAX_STDIN_BYTES from stdin. Returns possibly-empty bytes."""
    chunks: list[bytes] = []
    total = 0
    fd = 0
    while total < _MAX_STDIN_BYTES:
        try:
            chunk = os.read(fd, min(8192, _MAX_STDIN_BYTES - total))
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def _normalize(name: str) -> str:
    """Normalize an MCP server name to its sanitized tool-name form.

    Claude Code surfaces MCP tools as ``mcp__<name>__<tool>`` where
    ``<name>`` has had every ``-`` and ``.`` replaced with ``_``. To match
    we apply the same transform on both sides.
    """
    return name.replace("-", "_").replace(".", "_")


def _extract_mcp_server_from_tool(tool_name: str) -> str | None:
    """Return the (sanitized) MCP server slug for a tool, or None.

    Tool names look like ``mcp__gemini__query`` — the server is the
    component between the first and second double-underscore. Anything
    that doesn't match the pattern is not an MCP tool.
    """
    if not isinstance(tool_name, str) or not tool_name.startswith("mcp__"):
        return None
    rest = tool_name[5:]
    sep = rest.find("__")
    if sep <= 0:
        return None
    return rest[:sep]


def _load_health() -> dict[str, str] | None:
    """Read mcp-health.json and return the results dict, or None.

    None signals "no opinion" — the file is missing, malformed, or the
    schema is wrong — and the hook stays silent.
    """
    if not _HEALTH_PATH.exists():
        return None
    try:
        with _HEALTH_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, dict):
        return None
    return {str(k): str(v) for k, v in results.items()}


def _load_fallback_for(mcp_canonical_name: str) -> dict[str, Any] | None:
    """Find the fallback entry for an MCP by its canonical (settings.json) name.

    The hook uses a stripped-down YAML reader rather than importing the full
    cockpit loader — keeps the hot path dep-free and fast. PyYAML is used
    when available; otherwise the same line-based parser as
    mcp_health_check._load_fallbacks.
    """
    if not _FALLBACKS_PATH.exists():
        return None
    try:
        import yaml  # type: ignore[import-not-found]
        with _FALLBACKS_PATH.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        if isinstance(data, list):
            for entry in data:
                if isinstance(entry, dict) and entry.get("mcp_name") == mcp_canonical_name:
                    return entry
        return None
    except ImportError:
        pass
    # Stdlib fallback parser — small and forgiving.
    current: dict[str, Any] | None = None
    try:
        with _FALLBACKS_PATH.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.rstrip("\n")
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if line.startswith("- "):
                    if current and current.get("mcp_name") == mcp_canonical_name:
                        return current
                    current = {}
                    rest = line[2:].strip()
                    if ":" in rest:
                        k, _, v = rest.partition(":")
                        current[k.strip()] = _coerce(v.strip())
                elif current is not None and ":" in stripped:
                    k, _, v = stripped.partition(":")
                    current[k.strip()] = _coerce(v.strip())
        if current and current.get("mcp_name") == mcp_canonical_name:
            return current
    except OSError:
        return None
    return None


def _coerce(value: str) -> Any:
    if not value:
        return None
    if value.lower() == "null":
        return None
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


def _find_canonical_name(sanitized: str, results: dict[str, str]) -> str | None:
    """Look up an MCP by either its raw or sanitized form.

    The health file uses the raw settings.json keys (``gemini-flash``); the
    tool name uses the sanitized form (``gemini_flash``). We try raw first
    (no-op cost when names match) then map every key through _normalize and
    compare.
    """
    if sanitized in results:
        return sanitized
    for raw_name in results:
        if _normalize(raw_name) == sanitized:
            return raw_name
    return None


def _emit_additional_context(text: str) -> None:
    """Write the JSON envelope that injects context into Claude's view."""
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": text,
        }
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    try:
        raw = _read_stdin_bounded()
        if not raw:
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return
        if not isinstance(data, dict):
            return

        tool_name = data.get("tool_name")
        sanitized = _extract_mcp_server_from_tool(tool_name) if tool_name else None
        if not sanitized:
            return  # not an MCP tool — nothing to do

        results = _load_health()
        if results is None:
            return  # no opinion on health — stay silent

        canonical = _find_canonical_name(sanitized, results)
        if canonical is None:
            return  # MCP not in health file (newly added?) — stay silent

        status = results.get(canonical, "ok")
        if status == "ok":
            return  # MCP healthy — silent passthrough

        fallback = _load_fallback_for(canonical) or {}
        message = fallback.get("fallback_message") or (
            f"MCP '{canonical}' is currently {status}. "
            "No fallback registered; consider native alternatives."
        )
        skill_hint = fallback.get("fallback_skill")

        # One-line additionalContext payload — bracketed prefix so Claude's
        # parsing recognizes it as ULTRON-issued context, consistent with
        # the intent-dispatcher routing line format.
        line = (
            f"[ULTRON·MCP-DEGRADED] {canonical} status={status}. "
            f"Fallback: {message}"
        )
        if skill_hint:
            line += f" (suggested skill: {skill_hint})"

        _emit_additional_context(line)
    except BaseException:
        # NEVER write tracebacks to stdout — would pollute Claude context.
        pass
    finally:
        # Hard contract: the hook ALWAYS exits 0, never blocks the tool.
        sys.exit(0)


if __name__ == "__main__":
    main()
