#!/usr/bin/env python3
"""
ULTRON v10.0 Cockpit — Project Registry auto-discovery scanner.

Aggressive scan: walks SCAN_ROOTS, identifies project roots via PROJECT_MARKERS,
infers IDE/language/type via cockpit_base.detect_ide, writes ~/.ultron/cockpit/projects.json.

Run: python scripts/cockpit/scan_projects.py [--verbose]
Triggered by: install-scheduler.ps1 (post-login + every 12h).

Idempotent: re-running updates last_active and detects new projects without losing
manual edits to existing entries (status, deadline, tags are preserved).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Force UTF-8 stdout on Windows (cp1252 chokes on arrows etc.)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Allow running as script: ensure cockpit_base importable
sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import (  # noqa: E402
    Cockpit, Project, PROJECTS_JSON, IDE_MAPPINGS_JSON, SCAN_ROOTS, SKIP_DIR_NAMES,
    PROJECT_MARKERS, SKILLS_PROJECT_WHITELIST, USER_HOME, detect_ide, slug,
)

SKILLS_DIR = USER_HOME / ".claude" / "skills"
EXCLUSIONS_JSON = USER_HOME / ".ultron" / "cockpit" / "projects-exclusions.json"

# Cached at module load
_EXCLUSIONS = None


def load_exclusions() -> dict:
    """Load projects-exclusions.json (permanent blacklist)."""
    global _EXCLUSIONS
    if _EXCLUSIONS is None:
        _EXCLUSIONS = Cockpit.read_json(EXCLUSIONS_JSON, default={
            "excluded_by_id": [],
            "excluded_by_path_pattern": []
        })
    return _EXCLUSIONS


def is_excluded(project_id: str, project_path: str) -> bool:
    """Check if project is in permanent exclusions blacklist."""
    excl = load_exclusions()

    # Check by ID
    if project_id in excl.get("excluded_by_id", []):
        return True

    # Check by path pattern (glob-style)
    from fnmatch import fnmatch
    path_str = project_path.replace("\\", "/")
    for pattern in excl.get("excluded_by_path_pattern", []):
        if fnmatch(path_str, pattern):
            return True

    return False


# ── Auto-tag inference (fully deterministic, no LLM) ─────────────────────────

def infer_auto_tags(path: Path) -> list[str]:
    """Return a deduped sorted list of technology tags inferred from project markers.

    Rules are evaluated in priority order. Cap: 6 tags max.
    All tags are lowercase. Returns [] if nothing matches.
    """
    tags: set[str] = set()

    # ── Unreal Engine ──────────────────────────────────────────────────────────
    if list(path.glob("*.uproject")):
        tags.update(["unreal", "cpp", "game"])

    # ── Unity ──────────────────────────────────────────────────────────────────
    if (path / "Assets").is_dir() and (
        list(path.glob("*.unity"))
        or (path / "ProjectSettings" / "ProjectVersion.txt").exists()
    ):
        tags.update(["unity", "csharp", "game"])

    # ── Node / web ─────────────────────────────────────────────────────────────
    pkg_json = path / "package.json"
    if pkg_json.exists():
        tags.add("node")
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
            all_deps = {
                **pkg.get("dependencies", {}),
                **pkg.get("devDependencies", {}),
            }
            dep_names = set(all_deps.keys())
            # Framework tags (first match wins for react/next since next implies react)
            if "next" in dep_names:
                tags.add("next")
            elif "react" in dep_names:
                tags.add("react")
            if "vue" in dep_names:
                tags.add("vue")
            if "svelte" in dep_names:
                tags.add("svelte")
            if "astro" in dep_names:
                tags.add("astro")
            # Language tag
            if "typescript" in dep_names:
                tags.add("typescript")
            else:
                tags.add("javascript")
        except (json.JSONDecodeError, OSError):
            tags.add("javascript")  # fallback: has package.json but can't parse

    # ── Rust ───────────────────────────────────────────────────────────────────
    if (path / "Cargo.toml").exists():
        tags.add("rust")

    # ── Python ─────────────────────────────────────────────────────────────────
    pyproject = path / "pyproject.toml"
    if pyproject.exists():
        tags.add("python")
        try:
            content = pyproject.read_text(encoding="utf-8")
            if "fastapi" in content or "django" in content:
                tags.add("web")
        except OSError:
            pass
    elif (path / "requirements.txt").exists():
        # Only add 'python' from requirements.txt if no pyproject.toml
        tags.add("python")

    # ── Go ─────────────────────────────────────────────────────────────────────
    if (path / "go.mod").exists():
        tags.add("go")

    # ── .NET / C# (solution or project files) ──────────────────────────────────
    if list(path.glob("*.sln")) or list(path.glob("*.csproj")):
        tags.update(["dotnet", "csharp"])

    # ── C++ / Windows (Visual C++ project) ────────────────────────────────────
    if list(path.glob("*.vcxproj")):
        tags.update(["cpp", "windows"])

    # ── CMake ──────────────────────────────────────────────────────────────────
    if (path / "CMakeLists.txt").exists():
        tags.update(["cpp", "cmake"])

    # ── Gradle / Android / Java / Kotlin ──────────────────────────────────────
    gradle_file = None
    for gname in ("build.gradle", "build.gradle.kts"):
        gpath = path / gname
        if gpath.exists():
            gradle_file = gpath
            break
    if gradle_file is not None:
        tags.add("gradle")
        try:
            gcontent = gradle_file.read_text(encoding="utf-8")
            if "com.android.application" in gcontent:
                tags.add("android")
            if "kotlin" in gcontent.lower():
                tags.add("kotlin")
            else:
                tags.add("java")
        except OSError:
            tags.add("java")  # fallback

    # ── iOS ────────────────────────────────────────────────────────────────────
    if (path / "Podfile").exists():
        tags.update(["ios", "swift"])

    # ── ULTRON skill ───────────────────────────────────────────────────────────
    if (path / "SKILL.md").exists():
        tags.add("skill")

    # Cap at 6, sorted for determinism
    return sorted(tags)[:6]


# Cached at module load — overrides win over heuristic detect_ide()
_OVERRIDES = None


def get_overrides():
    global _OVERRIDES
    if _OVERRIDES is None:
        _OVERRIDES = Cockpit.read_json(IDE_MAPPINGS_JSON, default={})
    return _OVERRIDES


def resolve_ide(path: Path, project_id: str, project_name: str) -> tuple[str, str, str]:
    """Resolve (ide, language, type) checking ide-mappings.json overrides FIRST,
    falling back to heuristic detect_ide()."""
    overrides = get_overrides()

    # 1. by_project_id (highest precedence)
    by_id = overrides.get("by_project_id", {}).get(project_id)
    if by_id:
        return (
            by_id.get("ide", "VSCode"),
            by_id.get("language", "unknown"),
            by_id.get("type", "library"),
        )

    # 2. by_path_pattern (substring match, order matters)
    path_str = str(path).replace("\\", "/")
    for rule in overrides.get("by_path_pattern", {}).get("rules", []):
        needle = rule.get("contains", "").replace("\\", "/")
        if needle and needle in path_str:
            # Pull language from heuristic if not specified in override
            _, heuristic_lang, _ = detect_ide(path, project_name)
            return (
                rule.get("ide", "VSCode"),
                rule.get("language", heuristic_lang),
                rule.get("type", "library"),
            )

    # 3. Heuristic fallback
    return detect_ide(path, project_name)


def is_project_root(path: Path) -> bool:
    """Check if any PROJECT_MARKERS exist at this exact path level."""
    for pattern in PROJECT_MARKERS:
        if "*" in pattern:
            if list(path.glob(pattern)):
                return True
        elif (path / pattern).exists():
            return True
    return False


def get_last_modified(path: Path, *, max_depth: int = 2) -> datetime | None:
    """Most recent mtime in tree (capped by depth to avoid huge scans)."""
    try:
        latest = path.stat().st_mtime
        for child in path.rglob("*"):
            # Skip irrelevant dirs (already in skip list = won't be in rglob if pruned upstream)
            if any(skip in child.parts for skip in SKIP_DIR_NAMES):
                continue
            # Cap depth
            if len(child.relative_to(path).parts) > max_depth:
                continue
            try:
                latest = max(latest, child.stat().st_mtime)
            except OSError:
                continue
        return datetime.fromtimestamp(latest)
    except OSError:
        return None


def scan_root(root: Path, *, verbose: bool = False) -> list[Project]:
    """Walk root recursively, collect Project entries."""
    if not root.exists():
        if verbose:
            print(f"  [skip] {root} does not exist")
        return []

    found: list[Project] = []

    def walk(path: Path, depth: int = 0):
        if depth > 6:  # safety: don't walk too deep
            return
        if path.name in SKIP_DIR_NAMES:
            return
        try:
            entries = list(path.iterdir())
        except (PermissionError, OSError):
            return

        # Is THIS path a project root?
        if is_project_root(path):
            name = path.name
            project_id = slug(name)

            # Check permanent exclusions blacklist FIRST
            if is_excluded(project_id, str(path)):
                if verbose:
                    print(f"  [skip-blacklist] {name}")
                return

            # Skip skills under ~/.claude/skills/ unless whitelisted (personalidades
            # y skills de apoyo NO son proyectos abribles en IDE).
            try:
                if SKILLS_DIR in path.parents and project_id not in SKILLS_PROJECT_WHITELIST:
                    if verbose:
                        print(f"  [skip-skill] {name}")
                    return
            except Exception:
                pass
            ide, language, ptype = resolve_ide(path, project_id, name)
            last_mod = get_last_modified(path)
            project = Project(
                id=project_id,
                name=name,
                path=str(path),
                ide=ide,
                language=language,
                type=ptype,
                last_active=last_mod.isoformat()[:10] if last_mod else None,
                status="auto-detected",
                tags=[root.name],  # tag with parent root for context (manual slot)
                auto_tags=infer_auto_tags(path),
            )
            found.append(project)
            if verbose:
                auto_str = ",".join(project.auto_tags) if project.auto_tags else "—"
                print(f"  [+] {name:<40} → {ide} ({language}, {ptype}) [{auto_str}]")
            # Don't recurse INTO a project root (avoid finding sub-projects in node_modules etc.)
            return

        # Otherwise recurse into subdirectories
        for entry in entries:
            if entry.is_dir():
                walk(entry, depth + 1)

    walk(root)
    return found


def merge_with_existing(scanned: list[Project]) -> dict:
    """Merge newly-scanned projects with existing projects.json, preserving manual edits."""
    existing_data = Cockpit.read_json(PROJECTS_JSON, default={"projects": []})
    existing = {p["id"]: p for p in existing_data.get("projects", [])}

    # Deduplicate scanned list — if same ID appears twice (e.g. worktree copy),
    # keep the first occurrence (canonical path wins, worktrees are filtered upstream).
    seen_ids: set[str] = set()
    deduped_scanned: list[Project] = []
    for proj in scanned:
        if proj.id not in seen_ids:
            seen_ids.add(proj.id)
            deduped_scanned.append(proj)

    merged = []
    for proj in deduped_scanned:
        d = proj.__dict__.copy()
        if proj.id in existing:
            # Preserve fields that may have been manually edited
            old = existing[proj.id]
            d["status"] = old.get("status", d["status"])
            d["deadline"] = old.get("deadline", d["deadline"])
            # MANUAL tags: user-owned — scanner never overwrites
            d["tags"] = old.get("tags", d["tags"])
            # AUTO tags: scanner-owned — always replace with freshly inferred value
            d["auto_tags"] = proj.auto_tags
            # If old.status was 'active' or 'archived', don't downgrade to 'auto-detected'
            if old.get("status") in ("active", "archived", "paused"):
                d["status"] = old["status"]
        merged.append(d)

    # Preserve manually-added projects that the scanner didn't find.
    # These are entries the user created by hand (status != 'auto-detected') whose
    # path is outside SCAN_ROOTS or was otherwise not picked up this scan.
    for pid, proj in existing.items():
        if pid not in seen_ids and proj.get("status") not in ("auto-detected",):
            merged.append(proj)

    return {
        "version": "1.0",
        "last_scan": datetime.now().isoformat(timespec="seconds"),
        "projects": merged,
    }


def main():
    parser = argparse.ArgumentParser(description="ULTRON Cockpit project scanner")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print each detected project")
    parser.add_argument("--dry-run", action="store_true",
                        help="Scan but don't write projects.json")
    args = parser.parse_args()

    Cockpit.ensure_dirs()

    if args.verbose:
        print(f"Scanning {len(SCAN_ROOTS)} roots:")
        for r in SCAN_ROOTS:
            print(f"  - {r}")

    scanned: list[Project] = []
    for root in SCAN_ROOTS:
        if args.verbose:
            print(f"\n[scan] {root}")
        scanned.extend(scan_root(root, verbose=args.verbose))

    print(f"\n[scan] Found {len(scanned)} projects")

    if args.dry_run:
        print("[dry-run] would write to:", PROJECTS_JSON)
        return 0

    merged = merge_with_existing(scanned)
    Cockpit.write_json(PROJECTS_JSON, merged)

    print(f"[scan] Wrote {PROJECTS_JSON}")
    by_ide = {}
    for p in merged["projects"]:
        by_ide[p["ide"]] = by_ide.get(p["ide"], 0) + 1
    print("[scan] Distribution by IDE:")
    for ide, count in sorted(by_ide.items(), key=lambda x: -x[1]):
        print(f"  {ide:<20} {count}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
