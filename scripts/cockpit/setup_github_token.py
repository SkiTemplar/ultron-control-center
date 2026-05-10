#!/usr/bin/env python3
"""
Quick setup for GITHUB_TOKEN configuration.

Usage:
    python setup_github_token.py                    # Interactive setup
    python setup_github_token.py --check            # Check current status
    python setup_github_token.py --set <token>      # Set token directly
    python setup_github_token.py --clear             # Clear token
"""
import argparse
import json
import os
import sys
from pathlib import Path

SETTINGS_FILE = Path.home() / ".claude" / "settings.json"


def check_token():
    """Check if GITHUB_TOKEN is configured."""
    env_token = os.environ.get("GITHUB_TOKEN", "").strip()

    print("\n[github-token] Status Check\n")

    if env_token:
        print(f"✓ Environment: GITHUB_TOKEN is set (masked: {env_token[:10]}...)")
    else:
        print("✗ Environment: GITHUB_TOKEN not set")

    # Check settings.json
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                settings = json.load(f)

            # Look for GitHub token in any MCP server config
            found_in_settings = False
            for server_name, server_config in settings.get("mcpServers", {}).items():
                if "env" in server_config and "GITHUB_TOKEN" in server_config["env"]:
                    print(f"✓ settings.json: Found in mcpServers.{server_name}.env")
                    found_in_settings = True

            if not found_in_settings:
                print("✗ settings.json: GITHUB_TOKEN not configured in any MCP server")
        except Exception as e:
            print(f"✗ settings.json: Error reading ({e})")
    else:
        print(f"✗ settings.json: Not found at {SETTINGS_FILE}")

    print()


def set_token_env(token: str):
    """Display command to set token in environment."""
    print("\n[github-token] To set in current PowerShell session:\n")
    print(f"$env:GITHUB_TOKEN = '{token}'\n")
    print("To persist across sessions, add to your PowerShell profile:")
    print(f"[Environment]::SetEnvironmentVariable('GITHUB_TOKEN', '{token}', 'User')\n")


def set_token_settings(token: str):
    """Add GITHUB_TOKEN to settings.json under superpowers-mcp or a new section."""
    if not SETTINGS_FILE.exists():
        print(f"[error] settings.json not found at {SETTINGS_FILE}")
        return False

    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            settings = json.load(f)

        # Try to find or create superpowers-mcp section
        if "mcpServers" not in settings:
            settings["mcpServers"] = {}

        # Add to superpowers-mcp or create ultron-env section
        target = "superpowers-mcp"
        if target not in settings["mcpServers"]:
            # Create a minimal env server
            settings["mcpServers"]["ultron-env"] = {
                "env": {"GITHUB_TOKEN": token},
                "type": "environment"
            }
            target = "ultron-env"
        else:
            if "env" not in settings["mcpServers"][target]:
                settings["mcpServers"][target]["env"] = {}
            settings["mcpServers"][target]["env"]["GITHUB_TOKEN"] = token

        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)

        print(f"[github-token] Saved to settings.json → mcpServers.{target}.env.GITHUB_TOKEN")
        return True
    except Exception as e:
        print(f"[error] Failed to update settings.json: {e}")
        return False


def interactive_setup():
    """Interactive token setup."""
    print("\n[github-token] Interactive Setup\n")
    print("Get your token at: https://github.com/settings/tokens")
    print("  1. Click 'Generate new token (classic)'")
    print("  2. Check 'public_repo' scope")
    print("  3. Copy the token\n")

    token = input("Paste your GitHub token (or press Enter to skip): ").strip()
    if not token:
        print("Skipped.")
        return

    if len(token) < 10:
        print("[error] Token looks too short. Aborting.")
        return

    print("\nWhere do you want to save it?")
    print("  1. Environment variable (current session only)")
    print("  2. Environment variable (persistent across sessions)")
    print("  3. settings.json (Claude Code will load it)")
    print("  4. All of the above")

    choice = input("\nChoice [1-4]: ").strip()

    if choice in ("1", "4"):
        set_token_env(token)

    if choice in ("2", "4"):
        try:
            os.environ["GITHUB_TOKEN"] = token
            import ctypes
            ctypes.windll.kernel32.SetEnvironmentVariableW("GITHUB_TOKEN", token)
            print("[github-token] Set GITHUB_TOKEN in Windows environment variables")
        except Exception as e:
            print(f"[notice] Couldn't set Windows env var: {e}")

    if choice in ("3", "4"):
        if set_token_settings(token):
            print("[github-token] Restart Claude Code to load the new token")

    print()


def main():
    parser = argparse.ArgumentParser(
        prog="setup_github_token.py",
        description="ULTRON — GitHub Token Setup Helper",
    )
    parser.add_argument("--check", action="store_true", help="Check current status")
    parser.add_argument("--set", metavar="TOKEN", help="Set token directly")
    parser.add_argument("--clear", action="store_true", help="Clear token from environment")
    parser.add_argument("--show-command", action="store_true",
                        help="Show PowerShell command to set token")

    args = parser.parse_args()

    if args.check:
        check_token()
    elif args.clear:
        # Remove from current environment
        if "GITHUB_TOKEN" in os.environ:
            del os.environ["GITHUB_TOKEN"]
            print("[github-token] Cleared from environment")
        check_token()
    elif args.set:
        print(f"[github-token] Setting token...")
        if set_token_settings(args.set):
            print("[github-token] Token saved to settings.json")
            print("[github-token] Restart Claude Code to load the token")
    elif args.show_command:
        token = input("Paste your GitHub token: ").strip()
        if token:
            set_token_env(token)
    else:
        interactive_setup()


if __name__ == "__main__":
    main()
