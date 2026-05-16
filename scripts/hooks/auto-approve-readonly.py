#!/usr/bin/env python3
"""
ULTRON HOOK · auto-approve-readonly · v2.0 (SEC-02 hardening)
Auto-aprueba tools de solo lectura (Read, Glob, Grep, WebFetch, WebSearch) en PreToolUse.
Reduce permission prompts para flujo de exploración.

v2.0 (repo-evaluator TOTAL Triple 2026-05-03 → SEC-02):
  - DENY_PATH_PATTERNS: Read sobre paths sensibles (.ssh, .aws, credentials,
    .env, *token*, *secret*) NO se auto-aprueba — cae a prompt humano.
    Cierra V-CRIT-6 (prompt-injection exfil sin red).
  - WEBFETCH_ALLOWLIST: WebFetch a hosts conocidos se auto-aprueba; resto
    cae a prompt; metadata-service / localhost se rechazan duro (deny).

Nota: este hook es defensa en profundidad, no boundary primario. La
boundary primaria sigue siendo la disciplina del agente y el modelo de
permisos nativo de Claude Code.

Uso en ~/.claude/settings.json:
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read|Glob|Grep|WebFetch|WebSearch",
      "hooks": [{
        "type": "command",
        "command": "python %USERPROFILE%/.ultron/scripts/hooks/auto-approve-readonly.py"
      }]
    }]
  }
}
"""
from __future__ import annotations

import json
import re
import sys
from urllib.parse import urlparse

READ_ONLY_TOOLS = {"Read", "Glob", "Grep", "WebFetch", "WebSearch",
                    "TaskList", "TaskGet", "TaskOutput"}

# Pre-compiled at module level — cheap per-invocation. SEC-02a.
DENY_PATH_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"[\\/]\.ssh($|[\\/])",
    r"[\\/]\.aws($|[\\/])",
    r"[\\/]\.gcp($|[\\/])",
    r"[\\/]\.kube($|[\\/])",
    r"[\\/]\.codex[\\/]auth\.json",
    r"[\\/]\.gemini[\\/]oauth_creds\.json",
    r"[\\/]\.claude[\\/]\.credentials\.json",
    r"[\\/]\.claude[\\/]history\.jsonl",
    r"[\\/]\.tmp\.driveupload[\\/]",
    r"[\\/]\.tmp\.drivedownload[\\/]",
    r"[\\/]credentials?(\.[a-z]+)?$",
    r"[\\/]\.env(\.|$)",
    r"[\\/].*token.*\.(json|txt|toml|yaml|yml)$",
    r"[\\/].*secret.*\.(json|txt|toml|yaml|yml)$",
    r"[\\/]private[_\-]?key",
    r"[\\/]id_rsa($|\.pub$)",
    r"[\\/]id_ed25519($|\.pub$)",
))

# SEC-02b — WebFetch governance.
# Hosts (or suffixes) auto-approved without prompt:
WEBFETCH_ALLOWLIST = (
    # Anthropic ecosystem
    "anthropic.com", "claude.com", "claude.ai",
    # Code / docs / refs
    "github.com", "raw.githubusercontent.com", "gist.githubusercontent.com",
    "githubusercontent.com",
    "developer.mozilla.org", "stackoverflow.com",
    "docs.python.org", "pypi.org", "npmjs.com",
    "go.dev", "rust-lang.org", "doc.rust-lang.org",
    "kotlinlang.org", "developer.android.com",
    "docs.unrealengine.com", "docs.unity3d.com",
    # Standards / specs
    "tc39.es", "w3.org", "ietf.org", "rfc-editor.org",
    # Common AI/tooling docs
    "openai.com", "platform.openai.com",
    "supabase.com", "vercel.com", "nextjs.org",
)
# Hosts (or suffixes) rejected hard — never approve, never prompt:
WEBFETCH_DENYLIST = (
    "169.254.169.254",        # AWS/GCP metadata
    "metadata.google.internal",
    "metadata.azure.com",
    "100.100.100.200",        # Alibaba metadata
    "localhost", "127.0.0.1", "0.0.0.0", "::1",
)


def _path_is_sensitive(path: str) -> bool:
    if not path:
        return False
    # Normalize Windows backslashes for the regex set above
    norm = path.replace("\\", "/").lower()
    return any(p.search(norm) for p in DENY_PATH_PATTERNS)


def _host_in(host: str, suffixes) -> bool:
    if not host:
        return False
    h = host.lower()
    return any(h == s or h.endswith("." + s) or h == s for s in suffixes)


def _emit_decision(decision: str, reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    if input_data.get("hook_event_name") != "PreToolUse":
        sys.exit(0)

    tool = input_data.get("tool_name", "")
    if tool not in READ_ONLY_TOOLS:
        sys.exit(0)

    tool_input = input_data.get("tool_input", {}) or {}

    # SEC-02a — Read/Glob/Grep against sensitive paths → no auto-approve
    if tool in {"Read", "Glob", "Grep"}:
        candidate = (
            tool_input.get("file_path")
            or tool_input.get("path")
            or tool_input.get("pattern", "")
        )
        if isinstance(candidate, str) and _path_is_sensitive(candidate):
            # Don't deny outright — just abstain (let CC default permission
            # flow prompt the user). Avoids over-blocking benign legitimate
            # access (e.g., user explicitly asks to inspect their .env).
            sys.exit(0)

    # SEC-02b — WebFetch governance
    if tool == "WebFetch":
        url = tool_input.get("url", "")
        host = ""
        try:
            host = urlparse(url).hostname or ""
        except (ValueError, AttributeError):
            host = ""
        if _host_in(host, WEBFETCH_DENYLIST):
            _emit_decision("deny",
                            f"ULTRON SEC-02: WebFetch host '{host}' is in denylist "
                            f"(metadata-service / localhost). Blocked.")
            sys.exit(0)
        if not _host_in(host, WEBFETCH_ALLOWLIST):
            # Unknown host — abstain → falls back to user prompt.
            sys.exit(0)

    _emit_decision("allow",
                    f"Read-only tool '{tool}' auto-approved by ULTRON hook (v2.0)")


if __name__ == "__main__":
    main()
