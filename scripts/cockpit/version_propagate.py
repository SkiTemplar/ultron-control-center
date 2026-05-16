"""ULTRON Cockpit — propagate SSOT version to all hardcoded mentions.

SSOT: `~/.claude/skills/ultron/SKILL.md` frontmatter `version:` field.

Targets (places that hardcode the version and drift over time):
  1. ~/.agents/skills/ultron/SKILL.md          frontmatter version + H1 title
  2. ~/.agents/skills/ultron/CLAUDE.md         H1 title only
  3. ~/.claude/skills/ultron/CLAUDE.md         H1 title only
  4. ~/.ultron/scripts/cockpit/ultron.ps1      first comment line

The H1 title format is normalised to:
  "# ULTRON <vX.Y.Z> "<CODENAME>" ..."

The codename comes from SKILL.md description line. If absent → use "GENESIS".

Usage:
    ultron memory propagate-version              # show drift, NO writes
    ultron memory propagate-version --apply      # write changes
    ultron memory propagate-version --check      # exit 1 if drift detected
                                                 # (used by `ultron verify`)
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

HOME = Path.home()
SSOT_PATH = HOME / ".claude" / "skills" / "ultron" / "SKILL.md"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


@dataclass
class Target:
    path: Path
    label: str
    pattern: re.Pattern
    template: str   # uses {version} and {codename}


def read_ssot() -> tuple[str, str]:
    """Return (version, codename) from SKILL.md frontmatter + description."""
    text = SSOT_PATH.read_text(encoding="utf-8")
    version = "v?.?.?"
    codename = "GENESIS"
    in_fm = False
    for line in text.splitlines():
        s = line.strip()
        if s == "---":
            if in_fm:
                break
            in_fm = True
            continue
        if in_fm and s.startswith("version:"):
            version = s.split(":", 1)[1].strip()
        if in_fm and s.startswith("description:"):
            m = re.search(r'ULTRON\s+v[\d.]+\s+"([^"]+)"', text)
            if m:
                codename = m.group(1)
    if not version.startswith("v"):
        version = "v" + version
    return version, codename


def targets() -> list[Target]:
    return [
        Target(
            path=HOME / ".agents" / "skills" / "ultron" / "SKILL.md",
            label="agents/SKILL.md frontmatter",
            pattern=re.compile(r"^version:\s*v?[\d.]+", re.MULTILINE),
            template="version: {version}",
        ),
        Target(
            path=HOME / ".agents" / "skills" / "ultron" / "SKILL.md",
            label="agents/SKILL.md description",
            pattern=re.compile(r'ULTRON\s+v?[\d.]+\s+"[^"]+"'),
            template='ULTRON {version} "{codename}"',
        ),
        Target(
            path=HOME / ".agents" / "skills" / "ultron" / "CLAUDE.md",
            label="agents/CLAUDE.md H1",
            pattern=re.compile(r'^# ULTRON v?[\d.]+\s+"[^"]+"', re.MULTILINE),
            template='# ULTRON {version} "{codename}"',
        ),
        Target(
            path=HOME / ".claude" / "skills" / "ultron" / "CLAUDE.md",
            label="claude/CLAUDE.md H1",
            pattern=re.compile(r'^# ULTRON v?[\d.]+\s+"[^"]+"', re.MULTILINE),
            template='# ULTRON {version} "{codename}"',
        ),
        Target(
            path=HOME / ".ultron" / "scripts" / "cockpit" / "ultron.ps1",
            label="ultron.ps1 header comment",
            pattern=re.compile(r'^# ULTRON v?[\d.]+\s+"[^"]+"\s+CORE', re.MULTILINE),
            template='# ULTRON {version} "{codename}" CORE',
        ),
    ]


@dataclass
class Diff:
    target: Target
    found: bool
    old: str
    new: str
    changed: bool


def apply_target(t: Target, version: str, codename: str, apply: bool) -> Diff:
    if not t.path.exists():
        return Diff(t, found=False, old="(missing)", new="", changed=False)
    # utf-8-sig strips BOM if present (PowerShell .ps1 saved by some editors).
    text = t.path.read_text(encoding="utf-8-sig")
    had_bom = t.path.read_bytes()[:3] == b"\xef\xbb\xbf"
    m = t.pattern.search(text)
    if not m:
        return Diff(t, found=False, old="(no match)", new="", changed=False)
    old = m.group(0)
    new = t.template.format(version=version, codename=codename)
    if old == new:
        return Diff(t, found=True, old=old, new=new, changed=False)
    if apply:
        new_text = t.pattern.sub(new, text, count=1)
        # Preserve BOM if the original had one (PowerShell parser requires it
        # for some encodings — never silently strip).
        if had_bom:
            t.path.write_bytes(b"\xef\xbb\xbf" + new_text.encode("utf-8"))
        else:
            t.path.write_text(new_text, encoding="utf-8")
    return Diff(t, found=True, old=old, new=new, changed=True)


def render(diffs: list[Diff], applied: bool) -> str:
    lines = []
    for d in diffs:
        marker = "✏ " if d.changed else ("· " if d.found else "?? ")
        action = ("APPLIED" if applied else "WOULD CHANGE") if d.changed else ("OK" if d.found else "MISSING")
        lines.append(f"{marker} {action:<13} {d.target.label}")
        if d.changed:
            lines.append(f"             old: {d.old}")
            lines.append(f"             new: {d.new}")
        elif d.found:
            lines.append(f"             ok:  {d.old}")
        else:
            lines.append(f"             —    {d.target.path}")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser(prog="ultron memory propagate-version")
    p.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    p.add_argument("--check", action="store_true",
                   help="exit 1 if drift detected (for ultron verify)")
    args = p.parse_args()

    if not SSOT_PATH.exists():
        print(f"FATAL: SSOT missing: {SSOT_PATH}", file=sys.stderr)
        sys.exit(2)

    version, codename = read_ssot()
    diffs = [apply_target(t, version, codename, args.apply) for t in targets()]
    drift = sum(1 for d in diffs if d.changed)

    if args.check:
        if drift:
            print(f"DRIFT: {drift} target(s) out of sync with SSOT {version}", file=sys.stderr)
            sys.exit(1)
        print(f"OK: all targets in sync with SSOT {version}")
        sys.exit(0)

    print(f"SSOT: {version} \"{codename}\"  ({SSOT_PATH.name})\n")
    print(render(diffs, applied=args.apply))
    print()
    if drift and not args.apply:
        print(f"⚠  {drift} target(s) would change. Re-run with --apply to write.")
    elif drift and args.apply:
        print(f"✅ {drift} target(s) updated.")
    else:
        print("✅ All targets in sync.")


if __name__ == "__main__":
    main()
