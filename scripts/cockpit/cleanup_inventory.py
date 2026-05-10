#!/usr/bin/env python3
"""
ULTRON v12.5 — Cleanup Inventory (Task 13)

Scans ULTRON root directories and classifies files/directories into:
  active      referenced by manifest, route graph, vault, or current config
  canonical   source-of-truth that must remain
  synced-copy valid mirror/copy in another root
  deprecated  replaced by a newer canonical object
  orphan      not referenced anywhere
  cache       rebuildable generated data
  backup      old backup retained for rollback
  danger      credentials, tokens, private configs, unknown high-risk content

Commands:
    cleanup_inventory.py scan           Print inventory table
    cleanup_inventory.py report         Generate markdown report to ~/.ultron/cockpit/
    cleanup_inventory.py policy         Show cleanup policy
"""
from __future__ import annotations

import fnmatch
import json
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ULTRON_HOME   = Path.home() / ".ultron"
VAULT_HOME    = Path.home() / ".ultron-vault"
CLAUDE_HOME   = Path.home() / ".claude"
COCKPIT_DIR   = ULTRON_HOME / "cockpit"
CACHE_DIR     = ULTRON_HOME / "skill_cache"
REPORT_DIR    = ULTRON_HOME / "cockpit" / "audits"

CLEANUP_POLICY = {
    "deprecated_retention_days": 30,
    "cache_retention_days": 7,
    "archive_before_delete": True,
    "delete_requires_explicit_approval": True,
    "sync_before_cleanup": True,
    "rebuild_after_cleanup": ["skill_manifest", "brain_index", "registry_health"],
}

# Patterns that are always "danger" — never touch without explicit approval
_DANGER_PATTERNS = {".git", ".env", "*.key", "*.pem", "id_rsa", "credentials*", "*.vault"}

# Known cache dirs/files — rebuildable
_CACHE_DIRS  = {"skill_cache", ".tmp", "__pycache__", ".venv", "dist", "build"}
_CACHE_FILES = {"*.db", "*.db-shm", "*.db-wal", "*.pyc", "*.log"}

# Known canonical roots (sources of truth — must remain)
_CANONICAL_DIRS = {"plans", "knowledge", "hooks", "sessions", "archive"}


def _classify(path: Path, rel: str) -> str:
    name = path.name.lower()
    rel_l = rel.lower()

    # Danger: git metadata, credentials, keys — use fnmatch for glob patterns
    for pat in _DANGER_PATTERNS:
        if fnmatch.fnmatch(name, pat):
            return "danger"

    if path.is_dir():
        if name in _CACHE_DIRS:
            return "cache"
        if name in _CANONICAL_DIRS:
            return "canonical"
        if "archive" in rel_l:
            return "backup"
        return "active"

    # Files
    suffix = path.suffix.lower()
    if suffix in (".pyc", ".db", ".db-shm", ".db-wal"):
        return "cache"
    if suffix == ".log":
        return "cache"
    if name.startswith("backup-") or name.endswith(".bak"):
        return "backup"
    if "deprecated" in name or name.endswith(".old"):
        return "deprecated"
    if "tmp" in name or name.startswith("_"):
        return "cache"
    return "active"


def _scan_root(root: Path, max_depth: int = 3) -> list[dict]:
    if not root.exists():
        return []
    entries = []
    for p in sorted(root.rglob("*")):
        # Skip .git trees entirely — can be enormous and have no cleanup value
        if ".git" in p.parts:
            continue
        try:
            rel_path = p.relative_to(root)
            rel = str(rel_path)
        except ValueError:
            continue
        depth = len(rel_path.parts) - 1
        if depth >= max_depth:
            continue
        try:
            stat = p.stat()
            size = stat.st_size if p.is_file() else 0
            mtime = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d")
        except OSError:
            continue
        entries.append({
            "path":  str(p),
            "rel":   rel,
            "root":  str(root),
            "kind":  "dir" if p.is_dir() else "file",
            "size":  size,
            "mtime": mtime,
            "class": _classify(p, rel),
        })
    return entries


def cmd_scan(_args) -> int:
    roots = [ULTRON_HOME, VAULT_HOME, CLAUDE_HOME]
    all_entries: list[dict] = []
    for root in roots:
        all_entries.extend(_scan_root(root))

    by_class: dict[str, list[dict]] = {}
    for e in all_entries:
        by_class.setdefault(e["class"], []).append(e)

    print(f"\nCleanup Inventory  {datetime.now().strftime('%Y-%m-%d')}")
    print("=" * 70)
    class_order = ["danger", "deprecated", "orphan", "backup", "cache", "synced-copy", "active", "canonical"]
    for cls in class_order:
        items = by_class.get(cls, [])
        if not items:
            continue
        files   = sum(1 for i in items if i["kind"] == "file")
        dirs    = sum(1 for i in items if i["kind"] == "dir")
        total_b = sum(i["size"] for i in items)
        print(f"\n  {cls.upper():<14} {files} files, {dirs} dirs  ({total_b/1024:.0f} KB)")
        for item in items[:5]:
            print(f"    {item['rel']:<50}  {item['mtime']}")
        if len(items) > 5:
            print(f"    … {len(items)-5} more")
    print()
    return 0


def cmd_report(_args) -> int:
    roots = [ULTRON_HOME, VAULT_HOME, CLAUDE_HOME]
    all_entries: list[dict] = []
    for root in roots:
        all_entries.extend(_scan_root(root))

    by_class: dict[str, list[dict]] = {}
    for e in all_entries:
        by_class.setdefault(e["class"], []).append(e)

    date_str = datetime.now().strftime("%Y-%m-%d")
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"cleanup-report-{date_str}.md"

    lines = [
        f"# Cleanup Inventory Report — {date_str}",
        "",
        "Generated by `cleanup_inventory.py report`  ",
        f"Scanned: `{ULTRON_HOME}`, `{VAULT_HOME}`, `{CLAUDE_HOME}`",
        "",
        "## Summary",
        "",
        "| Class | Files | Dirs | Total KB |",
        "|---|---|---|---|",
    ]

    class_order = ["danger", "deprecated", "orphan", "backup", "cache", "synced-copy", "active", "canonical"]
    for cls in class_order:
        items = by_class.get(cls, [])
        if not items:
            continue
        files   = sum(1 for i in items if i["kind"] == "file")
        dirs    = sum(1 for i in items if i["kind"] == "dir")
        total_b = sum(i["size"] for i in items)
        lines.append(f"| {cls} | {files} | {dirs} | {total_b/1024:.0f} |")

    lines += ["", "## Details", ""]
    for cls in class_order:
        items = by_class.get(cls, [])
        if not items:
            continue
        lines.append(f"### {cls.upper()}")
        lines.append("")
        for item in sorted(items, key=lambda x: x["rel"]):
            lines.append(f"- `{item['rel']}`  ({item['kind']}, {item['mtime']})")
        lines.append("")

    lines += [
        "## Cleanup Policy",
        "",
        "```json",
        json.dumps(CLEANUP_POLICY, indent=2),
        "```",
        "",
        "---",
        "_No files were modified by this scan. Archive before delete. Approval required._",
    ]

    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[cleanup] Report written → {report_path}")
    return 0


def cmd_policy(_args) -> int:
    print("\nCleanup Policy:")
    print(json.dumps(CLEANUP_POLICY, indent=2))
    return 0


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="ULTRON v12.5 Cleanup Inventory (Task 13)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan",   help="Print inventory summary by class")
    sub.add_parser("report", help="Generate markdown report to ~/.ultron/cockpit/audits/")
    sub.add_parser("policy", help="Show cleanup policy")
    args = p.parse_args()
    if args.cmd == "scan":   return cmd_scan(args)
    if args.cmd == "report": return cmd_report(args)
    if args.cmd == "policy": return cmd_policy(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
