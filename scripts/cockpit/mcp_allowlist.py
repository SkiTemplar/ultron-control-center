"""ULTRON v14 Sprint 5-C — MCP allowlist enforcement (F03 fix).

Reads ``~/.ultron/config/mcp-allowlist.yaml`` and decides whether a given
MCP server install should be allowed. Pure stdlib + optional pyyaml; the
fallback regex parser handles the documented schema.

Schema reminder::

    schema_version: "1"
    allow_unlisted: false
    trusted_publishers:
      - "@modelcontextprotocol"
    servers:
      foo:
        package: "@scope/foo-mcp"

Decision order:
  1. ``allow_unlisted: true`` -> always allow (kill-switch).
  2. ``name`` matches an entry in ``servers`` -> allow.
  3. ``package`` (case-insensitive) starts with any prefix in
     ``trusted_publishers`` -> allow.
  4. Otherwise -> reject.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
ALLOWLIST_PATH = ULTRON_HOME / "config" / "mcp-allowlist.yaml"


def _parse_allowlist_yaml_fallback(text: str) -> dict[str, Any]:
    """Tiny stdlib parser for the documented mcp-allowlist.yaml schema."""
    out: dict[str, Any] = {
        "allow_unlisted": False,
        "trusted_publishers": [],
        "servers": {},
    }
    section: str | None = None
    cur_server: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            section = None
            cur_server = None
            if stripped.endswith(":"):
                section = stripped[:-1].strip()
                if section == "servers":
                    out["servers"] = {}
                else:
                    out[section] = []
                continue
            if ":" in stripped:
                k, _, v = stripped.partition(":")
                key = k.strip()
                val = v.strip().strip('"').strip("'")
                if val.lower() == "true":
                    out[key] = True
                elif val.lower() == "false":
                    out[key] = False
                else:
                    out[key] = val
            continue
        if section == "trusted_publishers" and stripped.startswith("-"):
            v = stripped.lstrip("-").strip().strip('"').strip("'")
            out["trusted_publishers"].append(v)
            continue
        if section == "servers":
            if indent == 2 and stripped.endswith(":"):
                cur_server = stripped[:-1].strip()
                out["servers"][cur_server] = {}
                continue
            if cur_server is not None and ":" in stripped:
                k, _, v = stripped.partition(":")
                kk = k.strip()
                vv = v.strip().strip('"').strip("'")
                out["servers"][cur_server][kk] = vv
    return out


def load_allowlist(path: Path = ALLOWLIST_PATH) -> dict[str, Any]:
    """Return the parsed allowlist dict. Defaults are used if missing/broken."""
    defaults = {
        "schema_version": "1",
        "allow_unlisted": False,
        "trusted_publishers": [],
        "servers": {},
    }
    if not path.exists():
        return defaults
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return defaults
    parsed: dict[str, Any]
    try:
        import yaml  # type: ignore[import-not-found]
        loaded = yaml.safe_load(text)
        parsed = loaded if isinstance(loaded, dict) else {}
    except ImportError:
        parsed = _parse_allowlist_yaml_fallback(text)
    except Exception:
        parsed = {}
    merged = {**defaults, **parsed}
    if not isinstance(merged.get("trusted_publishers"), list):
        merged["trusted_publishers"] = []
    if not isinstance(merged.get("servers"), dict):
        merged["servers"] = {}
    return merged


def check_mcp_allowed(name: str, package: str | None = None,
                      path: Path | None = None) -> tuple[bool, str]:
    """Return (allowed, reason). Reason is a short human-readable string."""
    cfg = load_allowlist(path or ALLOWLIST_PATH)
    if cfg.get("allow_unlisted") is True:
        return True, "allow_unlisted=true"
    servers = cfg.get("servers") or {}
    if isinstance(name, str) and name in servers:
        return True, f"explicit allow: servers.{name}"
    if isinstance(package, str) and package:
        pkg_low = package.strip().lower()
        for prefix in cfg.get("trusted_publishers") or []:
            if not isinstance(prefix, str) or not prefix:
                continue
            pref_low = prefix.strip().lower()
            # F-MaxDual-R2-M1 fix: require an exact scope-boundary match
            # (`@scope` exact OR `@scope/...`). Naive `startswith` would
            # let `@upstash-evil/foo` ride on `@upstash` trust.
            if pkg_low == pref_low or pkg_low.startswith(pref_low + "/"):
                return True, f"trusted publisher prefix: {prefix}"
    return False, "not in allowlist and no trusted publisher match"
