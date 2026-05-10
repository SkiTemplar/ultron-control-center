#!/usr/bin/env python3
"""
ULTRON v10.3 Cockpit - MCP Installer.

Public MCP server installer driven by ~/.ultron/cockpit/mcp-catalog.json.

Subcommands:
    list                    Show catalog with installed-status flag
    catalog                 Verbose details (env vars, prompts, docs URL)
    install <id>            Interactive install: prompts for keys -> writes settings.json
    install <id>            Install from catalog directly to settings.json
    uninstall <id>          Remove from settings.json (with backup)
    validate <id>           JSON-RPC handshake test against installed config

Settings.json edits are atomic (tmp + replace) with timestamped .bak backup.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import Cockpit, COCKPIT_DIR  # noqa: E402


# ── Paths ────────────────────────────────────────────────────────────────────
CATALOG_PATH  = COCKPIT_DIR / "mcp-catalog.json"
SETTINGS_PATH = Path.home() / ".claude" / "settings.json"


# ── ANSI colors (Windows Terminal supports ANSI by default in PS 5.1+) ───────

def _color(s: str, code: str) -> str:
    return f"\033[{code}m{s}\033[0m"

def green(s):  return _color(s, "32")
def yellow(s): return _color(s, "33")
def red(s):    return _color(s, "31")
def cyan(s):   return _color(s, "36")
def gray(s):   return _color(s, "90")


# ── Catalog / settings IO ────────────────────────────────────────────────────

def load_catalog() -> list[dict]:
    if not CATALOG_PATH.exists():
        print(red(f"[mcp] Catalog not found: {CATALOG_PATH}"))
        print(gray("    Re-create from skills/ultron repo or write your own."))
        sys.exit(1)
    data = Cockpit.read_json(CATALOG_PATH, default={"mcps": []})
    return data.get("mcps", [])


def find_in_catalog(catalog: list[dict], mcp_id: str) -> dict | None:
    for m in catalog:
        if m.get("id") == mcp_id:
            return m
    return None


def load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return {}
    return Cockpit.read_json(SETTINGS_PATH, default={})


def write_settings_atomic(settings: dict) -> Path:
    """Atomic settings.json write with timestamped backup. Returns backup path."""
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = SETTINGS_PATH.with_suffix(f".json.{stamp}.bak")

    if SETTINGS_PATH.exists():
        shutil.copy2(SETTINGS_PATH, backup)

    tmp = SETTINGS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, SETTINGS_PATH)
    return backup


def get_installed_mcps(settings: dict) -> set[str]:
    return set((settings.get("mcpServers") or {}).keys())


# ── Template substitution ────────────────────────────────────────────────────

_PLACEHOLDER_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def substitute(template, values: dict[str, str]):
    """Recursively replace ${VAR} placeholders in dict/list/str using `values`."""
    if isinstance(template, str):
        def repl(m):
            key = m.group(1)
            return values.get(key, m.group(0))
        return _PLACEHOLDER_RE.sub(repl, template)
    if isinstance(template, list):
        return [substitute(x, values) for x in template]
    if isinstance(template, dict):
        return {k: substitute(v, values) for k, v in template.items()}
    return template


def build_config(mcp: dict, answers: dict[str, str]) -> dict:
    """Render the settings_template using collected answers, including args additions."""
    template = json.loads(json.dumps(mcp["settings_template"]))
    config = substitute(template, answers)

    # Handle prompts that contribute extra args (applies_to: "args")
    for prompt in mcp.get("prompts", []):
        if prompt.get("applies_to") != "args":
            continue
        key = prompt["key"]
        val = answers.get(key, "")
        if not val:
            continue

        if "if_yes" in prompt:
            if val.lower() in ("y", "yes", "true", "1"):
                config.setdefault("args", []).append(prompt["if_yes"])
        elif "format" in prompt:
            config.setdefault("args", []).append(prompt["format"].format(value=val))
        else:
            # Plain positional substitution already handled by substitute() if
            # the template references ${KEY} in args.
            pass

    return config


# ── Interactive prompting ────────────────────────────────────────────────────

def prompt_user(mcp: dict, non_interactive_env: dict[str, str] | None = None) -> dict[str, str]:
    """Walk through catalog prompts, return collected answers."""
    answers = {}
    env_overrides = non_interactive_env or {}

    prompts = mcp.get("prompts", [])
    if prompts:
        print(cyan(f"\n[mcp] Configuring {mcp['name']}"))
        if mcp.get("docs_url"):
            print(gray(f"      Docs: {mcp['docs_url']}"))
        print()

    for p in prompts:
        key     = p["key"]
        label   = p["label"]
        secret  = p.get("secret", False)
        default = p.get("default", "")
        url     = p.get("url_hint")

        if key in env_overrides:
            answers[key] = env_overrides[key]
            shown = "***" if secret else env_overrides[key]
            print(f"  {key} = {shown}  {gray('(from --env)')}")
            continue

        if url:
            print(gray(f"      Get key at: {url}"))

        suffix = f" [default: {default}]" if default else ""
        prompt_text = f"  {label}{suffix}: "

        if secret:
            val = getpass.getpass(prompt_text)
        else:
            val = input(prompt_text)

        if not val.strip() and default:
            val = default

        answers[key] = val.strip()

    return answers


# ── Subcommand: list ─────────────────────────────────────────────────────────

def cmd_list(args):
    catalog  = load_catalog()
    settings = load_settings()
    installed = get_installed_mcps(settings)

    print(cyan(f"\nMCP Catalog ({len(catalog)} entries)\n"))
    print(f"  {'STATUS':<10} {'ID':<22} {'CATEGORY':<14} NAME")
    print(f"  {'─'*10} {'─'*22} {'─'*14} {'─'*30}")

    for m in sorted(catalog, key=lambda x: (x.get("category", ""), x["id"])):
        is_installed = m["id"] in installed
        status = green("INSTALLED") if is_installed else gray("available")
        marker = "*" if is_installed else " "
        print(f"  {marker} {status:<19} {m['id']:<22} {m.get('category','-'):<14} {m['name']}")

    print()
    print(gray(f"  Settings: {SETTINGS_PATH}"))
    print(gray(f"  Catalog:  {CATALOG_PATH}"))
    print()
    return 0


# ── Subcommand: catalog (verbose) ────────────────────────────────────────────

def cmd_catalog(args):
    catalog = load_catalog()
    target  = args.id

    for m in catalog:
        if target and m["id"] != target:
            continue
        print(cyan(f"\n[{m['id']}] {m['name']}"))
        print(f"  Category:    {m.get('category','-')}")
        print(f"  Description: {m.get('description','-')}")
        print(f"  Docs:        {m.get('docs_url','-')}")
        print(f"  Transport:   {m.get('transport','stdio')}")
        print(f"  Multi-acct:  {m.get('multi_account', False)}")
        pkg = m.get("package", {})
        if pkg:
            print(f"  Package:     {pkg.get('type','?')}/{pkg.get('name','?')}")
        prompts = m.get("prompts", [])
        if prompts:
            print(f"  Prompts ({len(prompts)}):")
            for p in prompts:
                tag = "[secret]" if p.get("secret") else "[plain]"
                print(f"    - {p['key']:<26} {tag}  {p['label']}")
        else:
            print(f"  Prompts:     (none)")
    print()
    return 0


# ── Subcommand: install ──────────────────────────────────────────────────────

def cmd_install(args):
    catalog = load_catalog()
    mcp = find_in_catalog(catalog, args.id)
    if not mcp:
        print(red(f"[mcp] Unknown id: {args.id}"))
        print(gray("     Run: ultron mcp list"))
        return 1

    settings = load_settings()
    installed = get_installed_mcps(settings)

    if mcp["id"] in installed and not args.force:
        print(yellow(f"[mcp] '{mcp['id']}' is already installed."))
        print(gray("     Use --force to overwrite, or `ultron mcp uninstall {0}` first.".format(mcp["id"])))
        return 1

    # F03 + F-MaxDual-R2-Hnew2 fix: allowlist enforcement BEFORE
    # settings.json modification. If the allowlist module cannot import,
    # FAIL CLOSED — refuse install unless --force, and log the bypass.
    # Previous behaviour silently set check_mcp_allowed=None and let
    # everything through, which meant a packaging regression could
    # disable the security check entirely.
    try:
        from mcp_allowlist import check_mcp_allowed
        _allowlist_import_error = None
    except Exception as exc:  # noqa: BLE001
        check_mcp_allowed = None  # type: ignore[assignment]
        _allowlist_import_error = exc

    if check_mcp_allowed is None:
        if not getattr(args, "force", False):
            print(red(
                "[mcp install] BLOCKED: allowlist module failed to import "
                f"({type(_allowlist_import_error).__name__}: "
                f"{_allowlist_import_error})"), file=sys.stderr)
            print(gray("  This is a fail-closed safety stop. Use --force to "
                      "override (alert logged)."), file=sys.stderr)
            return 2
        try:
            import alerts as _alerts
            _alerts.write_dedupe(
                severity="warn",
                source="mcp_installer",
                message=(f"--force install with allowlist module unavailable: "
                         f"{mcp['id']} (import error: "
                         f"{type(_allowlist_import_error).__name__})"),
                dedupe_tag=f"mcp_force_install_no_allowlist:{mcp['id']}",
                window_seconds=3600,
                tags=["security", "mcp_installer", "allowlist_unavailable"],
            )
        except Exception:
            pass

    if check_mcp_allowed is not None:
        pkg_obj = mcp.get("package") or {}
        pkg_id = pkg_obj.get("name") if isinstance(pkg_obj, dict) else None
        ok_allowlist, reason = check_mcp_allowed(name=mcp["id"], package=pkg_id)
        if not ok_allowlist:
            print(red(f"[mcp install] BLOCKED by allowlist: {reason}"), file=sys.stderr)
            print(gray("  Override with --force (logs to alerts as warn)"),
                  file=sys.stderr)
            if not getattr(args, "force", False):
                return 2
            try:
                import alerts as _alerts
                _alerts.write_dedupe(
                    severity="warn",
                    source="mcp_installer",
                    message=(f"User --force installed unlisted MCP: "
                             f"{mcp['id']} ({pkg_id})"),
                    dedupe_tag=f"mcp_force_install:{mcp['id']}",
                    window_seconds=3600,
                    tags=["security", "mcp_installer"],
                )
            except Exception:
                pass

    # Parse --env KEY=VAL ... overrides
    env_overrides = {}
    for kv in (args.env or []):
        if "=" not in kv:
            print(red(f"[mcp] Bad --env (expected KEY=VAL): {kv}"))
            return 1
        k, v = kv.split("=", 1)
        env_overrides[k.strip()] = v

    answers = prompt_user(mcp, non_interactive_env=env_overrides)
    config  = build_config(mcp, answers)

    # Direct path: write to settings.json
    settings.setdefault("mcpServers", {})
    settings["mcpServers"][mcp["id"]] = config

    backup = write_settings_atomic(settings)
    print()
    print(green(f"[mcp] Installed {mcp['id']} -> {SETTINGS_PATH}"))
    print(gray(f"     Backup: {backup}"))

    # Auto-validate unless --skip-validate
    if not args.skip_validate:
        print()
        print(cyan("[mcp] Validating handshake..."))
        rc = run_handshake(mcp["id"], config, timeout=args.validate_timeout)
        if rc != 0:
            print(yellow("     Validation FAILED — settings.json was written but the MCP did not"))
            print(yellow("     respond to JSON-RPC initialize. Check keys and try `ultron mcp validate`."))
            return rc

    print()
    print(yellow("[mcp] Restart Claude Code for the new MCP to load."))
    return 0


# ── Subcommand: uninstall ────────────────────────────────────────────────────

def cmd_uninstall(args):
    settings = load_settings()
    servers  = settings.get("mcpServers", {}) or {}

    if args.id not in servers:
        print(yellow(f"[mcp] '{args.id}' is not installed in {SETTINGS_PATH}"))
        return 1

    if not args.yes:
        resp = input(f"Remove '{args.id}' from settings.json? (y/N): ").strip().lower()
        if resp not in ("y", "yes"):
            print(gray("[mcp] Aborted by user"))
            return 0

    del settings["mcpServers"][args.id]
    backup = write_settings_atomic(settings)
    print(green(f"[mcp] Removed {args.id} from {SETTINGS_PATH}"))
    print(gray(f"     Backup: {backup}"))
    print(yellow("[mcp] Restart Claude Code for changes to take effect."))
    return 0


# ── Subcommand: validate (JSON-RPC handshake) ────────────────────────────────

def cmd_validate(args):
    settings = load_settings()
    servers  = settings.get("mcpServers", {}) or {}

    if args.id not in servers:
        print(red(f"[mcp] '{args.id}' is not installed (run: ultron mcp install {args.id})"))
        return 1

    config = servers[args.id]
    return run_handshake(args.id, config, timeout=args.timeout)


def run_handshake(mcp_id: str, config: dict, timeout: float = 15.0) -> int:
    """Spawn the MCP via stdio, send `initialize`, validate response."""
    cmd = config.get("command")
    cmd_args = config.get("args", [])
    if not cmd:
        print(red(f"[mcp] No 'command' in config for {mcp_id}"))
        return 1

    # On Windows, npx is npx.cmd. shutil.which handles both.
    resolved = shutil.which(cmd)
    if not resolved:
        # Try APPDATA\npm fallback (for npm global installs not in PATH)
        appdata = os.environ.get("APPDATA")
        if appdata:
            for ext in (".cmd", ".exe", ".ps1", ""):
                cand = Path(appdata) / "npm" / f"{cmd}{ext}"
                if cand.exists():
                    resolved = str(cand)
                    break
    if not resolved:
        print(red(f"[mcp] Command not found in PATH: {cmd}"))
        print(gray("     Install Node.js and ensure npx is on PATH, or set absolute path in catalog."))
        return 1

    full_cmd = [resolved] + list(cmd_args)
    env = os.environ.copy()
    env.update(config.get("env", {}) or {})

    print(gray(f"     Spawning: {resolved} {' '.join(cmd_args)}"))

    try:
        proc = subprocess.Popen(
            full_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
            creationflags=_WIN_HIDDEN,
        )
    except OSError as e:
        print(red(f"[mcp] Failed to spawn: {e}"))
        return 1

    # Send JSON-RPC initialize
    init_req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ultron-mcp-installer", "version": "1.0"},
        },
    }
    try:
        proc.stdin.write(json.dumps(init_req) + "\n")
        proc.stdin.flush()
    except (BrokenPipeError, OSError) as e:
        print(red(f"[mcp] Could not write to MCP stdin: {e}"))
        proc.kill()
        return 1

    # Read response with timeout
    deadline = time.monotonic() + timeout
    response_line = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            stderr = proc.stderr.read() if proc.stderr else ""
            print(red(f"[mcp] MCP exited prematurely (rc={proc.returncode})"))
            if stderr.strip():
                print(gray("     stderr:"))
                for line in stderr.splitlines()[:10]:
                    print(gray(f"       {line}"))
            return 1

        line = _read_line_nonblocking(proc.stdout)
        if line:
            stripped = line.strip()
            if stripped.startswith("{"):
                response_line = stripped
                break
        time.sleep(0.05)

    if not response_line:
        print(red(f"[mcp] No response from MCP within {timeout}s"))
        proc.kill()
        return 1

    # Parse response
    try:
        response = json.loads(response_line)
    except json.JSONDecodeError as e:
        print(red(f"[mcp] Response was not valid JSON: {e}"))
        print(gray(f"     Got: {response_line[:200]}"))
        proc.kill()
        return 1

    # Validate it's an initialize response with capabilities
    result = response.get("result", {})
    capabilities = result.get("capabilities", {})
    server_info = result.get("serverInfo", {})

    if not result or "capabilities" not in result:
        print(red("[mcp] Response did not include result.capabilities"))
        print(gray(f"     Response: {json.dumps(response)[:300]}"))
        proc.kill()
        return 1

    print(green(f"     OK - server={server_info.get('name','?')} v{server_info.get('version','?')}"))
    cap_keys = list(capabilities.keys())
    if cap_keys:
        print(gray(f"     Capabilities: {', '.join(cap_keys)}"))

    # Send graceful shutdown notification (some servers honor it)
    try:
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        proc.stdin.close()
    except OSError:
        pass

    # Give it 2s to exit cleanly, then kill
    try:
        proc.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        proc.kill()

    return 0


def _read_line_nonblocking(stream) -> str | None:
    """Read a line if available without blocking. Falls back to readline()
    after small sleep — good enough for handshake purposes."""
    if not stream:
        return None
    # On Windows there is no select() on pipes. We rely on the fact that
    # MCPs respond quickly to initialize, so a tiny blocking readline is fine.
    try:
        line = stream.readline()
        return line if line else None
    except (OSError, ValueError):
        return None


# ── Subcommand: wrap / unwrap ────────────────────────────────────────────────

ALLOWLIST_PATH = COCKPIT_DIR / "mcp-allowlist.json"
BROKER_SCRIPT  = Path(__file__).parent / "mcp_broker.py"
_WRAP_SENTINEL = "_ultron_broker_wrap"


def _load_allowlist() -> dict:
    if not ALLOWLIST_PATH.exists():
        return {"servers": {}}
    return Cockpit.read_json(ALLOWLIST_PATH, default={"servers": {}})


def _save_allowlist(data: dict) -> None:
    Cockpit.write_json(ALLOWLIST_PATH, data, backup=True)


def cmd_wrap(args) -> int:
    """Route an installed MCP server through the zero-trust broker.

    Wraps the settings.json entry so Claude Code / Codex / Gemini will talk to
    mcp_broker.py serve --server <id> instead of the raw server binary.
    Original config is preserved in mcp-allowlist.json for unwrap and broker use.
    """
    import sys as _sys

    settings = load_settings()
    servers  = settings.get("mcpServers", {}) or {}

    if args.id not in servers:
        print(red(f"[mcp] '{args.id}' is not installed (run: ultron mcp install {args.id})"))
        return 1

    original = servers[args.id]

    # Already wrapped?
    if original.get(_WRAP_SENTINEL):
        print(yellow(f"[mcp] '{args.id}' is already wrapped through the broker"))
        print(gray("     Use: ultron mcp unwrap <id>  to restore direct connection"))
        return 0

    if not BROKER_SCRIPT.exists():
        print(red(f"[mcp] Broker script not found: {BROKER_SCRIPT}"))
        return 1

    # Save original to allowlist (for broker + for unwrap)
    allowlist = _load_allowlist()
    allowlist.setdefault("servers", {})[args.id] = {
        "original":   original,
        "wrapped_at": datetime.now().isoformat(timespec="seconds"),
        "env_keys":   list((original.get("env") or {}).keys()),
        "max_calls_per_min": 60,
    }
    _save_allowlist(allowlist)
    print(gray(f"[mcp] Original config saved to {ALLOWLIST_PATH.name}"))

    # Build broker proxy entry
    broker_entry = {
        "command": _sys.executable,
        "args": [str(BROKER_SCRIPT), "serve", "--server", args.id],
        _WRAP_SENTINEL: True,
    }

    settings["mcpServers"][args.id] = broker_entry
    backup = write_settings_atomic(settings)
    print(green(f"[mcp] '{args.id}' is now wrapped through mcp_broker.py"))
    print(gray(f"     Backup: {backup}"))
    print(yellow("[mcp] Restart Claude Code for the broker to take effect."))
    return 0


def cmd_unwrap(args) -> int:
    """Restore a broker-wrapped MCP server to direct connection.

    Reads original config from mcp-allowlist.json, restores settings.json entry,
    removes from allowlist. Fail-closed: if original is missing, aborts.
    """
    settings = load_settings()
    servers  = settings.get("mcpServers", {}) or {}

    if args.id not in servers:
        print(red(f"[mcp] '{args.id}' is not installed"))
        return 1

    entry = servers[args.id]
    if not entry.get(_WRAP_SENTINEL):
        print(yellow(f"[mcp] '{args.id}' is not broker-wrapped — nothing to unwrap"))
        return 0

    # Restore from allowlist
    allowlist = _load_allowlist()
    saved = allowlist.get("servers", {}).get(args.id)
    if not saved or not saved.get("original"):
        print(red(f"[mcp] Cannot unwrap '{args.id}': original config not found in allowlist"))
        print(gray(f"     Allowlist: {ALLOWLIST_PATH}"))
        return 2  # fail-closed: don't delete entry without restore

    settings["mcpServers"][args.id] = saved["original"]
    backup = write_settings_atomic(settings)

    # Remove from allowlist
    del allowlist["servers"][args.id]
    _save_allowlist(allowlist)

    print(green(f"[mcp] '{args.id}' restored to direct connection"))
    print(gray(f"     Backup: {backup}"))
    print(yellow("[mcp] Restart Claude Code for changes to take effect."))
    return 0


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(
        prog="ultron mcp",
        description="Install/manage public MCP servers from a curated catalog.")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="Show catalog with installed status")
    pl.set_defaults(func=cmd_list)

    pc = sub.add_parser("catalog", help="Verbose details of catalog entries")
    pc.add_argument("id", nargs="?", help="Optional: filter by id")
    pc.set_defaults(func=cmd_catalog)

    pi = sub.add_parser("install", help="Install an MCP from the catalog")
    pi.add_argument("id", help="Catalog id (e.g. supabase)")
    pi.add_argument("--env", action="append", metavar="KEY=VAL",
                    help="Non-interactive: provide a prompt answer (repeatable)")
    pi.add_argument("--force", action="store_true",
                    help="Overwrite if already installed")
    pi.add_argument("--skip-validate", action="store_true",
                    help="Skip the JSON-RPC handshake after install")
    pi.add_argument("--validate-timeout", type=float, default=20.0,
                    help="Seconds to wait for handshake response (default: 20)")
    pi.set_defaults(func=cmd_install)

    pu = sub.add_parser("uninstall", help="Remove an MCP from settings.json")
    pu.add_argument("id", help="Server id to remove")
    pu.add_argument("-y", "--yes", action="store_true", help="Skip confirmation")
    pu.set_defaults(func=cmd_uninstall)

    pv = sub.add_parser("validate", help="JSON-RPC handshake against an installed MCP")
    pv.add_argument("id", help="Server id (must be installed)")
    pv.add_argument("--timeout", type=float, default=15.0)
    pv.set_defaults(func=cmd_validate)

    pw = sub.add_parser("wrap", help="Route MCP through zero-trust broker (mcp_broker.py)")
    pw.add_argument("id", help="Server id to wrap (must be installed)")
    pw.set_defaults(func=cmd_wrap)

    puw = sub.add_parser("unwrap", help="Restore direct connection (remove broker)")
    puw.add_argument("id", help="Server id to unwrap")
    puw.set_defaults(func=cmd_unwrap)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
