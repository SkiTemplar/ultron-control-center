#!/usr/bin/env python3
"""
ULTRON HOOK · deny-secrets · v1.0 (v15.5.21 — agento-patronum style)

PreToolUse hook that blocks Read / Edit / Write / NotebookEdit / Bash access
to credential files: .env, private keys / keystores, anything under an
`.ssh/` directory, `~/.aws/credentials`, and `secrets.json` /
`credentials.json` / `service-account*.json`.

Critical when ULTRON runs with `--dangerously-skip-permissions`: it is the
tripwire that stops an agent from reading the user's secrets.

Design — SPECIFIC patterns, not a generic `*secret*` substring. A substring
match would flag legit code (`secrets_scanner.py`, `secrets_manager.py`) and
blow the "<1% false positive" target. Every rule below targets a real
credential-file shape.

Defense in depth — single-user offline system; this is a tripwire, NOT a
primary boundary. The hook never raises and always exits 0.
"""
from __future__ import annotations

import json
import sys
from typing import Optional

# Tools whose tool_input carries a file path.
_FILE_TOOLS = {"Read", "Edit", "Write", "NotebookEdit"}

# Extensions that are private keys / keystores by definition.
_KEY_EXTS = {"pem", "pfx", "p12", "key", "keystore", "jks"}

# .env.<x> suffixes that are SAFE — examples / templates carry no real secret.
_SAFE_ENV_SUFFIXES = (".example", ".sample", ".template", ".dist")

# SSH private-key basename prefixes.
_SSH_KEY_PREFIXES = ("id_rsa", "id_ed25519", "id_dsa", "id_ecdsa")

# Exact credential-file basenames.
_CRED_BASENAMES = {"secrets.json", "credentials.json"}


def _classify_path(path: str) -> Optional[str]:
    """Return a block reason for a credential file path, or None if safe."""
    if not path or not isinstance(path, str):
        return None
    norm = path.replace("\\", "/").strip().strip("\"'")
    if not norm:
        return None
    segments = [s for s in norm.split("/") if s]
    if not segments:
        return None
    basename = segments[-1]
    base_low = basename.lower()
    seg_low = {s.lower() for s in segments}
    ext = base_low.rsplit(".", 1)[-1] if "." in base_low else ""

    # 1. .env credential file (but NOT .env.example / .sample / .template)
    if base_low == ".env" or base_low.startswith(".env."):
        if not base_low.endswith(_SAFE_ENV_SUFFIXES):
            return "dotenv credential file"

    # 2. private key / keystore by extension
    if ext in _KEY_EXTS:
        return f"private key / keystore (.{ext})"

    # 3. SSH private key by basename
    if base_low.startswith(_SSH_KEY_PREFIXES):
        return "SSH private key"

    # 4. anything inside an .ssh directory
    if ".ssh" in seg_low:
        return "file inside an .ssh directory"

    # 5. ~/.aws/credentials
    if ".aws" in seg_low and base_low == "credentials":
        return "AWS credentials file"

    # 6. secrets.json / credentials.json / service-account*.json
    if base_low in _CRED_BASENAMES:
        return "credentials/secrets file"
    if base_low.startswith("service-account") and ext == "json":
        return "service-account key file"

    return None


def _classify_bash(command: str) -> Optional[str]:
    """Scan a shell command for tokens that reference a credential file."""
    if not command or not isinstance(command, str):
        return None
    for raw in command.split():
        token = raw.strip("\"';|&<>()`")
        # Only treat path-ish tokens as candidates (skip bare flags/words).
        if "/" not in token and not token.startswith("."):
            continue
        reason = _classify_path(token)
        if reason:
            return f"command accesses a {reason}"
    return None


def classify(tool_name: str, tool_input: dict) -> Optional[str]:
    """Return a block reason for this tool call, or None if it is allowed."""
    if not isinstance(tool_input, dict):
        return None
    if tool_name in _FILE_TOOLS:
        path = tool_input.get("file_path") or tool_input.get("notebook_path")
        return _classify_path(path or "")
    if tool_name == "Bash":
        return _classify_bash(tool_input.get("command", ""))
    return None


def main() -> None:
    try:
        data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    if not isinstance(data, dict) or data.get("hook_event_name") != "PreToolUse":
        sys.exit(0)

    try:
        reason = classify(data.get("tool_name", ""), data.get("tool_input", {}))
    except Exception:  # noqa: BLE001 — a hook must never crash the tool flow
        reason = None

    if reason:
        print(json.dumps({
            "systemMessage": (
                f"ULTRON deny-secrets blocked: {reason}. Credential files are "
                f"off-limits to the agent — open it from a manual shell if "
                f"genuinely needed."
            ),
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"BLOCKED (deny-secrets): {reason}",
            },
        }))
    sys.exit(0)


if __name__ == "__main__":
    main()
