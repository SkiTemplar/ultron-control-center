#!/usr/bin/env python3
"""
ULTRON v12.5 — Skill frontmatter validator + auto-fixer (repo-evaluator-hardened).

Walks ~/.claude/skills/, ~/.agents/skills/, ~/.codex/skills/ and detects/fixes:
  1. UTF-8 BOM at byte 0
  2. description > 1024 chars (manual review only — semantic loss)
  3. Unquoted YAML scalars with embedded `:` (mapping-values error)
  4. Mojibake `�` characters in frontmatter (scoped — body is preserved)

Hardening (post-repo-evaluator audit):
  - Atomic writes (tmp + os.replace) — no truncation on interrupt
  - BOM-only mode does NOT decode/re-encode (preserves non-UTF-8 bytes intact)
  - Mojibake substitution is SCOPED to frontmatter span (body is sacred)
  - Newline-aware folding for block-scalar emit (no chopped words)
  - Preserves CRLF if input was CRLF; LF otherwise
  - `...` document terminator recognized in addition to `---`

Commands:
    validate_skills.py scan [--verbose]
    validate_skills.py fix [--dry-run] [--bom-only]
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BOM = b"\xef\xbb\xbf"
DESC_MAX = 1024
DEFAULT_ROOTS = [
    Path.home() / ".claude" / "skills",
    Path.home() / ".agents" / "skills",
    Path.home() / ".codex"  / "skills",
]
SKILL_FILE_NAMES = ("SKILL.md", "skill.md")
# U+FFFD (replacement), U+FEFF (zero-width nbsp / BOM-as-text).
# Other invisible chars (zero-width space, soft hyphen, etc.) are NOT auto-replaced
# because they may be intentional in skill body content.
MOJIBAKE_RE = re.compile("[�﻿]")
# Frontmatter regex: opens with `---`, optional `\r`, closes with `---` or `...`
# Captures the inner block AND the closing terminator so we can preserve it.
FRONTMATTER_RE = re.compile(
    r"\A(---)(\r?\n)(.*?)\2(---|\.\.\.)\2",
    re.DOTALL,
)
DESC_FIELD_RE = re.compile(
    r"^(description\s*:\s*)(.+?)(?=\n[a-zA-Z_][\w-]*\s*:|\Z)",
    re.MULTILINE | re.DOTALL,
)


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
                break
    return files


def has_bom(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            return fh.read(3) == BOM
    except OSError:
        return False


def parse_frontmatter(text: str) -> tuple[str, str, str, str, int] | None:
    """Return (open_marker, eol, fm_body, close_marker, body_offset) or None."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3), m.group(4), m.end()


def extract_description_value(fm: str) -> tuple[str, bool] | None:
    """Return (effective_value, is_block_or_quoted) or None.

    is_block_or_quoted=True means already YAML-safe (block scalar or quoted).
    For length counting, the effective value joins folded lines with spaces.
    """
    m = DESC_FIELD_RE.search(fm)
    if not m:
        return None
    raw = m.group(2).strip()
    # Block scalar
    if raw.startswith(">") or raw.startswith("|"):
        lines = raw.split("\n")
        body_lines = [ln.strip() for ln in lines[1:] if ln.strip()]
        return (" ".join(body_lines), True)
    # Quoted
    if (raw.startswith('"') and raw.endswith('"')) or \
       (raw.startswith("'") and raw.endswith("'")):
        return (raw[1:-1], True)
    return (raw, False)


def scalar_has_yaml_hazard(value: str, already_safe: bool) -> bool:
    if already_safe:
        return False
    if MOJIBAKE_RE.search(value):
        return True
    if ": " in value:
        return True
    if "\t" in value:
        return True
    if value.startswith(("[", "{", "&", "*", "!", "|", ">", "%", "@", "`", "#")):
        return True
    return False


class Issue:
    __slots__ = ("path", "kind", "detail", "auto_fixable")
    def __init__(self, path, kind, detail, auto_fixable):
        self.path = path
        self.kind = kind
        self.detail = detail
        self.auto_fixable = auto_fixable


def diagnose(path: Path) -> list[Issue]:
    issues: list[Issue] = []
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return [Issue(path, "io-error", str(exc), False)]

    has_bom_flag = raw.startswith(BOM)
    if has_bom_flag:
        issues.append(Issue(path, "bom", "UTF-8 BOM at byte 0", True))
        raw_stripped = raw[len(BOM):]
    else:
        raw_stripped = raw

    try:
        text = raw_stripped.decode("utf-8")
    except UnicodeDecodeError as exc:
        return issues + [Issue(path, "encoding", str(exc), False)]

    parsed = parse_frontmatter(text)
    if not parsed:
        issues.append(Issue(path, "no-frontmatter",
                             "no `---` block at start of file", False))
        return issues

    _, _, fm, _, _ = parsed
    desc = extract_description_value(fm)
    if not desc:
        issues.append(Issue(path, "no-description",
                             "frontmatter lacks `description:` field", False))
        return issues
    value, already_safe = desc
    if len(value) > DESC_MAX:
        issues.append(Issue(path, "desc-too-long",
                             f"description is {len(value)} chars (max {DESC_MAX})",
                             False))
    if scalar_has_yaml_hazard(value, already_safe):
        mojibake = bool(MOJIBAKE_RE.search(value))
        issues.append(Issue(path, "yaml-hazard",
                             f"unquoted scalar with hazard"
                             + (" (mojibake)" if mojibake else " (embedded colon/tab/special)"),
                             True))
    return issues


def _atomic_write(path: Path, data: bytes) -> bool:
    """Write data via tmp + os.replace. Returns True on success."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)  # atomic on Windows + POSIX
        return True
    except OSError as exc:
        print(f"  [error] atomic write {path}: {exc}", file=sys.stderr)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


def _fold_value(value: str, indent: str = "  ", width: int = 80) -> str:
    """Word-wrap value into lines of ~width chars, each prefixed with indent.

    Newline-aware: collapses any internal whitespace (including \\n) to single
    spaces first, then word-wraps. Avoids chopping words mid-character.
    """
    flat = re.sub(r"\s+", " ", value).strip()
    words = flat.split(" ")
    lines: list[str] = []
    current = ""
    for w in words:
        if not current:
            current = w
        elif len(current) + 1 + len(w) > width:
            lines.append(indent + current)
            current = w
        else:
            current = current + " " + w
    if current:
        lines.append(indent + current)
    return "\n".join(lines)


def fix_file(path: Path, issues: list[Issue], dry_run: bool, bom_only: bool) -> list[str]:
    applied: list[str] = []
    if not issues:
        return applied

    # ── BOM-only path: byte-precise strip, NO decode/re-encode ────────────────
    if bom_only or all(i.kind == "bom" for i in issues if i.auto_fixable):
        if any(i.kind == "bom" for i in issues if i.auto_fixable):
            try:
                raw = path.read_bytes()
            except OSError:
                return applied
            if raw.startswith(BOM):
                if dry_run:
                    applied.append("strip-bom")
                else:
                    if _atomic_write(path, raw[len(BOM):]):
                        applied.append("strip-bom")
        return applied

    # ── Full fix path: read, decode, mutate frontmatter only, write ───────────
    try:
        raw = path.read_bytes()
    except OSError:
        return applied
    had_bom = raw.startswith(BOM)
    if had_bom:
        raw = raw[len(BOM):]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # Don't try to fix non-UTF-8 files via this path — risk of mangling
        if had_bom and not dry_run:
            # At least preserve BOM strip via byte-write
            _atomic_write(path, raw)
            applied.append("strip-bom")
        return applied

    parsed = parse_frontmatter(text)
    if not parsed:
        return applied
    open_mark, eol, fm, close_mark, body_offset = parsed
    body = text[body_offset:]
    new_fm = fm

    # Mojibake — SCOPED to frontmatter span only
    if any(i.kind == "yaml-hazard" for i in issues if i.auto_fixable):
        new_fm_no_mojibake = MOJIBAKE_RE.sub("-", new_fm)
        if new_fm_no_mojibake != new_fm:
            new_fm = new_fm_no_mojibake

        # Re-emit description as block scalar if hazard
        desc_m = DESC_FIELD_RE.search(new_fm)
        if desc_m:
            prefix = desc_m.group(1).rstrip()  # "description:"
            value = desc_m.group(2).strip()
            already_safe = (
                value.startswith((">", "|"))
                or (value.startswith('"') and value.endswith('"'))
                or (value.startswith("'") and value.endswith("'"))
            )
            if not already_safe and scalar_has_yaml_hazard(value, False):
                folded = _fold_value(value)
                new_desc = f"{prefix} >\n{folded}"
                new_fm = new_fm[:desc_m.start()] + new_desc + new_fm[desc_m.end():]
        if new_fm != fm:
            applied.append("yaml-quote")

    if had_bom:
        applied.append("strip-bom")

    if not applied:
        return applied

    # Reassemble preserving original line endings + terminator
    new_text = open_mark + eol + new_fm + eol + close_mark + eol + body
    new_bytes = new_text.encode("utf-8")
    if dry_run:
        return applied
    if _atomic_write(path, new_bytes):
        return applied
    return []


def cmd_scan(args) -> int:
    roots = [Path(r) for r in args.roots] if args.roots else DEFAULT_ROOTS
    grand: dict[str, int] = {}
    by_root_total = 0
    by_root_with_issues = 0
    for root in roots:
        files = find_skill_files(root)
        if not files:
            print(f"{root}: (not found or empty)")
            continue
        with_issues = 0
        for f in files:
            iss = diagnose(f)
            if not iss:
                continue
            with_issues += 1
            for i in iss:
                grand[i.kind] = grand.get(i.kind, 0) + 1
                if args.verbose:
                    print(f"  [{i.kind}] {f.relative_to(root)}: {i.detail}")
        print(f"{root}: {with_issues}/{len(files)} have issues")
        by_root_total += len(files)
        by_root_with_issues += with_issues
    print(f"\nTotal: {by_root_with_issues}/{by_root_total} files have issues")
    if grand:
        print("By kind:")
        for kind, n in sorted(grand.items(), key=lambda x: -x[1]):
            auto = " (auto-fixable)" if kind in {"bom", "yaml-hazard"} else " (manual review)"
            print(f"  {kind:>15}: {n}{auto}")
    return 0 if not grand else 1


def cmd_fix(args) -> int:
    roots = [Path(r) for r in args.roots] if args.roots else DEFAULT_ROOTS
    grand_fixed: dict[str, int] = {}
    grand_unfixable: list[tuple[Path, str, str]] = []
    for root in roots:
        files = find_skill_files(root)
        if not files:
            continue
        n_fixed = 0
        for f in files:
            issues = diagnose(f)
            if not issues:
                continue
            applied = fix_file(f, issues, args.dry_run, args.bom_only)
            for fix in applied:
                grand_fixed[fix] = grand_fixed.get(fix, 0) + 1
            if applied:
                n_fixed += 1
            for i in issues:
                if not i.auto_fixable:
                    grand_unfixable.append((f, i.kind, i.detail))
        print(f"{root}: {n_fixed} files {'would be ' if args.dry_run else ''}fixed")
    print()
    if grand_fixed:
        print(f"{'Would apply' if args.dry_run else 'Applied'}:")
        for kind, n in sorted(grand_fixed.items(), key=lambda x: -x[1]):
            print(f"  {kind:>15}: {n}")
    if grand_unfixable:
        # Dedup (multi-issue files surface once per issue)
        seen = set()
        unique = []
        for path, kind, detail in grand_unfixable:
            k = (str(path), kind)
            if k in seen:
                continue
            seen.add(k)
            unique.append((path, kind, detail))
        print(f"\nManual review needed ({len(unique)}):")
        for path, kind, detail in unique[:30]:
            print(f"  [{kind}] {path}")
            print(f"    {detail}")
        if len(unique) > 30:
            print(f"  ... and {len(unique) - 30} more")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="validate_skills",
        description="Skill frontmatter validator + auto-fixer (BOM, YAML hazards, length)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="Report issues without modifying files")
    p_scan.add_argument("--roots", nargs="+")
    p_scan.add_argument("--verbose", "-v", action="store_true")
    p_scan.set_defaults(func=cmd_scan)

    p_fix = sub.add_parser("fix", help="Auto-fix safe issues; flag the rest")
    p_fix.add_argument("--roots", nargs="+")
    p_fix.add_argument("--dry-run", action="store_true")
    p_fix.add_argument("--bom-only", action="store_true",
                        help="Only strip BOM (byte-precise, no decode/re-encode)")
    p_fix.set_defaults(func=cmd_fix)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
