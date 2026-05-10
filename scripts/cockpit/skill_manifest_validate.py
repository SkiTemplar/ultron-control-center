#!/usr/bin/env python3
"""
ULTRON v13.0 — SKILL.md frontmatter contract validator (Sprint 2 F2.1).

Enforces the v13.0 frontmatter schema across every SKILL.md in the codebase:

    REQUIRED fields:
      name           : slug (lowercase-kebab), matches directory name
      description    : 1..1024 chars (Anthropic CC limit)
      kind           : persona | plugin | skill | agent | meta
      tier           : L1 | L2 | L3
      category       : free string (e.g., "persona", "game-dev", "misc")

    OPTIONAL fields (warn if missing on persona/meta):
      last_verified  : YYYY-MM-DD — when human last reviewed (decay scoring input)
      version        : free string (e.g., "v12.5.0")

CLI:
    skill_manifest_validate.py validate                 # exit 0 if all pass, 1 if any fail
    skill_manifest_validate.py validate --warn-only     # exit 0 always
    skill_manifest_validate.py report [--json]          # human or machine-readable summary
    skill_manifest_validate.py one <name-or-path>       # check one skill

Used as CI gate in skill_manifest.py rebuild (F2.3).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Local import — ultron_paths is the SSOT for filesystem locations (F12)
sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import CLAUDE_SKILLS_DIR

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

VALID_KINDS = {"persona", "plugin", "skill", "agent", "meta"}
VALID_TIERS = {"L1", "L2", "L3"}
DESCRIPTION_MAX = 1024  # Anthropic Claude Code limit
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]*$")  # dots allowed for version-tagged slugs (e.g., powershell-5.1-expert)
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)


@dataclass
class Issue:
    skill: str
    file: str
    severity: str            # error | warn
    field: str
    message: str


@dataclass
class ValidationReport:
    total: int = 0
    valid: int = 0
    issues: list[Issue] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == "warn"]


def parse_frontmatter(text: str) -> tuple[dict[str, str], bool]:
    """Cheap YAML-frontmatter parser. Returns (fields, has_block).

    Supports:
      - flat key: value pairs
      - YAML scalar block `description: >` (folded scalar) — concatenates following indented lines
      - Quoted strings (single/double)

    Does NOT support arbitrary nested structures — that's fine for our flat schema.
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, False

    fm: dict[str, str] = {}
    block = m.group(1)
    lines = block.splitlines()

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        i += 1
        if not line or line.startswith("#"):
            continue
        # Collect indented continuation (folded `>` or block `|` scalar)
        if line.endswith(": >") or line.endswith(": |"):
            key = line.split(":", 1)[0].strip()
            buf = []
            while i < len(lines) and (lines[i].startswith(" ") or lines[i].startswith("\t") or not lines[i].strip()):
                buf.append(lines[i].strip())
                i += 1
            fm[key] = " ".join(s for s in buf if s).strip()
            continue
        if ":" in line:
            k, _, v = line.partition(":")
            v = v.strip().strip('"').strip("'")
            fm[k.strip()] = v
    return fm, True


def validate_skill(skill_dir: Path) -> tuple[bool, list[Issue]]:
    """Validate SKILL.md frontmatter for one skill directory.

    Returns (is_valid, issues). is_valid means no errors (warnings OK)."""
    skill_md = skill_dir / "SKILL.md"
    name = skill_dir.name
    issues: list[Issue] = []
    file_str = str(skill_md)

    if not skill_md.exists():
        issues.append(Issue(name, file_str, "error", "FILE",
                            "SKILL.md missing"))
        return False, issues

    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        issues.append(Issue(name, file_str, "error", "FILE",
                            f"read error: {e}"))
        return False, issues

    fm, has_block = parse_frontmatter(text)
    if not has_block:
        issues.append(Issue(name, file_str, "error", "frontmatter",
                            "no `---` frontmatter block found"))
        return False, issues

    # Required: name
    fm_name = fm.get("name", "").strip()
    if not fm_name:
        issues.append(Issue(name, file_str, "error", "name",
                            "missing required field"))
    elif not SLUG_RE.match(fm_name):
        issues.append(Issue(name, file_str, "error", "name",
                            f"not a valid slug: '{fm_name}'"))
    elif fm_name != name:
        issues.append(Issue(name, file_str, "warn", "name",
                            f"frontmatter '{fm_name}' != dir '{name}'"))

    # Required: description
    desc = fm.get("description", "").strip()
    if not desc:
        issues.append(Issue(name, file_str, "error", "description",
                            "missing required field"))
    elif len(desc) > DESCRIPTION_MAX:
        issues.append(Issue(name, file_str, "error", "description",
                            f"length {len(desc)} > {DESCRIPTION_MAX} (Anthropic CC limit)"))

    # Required: kind
    kind = fm.get("kind", "").strip()
    if not kind:
        issues.append(Issue(name, file_str, "error", "kind",
                            "missing required field — must be one of "
                            f"{sorted(VALID_KINDS)}"))
    elif kind not in VALID_KINDS:
        issues.append(Issue(name, file_str, "error", "kind",
                            f"'{kind}' not in {sorted(VALID_KINDS)}"))

    # Required: tier
    tier = fm.get("tier", "").strip()
    if not tier:
        issues.append(Issue(name, file_str, "error", "tier",
                            f"missing required field — must be one of {sorted(VALID_TIERS)}"))
    elif tier not in VALID_TIERS:
        issues.append(Issue(name, file_str, "error", "tier",
                            f"'{tier}' not in {sorted(VALID_TIERS)}"))

    # Required: category
    category = fm.get("category", "").strip()
    if not category:
        issues.append(Issue(name, file_str, "error", "category",
                            "missing required field"))

    # Optional: last_verified
    last_verified = fm.get("last_verified", "").strip()
    if last_verified and not ISO_DATE_RE.match(last_verified):
        issues.append(Issue(name, file_str, "error", "last_verified",
                            f"not ISO date YYYY-MM-DD: '{last_verified}'"))
    elif not last_verified and kind in {"persona", "meta"}:
        # personas + meta should have last_verified for decay scoring
        issues.append(Issue(name, file_str, "warn", "last_verified",
                            "missing — recommended for persona/meta"))

    is_valid = not any(i.severity == "error" for i in issues)
    return is_valid, issues


def discover_skills() -> list[Path]:
    """Return all skill directories that contain a SKILL.md or could (for missing-file detection)."""
    if not CLAUDE_SKILLS_DIR.exists():
        return []
    return sorted(d for d in CLAUDE_SKILLS_DIR.iterdir()
                  if d.is_dir() and not d.name.startswith("."))


def run_validation() -> ValidationReport:
    report = ValidationReport()
    for skill_dir in discover_skills():
        report.total += 1
        ok, issues = validate_skill(skill_dir)
        if ok:
            report.valid += 1
        report.issues.extend(issues)
    return report


# ─── CLI ───────────────────────────────────────────────────────────────────────

def cmd_validate(args) -> int:
    report = run_validation()
    n_err = len(report.errors)
    n_warn = len(report.warnings)
    coverage = report.valid / report.total * 100 if report.total else 0
    print(f"[validate] {report.valid}/{report.total} skills pass ({coverage:.1f}% coverage)")
    print(f"[validate] {n_err} error(s), {n_warn} warning(s)")
    if n_err:
        # Show top 10 error skills (deduplicated)
        skills_with_errors = {}
        for issue in report.errors:
            skills_with_errors.setdefault(issue.skill, []).append(
                f"{issue.field}: {issue.message}")
        for skill in sorted(skills_with_errors)[:10]:
            print(f"  ✗ {skill}:")
            for msg in skills_with_errors[skill][:3]:
                print(f"      {msg}")
        if len(skills_with_errors) > 10:
            print(f"  ... and {len(skills_with_errors) - 10} more skill(s) with errors")
    if args.warn_only:
        return 0
    return 1 if n_err else 0


def cmd_report(args) -> int:
    report = run_validation()
    if args.json:
        out = {
            "total": report.total,
            "valid": report.valid,
            "errors": len(report.errors),
            "warnings": len(report.warnings),
            "coverage": round(report.valid / report.total * 100, 1) if report.total else 0,
            "issues": [
                {"skill": i.skill, "severity": i.severity, "field": i.field, "message": i.message}
                for i in report.issues
            ],
        }
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0
    # Human report by field
    by_field: dict[str, int] = {}
    for issue in report.errors:
        by_field[issue.field] = by_field.get(issue.field, 0) + 1
    print(f"Coverage: {report.valid}/{report.total} ({report.valid / report.total * 100:.1f}%)")
    print("Errors by field:")
    for field_name, count in sorted(by_field.items(), key=lambda kv: -kv[1]):
        print(f"  {field_name:<16} {count}")
    return 0


def cmd_one(args) -> int:
    target = args.skill
    skill_dir = (CLAUDE_SKILLS_DIR / target if not Path(target).is_absolute()
                 else Path(target))
    if not skill_dir.is_dir():
        print(f"[validate] skill dir not found: {skill_dir}", file=sys.stderr)
        return 2
    ok, issues = validate_skill(skill_dir)
    print(f"[validate] {skill_dir.name}: {'OK' if ok else 'FAIL'}")
    for issue in issues:
        prefix = "✗" if issue.severity == "error" else "⚠"
        print(f"  {prefix} {issue.field}: {issue.message}")
    return 0 if ok else 1


def main() -> int:
    p = argparse.ArgumentParser(prog="skill_manifest_validate",
                                description="ULTRON v13.0 SKILL.md frontmatter contract validator")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp_v = sub.add_parser("validate", help="Validate all SKILL.md (exit 0 if all pass)")
    sp_v.add_argument("--warn-only", action="store_true",
                      help="Exit 0 even with errors (for diagnostic runs)")
    sp_v.set_defaults(func=cmd_validate)

    sp_r = sub.add_parser("report", help="Show coverage + error breakdown")
    sp_r.add_argument("--json", action="store_true", help="JSON output")
    sp_r.set_defaults(func=cmd_report)

    sp_o = sub.add_parser("one", help="Validate one skill by name or path")
    sp_o.add_argument("skill")
    sp_o.set_defaults(func=cmd_one)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
