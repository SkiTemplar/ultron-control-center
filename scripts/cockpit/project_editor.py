#!/usr/bin/env python3
"""
ULTRON v10.4 - Project Editor (AI-powered, terminal-only).

Edit/create/delete projects in ~/.ultron/cockpit/projects.json via natural-language
prompts. Token strategy:
  - Haiku for: tag operations, name lookups, simple field changes (cheap, fast)
  - Sonnet for: multi-field edits, new project creation, ambiguous queries

Codex's recommended split honored:
  - destructive ops (delete) require explicit confirmation
  - mutations always show diff first (--dry-run by default; --apply commits)
  - timestamped backup before every write

Usage:
    project_editor.py edit <id> "<query>" [--apply]
    project_editor.py add "<description>" [--apply]
    project_editor.py delete <id>
    project_editor.py tag <id> add <tag>      (no LLM — direct edit)
    project_editor.py tag <id> remove <tag>   (no LLM)
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import Cockpit, COCKPIT_DIR, PROJECTS_JSON  # noqa: E402

PROJECT_SCHEMA = {
    "id": "str (lowercase, no spaces)",
    "name": "str",
    "path": "str (absolute Windows path)",
    "ide": "Rider | Webstorm | VSCode | Cursor | AndroidStudio | VisualStudio | CLion | PyCharm",
    "language": "str (e.g. Python, Kotlin, TypeScript, C++, C#, ...)",
    "type": "academic | personal | freelance | tool | game",
    "deadline": "ISO date or null",
    "last_active": "ISO date or null",
    "status": "active | auto-detected | archived",
    "tags": "list[str]",
}

# Model can be overridden via ULTRON_EDIT_MODEL env var (set by TUI choice).
# Defaults to Sonnet (good for state mutation). Haiku for cheap simple edits.
EDIT_MODEL = os.environ.get("ULTRON_EDIT_MODEL", "claude-sonnet-5")
ADD_MODEL = os.environ.get("ULTRON_EDIT_MODEL", "claude-sonnet-5")
EDIT_TIMEOUT = 90


def load_registry() -> dict:
    raw = PROJECTS_JSON.read_text(encoding="utf-8-sig")
    return json.loads(raw)


def save_registry(data: dict) -> Path:
    """Atomic write with timestamped backup."""
    if PROJECTS_JSON.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = PROJECTS_JSON.with_suffix(f".json.{stamp}.bak")
        shutil.copy2(PROJECTS_JSON, backup)
        print(f"[project] Backup: {backup.name}")
    tmp = PROJECTS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PROJECTS_JSON)
    return PROJECTS_JSON


def find_project(reg: dict, query: str) -> dict | None:
    q = query.lower()
    projects = reg.get("projects", [])
    for p in projects:
        if p.get("id") == query:
            return p
    matches = [p for p in projects
               if q in p.get("id", "").lower() or q in p.get("name", "").lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        print(f"[project] Ambiguous '{query}', candidates: "
              f"{[m['id'] for m in matches[:8]]}")
        return None
    return None


def show_diff(before: dict, after: dict) -> None:
    """Pretty-print field-by-field diff."""
    keys = sorted(set(before.keys()) | set(after.keys()))
    print()
    print("--- DIFF ---")
    for k in keys:
        b = before.get(k)
        a = after.get(k)
        if b == a:
            continue
        print(f"  {k}:")
        print(f"    - {b}")
        print(f"    + {a}")
    print()


def call_claude(model: str, system: str, user: str, timeout: int = EDIT_TIMEOUT) -> str | None:
    claude_bin = shutil.which("claude")
    if not claude_bin:
        print("[project] claude CLI not found in PATH", file=sys.stderr)
        return None
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions",
           "--model", model,
           "--append-system-prompt", system, user]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=timeout, encoding="utf-8", creationflags=_WIN_HIDDEN)
        if result.returncode != 0:
            print(f"[project] claude failed (exit {result.returncode})", file=sys.stderr)
            if result.stderr:
                print(f"[project] stderr: {result.stderr[:300]}", file=sys.stderr)
            return None
        return (result.stdout or "").strip()
    except subprocess.TimeoutExpired:
        print(f"[project] Timeout after {timeout}s", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[project] Failed: {e}", file=sys.stderr)
        return None


def extract_json(text: str) -> dict | None:
    """Strip code fences and parse JSON. Sonnet sometimes wraps in ```json...```."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        # drop first fence line + last fence line
        if lines[-1].strip().startswith("```"):
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        cleaned = "\n".join(lines)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"[project] JSON parse failed: {e}", file=sys.stderr)
        print(f"[project] Raw: {cleaned[:500]}", file=sys.stderr)
        return None


def cmd_edit(args) -> int:
    reg = load_registry()
    target = find_project(reg, args.id)
    if not target:
        print(f"[project] Not found: {args.id}")
        return 1

    schema_str = "\n".join(f"  {k}: {v}" for k, v in PROJECT_SCHEMA.items())
    system = (
        "Eres un editor de registry JSON. Recibes una entrada de proyecto y una "
        "instrucción del usuario. Devuelves SOLO el JSON modificado (sin code fences, "
        "sin explicación). NUNCA inventes campos no listados en el schema. "
        "Si la instrucción es ambigua, mantén lo existente."
    )
    user = (
        f"Schema:\n{schema_str}\n\n"
        f"Entrada actual:\n{json.dumps(target, indent=2, ensure_ascii=False)}\n\n"
        f"Instrucción del usuario: {args.query}\n\n"
        f"Devuelve SOLO el JSON modificado completo (todos los campos, no solo los cambiados)."
    )

    print(f"[project] Editing '{target['id']}' via {EDIT_MODEL}...")
    response = call_claude(EDIT_MODEL, system, user)
    if not response:
        return 1

    new_entry = extract_json(response)
    if not new_entry:
        return 1

    # Validate: id must remain the same
    if new_entry.get("id") != target.get("id"):
        print(f"[project] WARN: model tried to change id "
              f"{target.get('id')} → {new_entry.get('id')} - reverting")
        new_entry["id"] = target["id"]

    show_diff(target, new_entry)

    if not args.apply:
        print(f"[project] Dry-run mode. Pass --apply to commit.")
        return 0

    # Apply: replace entry in registry
    for i, p in enumerate(reg["projects"]):
        if p.get("id") == target["id"]:
            reg["projects"][i] = new_entry
            break
    save_registry(reg)
    print(f"[project] Updated: {target['id']}")
    return 0


def cmd_add(args) -> int:
    reg = load_registry()
    schema_str = "\n".join(f"  {k}: {v}" for k, v in PROJECT_SCHEMA.items())
    existing_ids = sorted(p.get("id", "") for p in reg.get("projects", []))

    system = (
        "Eres un creador de entradas de project registry. Recibes una descripción "
        "y devuelves SOLO el JSON de la nueva entrada (sin code fences). El id debe "
        "ser único, lowercase, sin espacios. Si el path no existe en el filesystem, "
        "lo dejas tal cual el usuario indique. Marca status='active' por defecto."
    )
    user = (
        f"Schema:\n{schema_str}\n\n"
        f"IDs ya en registry (NO reusar): {existing_ids}\n\n"
        f"Descripción del usuario: {args.description}\n\n"
        f"Devuelve SOLO el JSON de la nueva entrada."
    )

    print(f"[project] Creating new entry via {ADD_MODEL}...")
    response = call_claude(ADD_MODEL, system, user)
    if not response:
        return 1

    new_entry = extract_json(response)
    if not new_entry:
        return 1

    if new_entry.get("id") in existing_ids:
        print(f"[project] ERROR: model produced duplicate id '{new_entry.get('id')}'")
        return 1

    print()
    print("--- NEW ENTRY ---")
    print(json.dumps(new_entry, indent=2, ensure_ascii=False))
    print()

    if not args.apply:
        print(f"[project] Dry-run mode. Pass --apply to commit.")
        return 0

    reg.setdefault("projects", []).append(new_entry)
    save_registry(reg)
    print(f"[project] Added: {new_entry.get('id')}")
    return 0


def cmd_delete(args) -> int:
    reg = load_registry()
    target = find_project(reg, args.id)
    if not target:
        print(f"[project] Not found: {args.id}")
        return 1

    print()
    print("--- WILL DELETE ---")
    print(json.dumps(target, indent=2, ensure_ascii=False))
    print()
    if not args.yes:
        resp = input(f"Confirm delete '{target['id']}'? (yes/no): ").strip().lower()
        if resp not in ("y", "yes", "si"):
            print("[project] Aborted.")
            return 0

    reg["projects"] = [p for p in reg["projects"] if p.get("id") != target["id"]]
    save_registry(reg)
    print(f"[project] Deleted: {target['id']}")
    return 0


def cmd_tag(args) -> int:
    """Direct tag manipulation, no LLM (cheap path for common case)."""
    reg = load_registry()
    target = find_project(reg, args.id)
    if not target:
        print(f"[project] Not found: {args.id}")
        return 1

    tags = list(target.get("tags") or [])
    if args.action == "add":
        if args.tag in tags:
            print(f"[project] Tag '{args.tag}' already present.")
            return 0
        tags.append(args.tag)
    elif args.action == "remove":
        if args.tag not in tags:
            print(f"[project] Tag '{args.tag}' not in list.")
            return 1
        tags.remove(args.tag)

    target["tags"] = tags
    for i, p in enumerate(reg["projects"]):
        if p.get("id") == target["id"]:
            reg["projects"][i] = target
            break
    save_registry(reg)
    print(f"[project] Tags for {target['id']}: {tags}")
    return 0


def cmd_rename(args) -> int:
    """v10.6.1: rename a project's id (deterministic, no LLM).

    Why: scanner inferred id from folder name, but the user prefers a different
    slug (e.g. id 't11' with name 'Web2' on path \\Web2 → rename to 'web2').
    Updates only the id field; path/name preserved. Detects collisions with
    existing ids. Refreshes ide-mappings.json by_project_id keys if present.
    """
    reg = load_registry()
    target = find_project(reg, args.old_id)
    if not target:
        print(f"[project] not found: {args.old_id}")
        return 1
    # v10.6.2: respect user-provided casing. Earlier version forced .lower(),
    # which corrupted ids like "Web2" into "web2". Casing is preserved as-is;
    # only spaces and path separators are rejected.
    new_id = args.new_id.strip()
    if not new_id or " " in new_id or "/" in new_id or "\\" in new_id:
        print(f"[project] invalid new id: {new_id!r}")
        return 1
    # Case-insensitive collision check: 'web2' and 'Web2' would still collide
    # because find_project matches case-insensitively.
    new_lower = new_id.lower()
    for p in reg.get("projects", []):
        existing = p.get("id", "")
        if existing == new_id:
            print(f"[project] id collision: '{new_id}' already exists")
            return 1
        if existing.lower() == new_lower and existing != target["id"]:
            print(f"[project] id collision (case-insensitive): "
                  f"'{existing}' would shadow '{new_id}'")
            return 1
    old_id = target["id"]
    if old_id == new_id:
        print(f"[project] no-op (already '{new_id}')")
        return 0

    print(f"[project] rename: {old_id} → {new_id}")
    print(f"  name preserved: {target.get('name')}")
    print(f"  path preserved: {target.get('path')}")

    if not args.apply:
        print("[project] dry-run mode. Pass --apply to commit.")
        return 0

    target["id"] = new_id
    save_registry(reg)
    print(f"[project] renamed in projects.json")

    # v10.6.1: also update ide-mappings.json if old id had an override
    from cockpit_base import IDE_MAPPINGS_JSON
    if IDE_MAPPINGS_JSON.exists():
        try:
            mappings = json.loads(IDE_MAPPINGS_JSON.read_text(encoding="utf-8-sig"))
            by_id = mappings.get("by_project_id", {})
            if old_id in by_id:
                by_id[new_id] = by_id.pop(old_id)
                IDE_MAPPINGS_JSON.write_text(
                    json.dumps(mappings, indent=2, ensure_ascii=False),
                    encoding="utf-8")
                print(f"[project] also moved ide-mappings override "
                      f"{old_id} → {new_id}")
        except (OSError, json.JSONDecodeError) as e:
            print(f"[project] WARN: ide-mappings update skipped: {e}")
    return 0


def cmd_link(args) -> int:
    """v10.6.2: per-project links (URLs) — github, vercel, notion, docs, etc.

    Each project can have a `links` dict mapping a label → URL. Labels are
    arbitrary slugs (github, deploy, notion, figma, ...). Open all of them
    via `ultron open <id>` (which we'll teach to honor links + apps), or one
    at a time via `ultron project link <id> open <label>`.
    """
    reg = load_registry()
    target = find_project(reg, args.id)
    if not target:
        print(f"[project] not found: {args.id}")
        return 1
    target.setdefault("links", {})
    action = args.action

    if action == "list":
        if not target["links"]:
            print(f"[project] {target['id']}: no links")
            return 0
        print(f"[project] {target['id']}: links")
        for label, url in sorted(target["links"].items()):
            print(f"  {label:<12} {url}")
        return 0

    if action == "add":
        label = args.label.strip()
        url = args.url.strip()
        if not (url.startswith("http://") or url.startswith("https://")
                or url.startswith("file:///")):
            print(f"[project] WARN: url has no recognized scheme: {url}")
        target["links"][label] = url
        save_registry(reg)
        print(f"[project] {target['id']}: link '{label}' → {url}")
        return 0

    if action == "remove":
        label = args.label.strip()
        if label not in target["links"]:
            print(f"[project] {target['id']}: no link '{label}'")
            return 1
        del target["links"][label]
        save_registry(reg)
        print(f"[project] {target['id']}: removed link '{label}'")
        return 0

    if action == "open":
        import webbrowser
        if args.label:
            url = target["links"].get(args.label)
            if not url:
                print(f"[project] {target['id']}: no link '{args.label}'")
                return 1
            webbrowser.open(url)
            print(f"[project] opened {args.label}: {url}")
        else:
            if not target["links"]:
                print(f"[project] {target['id']}: no links to open")
                return 0
            for label, url in target["links"].items():
                webbrowser.open(url)
                print(f"[project] opened {label}: {url}")
        return 0

    print(f"[project] unknown link action: {action}")
    return 1


def cmd_app(args) -> int:
    """v10.6.2: per-project extra apps to launch alongside the IDE.

    Each project may need more than the IDE: e.g. Web2 wants Webstorm AND
    Chrome (with localhost:3000) AND Docker Desktop. The `apps` field is a
    list of registered app names (from apps.json) or absolute paths.

    `ultron open <id>` will spawn the IDE first, then iterate apps and launch
    each via apps_launcher.py.
    """
    reg = load_registry()
    target = find_project(reg, args.id)
    if not target:
        print(f"[project] not found: {args.id}")
        return 1
    target.setdefault("apps", [])
    action = args.action

    if action == "list":
        if not target["apps"]:
            print(f"[project] {target['id']}: no extra apps")
            return 0
        print(f"[project] {target['id']}: launches alongside IDE:")
        for a in target["apps"]:
            print(f"  - {a}")
        return 0

    if action == "add":
        name = args.name.strip()
        if name in target["apps"]:
            print(f"[project] {target['id']}: app '{name}' already listed")
            return 0
        target["apps"].append(name)
        save_registry(reg)
        print(f"[project] {target['id']}: added app '{name}'")
        return 0

    if action == "remove":
        name = args.name.strip()
        if name not in target["apps"]:
            print(f"[project] {target['id']}: app '{name}' not listed")
            return 1
        target["apps"].remove(name)
        save_registry(reg)
        print(f"[project] {target['id']}: removed app '{name}'")
        return 0

    print(f"[project] unknown app action: {action}")
    return 1


def cmd_move_path(args) -> int:
    """v10.6.1: change a project's path (deterministic, no LLM).

    Validates: target id exists, new path is absolute, optionally exists on
    disk. The id and name stay; only the filesystem location changes."""
    reg = load_registry()
    target = find_project(reg, args.id)
    if not target:
        print(f"[project] not found: {args.id}")
        return 1
    new_path = args.path
    p = Path(new_path)
    if not p.is_absolute():
        print(f"[project] path must be absolute: {new_path}")
        return 1

    old_path = target.get("path", "")
    print(f"[project] {target['id']}: path change")
    print(f"  old: {old_path}")
    print(f"  new: {new_path}")
    if not p.exists():
        print(f"[project] WARN: new path does not exist on disk")
        if not args.force:
            print("[project] aborting (use --force to record the path anyway)")
            return 1

    if not args.apply:
        print("[project] dry-run. Pass --apply to commit.")
        return 0

    target["path"] = str(p)
    save_registry(reg)
    print(f"[project] path updated")
    return 0


def main():
    p = argparse.ArgumentParser(description="ULTRON Project Editor (terminal AI)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("edit")
    sp.add_argument("id")
    sp.add_argument("query", nargs="+",
                    help="Natural-language instruction (no quotes needed)")
    sp.add_argument("--apply", action="store_true",
                    help="Commit changes (default is dry-run)")
    sp.set_defaults(func=lambda a: cmd_edit(_join_query(a)))

    sp = sub.add_parser("add")
    sp.add_argument("description", nargs="+",
                    help="Free-form project description")
    sp.add_argument("--apply", action="store_true")
    sp.set_defaults(func=lambda a: cmd_add(_join_description(a)))

    sp = sub.add_parser("delete")
    sp.add_argument("id")
    sp.add_argument("-y", "--yes", action="store_true",
                    help="Skip confirmation prompt")
    sp.set_defaults(func=cmd_delete)

    sp = sub.add_parser("tag")
    sp.add_argument("id")
    sp.add_argument("action", choices=["add", "remove"])
    sp.add_argument("tag")
    sp.set_defaults(func=cmd_tag)

    sp = sub.add_parser("rename",
                         help="Change a project's id (deterministic, no LLM)")
    sp.add_argument("old_id")
    sp.add_argument("new_id")
    sp.add_argument("--apply", action="store_true",
                    help="Commit (default is dry-run)")
    sp.set_defaults(func=cmd_rename)

    sp = sub.add_parser("move-path",
                         help="Change a project's filesystem path")
    sp.add_argument("id")
    sp.add_argument("path", help="New absolute path")
    sp.add_argument("--apply", action="store_true")
    sp.add_argument("--force", action="store_true",
                    help="Record path even if it does not exist on disk")
    sp.set_defaults(func=cmd_move_path)

    # v10.6.2: per-project links (URLs)
    sp = sub.add_parser("link", help="Manage URLs associated with a project")
    sp.add_argument("id")
    sp.add_argument("action", choices=["list", "add", "remove", "open"])
    sp.add_argument("label", nargs="?",
                    help="Link label (github, deploy, notion, ...)")
    sp.add_argument("url", nargs="?", help="URL (only for add)")
    sp.set_defaults(func=cmd_link)

    # v10.6.2: per-project extra apps to launch alongside IDE
    sp = sub.add_parser("app", help="Manage extra apps to launch with project")
    sp.add_argument("id")
    sp.add_argument("action", choices=["list", "add", "remove"])
    sp.add_argument("name", nargs="?",
                    help="App name from apps.json or absolute path")
    sp.set_defaults(func=cmd_app)

    args = p.parse_args()
    return args.func(args)


def _join_query(args):
    args.query = " ".join(args.query)
    return args


def _join_description(args):
    args.description = " ".join(args.description)
    return args


if __name__ == "__main__":
    sys.exit(main())
