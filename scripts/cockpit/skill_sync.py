#!/usr/bin/env python3
"""
ULTRON v10.4 - Skills sync Claude → Codex (AGENTS.md) + Gemini (GEMINI.md).

Translates a Claude SKILL.md to formats that Codex and Gemini CLIs read
when invoked in a project directory:
  - Codex reads:  AGENTS.md
  - Gemini reads: GEMINI.md
  - Claude reads: CLAUDE.md (project-level) and ~/.claude/skills/*/SKILL.md

Token strategy: Haiku for the format adaptation (mostly mechanical).
Anti-laundering: marks each output as "Auto-generated from <source SKILL.md>"
to prevent confusion with hand-written instructions.

Usage:
    skill_sync.py export <skill> [--target codex|gemini|both] [--out <dir>]
    skill_sync.py check <skill>          Compare drift vs target files
    skill_sync.py sync-all [--target both] [--out <dir>]
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

SKILLS_DIR = Path.home() / ".claude" / "skills"
SYNC_MODEL = "claude-haiku-4-5"
SYNC_TIMEOUT = 90

TARGET_PROFILES = {
    "codex": {
        "filename": "AGENTS.md",
        "header": ("# AGENTS.md — Codex CLI guidance\n\n"
                   "_Auto-generated from `~/.claude/skills/{skill}/SKILL.md` "
                   "by `ultron skills sync` ({date}). Edit the source SKILL.md, "
                   "not this file._\n\n---\n\n"),
        "system": (
            "You are translating a Claude skill SKILL.md to Codex CLI's AGENTS.md "
            "format. Codex reads AGENTS.md from the project root. "
            "Strip Claude-specific machinery (Skill tool invocation, Agent tool "
            "subagent_types) — Codex doesn't have those. Keep: routing rules, "
            "personality, do/don't lists, examples. Use plain Markdown headers. "
            "Output only the Markdown body — caller adds header. No code fences "
            "wrapping the whole output."
        ),
    },
    "gemini": {
        "filename": "GEMINI.md",
        "header": ("# GEMINI.md — Gemini CLI guidance\n\n"
                   "_Auto-generated from `~/.claude/skills/{skill}/SKILL.md` "
                   "by `ultron skills sync` ({date}). Edit the source SKILL.md, "
                   "not this file._\n\n---\n\n"),
        "system": (
            "You are translating a Claude skill SKILL.md to Gemini CLI's GEMINI.md "
            "format. Gemini reads GEMINI.md from the project root. Strip "
            "Claude-specific machinery. Keep: routing logic, personality, "
            "concrete examples. Mention only flags Gemini supports "
            "(--approval-mode, -m, -p). Output only Markdown body — caller adds header."
        ),
    },
}


def list_skills() -> list[Path]:
    if not SKILLS_DIR.exists():
        return []
    return sorted(p for p in SKILLS_DIR.iterdir()
                  if p.is_dir() and (p / "SKILL.md").exists())


def find_skill(name: str) -> Path | None:
    target = SKILLS_DIR / name
    if target.exists() and (target / "SKILL.md").exists():
        return target
    matches = [p for p in list_skills() if name.lower() in p.name.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        print(f"[skills] Ambiguous: {[m.name for m in matches]}")
    return None


def call_claude(system: str, user: str) -> str | None:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[skills] claude CLI not found in PATH", file=sys.stderr)
        return None
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions",
           "--model", SYNC_MODEL, "--append-system-prompt", system, user]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                            timeout=SYNC_TIMEOUT, encoding="utf-8", creationflags=_WIN_HIDDEN)
        if r.returncode != 0:
            print(f"[skills] claude failed exit={r.returncode}", file=sys.stderr)
            return None
        return (r.stdout or "").strip()
    except subprocess.TimeoutExpired:
        print(f"[skills] timeout after {SYNC_TIMEOUT}s", file=sys.stderr)
        return None


def export_one(skill_dir: Path, target: str, out_dir: Path) -> int:
    """Translate skill_dir/SKILL.md to target format and write to out_dir."""
    profile = TARGET_PROFILES[target]
    skill_md = skill_dir / "SKILL.md"
    skill_text = skill_md.read_text(encoding="utf-8")

    user = (f"Source skill name: {skill_dir.name}\n"
            f"Source size: {len(skill_text)} chars\n\n"
            f"--- SKILL.MD START ---\n{skill_text}\n--- SKILL.MD END ---\n\n"
            f"Translate to {profile['filename']} format following the system rules. "
            f"Output ONLY the markdown body.")

    print(f"[skills] Translating {skill_dir.name} → {target} via {SYNC_MODEL}...")
    body = call_claude(profile["system"], user)
    if not body:
        return 1

    # Strip code fences if model wrapped output
    if body.startswith("```"):
        lines = body.split("\n")
        if lines[-1].strip().startswith("```"):
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        body = "\n".join(lines)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / profile["filename"]
    header = profile["header"].format(skill=skill_dir.name,
                                       date=datetime.now().strftime("%Y-%m-%d"))
    out_path.write_text(header + body, encoding="utf-8")
    print(f"[skills] Wrote: {out_path} ({out_path.stat().st_size}b)")
    return 0


def cmd_export(args) -> int:
    skill_dir = find_skill(args.skill)
    if not skill_dir:
        print(f"[skills] Not found: {args.skill}")
        return 1
    out_dir = Path(args.out).resolve() if args.out else Path.cwd()
    targets = ["codex", "gemini"] if args.target == "both" else [args.target]
    rc = 0
    for t in targets:
        rc |= export_one(skill_dir, t, out_dir)
    return rc


def cmd_check(args) -> int:
    """Detect drift between source SKILL.md and target AGENTS/GEMINI files."""
    skill_dir = find_skill(args.skill)
    if not skill_dir:
        print(f"[skills] Not found: {args.skill}")
        return 1
    skill_md = skill_dir / "SKILL.md"
    src_mtime = datetime.fromtimestamp(skill_md.stat().st_mtime)
    print(f"[skills] Source: {skill_md} (modified {src_mtime})")
    print()
    out_dir = Path(args.out).resolve() if args.out else Path.cwd()
    for t, profile in TARGET_PROFILES.items():
        target_path = out_dir / profile["filename"]
        if not target_path.exists():
            print(f"  {profile['filename']:<14} ABSENT (run: ultron skills sync export {args.skill} --target {t})")
            continue
        tgt_mtime = datetime.fromtimestamp(target_path.stat().st_mtime)
        drift = (src_mtime - tgt_mtime).total_seconds() / 60
        if drift > 5:
            print(f"  {profile['filename']:<14} STALE ({drift:.0f}min behind source)")
        else:
            print(f"  {profile['filename']:<14} fresh ({tgt_mtime})")
    return 0


def cmd_sync_all(args) -> int:
    """Translate ALL skills to target dir."""
    skills = list_skills()
    print(f"[skills] Syncing {len(skills)} skills to {args.target}...")
    out_dir = Path(args.out).resolve() if args.out else Path.cwd()
    rc = 0
    targets = ["codex", "gemini"] if args.target == "both" else [args.target]
    for s in skills:
        for t in targets:
            rc |= export_one(s, t, out_dir / s.name)
    return rc


def main():
    p = argparse.ArgumentParser(description="ULTRON Skills sync (Claude→Codex/Gemini)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("export")
    sp.add_argument("skill")
    sp.add_argument("--target", choices=["codex", "gemini", "both"], default="both")
    sp.add_argument("--out", help="Output directory (default cwd)")
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser("check")
    sp.add_argument("skill")
    sp.add_argument("--out", help="Where to look for AGENTS/GEMINI files (default cwd)")
    sp.set_defaults(func=cmd_check)

    sp = sub.add_parser("sync-all")
    sp.add_argument("--target", choices=["codex", "gemini", "both"], default="both")
    sp.add_argument("--out", help="Base output dir (creates <skill>/ subdir per skill)")
    sp.set_defaults(func=cmd_sync_all)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
