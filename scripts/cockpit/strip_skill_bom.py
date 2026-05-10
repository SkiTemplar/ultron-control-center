#!/usr/bin/env python3
"""
ULTRON v12.5 — Strip UTF-8 BOM from skill files.

PowerShell's Set-Content default writes UTF-8 with BOM (\xef\xbb\xbf). Markdown
parsers (Codex skill loader, GitHub markdown rendering, YAML frontmatter
parsers) look for `^---` at byte 0 and fail when there's a 3-byte BOM in front,
producing "missing YAML frontmatter" warnings on perfectly-valid skills.

This script walks ~/.claude/skills/ and ~/.agents/skills/, finds SKILL.md /
skill.md files starting with the UTF-8 BOM, and rewrites them as plain UTF-8.

Usage:
    strip_skill_bom.py scan          # Just count, don't modify
    strip_skill_bom.py fix [--dry-run]  # Strip BOM from affected files
    strip_skill_bom.py fix --root <path>  # Specific root only

Idempotent: re-running on already-stripped files is a no-op.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BOM = b"\xef\xbb\xbf"
DEFAULT_ROOTS = [
    Path.home() / ".claude" / "skills",
    Path.home() / ".agents" / "skills",
]
SKILL_FILE_NAMES = ("SKILL.md", "skill.md")


def find_skill_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    files: list[Path] = []
    for skill_dir in root.iterdir():
        if not skill_dir.is_dir() or skill_dir.name.startswith("."):
            continue
        for name in SKILL_FILE_NAMES:
            f = skill_dir / name
            if f.is_file():
                files.append(f)
    return files


def has_bom(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            return fh.read(3) == BOM
    except OSError:
        return False


def strip_bom(path: Path) -> bool:
    """Rewrite the file without BOM. Returns True if changed."""
    try:
        data = path.read_bytes()
    except OSError as exc:
        print(f"  [error] read {path}: {exc}", file=sys.stderr)
        return False
    if not data.startswith(BOM):
        return False
    try:
        path.write_bytes(data[len(BOM):])
        return True
    except OSError as exc:
        print(f"  [error] write {path}: {exc}", file=sys.stderr)
        return False


def cmd_scan(args) -> int:
    roots = [Path(r) for r in args.roots] if args.roots else DEFAULT_ROOTS
    grand_total = 0
    grand_bom = 0
    for root in roots:
        files = find_skill_files(root)
        bom_files = [f for f in files if has_bom(f)]
        grand_total += len(files)
        grand_bom += len(bom_files)
        if files:
            print(f"{root}: {len(bom_files)}/{len(files)} have BOM")
            if args.verbose and bom_files:
                for f in bom_files[:20]:
                    print(f"  - {f.relative_to(root)}")
                if len(bom_files) > 20:
                    print(f"  ... and {len(bom_files) - 20} more")
    print(f"\nTotal: {grand_bom}/{grand_total} skill files have UTF-8 BOM")
    return 0 if grand_bom == 0 else 1


def cmd_fix(args) -> int:
    roots = [Path(r) for r in args.roots] if args.roots else DEFAULT_ROOTS
    grand_fixed = 0
    grand_skipped = 0
    for root in roots:
        files = find_skill_files(root)
        if not files:
            continue
        fixed = 0
        for f in files:
            if not has_bom(f):
                continue
            if args.dry_run:
                print(f"  DRY-RUN strip: {f}")
                fixed += 1
            else:
                if strip_bom(f):
                    fixed += 1
        grand_fixed += fixed
        grand_skipped += len(files) - fixed
        print(f"{root}: {fixed} {'would be ' if args.dry_run else ''}stripped, "
              f"{len(files) - fixed} already clean")
    if args.dry_run:
        print(f"\nDRY-RUN: {grand_fixed} files would have BOM removed")
    else:
        print(f"\nDone: {grand_fixed} files stripped of BOM")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="strip_skill_bom",
                                description="Strip UTF-8 BOM from SKILL.md files")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="Count BOM-affected files (read-only)")
    p_scan.add_argument("--roots", nargs="+",
                         help="Override default roots (~/.claude/skills, ~/.agents/skills)")
    p_scan.add_argument("--verbose", "-v", action="store_true",
                         help="List affected files (max 20 per root)")
    p_scan.set_defaults(func=cmd_scan)

    p_fix = sub.add_parser("fix", help="Strip BOM from affected files")
    p_fix.add_argument("--roots", nargs="+",
                        help="Override default roots")
    p_fix.add_argument("--dry-run", action="store_true",
                        help="Print what would be done without modifying")
    p_fix.set_defaults(func=cmd_fix)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
