"""ULTRON — Skill Catalog Generator.

Espejo del patron sync-agent-catalog.py: descubre todos los SKILL.md en las
tres fuentes canónicas (local skills, plugins/cache, skill-vault), extrae
frontmatter usando el mismo _parse_frontmatter de embed_skills.py, y genera
~/.ultron/cockpit/skill-catalog.json con la misma forma que agent-catalog.json.

Schema del JSON resultante:
  {
    "schema_version": 1,
    "generated_at": "<ISO8601>",
    "total": N,
    "skills": [
      {
        "id":          "<kind>::<name>",   # clave estable para el UI / router
        "name":        "...",
        "description": "...",              # primeros 400 chars
        "tags":        [...],
        "tier":        "L1",
        "kind":        "local|plugin|vaulted",
        "path":        "/abs/path/to/SKILL.md",
        "installed":   true               # true si esta en skills/ o plugin; false si vaulted
      }, ...
    ]
  }

CLI:
  skill_catalog_gen.py [--out <path>] [--verbose]

Sin argumentos escribe en ~/.ultron/cockpit/skill-catalog.json.
"""
from __future__ import annotations

import argparse
import importlib
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

logger = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────

_HOME = Path.home()
_COCKPIT = _HOME / ".ultron" / "cockpit"
_DEFAULT_OUT = _COCKPIT / "skill-catalog.json"
_SCRIPTS_COCKPIT = Path(__file__).resolve().parent

# ── Reuse embed_skills helpers ────────────────────────────────────────────────


def _load_embed_skills():
    """Import embed_skills from the same cockpit directory at runtime.

    Avoids duplicating _parse_frontmatter / walk_* logic. Adds the cockpit
    directory to sys.path only if not already present.
    """
    cockpit = str(_SCRIPTS_COCKPIT)
    if cockpit not in sys.path:
        sys.path.insert(0, cockpit)
    # Force fresh import so monkeypatch in tests works cleanly.
    mod_name = "embed_skills"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    return importlib.import_module(mod_name)


# ── Skill catalog entry ───────────────────────────────────────────────────────


def _build_entry(path: Path, kind: str, es_mod: Any) -> dict[str, Any] | None:
    """Return a catalog dict from a SKILL.md path, or None on parse failure.

    Args:
        path: Absolute path to SKILL.md.
        kind: One of "local", "plugin", "vaulted".
        es_mod: The embed_skills module (to reuse extract_skill_meta).

    Returns:
        Catalog entry dict, or None if the SKILL.md is malformed / unreadable.
    """
    meta = es_mod.extract_skill_meta(path, kind=kind)
    if meta is None:
        logger.warning("WARN: frontmatter invalido o sin description en %s — omitida", path)
        return None

    installed: bool = kind in ("local", "plugin")

    return {
        "id": f"{kind}::{meta.name}",
        "name": meta.name,
        "description": meta.description[:400],
        "tags": meta.tags,
        "tier": meta.tier,
        "kind": kind,
        "path": str(path),
        "installed": installed,
    }


# ── Discovery + generation ────────────────────────────────────────────────────


def generate_catalog(
    out_path: Path = _DEFAULT_OUT,
    *,
    verbose: bool = False,
) -> dict[str, Any]:
    """Discover all SKILL.md files and write skill-catalog.json.

    Args:
        out_path: Destination path for the JSON file.
        verbose: If True, log INFO-level progress.

    Returns:
        The catalog dict that was written to disk.
    """
    if verbose:
        logging.basicConfig(
            level=logging.INFO,
            format="%(levelname)s %(message)s",
            stream=sys.stderr,
        )
    else:
        logging.basicConfig(
            level=logging.WARNING,
            format="%(levelname)s %(message)s",
            stream=sys.stderr,
        )

    es = _load_embed_skills()

    skills: list[dict[str, Any]] = []
    failed = 0

    # local skills (~/.claude/skills/)
    for path in es.walk_local_skills():
        entry = _build_entry(path, "local", es)
        if entry:
            skills.append(entry)
        else:
            failed += 1

    # plugin skills (~/.claude/plugins/cache/)
    for path in es.walk_plugin_skills():
        entry = _build_entry(path, "plugin", es)
        if entry:
            skills.append(entry)
        else:
            failed += 1

    # vaulted skills (~/.ultron/skill-vault/)
    for path in es.walk_vaulted_skills():
        entry = _build_entry(path, "vaulted", es)
        if entry:
            skills.append(entry)
        else:
            failed += 1

    # Deduplicate by id (last writer wins — vaulted < plugin < local in priority)
    seen: dict[str, dict[str, Any]] = {}
    kind_priority = {"vaulted": 0, "plugin": 1, "local": 2}
    for entry in skills:
        eid = entry["id"]
        if eid not in seen:
            seen[eid] = entry
        else:
            existing_prio = kind_priority.get(seen[eid]["kind"], 0)
            new_prio = kind_priority.get(entry["kind"], 0)
            if new_prio >= existing_prio:
                seen[eid] = entry

    final: list[dict[str, Any]] = sorted(seen.values(), key=lambda e: e["name"])

    catalog: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(final),
        "failed": failed,
        "skills": final,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(out_path)

    logger.info(
        "skill-catalog.json generado: %d skills (%d fallidas) → %s",
        len(final),
        failed,
        out_path,
    )
    return catalog


# ── CLI ────────────────────────────────────────────────────────────────────────


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="skill_catalog_gen.py",
        description="Genera ~/.ultron/cockpit/skill-catalog.json desde SKILL.md locales.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=_DEFAULT_OUT,
        help=f"Ruta de salida (default: {_DEFAULT_OUT})",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Mostrar progreso detallado",
    )
    args = parser.parse_args(argv)

    try:
        catalog = generate_catalog(out_path=args.out, verbose=args.verbose)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    # Summary output (stdout — parseable por scripts)
    summary = {
        "out": str(args.out),
        "total": catalog["total"],
        "failed": catalog["failed"],
        "generated_at": catalog["generated_at"],
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_main())
