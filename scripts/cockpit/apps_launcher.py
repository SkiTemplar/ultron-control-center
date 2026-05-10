#!/usr/bin/env python3
"""
ULTRON v10.4 - GUI app launcher.

Launches user-registered desktop apps (Claude Desktop, ChatGPT, Spotify, Notion,
Steam, Discord, etc.). Auto-discovers common Windows install paths on first run.

Registry: ~/.ultron/cockpit/apps.json
  {"apps": {"<name>": {"path": "...", "args": [...], "label": "..."}}}

Usage:
    apps_launcher.py launch <name> [extra args]
    apps_launcher.py list
    apps_launcher.py add <name> <path> [--label <text>] [--args <a> <b>]
    apps_launcher.py remove <name>
    apps_launcher.py discover    # re-scan defaults, append missing
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import Cockpit, COCKPIT_DIR  # noqa: E402

APPS_JSON = COCKPIT_DIR / "apps.json"


def _expand(path: str) -> Path:
    return Path(os.path.expandvars(path))


# Default app paths - probed in this order. First existing path wins.
DEFAULT_PROBES: dict[str, dict[str, Any]] = {
    "claude-desktop": {
        "label": "Claude Desktop",
        "candidates": [
            r"%LOCALAPPDATA%\AnthropicClaude\Claude.exe",
            r"%LOCALAPPDATA%\AnthropicClaude\claude.exe",
            r"%LOCALAPPDATA%\Programs\AnthropicClaude\Claude.exe",
        ],
    },
    "chatgpt": {
        "label": "ChatGPT Desktop",
        "candidates": [
            r"%LOCALAPPDATA%\Programs\OpenAI\ChatGPT.exe",
            r"%LOCALAPPDATA%\OpenAI\ChatGPT\ChatGPT.exe",
        ],
    },
    "spotify": {
        "label": "Spotify",
        "candidates": [
            r"%APPDATA%\Spotify\Spotify.exe",
            r"%LOCALAPPDATA%\Microsoft\WindowsApps\Spotify.exe",
        ],
    },
    "notion": {
        "label": "Notion",
        "candidates": [
            r"%LOCALAPPDATA%\Programs\Notion\Notion.exe",
        ],
    },
    "discord": {
        "label": "Discord",
        "candidates": [
            r"%LOCALAPPDATA%\Discord\Update.exe",  # Discord uses Update.exe --processStart
            r"%LOCALAPPDATA%\Discord\app-*\Discord.exe",
        ],
    },
    "steam": {
        "label": "Steam",
        "candidates": [
            r"C:\Program Files (x86)\Steam\steam.exe",
            r"C:\Program Files\Steam\steam.exe",
        ],
    },
    "obsidian": {
        "label": "Obsidian",
        "candidates": [
            r"%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe",
        ],
    },
    "vscode": {
        "label": "VS Code",
        "candidates": [
            r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe",
            r"C:\Program Files\Microsoft VS Code\Code.exe",
        ],
    },
    "explorer": {
        "label": "File Explorer",
        "candidates": [r"C:\Windows\explorer.exe"],
    },
}


def _resolve_candidate(pattern: str) -> Path | None:
    """Expand env vars and resolve glob patterns. Returns first existing match."""
    expanded = os.path.expandvars(pattern)
    p = Path(expanded)
    if "*" in expanded:
        # Glob - return first match
        parent = p.parent
        if parent.exists():
            for m in sorted(parent.glob(p.name), reverse=True):
                if m.exists():
                    return m
        return None
    return p if p.exists() else None


def discover_defaults() -> dict[str, dict]:
    """Probe default paths, return map of {name: {path, label}}."""
    found: dict[str, dict] = {}
    for name, info in DEFAULT_PROBES.items():
        for cand in info["candidates"]:
            resolved = _resolve_candidate(cand)
            if resolved:
                entry = {"path": str(resolved), "label": info["label"]}
                # Discord needs special launch args
                if name == "discord" and "Update.exe" in str(resolved):
                    entry["args"] = ["--processStart", "Discord.exe"]
                found[name] = entry
                break
    return found


def load_registry() -> dict[str, dict]:
    data = Cockpit.read_json(APPS_JSON, default={"apps": {}})
    return data.get("apps", {})


def save_registry(apps: dict[str, dict]) -> None:
    Cockpit.write_json(APPS_JSON, {"apps": apps})


def cmd_list(_args) -> int:
    apps = load_registry()
    if not apps:
        print("[apps] Registry empty. Run: ultron apps discover")
        return 0
    print(f"Registered apps ({len(apps)}):")
    for name in sorted(apps.keys()):
        a = apps[name]
        path = a.get("path", "?")
        label = a.get("label", name)
        ok = "✓" if Path(path).exists() else "✗"
        print(f"  {ok} {name:<18}  {label}")
        print(f"     {path}")
    return 0


def cmd_launch(args) -> int:
    apps = load_registry()
    name = args.name.lower()
    if name not in apps:
        # Auto-discover on first launch attempt
        if not apps:
            print(f"[apps] Empty registry, running discover first...")
            apps = discover_defaults()
            save_registry(apps)
        if name not in apps:
            print(f"[apps] Unknown: {name}")
            print(f"[apps] Available: {', '.join(sorted(apps.keys())) or '(none)'}")
            print(f"[apps] Try: ultron apps discover  -or-  ultron apps add {name} <path>")
            return 1
    app = apps[name]
    path = app.get("path")
    if not path or not Path(path).exists():
        print(f"[apps] Path missing or stale for {name}: {path}")
        print(f"[apps] Re-discover with: ultron apps discover")
        return 2

    launch_args = list(app.get("args", []))
    if args.extra:
        launch_args.extend(args.extra)

    try:
        # Use Popen so we don't block the parent terminal
        subprocess.Popen(
            [path] + launch_args,
            cwd=Path(path).parent,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
                          | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            close_fds=True,
        )
        print(f"[apps] Launched: {app.get('label', name)}")
        return 0
    except OSError as e:
        print(f"[apps] Launch failed: {e}")
        return 1


def cmd_add(args) -> int:
    apps = load_registry()
    name = args.name.lower()
    path = str(_expand(args.path))
    if not Path(path).exists():
        print(f"[apps] Warning: path does not exist: {path}")
    entry = {"path": path, "label": args.label or args.name}
    if args.args:
        entry["args"] = args.args
    apps[name] = entry
    save_registry(apps)
    print(f"[apps] Registered: {name} → {path}")
    return 0


def cmd_remove(args) -> int:
    apps = load_registry()
    name = args.name.lower()
    if name not in apps:
        print(f"[apps] Not in registry: {name}")
        return 1
    del apps[name]
    save_registry(apps)
    print(f"[apps] Removed: {name}")
    return 0


def cmd_discover(_args) -> int:
    existing = load_registry()
    found = discover_defaults()
    added = 0
    updated = 0
    for name, info in found.items():
        if name in existing:
            if existing[name].get("path") != info["path"]:
                existing[name].update(info)
                updated += 1
        else:
            existing[name] = info
            added += 1
    save_registry(existing)
    print(f"[apps] Discovery complete: {added} added, {updated} updated, "
          f"{len(existing)} total")
    if added or updated:
        for name, info in found.items():
            print(f"  - {name}: {info['path']}")
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON GUI app launcher")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("list")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("launch")
    sp.add_argument("name")
    sp.add_argument("extra", nargs="*", help="Extra args passed to the app")
    sp.set_defaults(func=cmd_launch)

    sp = sub.add_parser("add")
    sp.add_argument("name")
    sp.add_argument("path")
    sp.add_argument("--label")
    sp.add_argument("--args", nargs="+")
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("remove")
    sp.add_argument("name")
    sp.set_defaults(func=cmd_remove)

    sp = sub.add_parser("discover")
    sp.set_defaults(func=cmd_discover)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
