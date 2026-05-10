#!/usr/bin/env python3
"""
ULTRON v12 Vault Schema Migrator.

Tech debt closure from Triple Kirkardo R3: "Vault schema sin version → si
cambias frontmatter no hay migrator". This is the infrastructure to add now,
so when v13/v14 changes the schema (new required fields, renamed keys, MECE
restructure), we have the path. v1 is the current state.

Migration model:
  - Each note's frontmatter SHOULD include `schema_version: <int>` (absent =
    treated as v1).
  - This script offers `audit` (no writes), `migrate <to_version>` (apply
    all migrations from current → target, idempotent), and `bless <files>`
    (just stamp schema_version=N without other changes, useful when you
    re-organise files manually).
  - Migrations are registered as small functions keyed by target version.
  - Currently zero migrations exist beyond v1. The framework is the deliverable.

Conventions:
  - All migrations are idempotent (safe to re-run).
  - All write operations refuse to touch files outside ~/.ultron-vault/.
  - --dry-run prints diffs without writing.

CLI:
    vault_migrator.py audit                Per-version count + missing-field report
    vault_migrator.py migrate --to 1 [--dry-run]
                                            Apply migrations up to N
    vault_migrator.py bless <pattern> --version 1 [--dry-run]
                                            Stamp schema_version into frontmatter
    vault_migrator.py validate             Check every note has valid frontmatter
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

VAULT = Path.home() / ".ultron-vault"

CURRENT_SCHEMA_VERSION = 2

FRONTMATTER_RE = re.compile(r"^(---\s*\n)(.*?)(\n---\s*\n)", re.DOTALL)
SCHEMA_VERSION_RE = re.compile(r"^schema_version\s*:\s*(\d+)\s*$",
                                 re.MULTILINE | re.IGNORECASE)


# ── Note IO ───────────────────────────────────────────────────────────────────

@dataclass
class NoteFM:
    path: Path
    has_frontmatter: bool
    fm_block: str  # raw text between --- fences (no fences)
    body: str
    schema_version: int  # 0 if absent


def read_note(path: Path) -> NoteFM:
    text = path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        return NoteFM(path=path, has_frontmatter=False, fm_block="",
                      body=text, schema_version=0)
    block = m.group(2)
    body = text[m.end():]
    sv_match = SCHEMA_VERSION_RE.search(block)
    sv = int(sv_match.group(1)) if sv_match else 0
    return NoteFM(path=path, has_frontmatter=True, fm_block=block,
                   body=body, schema_version=sv)


def write_note(note: NoteFM) -> None:
    """Reassemble + write. Refuses to touch anything outside VAULT."""
    p = note.path.resolve()
    if VAULT.resolve() not in p.parents and p != VAULT.resolve():
        raise PermissionError(f"Refuse to write outside vault: {p}")
    if note.has_frontmatter:
        text = f"---\n{note.fm_block}\n---\n{note.body}"
    else:
        text = note.body
    note.path.write_text(text, encoding="utf-8")


def set_schema_version(fm_block: str, version: int) -> str:
    """Insert or replace schema_version in a frontmatter block."""
    if SCHEMA_VERSION_RE.search(fm_block):
        return SCHEMA_VERSION_RE.sub(f"schema_version: {version}",
                                       fm_block, count=1)
    # Append at end of block
    block = fm_block.rstrip()
    return f"{block}\nschema_version: {version}"


# ── Migration registry ────────────────────────────────────────────────────────

MigrationFn = Callable[[NoteFM], NoteFM]
MIGRATIONS: dict[int, MigrationFn] = {}


def register(target_version: int):
    """Decorator: register a migration that takes a v(target-1) note and
    returns a v(target) note. Idempotent: must be safe to run on already-
    migrated notes (check schema_version inside if needed)."""
    def deco(fn: MigrationFn) -> MigrationFn:
        MIGRATIONS[target_version] = fn
        return fn
    return deco


# v1 baseline: no transformation, just ensure frontmatter exists with
# schema_version. Notes without frontmatter get a minimal one stamped in.
@register(1)
def migrate_to_v1(note: NoteFM) -> NoteFM:
    if note.schema_version >= 1:
        return note
    if not note.has_frontmatter:
        # Synthesize minimal frontmatter: title from filename + schema version.
        title = note.path.stem.replace("-", " ").replace("_", " ")
        note.fm_block = f"name: {note.path.stem}\ntitle: {title}\nschema_version: 1"
        note.has_frontmatter = True
    else:
        note.fm_block = set_schema_version(note.fm_block, 1)
    note.schema_version = 1
    return note


# v2: stamp `criticality:` based on vault directory — enables decay_queue
# to differentiate note importance instead of defaulting everything to "medium".
_DIR_CRITICALITY: dict[str, str] = {
    "00_INDEX":        "critical",   # navigation hub, always relevant
    "10_KNOWLEDGE":    "high",       # domain knowledge, frequently accessed
    "20_DECISIONS":    "critical",   # architectural decisions, never stale
    "30_PATTERNS":     "high",       # coding patterns to follow
    "40_SKILLS":       "medium",     # skill catalog + personas, consulted on demand
    "40_NEWS_ARCHIVE": "low",        # historical news, decays fast
    "50_SESSIONS_LOG": "low",        # session logs, short-lived
    "CC-memories":     "low",        # project-specific context, narrow scope
}
_CRITICALITY_RE = re.compile(r"^criticality\s*:\s*\S+\s*$", re.MULTILINE | re.IGNORECASE)


def _infer_criticality(path: Path) -> str:
    """Return criticality level from vault subdirectory name."""
    parts = path.relative_to(VAULT).parts
    top = parts[0] if parts else ""
    return _DIR_CRITICALITY.get(top, "medium")


@register(2)
def migrate_to_v2(note: NoteFM) -> NoteFM:
    """Add criticality: <level> to frontmatter based on vault directory."""
    if note.schema_version >= 2:
        return note
    # Ensure frontmatter exists (v1 guarantees this, but be safe)
    if not note.has_frontmatter:
        note = MIGRATIONS[1](note)
    # Skip if criticality already present
    if _CRITICALITY_RE.search(note.fm_block):
        note.fm_block = set_schema_version(note.fm_block, 2)
        note.schema_version = 2
        return note
    crit = _infer_criticality(note.path)
    block = note.fm_block.rstrip()
    note.fm_block = f"{block}\ncriticality: {crit}"
    note.fm_block = set_schema_version(note.fm_block, 2)
    note.schema_version = 2
    return note


# ── Walk + filter ─────────────────────────────────────────────────────────────

def iter_vault_notes() -> list[Path]:
    if not VAULT.exists():
        return []
    skip = ("/.git/", "/.obsidian/")
    return [p for p in VAULT.rglob("*.md")
             if not any(s in p.as_posix() for s in skip)]


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_audit(_args) -> int:
    notes = iter_vault_notes()
    by_version: dict[int, int] = {}
    missing_fm = 0
    for path in notes:
        n = read_note(path)
        if not n.has_frontmatter:
            missing_fm += 1
            v = -1  # surface no-fm separately
        else:
            v = n.schema_version
        by_version[v] = by_version.get(v, 0) + 1
    total = len(notes)
    print(f"⌬  Vault Schema Audit — {VAULT}  (CURRENT_SCHEMA_VERSION={CURRENT_SCHEMA_VERSION})")
    print("=" * 70)
    print(f"  Total notes: {total}")
    print(f"  Without frontmatter: {missing_fm}")
    print()
    print("  By schema_version:")
    for v in sorted(by_version.keys()):
        label = "(no frontmatter)" if v == -1 else (
            "(no schema_version field)" if v == 0 else f"v{v}")
        marker = "✓" if v == CURRENT_SCHEMA_VERSION else "·"
        print(f"  {marker} {label:<30} {by_version[v]}")
    return 0


def cmd_migrate(args) -> int:
    target = args.to
    if target not in MIGRATIONS:
        sys.stderr.write(
            f"[error] no migration defined for v{target}. "
            f"Available targets: {sorted(MIGRATIONS.keys())}\n",
        )
        return 1

    notes = iter_vault_notes()
    migrated = 0
    skipped = 0
    for path in notes:
        n = read_note(path)
        if n.schema_version >= target:
            skipped += 1
            continue
        # Apply each migration step from current → target in order
        for v in range(max(1, n.schema_version + 1), target + 1):
            if v in MIGRATIONS:
                n = MIGRATIONS[v](n)
        if args.dry_run:
            print(f"[dry-run] would migrate: {path.relative_to(VAULT)} "
                   f"v{n.schema_version} (was v{read_note(path).schema_version})")
            migrated += 1
        else:
            try:
                write_note(n)
                migrated += 1
                print(f"[ok] migrated v{n.schema_version}: "
                       f"{path.relative_to(VAULT)}")
            except Exception as e:
                print(f"[err] {path.relative_to(VAULT)}: {e}")
    print()
    print(f"[migrate] target=v{target}  migrated={migrated}  "
           f"skipped (already current)={skipped}")
    return 0


def cmd_bless(args) -> int:
    """Stamp schema_version: N into matching files without other changes."""
    pattern = args.pattern
    version = args.version
    matches = sorted(VAULT.rglob(pattern))
    if not matches:
        print(f"[bless] no matches for: {pattern}")
        return 0
    for path in matches:
        if not path.is_file() or path.suffix != ".md":
            continue
        n = read_note(path)
        if not n.has_frontmatter:
            print(f"[skip] no frontmatter: {path.relative_to(VAULT)}")
            continue
        if n.schema_version == version:
            continue
        n.fm_block = set_schema_version(n.fm_block, version)
        n.schema_version = version
        if args.dry_run:
            print(f"[dry-run] would bless v{version}: "
                   f"{path.relative_to(VAULT)}")
        else:
            write_note(n)
            print(f"[ok] blessed v{version}: {path.relative_to(VAULT)}")
    return 0


def cmd_validate(_args) -> int:
    """Surface notes that look broken to the schema (missing frontmatter,
    schema_version > current, etc.). Exit code reflects severity."""
    issues: list[str] = []
    for path in iter_vault_notes():
        n = read_note(path)
        rel = path.relative_to(VAULT)
        if not n.has_frontmatter:
            issues.append(f"  ⚠ no frontmatter: {rel}")
        elif n.schema_version > CURRENT_SCHEMA_VERSION:
            issues.append(
                f"  ✘ schema_version={n.schema_version} (newer than current "
                f"v{CURRENT_SCHEMA_VERSION}): {rel}",
            )
    if issues:
        print(f"⌬  Vault Validation — {len(issues)} issue(s)")
        print("=" * 70)
        print("\n".join(issues[:50]))
        if len(issues) > 50:
            print(f"  … and {len(issues) - 50} more")
        return 1
    print(f"[validate] OK — all notes have frontmatter ≤ "
           f"v{CURRENT_SCHEMA_VERSION}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        prog="vault_migrator",
        description=("ULTRON v12 — vault schema version + migrator. "
                       f"Current schema: v{CURRENT_SCHEMA_VERSION}"),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("audit",
                    help="Per-version counts + missing-field report").set_defaults(
        func=cmd_audit)

    sp = sub.add_parser("migrate", help="Apply migrations up to --to version")
    sp.add_argument("--to", type=int, default=CURRENT_SCHEMA_VERSION)
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(func=cmd_migrate)

    sp = sub.add_parser("bless",
                          help="Stamp schema_version without other changes")
    sp.add_argument("pattern", help="Glob (relative to vault root)")
    sp.add_argument("--version", type=int, required=True)
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(func=cmd_bless)

    sub.add_parser("validate",
                    help="Surface notes that look schema-broken").set_defaults(
        func=cmd_validate)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
