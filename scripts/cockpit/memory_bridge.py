#!/usr/bin/env python3
"""
ULTRON v12.2 — Memory Bridge: CC project memories <-> Vault sync + wikilink repair.

Fixes the CC<->Desktop split by ingesting ~/.claude/projects/*/memory/*.md files
into ~/.ultron-vault/CC-memories/ (L2 vault), then updating brain_index.

Commands:
    memory_bridge.py status              Show what's pending ingest from CC projects
    memory_bridge.py ingest              Ingest new/changed CC memories into vault
    memory_bridge.py repair-wikilinks    Scan vault for broken [[link]] references
    memory_bridge.py repair-wikilinks --fix  Convert broken links to plain text
Commands:
    memory_bridge.py export [--project SLUG]  Export vault CC-memories back to CC projects
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import COCKPIT_DIR  # noqa: E402

PROJECTS_DIR = Path.home() / ".claude" / "projects"
VAULT_DIR = Path.home() / ".ultron-vault"
CC_MEMORIES_DIR = VAULT_DIR / "CC-memories"
BRIDGE_INDEX = COCKPIT_DIR / "bridge-index.json"

SKILL_ROOT = Path.home() / ".ultron"


# ── Helpers ────────────────────────────────────────────────────────────────────

def _load_index() -> dict:
    if BRIDGE_INDEX.exists():
        try:
            return json.loads(BRIDGE_INDEX.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"version": "1.0", "ingested": {}}


def _save_index(index: dict) -> None:
    BRIDGE_INDEX.parent.mkdir(parents=True, exist_ok=True)
    index["updated"] = datetime.now().isoformat()
    BRIDGE_INDEX.write_text(json.dumps(index, indent=2), encoding="utf-8")


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


def _project_slug(project_dir: Path) -> str:
    """Convert CC project dir name to a readable slug.

    C--Users-USER-CARRERA-PROYECTOS-PERSONALES-niajska -> niajska
    C--Users-USER--claude-skills-ultron -> claude-skills-ultron
    """
    name = project_dir.name
    # Strip leading drive letter pattern (C--)
    name = re.sub(r"^[A-Z]--", "", name)
    # Drop User-specific prefix
    name = re.sub(r"^Users-[^-]+-", "", name)
    # Take last 3 meaningful segments max
    parts = [p for p in name.split("-") if p]
    if not parts:
        return project_dir.name[:30]
    slug = "-".join(parts[-3:]).lower()
    return re.sub(r"[^a-z0-9\-]", "", slug)[:50]


def _scan_cc_memories() -> list[tuple[Path, Path]]:
    """Find all .md files in ~/.claude/projects/*/memory/. Returns (project_dir, file) pairs."""
    results = []
    if not PROJECTS_DIR.exists():
        return results
    for project_dir in PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        mem_dir = project_dir / "memory"
        if not mem_dir.exists():
            continue
        for f in sorted(mem_dir.glob("*.md")):
            results.append((project_dir, f))
    return results


def _update_brain_index() -> None:
    brain_script = Path(__file__).parent / "brain_index.py"
    if not brain_script.exists():
        return
    try:
        r = subprocess.run(
            ["uv", "run", "python", str(brain_script), "update"],
            capture_output=True, text=True, timeout=60,
            cwd=SKILL_ROOT, creationflags=_WIN_HIDDEN,
        )
        if r.returncode == 0:
            print("  [brain_index] incremental update done")
        else:
            print(f"  [brain_index] update failed (exit={r.returncode})")
    except Exception as e:
        print(f"  [brain_index] skip: {e}")


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_status(_args) -> int:
    files = _scan_cc_memories()
    index = _load_index()

    pending = []
    synced = []

    for project_dir, mem_file in files:
        key = str(mem_file)
        try:
            content = mem_file.read_text(encoding="utf-8")
        except OSError:
            continue
        h = _content_hash(content)
        existing = index["ingested"].get(key)
        if not existing or existing.get("hash") != h:
            pending.append((project_dir, mem_file))
        else:
            synced.append((project_dir, mem_file))

    print()
    print("Memory Bridge Status")
    print("=" * 44)
    print(f"CC project memories found:  {len(files)}")
    print(f"  Synced to vault:          {len(synced)}")
    print(f"  Pending ingest:           {len(pending)}")
    updated = index.get("updated", "never")
    print(f"  Last ingest run:          {updated[:19] if updated != 'never' else 'never'}")

    if pending:
        print()
        print("Pending:")
        for project_dir, mem_file in pending:
            slug = _project_slug(project_dir)
            size = mem_file.stat().st_size
            print(f"  [{slug}] {mem_file.name}  ({size}b)")

    print()
    return 0


def cmd_ingest(_args) -> int:
    files = _scan_cc_memories()
    index = _load_index()

    CC_MEMORIES_DIR.mkdir(parents=True, exist_ok=True)

    ingested = 0
    skipped = 0
    errors = 0

    for project_dir, mem_file in files:
        key = str(mem_file)
        try:
            content = mem_file.read_text(encoding="utf-8")
        except OSError as e:
            print(f"  [skip] {mem_file.name}: read error: {e}")
            errors += 1
            continue

        h = _content_hash(content)
        existing = index["ingested"].get(key)
        if existing and existing.get("hash") == h:
            skipped += 1
            continue

        slug = _project_slug(project_dir)
        dest_dir = CC_MEMORIES_DIR / slug
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / mem_file.name

        # Prepend source header if not already present
        source_comment = f"<!-- source: {project_dir.name}/memory/{mem_file.name} -->"
        if source_comment not in content:
            ts = datetime.now().isoformat()[:19]
            header = f"{source_comment}\n<!-- ingested: {ts} -->\n\n"
            final_content = header + content
        else:
            final_content = content

        dest_file.write_text(final_content, encoding="utf-8")

        index["ingested"][key] = {
            "hash": h,
            "vault_path": str(dest_file),
            "ingested_at": datetime.now().isoformat(),
            "project": project_dir.name,
            "slug": slug,
        }

        print(f"  [+] {slug}/{mem_file.name}  ({len(content)}b)")
        ingested += 1

    _save_index(index)

    print()
    print(f"Done — ingested: {ingested}  unchanged: {skipped}  errors: {errors}")

    if ingested > 0:
        _update_brain_index()

    return 0 if errors == 0 else 1


def cmd_export(args) -> int:
    """Export vault CC-memories back to CC project memory directories (vault→CC direction)."""
    if not CC_MEMORIES_DIR.exists():
        print(f"[export] No CC-memories in vault: {CC_MEMORIES_DIR}")
        return 0

    index = _load_index()
    project_filter = args.project.lower() if args.project else None

    exported = 0
    skipped = 0
    errors = 0

    for slug_dir in sorted(CC_MEMORIES_DIR.iterdir()):
        if not slug_dir.is_dir():
            continue
        slug = slug_dir.name
        if project_filter and slug != project_filter:
            continue

        # Find the matching CC project dir by slug
        target_proj = None
        if PROJECTS_DIR.exists():
            for proj_dir in PROJECTS_DIR.iterdir():
                if _project_slug(proj_dir) == slug:
                    target_proj = proj_dir
                    break

        if target_proj is None:
            print(f"  [skip] {slug}: no matching CC project dir found")
            skipped += 1
            continue

        cc_mem_dir = target_proj / "memory"
        cc_mem_dir.mkdir(parents=True, exist_ok=True)

        for vault_file in sorted(slug_dir.glob("*.md")):
            try:
                content = vault_file.read_text(encoding="utf-8")
            except OSError as e:
                print(f"  [skip] {slug}/{vault_file.name}: {e}")
                errors += 1
                continue

            # Strip ingestion headers added during ingest (source + ingested comments)
            source_re = re.compile(r'^<!-- source: .+ -->\n<!-- ingested: .+ -->\n\n', re.MULTILINE)
            clean_content = source_re.sub("", content, count=1)

            dest = cc_mem_dir / vault_file.name
            if dest.exists():
                existing = dest.read_text(encoding="utf-8")
                if _content_hash(existing) == _content_hash(clean_content):
                    skipped += 1
                    continue
                # Vault is newer — overwrite
            dest.write_text(clean_content, encoding="utf-8")
            print(f"  [->CC] {slug}/{vault_file.name}  ({len(clean_content)}b)")
            exported += 1

        # Rebuild MEMORY.md index for this project
        _rebuild_memory_index(target_proj)

    print()
    print(f"Done — exported: {exported}  unchanged: {skipped}  errors: {errors}")
    return 0 if errors == 0 else 1


def _rebuild_memory_index(project_dir: Path) -> None:
    """Regenerate MEMORY.md index from all .md files in the memory/ directory."""
    mem_dir = project_dir / "memory"
    index_path = project_dir / "MEMORY.md"
    if not mem_dir.exists():
        return
    files = sorted(f for f in mem_dir.glob("*.md") if f.name != "MEMORY.md")
    if not files:
        return
    lines = ["# Memory Index\n"]
    for f in files:
        try:
            first_line = f.read_text(encoding="utf-8").splitlines()[0]
            title = first_line.lstrip("# ").strip() or f.stem
        except (OSError, IndexError):
            title = f.stem
        lines.append(f"- [{title}](memory/{f.name})\n")
    # Only write if MEMORY.md doesn't already exist (avoid overwriting user-curated index)
    if not index_path.exists():
        index_path.write_text("".join(lines), encoding="utf-8")


def cmd_repair_wikilinks(args) -> int:
    """Scan vault .md files for broken [[wikilink]] references."""
    if not VAULT_DIR.exists():
        print(f"[repair] Vault not found: {VAULT_DIR}")
        return 1

    # Build set of known note stems from all vault .md files
    known: set[str] = set()
    for f in VAULT_DIR.rglob("*.md"):
        stem = f.stem.lower()
        known.add(stem)
        known.add(stem.replace(" ", "_"))
        known.add(stem.replace(" ", "-"))
        known.add(stem.replace("_", " "))
        known.add(stem.replace("-", " "))

    # M-LOW-1 fix (Kirkardo TOTAL v2 2026-05-03): require first char of wikilink
    # target to be alphanumeric or underscore to avoid matching bash test
    # conditionals like `[[ -f "$X" ]]`, `[[ ! -d $D ]]`, `[[$VAR]]`. Real wiki
    # links never start with space, hyphen, exclamation, quote, or dollar sign.
    wikilink_re = re.compile(r'\[\[([A-Za-z0-9_][^\]|#]*?)(?:[|#][^\]]*)?\]\]')

    broken_by_file: dict[str, list[tuple[str, int]]] = {}
    total_broken = 0

    for vault_file in sorted(VAULT_DIR.rglob("*.md")):
        try:
            content = vault_file.read_text(encoding="utf-8")
        except OSError:
            continue

        lines = content.splitlines()
        file_broken: list[tuple[str, int]] = []

        in_code_fence = False
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_code_fence = not in_code_fence
                continue
            if in_code_fence:
                continue
            for m in wikilink_re.finditer(line):
                target = m.group(1).strip().lower()
                if target not in known:
                    file_broken.append((m.group(1).strip(), i))

        if file_broken:
            rel = str(vault_file.relative_to(VAULT_DIR))
            broken_by_file[rel] = file_broken
            total_broken += len(file_broken)

    if total_broken == 0:
        print("[wikilinks] No broken links found in vault.")
        return 0

    print(f"\nBroken wikilinks: {total_broken} across {len(broken_by_file)} files\n")
    for fname, links in sorted(broken_by_file.items()):
        print(f"  {fname}")
        for link, line_no in links:
            print(f"    line {line_no:4}: [[{link}]]")

    fixed_files = 0

    if args.fix:
        print()
        for vault_file in sorted(VAULT_DIR.rglob("*.md")):
            rel = str(vault_file.relative_to(VAULT_DIR))
            if rel not in broken_by_file:
                continue
            try:
                content = vault_file.read_text(encoding="utf-8")
            except OSError:
                continue

            new_content = content
            for link, _ in broken_by_file[rel]:
                # [[broken link]] → broken link
                # [[broken link|alias]] → alias
                escaped = re.escape(link)
                new_content = re.sub(
                    r'\[\[' + escaped + r'(?:\|([^\]]+))?\]\]',
                    lambda m: m.group(1) if m.group(1) else link,
                    new_content,
                )

            if new_content != content:
                vault_file.write_text(new_content, encoding="utf-8")
                fixed_files += 1
                print(f"  [fixed] {rel}")

        print(f"\nRepaired: {fixed_files} files (broken links converted to plain text)")
        if fixed_files > 0:
            _update_brain_index()
    else:
        print(f"\nRun with --fix to convert broken links to plain text.")

    return 1 if total_broken > 0 and not args.fix else 0


def cmd_prune(args) -> int:
    """Find vault CC-memories whose source CC project memory no longer exists.

    Auditor 2 finding: bridge had ingest but no prune — when a CC project was
    renamed or its memory file deleted, the vault copy persisted forever.
    """
    if not CC_MEMORIES_DIR.exists():
        print(f"[prune] CC-memories dir does not exist: {CC_MEMORIES_DIR}")
        return 0

    index = _load_index()
    live_keys = {str(p[1]) for p in _scan_cc_memories()}

    # Walk the bridge index — orphan = ingested key whose source no longer exists
    orphans: list[tuple[str, str]] = []  # (source_key, vault_path)
    for src_key, meta in index.get("ingested", {}).items():
        if src_key in live_keys:
            continue
        vault_rel = meta.get("vault_path")
        if not vault_rel:
            orphans.append((src_key, ""))
            continue
        orphans.append((src_key, vault_rel))

    if not orphans:
        print("[prune] no orphans — every vault CC-memory has a live source")
        return 0

    print(f"[prune] found {len(orphans)} orphan(s):")
    moved = 0
    archive_dir = VAULT_DIR / "_archive" / str(datetime.now().year) / "CC-memories"
    for src_key, vault_rel in orphans:
        print(f"  {src_key}")
        if not vault_rel:
            # No vault path recorded — just clean the index entry
            if not args.dry_run:
                del index["ingested"][src_key]
                moved += 1
            continue
        vault_path = VAULT_DIR / vault_rel
        if args.dry_run:
            print(f"    DRY-RUN → archive: {vault_rel}")
            continue
        if vault_path.exists():
            archive_dir.mkdir(parents=True, exist_ok=True)
            dst = archive_dir / vault_path.name
            try:
                vault_path.rename(dst)
                print(f"    moved → _archive/{datetime.now().year}/CC-memories/{vault_path.name}")
            except OSError as exc:
                print(f"    error: {exc}", file=sys.stderr)
                continue
        del index["ingested"][src_key]
        moved += 1

    if not args.dry_run and moved > 0:
        _save_index(index)
        print(f"[prune] {moved} orphan(s) archived; bridge-index.json updated")
    elif args.dry_run:
        print(f"[prune] DRY-RUN: {len(orphans)} orphan(s) would be archived")
    return 0


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="ULTRON Memory Bridge — CC<->Vault sync + wikilink repair")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="Show what's pending ingest from CC project memories")
    sub.add_parser("ingest", help="Ingest new/changed CC memories into vault")

    p_export = sub.add_parser("export", help="Export vault CC-memories back to CC project dirs (vault→CC)")
    p_export.add_argument("--project", metavar="SLUG", default="",
                          help="Only export this project slug (default: all)")

    p_repair = sub.add_parser("repair-wikilinks", help="Find (and optionally fix) broken [[links]]")
    p_repair.add_argument("--fix", action="store_true",
                          help="Convert broken links to plain text in-place")

    p_prune = sub.add_parser("prune",
                              help="Archive vault CC-memories whose source no longer exists")
    p_prune.add_argument("--dry-run", action="store_true",
                          help="List orphans without moving files")

    args = p.parse_args()

    if args.cmd == "status":
        return cmd_status(args)
    elif args.cmd == "ingest":
        return cmd_ingest(args)
    elif args.cmd == "export":
        return cmd_export(args)
    elif args.cmd == "repair-wikilinks":
        return cmd_repair_wikilinks(args)
    elif args.cmd == "prune":
        return cmd_prune(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
