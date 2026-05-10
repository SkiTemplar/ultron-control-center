#!/usr/bin/env python3
"""
ULTRON v10.6 — Shadow peer review (Gemini's "shadow loop" from Triple Max).

Watches the working tree of the cwd (or a target project) for git diff
changes. When the diff stabilizes for `--debounce` seconds, dispatches a
read-only critique to Codex (or Gemini, configurable) and appends the
result to `~/.ultron/cockpit/shadow-critiques.md`.

Anti-laundering doctrine preserved:
  - Peer is read-only (`--sandbox read-only` for Codex, `--approval-mode plan`
    for Gemini).
  - Critique is APPENDED only — peer never edits source files.
  - Single-writer doctrine: only Claude (or USER) ever calls Edit/Write.

Why "shadow":
  - Cursor 3.1 ships Background Agents that run async fix-loops while the user
    types. We can't (and don't want to) edit while USER types — but we CAN
    feed a continuous critique stream that he reads when he wants to.

Usage:
    shadow_review.py watch                          # watch cwd, default Codex peer
    shadow_review.py watch --peer gemini --debounce 30
    shadow_review.py watch --once                  # run one critique now, no loop
    shadow_review.py tail [-n 20]                  # show recent critiques

NO LLM is invoked when the diff is empty or unchanged. Idle CPU near zero.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
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
from cockpit_base import COCKPIT_DIR  # noqa: E402

CRITIQUES_LOG = COCKPIT_DIR / "shadow-critiques.md"
LAST_HASH_FILE = COCKPIT_DIR / "shadow-last-hash.txt"

ULTRON_SCRIPTS = Path(__file__).resolve().parents[1]
CODEX_HELPER = ULTRON_SCRIPTS / "codex-duet.ps1"
GEMINI_HELPER = ULTRON_SCRIPTS / "gemini-duet.ps1"

DEFAULT_DEBOUNCE = 20.0  # seconds
DEFAULT_POLL = 5.0        # seconds between git diff polls
MAX_DIFF_BYTES = 12000    # truncate before sending to peer


def get_git_diff(cwd: Path) -> str | None:
    """Returns combined unstaged + untracked diff as a string, or None if
    the directory isn't a git repo or git fails."""
    if not (cwd / ".git").exists() and not _in_git_repo(cwd):
        return None
    try:
        # Combined working-tree diff
        r = subprocess.run(
            ["git", "diff", "--no-color", "--stat", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace", creationflags=_WIN_HIDDEN,
        )
        stat = (r.stdout or "").strip()
        r2 = subprocess.run(
            ["git", "diff", "--no-color", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=10,
            encoding="utf-8", errors="replace", creationflags=_WIN_HIDDEN,
        )
        body = (r2.stdout or "")[:MAX_DIFF_BYTES]
        if not body and not stat:
            return ""
        return f"=== STAT ===\n{stat}\n\n=== DIFF ===\n{body}"
    except (OSError, subprocess.TimeoutExpired):
        return None


def _in_git_repo(cwd: Path) -> bool:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=cwd, capture_output=True, text=True, timeout=5,
            creationflags=_WIN_HIDDEN,
        )
        return r.returncode == 0 and (r.stdout or "").strip() == "true"
    except (OSError, subprocess.TimeoutExpired):
        return False


def diff_hash(diff: str) -> str:
    return hashlib.sha256(diff.encode("utf-8", errors="replace")).hexdigest()[:16]


def read_last_hash() -> str:
    if LAST_HASH_FILE.exists():
        try:
            return LAST_HASH_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


def write_last_hash(h: str) -> None:
    LAST_HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_HASH_FILE.write_text(h, encoding="utf-8")


def invoke_codex(prompt_file: Path) -> str | None:
    if not CODEX_HELPER.exists():
        print(f"[shadow] codex helper not found: {CODEX_HELPER}",
              file=sys.stderr)
        return None
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(CODEX_HELPER),
             "-Mode", "Mini", "-Round", "1",
             "-PromptFile", str(prompt_file),
             "-BypassCaps"],
            capture_output=True, text=True, timeout=180, encoding="utf-8",
            errors="replace", creationflags=_WIN_HIDDEN,
        )
        out = r.stdout or ""
        # Codex helper prints "--- OUTPUT JSON ---" then the JSON
        if "--- OUTPUT JSON ---" in out:
            payload = out.split("--- OUTPUT JSON ---", 1)[1].strip()
            try:
                d = json.loads(payload)
                return d.get("critique") or d.get("raw_text") or payload
            except json.JSONDecodeError:
                return payload
        return out.strip() or None
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[shadow] codex failed: {e}", file=sys.stderr)
        return None


def invoke_gemini(prompt_file: Path) -> str | None:
    if not GEMINI_HELPER.exists():
        print(f"[shadow] gemini helper not found: {GEMINI_HELPER}",
              file=sys.stderr)
        return None
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(GEMINI_HELPER),
             "-Mode", "Mini", "-Round", "1",
             "-PromptFile", str(prompt_file),
             "-BypassCaps"],
            capture_output=True, text=True, timeout=180, encoding="utf-8",
            errors="replace", creationflags=_WIN_HIDDEN,
        )
        out = r.stdout or ""
        if "--- OUTPUT JSON ---" in out:
            payload = out.split("--- OUTPUT JSON ---", 1)[1].strip()
            try:
                d = json.loads(payload)
                return d.get("raw_text") or d.get("critique") or payload
            except json.JSONDecodeError:
                return payload
        return out.strip() or None
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[shadow] gemini failed: {e}", file=sys.stderr)
        return None


def build_prompt(cwd: Path, diff: str) -> str:
    return (
        "SHADOW REVIEW (read-only critique of an in-progress git diff).\n\n"
        "You are a peer reviewer. Read the diff below and emit ONE concise "
        "critique focused on:\n"
        "  - bugs introduced by the diff\n"
        "  - missing tests for new branches\n"
        "  - boundary conditions / edge cases not handled\n"
        "  - security or anti-laundering concerns\n"
        "Skip cosmetics, style, line-length. Skip generic praise.\n"
        "Cap output at ~300 words. Be concrete, cite filenames and line "
        "context where possible.\n"
        "Do NOT propose Edit operations — Claude/USER are the only writers.\n\n"
        f"Working directory: {cwd}\n"
        f"Time: {datetime.now().isoformat(timespec='seconds')}\n\n"
        f"{diff}"
    )


def append_critique(cwd: Path, peer: str, critique: str, diff_h: str) -> None:
    CRITIQUES_LOG.parent.mkdir(parents=True, exist_ok=True)
    existing = CRITIQUES_LOG.read_text(encoding="utf-8") \
               if CRITIQUES_LOG.exists() else ""
    if not existing:
        existing = ("# ULTRON Shadow Critiques\n"
                    "> Async peer reviews on uncommitted diffs. Single-writer "
                    "doctrine: peers append, never edit.\n\n")
    block = (
        f"---\n\n"
        f"## {datetime.now().isoformat(timespec='seconds')} — {peer} "
        f"on `{cwd.name}` (diff {diff_h})\n\n"
        f"{critique.strip()}\n\n"
    )
    CRITIQUES_LOG.write_text(existing + block, encoding="utf-8")


def cmd_watch(args) -> int:
    cwd = Path(getattr(args, "cwd", None) or os.getcwd()).resolve()
    peer = (getattr(args, "peer", None) or "codex").lower()
    once = getattr(args, "once", False)
    debounce = float(getattr(args, "debounce", None) or DEFAULT_DEBOUNCE)
    poll = float(getattr(args, "poll", None) or DEFAULT_POLL)
    if peer not in ("codex", "gemini"):
        print(f"[shadow] unknown peer: {peer}", file=sys.stderr)
        return 1

    print(f"[shadow] watching {cwd}  peer={peer}  "
          f"debounce={debounce}s  poll={poll}s  "
          f"{'(one-shot)' if once else '(loop, ctrl-c to stop)'}")

    last_hash = "" if once else read_last_hash()
    stable_since: float | None = None

    while True:
        diff = get_git_diff(cwd)
        if diff is None:
            print("[shadow] not a git repo, exiting")
            return 1
        if not diff.strip():
            stable_since = None
            if once:
                print("[shadow] no diff; nothing to review")
                return 0
            time.sleep(poll)
            continue

        h = diff_hash(diff)
        if h == last_hash:
            stable_since = None  # already reviewed this exact diff
            if once:
                print("[shadow] diff unchanged since last review; nothing to do")
                return 0
            time.sleep(poll)
            continue

        # Diff changed — start/reset the debounce timer
        if stable_since is None:
            stable_since = time.time()
            elapsed = 0.0
        else:
            elapsed = time.time() - stable_since

        if not once and elapsed < debounce:
            time.sleep(poll)
            continue

        # Stable enough — invoke peer
        prompt = build_prompt(cwd, diff)
        prompt_file = COCKPIT_DIR / f"shadow-prompt-{h}.txt"
        prompt_file.parent.mkdir(parents=True, exist_ok=True)
        prompt_file.write_text(prompt, encoding="utf-8")

        print(f"[shadow] dispatching to {peer}...")
        critique = (invoke_codex if peer == "codex" else invoke_gemini)(
            prompt_file)
        try:
            prompt_file.unlink()
        except OSError:
            pass

        if not critique:
            print("[shadow] peer returned nothing")
        else:
            append_critique(cwd, peer, critique, h)
            print(f"[shadow] appended critique ({len(critique)}b)")

        last_hash = h
        write_last_hash(h)
        stable_since = None

        if once:
            return 0
        time.sleep(poll)


def cmd_tail(args) -> int:
    if not CRITIQUES_LOG.exists():
        print("[shadow] no critiques logged yet")
        return 0
    n = max(1, int(getattr(args, "n", 3)))
    text = CRITIQUES_LOG.read_text(encoding="utf-8")
    blocks = text.split("---")
    # Last n non-empty blocks
    recent = [b for b in blocks if b.strip()][-n:]
    print(f"[shadow] last {len(recent)} critique(s):\n")
    for b in recent:
        print(b.rstrip())
        print("---")
    return 0


def main():
    p = argparse.ArgumentParser(
        description="ULTRON shadow peer review (async, read-only)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("watch", help="Watch cwd diff and dispatch reviews")
    sp.add_argument("--cwd", help="Override working directory")
    sp.add_argument("--peer", choices=("codex", "gemini"), default="codex")
    sp.add_argument("--debounce", type=float, default=DEFAULT_DEBOUNCE,
                    help="Seconds the diff must be stable before dispatching")
    sp.add_argument("--poll", type=float, default=DEFAULT_POLL,
                    help="Seconds between git diff polls")
    sp.add_argument("--once", action="store_true",
                    help="Run a single review now and exit")
    sp.set_defaults(func=cmd_watch)

    sp = sub.add_parser("tail", help="Show recent critiques")
    sp.add_argument("-n", type=int, default=3)
    sp.set_defaults(func=cmd_tail)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
