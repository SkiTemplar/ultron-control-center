"""ULTRON — CLI: ultron skill add <path/SKILL.md>.

Validates a SKILL.md frontmatter (name, description, tags required), embeds
the skill into the Qdrant ultron_skills collection, and upserts its entry into
~/.ultron/cockpit/skill-catalog.json — so every new skill auto-integrates
without hand-editing any JS routing files.

Usage:
  uv run python scripts/cockpit/ultron_skill_add.py <path-to-SKILL.md>
  uv run python scripts/cockpit/ultron_skill_add.py --help

Exit codes:
  0  success
  1  validation error (bad frontmatter)
  2  Qdrant unreachable
  3  unexpected error
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

_COCKPIT = Path(__file__).resolve().parent
_CATALOG_PATH = Path.home() / ".ultron" / "cockpit" / "skill-catalog.json"

logger = logging.getLogger(__name__)


# ── Module loader helpers ─────────────────────────────────────────────────────


def _import(name: str):
    """Import a sibling cockpit module, inserting its directory into sys.path."""
    cockpit = str(_COCKPIT)
    if cockpit not in sys.path:
        sys.path.insert(0, cockpit)
    if name in sys.modules:
        return sys.modules[name]
    return importlib.import_module(name)


# ── Validation ────────────────────────────────────────────────────────────────


class ValidationError(Exception):
    """Raised when a SKILL.md is missing required frontmatter fields."""


_REQUIRED_FIELDS: tuple[str, ...] = ("name", "description", "tags")


def validate_frontmatter(fm: dict[str, Any], path: Path) -> None:
    """Assert all required frontmatter fields are present and non-empty.

    Args:
        fm: Parsed frontmatter dict.
        path: Path to the SKILL.md (used in error messages).

    Raises:
        ValidationError: With a human-readable description of missing fields.
    """
    missing: list[str] = []
    for field in _REQUIRED_FIELDS:
        val = fm.get(field)
        if not val:
            missing.append(field)
        elif field == "tags":
            tags = val if isinstance(val, list) else [val]
            if not any(str(t).strip() for t in tags):
                missing.append("tags (lista vacía)")

    if missing:
        raise ValidationError(
            f"SKILL.md en {path} falta campos requeridos: {', '.join(missing)}"
        )


# ── Catalog update ────────────────────────────────────────────────────────────


def _read_catalog(path: Path) -> dict[str, Any]:
    """Load existing catalog or return an empty scaffold."""
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("WARN: skill-catalog.json ilegible, iniciando vacío")
    return {
        "schema_version": 1,
        "generated_at": "",
        "total": 0,
        "failed": 0,
        "skills": [],
    }


def _write_catalog(catalog: dict[str, Any], path: Path) -> None:
    """Atomic write to catalog JSON (tmp + replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def upsert_catalog_entry(
    entry: dict[str, Any],
    catalog_path: Path = _CATALOG_PATH,
) -> dict[str, str]:
    """Insert or update a skill entry in skill-catalog.json.

    Args:
        entry: Catalog entry dict (same schema as skill_catalog_gen produces).
        catalog_path: Path to the catalog JSON file.

    Returns:
        Dict with "action": "added" | "updated".
    """
    catalog = _read_catalog(catalog_path)
    skills: list[dict[str, Any]] = catalog.setdefault("skills", [])
    skill_id = entry["id"]

    for i, existing in enumerate(skills):
        if existing.get("id") == skill_id:
            skills[i] = entry
            catalog["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            catalog["total"] = len(skills)
            _write_catalog(catalog, catalog_path)
            return {"action": "updated"}

    skills.append(entry)
    skills.sort(key=lambda s: s.get("name", ""))
    catalog["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    catalog["total"] = len(skills)
    _write_catalog(catalog, catalog_path)
    return {"action": "added"}


# ── Core add logic ────────────────────────────────────────────────────────────


def add_skill(
    skill_path: Path,
    *,
    kind: str | None = None,
    catalog_path: Path = _CATALOG_PATH,
) -> dict[str, Any]:
    """Validate, embed, and register a SKILL.md.

    Steps:
      1. Validate frontmatter (name, description, tags required).
      2. Detect kind from the file location if not provided.
      3. Embed and upsert into Qdrant via embed_skills.upsert_skills.
      4. Update skill-catalog.json.

    Args:
        skill_path: Absolute path to the SKILL.md file.
        kind: Force kind ("local", "plugin", "vaulted"). Auto-detected when None.
        catalog_path: Path to skill-catalog.json.

    Returns:
        Result dict with keys: ok, name, kind, catalog_action, qdrant_upserted,
        qdrant_unreachable, path, error.
    """
    skill_path = skill_path.resolve()
    if not skill_path.exists():
        return {"ok": False, "error": f"archivo no encontrado: {skill_path}"}
    if skill_path.name != "SKILL.md":
        return {"ok": False, "error": f"el archivo debe llamarse SKILL.md, no {skill_path.name}"}

    es = _import("embed_skills")

    # Parse frontmatter with source hint for better WARN messages.
    text = skill_path.read_text(encoding="utf-8", errors="replace")
    fm = es._parse_frontmatter(text, _source_hint=str(skill_path))
    if not fm:
        return {
            "ok": False,
            "error": "no se encontró frontmatter YAML (falta bloque --- ... ---)",
        }

    try:
        validate_frontmatter(fm, skill_path)
    except ValidationError as exc:
        return {"ok": False, "error": str(exc)}

    # Auto-detect kind from path.
    if kind is None:
        sp = str(skill_path)
        if "skill-vault" in sp:
            kind = "vaulted"
        elif "plugins" in sp and "cache" in sp:
            kind = "plugin"
        else:
            kind = "local"

    meta = es.extract_skill_meta(skill_path, kind=kind)
    if meta is None:
        return {
            "ok": False,
            "error": "extract_skill_meta retornó None — revisar frontmatter description",
        }

    # Qdrant embed + upsert.
    qdrant_upserted = 0
    qdrant_unreachable = False
    if not es._qdrant_healthy():
        qdrant_unreachable = True
        logger.warning(
            "WARN: Qdrant no disponible en %s — skill registrada en catalog pero NO embebida",
            es.QDRANT_URL,
        )
    else:
        es.ensure_collection()
        qdrant_upserted = es.upsert_skills([meta])

        # Update incremental state cache so next embed_skills index is a no-op.
        state = es.load_state()
        state[f"{kind}::{meta.name}"] = {
            "desc_sha1": meta.desc_sha1,
            "path": str(skill_path),
        }
        es.save_state(state)

    # Catalog entry.
    entry: dict[str, Any] = {
        "id": f"{kind}::{meta.name}",
        "name": meta.name,
        "description": meta.description[:400],
        "tags": meta.tags,
        "tier": meta.tier,
        "kind": kind,
        "path": str(skill_path),
        "installed": kind in ("local", "plugin"),
    }
    catalog_result = upsert_catalog_entry(entry, catalog_path=catalog_path)

    return {
        "ok": True,
        "name": meta.name,
        "kind": kind,
        "catalog_action": catalog_result["action"],
        "qdrant_upserted": qdrant_upserted,
        "qdrant_unreachable": qdrant_unreachable,
        "path": str(skill_path),
        "error": None,
    }


# ── CLI ────────────────────────────────────────────────────────────────────────


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ultron_skill_add.py",
        description="Registra una SKILL.md en Qdrant y en skill-catalog.json.",
    )
    parser.add_argument(
        "skill_path",
        type=Path,
        help="Ruta al archivo SKILL.md a registrar",
    )
    parser.add_argument(
        "--kind",
        choices=["local", "plugin", "vaulted"],
        default=None,
        help="Fuerza el tipo. Por defecto se auto-detecta por la ruta.",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=_CATALOG_PATH,
        help=f"Ruta al skill-catalog.json (default: {_CATALOG_PATH})",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
        stream=sys.stderr,
    )

    result = add_skill(
        args.skill_path,
        kind=args.kind,
        catalog_path=args.catalog,
    )

    print(json.dumps(result, indent=2, ensure_ascii=False))

    if not result["ok"]:
        return 1
    if result.get("qdrant_unreachable"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(_main())
