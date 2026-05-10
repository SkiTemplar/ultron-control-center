#!/usr/bin/env python3
"""
ULTRON v10.4 - MCP Creator (scaffold new MCP server from idea).

Sonnet generates a starter MCP server based on a natural-language idea.
Default stack: Python FastMCP. Use --lang ts for TypeScript SDK.

Output files (in target dir):
  - server.py / server.ts
  - README.md
  - pyproject.toml / package.json
  - .env.example

Anti-laundering: scaffold ALWAYS marks itself as auto-generated draft.
NOT for production without review.

Usage:
    mcp_creator.py scaffold <idea...> [--lang python|ts] [--out <dir>]
    mcp_creator.py scaffold <idea...> --apply       Write files
                                                     (default = dry-run, prints to stdout)
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

SCAFFOLD_MODEL = "claude-sonnet-4-6"
SCAFFOLD_TIMEOUT = 240


SCAFFOLD_SYSTEM = (
    "You are an MCP server scaffolding assistant. Given an idea description "
    "and target language, output a starter MCP server. "
    "Output ONLY JSON, no preamble, no code fences around the JSON. "
    "Schema: {\"files\": {\"<filename>\": \"<file_content>\"}, "
    "\"summary\": \"<2-3 sentence description>\", "
    "\"next_steps\": [\"<step1>\", \"<step2>\"]}. "
    "All file_content values are strings (use \\n for newlines, escape \" as \\\")."
    "\n\nFor Python: use FastMCP, pyproject.toml with mcp>=1.0, .env.example, README.md, server.py with 2-4 example tools matching the idea."
    "\n\nFor TypeScript: use @modelcontextprotocol/sdk, package.json with type=module, tsconfig.json, src/server.ts with 2-4 tools, .env.example, README.md."
    "\n\nIn README.md, ALWAYS include this exact warning: "
    "'⚠️ AUTO-GENERATED DRAFT - review every line before running. NOT production-ready.'"
    "\n\nKeep server file under 200 lines. Tools should match idea closely "
    "but with placeholder logic (TODO comments mark business logic to fill in)."
)


def call_claude(user_prompt: str) -> str | None:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[mcp-creator] claude CLI not found in PATH", file=sys.stderr)
        return None
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions",
           "--model", SCAFFOLD_MODEL,
           "--append-system-prompt", SCAFFOLD_SYSTEM, user_prompt]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                            timeout=SCAFFOLD_TIMEOUT, encoding="utf-8", creationflags=_WIN_HIDDEN)
        if r.returncode != 0:
            print(f"[mcp-creator] claude failed exit={r.returncode}",
                  file=sys.stderr)
            if r.stderr:
                print(f"[mcp-creator] stderr: {r.stderr[:500]}",
                      file=sys.stderr)
            return None
        return (r.stdout or "").strip()
    except subprocess.TimeoutExpired:
        print(f"[mcp-creator] timeout after {SCAFFOLD_TIMEOUT}s",
              file=sys.stderr)
        return None


def extract_json(text: str) -> dict | None:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        if lines[-1].strip().startswith("```"):
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        cleaned = "\n".join(lines)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"[mcp-creator] JSON parse failed: {e}", file=sys.stderr)
        print(f"[mcp-creator] raw start: {cleaned[:400]}", file=sys.stderr)
        return None


def cmd_scaffold(args) -> int:
    lang = args.lang
    user = (f"Idea: {args.idea}\n"
            f"Target language: {lang}\n"
            f"Generate the MCP server scaffold per the schema.")

    print(f"[mcp-creator] Scaffolding {lang} MCP server via {SCAFFOLD_MODEL}...")
    print(f"[mcp-creator] Idea: {args.idea}")
    print()
    response = call_claude(user)
    if not response:
        return 1
    payload = extract_json(response)
    if not payload:
        return 1

    files = payload.get("files", {})
    summary = payload.get("summary", "")
    next_steps = payload.get("next_steps", [])

    if not files:
        print("[mcp-creator] No files in response.")
        return 1

    print("=== Scaffold summary ===")
    print(summary)
    print()
    print("=== Files generated ===")
    for fname, content in files.items():
        size = len(content) if isinstance(content, str) else 0
        print(f"  {fname}  ({size}b)")
    print()
    if next_steps:
        print("=== Next steps ===")
        for step in next_steps:
            print(f"  - {step}")
        print()

    if not args.apply:
        print("[mcp-creator] Dry-run — pass --apply to write files to disk.")
        if args.show:
            for fname, content in files.items():
                print()
                print("=" * 60)
                print(f"FILE: {fname}")
                print("=" * 60)
                print(content if isinstance(content, str) else "(binary)")
        return 0

    # Apply: write files to out dir
    out_dir = Path(args.out).resolve() if args.out else Path.cwd() / f"mcp-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[mcp-creator] Writing to: {out_dir}")
    for fname, content in files.items():
        target = out_dir / fname
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            target.write_text(content, encoding="utf-8")
            print(f"  wrote {fname} ({target.stat().st_size}b)")
        else:
            print(f"  skipped {fname} (non-string content)")
    print()
    print(f"[mcp-creator] Scaffold ready at: {out_dir}")
    print("[mcp-creator] WARNING: this is AUTO-GENERATED DRAFT. Review every line.")
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON MCP server scaffold creator")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("scaffold")
    sp.add_argument("idea", nargs="+",
                    help="Free-form description of what the MCP should do")
    sp.add_argument("--lang", choices=["python", "ts"], default="python")
    sp.add_argument("--out", help="Output directory (default: cwd/mcp-<timestamp>)")
    sp.add_argument("--apply", action="store_true",
                    help="Write files to disk (default = dry-run)")
    sp.add_argument("--show", action="store_true",
                    help="In dry-run, also print file contents to stdout")
    sp.set_defaults(func=lambda a: (setattr(a, "idea", " ".join(a.idea)),
                                     cmd_scaffold(a))[1])

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
