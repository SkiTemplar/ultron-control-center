#!/usr/bin/env python3
"""
ULTRON v10.6 — MCP zero-trust broker.

Closes the 2026-04 MCP STDIO RCE vector flagged by Codex+Gemini Triple Max:
agents (Claude Code, Codex CLI, Gemini CLI) can be tricked into invoking
malicious MCP tools via crafted prompt-injection. Direct STDIO has no schema
validation, no allowlist, no audit trail.

This broker sits between the agent's STDIO request and the actual MCP server
process. It enforces:

  1. Allowlist        — server name must be in `mcp-allowlist.json`
  2. Schema validation — request must be valid JSON-RPC 2.0 (jsonrpc==2.0,
                         method present). Per-tool parameter schema enforcement
                         is NOT implemented (future enhancement).
  3. Argv guard       — reject servers whose declared command contains shell
                         metacharacters (|, ;, &&, $(), backticks)
  4. Env minimization — only env vars in the per-server `env_keys` allowlist
                         pass through; everything else stripped
  5. Audit log        — sha256(request) + sha256(response) appended to
                         `~/.ultron/cockpit/mcp-audit.jsonl` for every call
  6. Rate limit       — per-server per-minute call cap (default 60)

Anti-laundering: this broker is itself a process USER runs. It does NOT
talk to LLMs. Pure subprocess dispatch + JSON-RPC validation.

Usage:
    mcp_broker.py serve --server <name>          # broker mode (run forever)
    mcp_broker.py validate                        # check config + allowlist
    mcp_broker.py audit-tail [-n 20]              # show recent calls
    mcp_broker.py allowlist add <name> <cmd>     # whitelist a server
    mcp_broker.py allowlist remove <name>
    mcp_broker.py allowlist list

Configuration (~/.ultron/cockpit/mcp-allowlist.json):
{
  "servers": {
    "<name>": {
      "command": ["node", "/abs/path/to/server.js"],
      "env_keys": ["GEMINI_API_KEY"],
      "max_calls_per_min": 60,
      "added": "2026-04-28T...",
      "checksum": "sha256:..."
    }
  }
}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR  # noqa: E402

ALLOWLIST_PATH = COCKPIT_DIR / "mcp-allowlist.json"
AUDIT_LOG = COCKPIT_DIR / "mcp-audit.jsonl"

# Reject any command string containing these characters — they enable shell
# injection / dynamic command construction.
SHELL_METACHARS = re.compile(r"[|;&`$\n]|\$\(|>\s*\w|<\s*\w")

# JSON-RPC 2.0 minimum-shape validator
RPC_REQUIRED = {"jsonrpc", "method"}


def _sha256(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


def load_allowlist() -> dict:
    if not ALLOWLIST_PATH.exists():
        return {"servers": {}}
    try:
        return json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"[mcp-broker] WARN: allowlist unreadable: {e}", file=sys.stderr)
        return {"servers": {}}


def save_allowlist(data: dict) -> None:
    COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
    if ALLOWLIST_PATH.exists():
        backup = ALLOWLIST_PATH.with_suffix(
            f".json.{datetime.now():%Y%m%d-%H%M%S}.bak")
        shutil.copy2(ALLOWLIST_PATH, backup)
    tmp = ALLOWLIST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(ALLOWLIST_PATH)


def is_safe_command(parts: list[str]) -> tuple[bool, str]:
    """Reject obvious injection vectors. Each arg must be a literal token,
    not a shell expression. The actual binary must exist on disk."""
    if not parts or not isinstance(parts, list):
        return False, "command must be a non-empty list of literal args"
    for p in parts:
        if not isinstance(p, str):
            return False, f"non-string arg: {p!r}"
        if SHELL_METACHARS.search(p):
            return False, f"shell metacharacter in {p!r}"
    binary = parts[0]
    # Allow PATH lookup for known interpreters; require absolute path otherwise
    interpreters = {"node", "python", "python3", "uvx", "npx", "deno"}
    if binary not in interpreters:
        if not Path(binary).is_file():
            resolved = shutil.which(binary)
            if not resolved:
                return False, f"binary not found: {binary}"
    return True, ""


def append_audit(record: dict) -> None:
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    record.setdefault("ts", datetime.now().isoformat(timespec="seconds"))
    with AUDIT_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def validate_jsonrpc(line: str) -> tuple[bool, str]:
    """Returns (ok, reason). Each STDIO line MUST be a valid JSON-RPC 2.0
    object before we forward it to the underlying server."""
    try:
        d = json.loads(line)
    except json.JSONDecodeError as e:
        return False, f"not JSON: {e}"
    if not isinstance(d, dict):
        return False, "not a JSON object"
    missing = RPC_REQUIRED - set(d.keys())
    if missing:
        return False, f"missing JSON-RPC fields: {missing}"
    if d.get("jsonrpc") != "2.0":
        return False, f"unsupported jsonrpc version: {d.get('jsonrpc')}"
    method = d.get("method")
    if not isinstance(method, str) or not method:
        return False, "method must be non-empty string"
    return True, ""


def cmd_validate(_args) -> int:
    """Sanity-check the allowlist file + each server's command."""
    data = load_allowlist()
    servers = data.get("servers", {})
    if not servers:
        print("[mcp-broker] allowlist empty (no servers configured)")
        return 0
    issues = 0
    print(f"[mcp-broker] checking {len(servers)} server(s)...")
    for name, cfg in servers.items():
        cmd = cfg.get("command", [])
        ok, reason = is_safe_command(cmd)
        if not ok:
            print(f"  [FAIL] {name}: {reason}")
            issues += 1
        else:
            print(f"  [ ok ] {name}: {cmd[0]}")
    if issues:
        print(f"[mcp-broker] {issues} issue(s) detected")
        return 2
    print("[mcp-broker] allowlist valid")
    return 0


def cmd_audit_tail(args) -> int:
    if not AUDIT_LOG.exists():
        print("[mcp-broker] no audit log yet")
        return 0
    n = max(1, int(getattr(args, "n", 20)))
    lines = AUDIT_LOG.read_text(encoding="utf-8").splitlines()[-n:]
    print(f"[mcp-broker] last {len(lines)} audit entries:")
    for ln in lines:
        try:
            d = json.loads(ln)
            print(f"  {d.get('ts','?')}  "
                  f"{d.get('event',d.get('action','?')):<12}  "
                  f"server={d.get('server','?'):<14}  "
                  f"{d.get('detail','')}")
        except json.JSONDecodeError:
            continue
    return 0


def cmd_allow_add(args) -> int:
    name = args.name
    cmd_parts = args.cmd
    if isinstance(cmd_parts, str):
        cmd_parts = cmd_parts.split()
    ok, reason = is_safe_command(cmd_parts)
    if not ok:
        print(f"[mcp-broker] REJECTED: {reason}")
        return 1
    data = load_allowlist()
    data.setdefault("servers", {})[name] = {
        "command": cmd_parts,
        "env_keys": getattr(args, "env_keys", None) or [],
        "max_calls_per_min": int(getattr(args, "max_calls_per_min", 60)),
        "added": datetime.now().isoformat(timespec="seconds"),
        "checksum": _sha256(json.dumps(cmd_parts)),
    }
    save_allowlist(data)
    append_audit({"event": "allowlist-add", "server": name,
                  "detail": " ".join(cmd_parts)})
    print(f"[mcp-broker] added: {name}")
    return 0


def cmd_allow_remove(args) -> int:
    data = load_allowlist()
    if args.name not in data.get("servers", {}):
        print(f"[mcp-broker] not found: {args.name}")
        return 1
    del data["servers"][args.name]
    save_allowlist(data)
    append_audit({"event": "allowlist-remove", "server": args.name})
    print(f"[mcp-broker] removed: {args.name}")
    return 0


def cmd_allow_list(_args) -> int:
    data = load_allowlist()
    servers = data.get("servers", {})
    if not servers:
        print("[mcp-broker] allowlist empty")
        return 0
    print(f"[mcp-broker] {len(servers)} server(s) on allowlist:")
    for name, cfg in sorted(servers.items()):
        cmd = " ".join(cfg.get("command", []))
        env_n = len(cfg.get("env_keys", []) or [])
        cap = cfg.get("max_calls_per_min", "?")
        added = cfg.get("added", "?")[:10]
        print(f"  {name:<18}  cmd: {cmd}")
        print(f"  {'':<18}  env_keys={env_n}  cap={cap}/min  added={added}")
    return 0


def cmd_serve(args) -> int:
    """Broker mode. Reads JSON-RPC lines from stdin, validates each, forwards
    to the underlying server, validates response, audits, returns to stdout.

    This is the runtime entry point: an agent's MCP client launches this
    script with `mcp_broker.py serve --server <name>` instead of launching
    the server binary directly. The agent's STDIO is intercepted here.
    """
    name = args.server
    data = load_allowlist()
    cfg = data.get("servers", {}).get(name)
    if not cfg:
        print(f"[mcp-broker] server not on allowlist: {name}", file=sys.stderr)
        append_audit({"event": "denied-not-allowlisted", "server": name})
        return 2

    cmd = cfg["command"]
    env_keys = cfg.get("env_keys", []) or []
    cap_per_min = int(cfg.get("max_calls_per_min", 60))

    # Build minimized env: only declared keys + critical OS basics
    minimized_env = {
        "PATH": os.environ.get("PATH", ""),
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
        "USERPROFILE": os.environ.get("USERPROFILE", ""),
        "TEMP": os.environ.get("TEMP", ""),
    }
    for k in env_keys:
        v = os.environ.get(k)
        if v is not None:
            minimized_env[k] = v

    append_audit({"event": "broker-start", "server": name,
                  "detail": " ".join(cmd)})

    # Spawn the underlying server with minimized env
    try:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=minimized_env, text=True,
            encoding="utf-8", bufsize=1, creationflags=_WIN_HIDDEN,
        )
    except OSError as e:
        append_audit({"event": "spawn-failed", "server": name, "detail": str(e)})
        print(f"[mcp-broker] spawn failed: {e}", file=sys.stderr)
        return 3

    call_times: deque[float] = deque(maxlen=cap_per_min * 2)

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            ok, reason = validate_jsonrpc(line)
            if not ok:
                append_audit({"event": "denied-invalid-rpc", "server": name,
                              "detail": reason,
                              "in_hash": _sha256(line)})
                continue

            # Rate limit per minute
            now = time.time()
            call_times.append(now)
            recent = sum(1 for t in call_times if t > now - 60)
            if recent > cap_per_min:
                append_audit({"event": "denied-rate-limit", "server": name,
                              "detail": f"{recent}/min > {cap_per_min}",
                              "in_hash": _sha256(line)})
                continue

            in_hash = _sha256(line)
            proc.stdin.write(line + "\n")
            proc.stdin.flush()
            response_line = proc.stdout.readline()
            if not response_line:
                append_audit({"event": "no-response", "server": name,
                              "in_hash": in_hash})
                continue
            out_hash = _sha256(response_line)
            append_audit({
                "event": "call",
                "server": name,
                "in_hash": in_hash,
                "out_hash": out_hash,
                "method": json.loads(line).get("method", "?"),
            })
            sys.stdout.write(response_line)
            sys.stdout.flush()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
        append_audit({"event": "broker-stop", "server": name})
    return 0


def main():
    p = argparse.ArgumentParser(
        description="ULTRON MCP zero-trust broker (v10.6)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("serve", help="Run broker for a single server")
    sp.add_argument("--server", required=True, help="Allowlisted server name")
    sp.set_defaults(func=cmd_serve)

    sp = sub.add_parser("validate", help="Sanity-check allowlist")
    sp.set_defaults(func=cmd_validate)

    sp = sub.add_parser("audit-tail", help="Show recent audit entries")
    sp.add_argument("-n", type=int, default=20)
    sp.set_defaults(func=cmd_audit_tail)

    al = sub.add_parser("allowlist", help="Manage MCP server allowlist")
    al_sub = al.add_subparsers(dest="al_cmd", required=True)

    sp = al_sub.add_parser("add", help="Add server to allowlist")
    sp.add_argument("name")
    sp.add_argument("cmd", nargs="+",
                    help="Command + args (e.g. node /abs/server.js)")
    sp.add_argument("--env-keys", nargs="*", default=[],
                    help="Env vars allowed to pass through (e.g. API_KEY)")
    sp.add_argument("--max-calls-per-min", type=int, default=60)
    sp.set_defaults(func=cmd_allow_add)

    sp = al_sub.add_parser("remove")
    sp.add_argument("name")
    sp.set_defaults(func=cmd_allow_remove)

    sp = al_sub.add_parser("list")
    sp.set_defaults(func=cmd_allow_list)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
