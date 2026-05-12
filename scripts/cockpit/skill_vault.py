#!/usr/bin/env python3
"""
ULTRON v15.0b — Skill Vault

Mueve skills poco usadas fuera de ~/.claude/skills/ (y de los mirrors
~/.agents/skills/ y ~/.codex/skills/) a ~/.ultron/skill-vault/, para que su
metadata NO se cargue en el contexto de cada sesion. Quedan recuperables
on-demand via `skill_vault.py search` / `restore`, e indexables en Qdrant
(coleccion `ultron_skills`) cuando el pipeline semantico este vivo.

Comandos:
    migrate --keep-file <path> [--dry-run]   Mover a vault todo lo que NO este en keep
    list [--active|--vaulted]                Listar skills por estado
    search "<query>"                         Buscar en el vault (keyword sobre INDEX.json)
    restore <name> [<name>...]               Devolver skill(s) del vault a ~/.claude/skills/
    status                                   Resumen

INDEX.json (en el vault) — 1 entrada por skill vaulteada:
    {name, description, tags, source, vaulted_at, usage_count, restored_count, embedding_id}
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HOME = Path.home()
REGISTRIES = [HOME / ".claude" / "skills", HOME / ".agents" / "skills", HOME / ".codex" / "skills"]
PRIMARY = REGISTRIES[0]                       # ~/.claude/skills es la fuente canonica del move
VAULT_DIR = HOME / ".ultron" / "skill-vault"
INDEX_PATH = VAULT_DIR / "INDEX.json"
_NON_SKILL = {"ultron"}                       # nunca tocar (por si acaso)


def _is_skill_dir(p: Path) -> bool:
    return p.is_dir() and not p.name.startswith(".") and (p / "SKILL.md").exists()


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _parse_frontmatter(skill_md: Path) -> dict:
    """Extrae name/description/allowed-tools de la frontmatter YAML de un SKILL.md."""
    out = {"name": skill_md.parent.name, "description": "", "tags": []}
    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    block = m.group(1) if m else text[:1500]
    # name
    mn = re.search(r"^name:\s*(.+)$", block, re.MULTILINE)
    if mn:
        out["name"] = mn.group(1).strip().strip('"').strip("'")
    # description (puede ser multilinea folded/literal — recogemos hasta la siguiente clave)
    md = re.search(r"^description:\s*(.*)$", block, re.MULTILINE)
    if md:
        desc = md.group(1).strip()
        if desc in (">", "|", ">-", "|-", ">+", "|+"):
            # bloque indentado en lineas siguientes
            tail = block[md.end():].splitlines()
            collected = []
            for ln in tail:
                if re.match(r"^\S", ln):  # nueva clave top-level
                    break
                collected.append(ln.strip())
            desc = " ".join(x for x in collected if x)
        out["description"] = desc.strip().strip('"').strip("'")[:600]
    # tags from kebab name segments + obvious keywords
    out["tags"] = [t for t in re.split(r"[-_/]", out["name"]) if len(t) > 2]
    return out


def _load_index() -> dict:
    if INDEX_PATH.exists():
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    return {"version": 1, "updated_at": None, "skills": {}}


def _save_index(idx: dict) -> None:
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    idx["updated_at"] = _now()
    INDEX_PATH.write_text(json.dumps(idx, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_keep(path: Path) -> set[str]:
    return {ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")}


# ── migrate ───────────────────────────────────────────────────────────────────

def cmd_migrate(args) -> int:
    keep = _read_keep(Path(args.keep_file).expanduser())
    if "ultron" not in keep:
        keep |= _NON_SKILL
    if not PRIMARY.exists():
        print(f"[skill_vault] no existe {PRIMARY}"); return 1
    active = {p.name for p in PRIMARY.iterdir() if _is_skill_dir(p)}
    targets = sorted(active - keep)
    print(f"[skill_vault] activas={len(active)}  keep={len(keep & active)}  -> vault={len(targets)}")
    if not targets:
        print("  nada que mover."); return 0
    idx = _load_index()
    moved = 0
    for name in targets:
        src = PRIMARY / name
        dst = VAULT_DIR / name
        meta = _parse_frontmatter(src / "SKILL.md")
        if args.dry_run:
            print(f"  [dry] {name}  <-  {meta['description'][:70]!r}")
            continue
        VAULT_DIR.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            shutil.rmtree(src, ignore_errors=True)          # ya en vault: borrar duplicado origen
        else:
            shutil.move(str(src), str(dst))
        # limpiar mirrors (copias redundantes)
        for reg in REGISTRIES[1:]:
            mp = reg / name
            if mp.exists():
                shutil.rmtree(mp, ignore_errors=True)
        prev = idx["skills"].get(name, {})
        idx["skills"][name] = {
            "name": meta["name"],
            "description": meta["description"],
            "tags": meta["tags"],
            "source": prev.get("source", "bulk-import"),
            "vaulted_at": prev.get("vaulted_at", _now()),
            "usage_count": prev.get("usage_count", 0),
            "restored_count": prev.get("restored_count", 0),
            "embedding_id": prev.get("embedding_id"),
        }
        moved += 1
    if not args.dry_run:
        _save_index(idx)
        print(f"[skill_vault] movidas {moved} skills -> {VAULT_DIR}")
        print(f"[skill_vault] INDEX.json: {len(idx['skills'])} entradas")
        print("  NOTA: el cambio de contexto surte efecto en la PROXIMA sesion Claude Code.")
        print("  NOTA: ejecuta `registry_sync.py update-manifest` y revisa que propagate no re-copie las vaulteadas.")
    return 0


# ── list / status / search / restore ──────────────────────────────────────────

def cmd_list(args) -> int:
    idx = _load_index()
    if not args.active:
        print(f"VAULTED ({len(idx['skills'])}):")
        for name in sorted(idx["skills"]):
            d = idx["skills"][name]
            print(f"  {name:<34} {d['description'][:60]}")
    if not args.vaulted:
        if PRIMARY.exists():
            act = sorted(p.name for p in PRIMARY.iterdir() if _is_skill_dir(p))
            print(f"\nACTIVE ({len(act)}): {' · '.join(act)}")
    return 0


def cmd_status(args) -> int:
    idx = _load_index()
    act = len([p for p in PRIMARY.iterdir() if _is_skill_dir(p)]) if PRIMARY.exists() else 0
    print(f"skill-vault  ·  active={act}  vaulted={len(idx['skills'])}  total={act + len(idx['skills'])}")
    print(f"  vault dir: {VAULT_DIR}")
    print(f"  index:     {INDEX_PATH}  (updated {idx.get('updated_at')})")
    hot = sorted(idx["skills"].items(), key=lambda kv: kv[1].get("restored_count", 0), reverse=True)[:5]
    hot = [(n, d) for n, d in hot if d.get("restored_count", 0)]
    if hot:
        print("  hot vaulted (mas restauradas):")
        for n, d in hot:
            print(f"    {n}  ×{d['restored_count']}")
    return 0


def cmd_search(args) -> int:
    idx = _load_index()
    terms = [t.lower() for t in re.split(r"\s+", args.query.strip()) if t]
    scored = []
    for name, d in idx["skills"].items():
        hay = f"{name} {d.get('description','')} {' '.join(d.get('tags',[]))}".lower()
        score = sum(hay.count(t) for t in terms) + (5 if any(t in name.lower() for t in terms) else 0)
        if score:
            scored.append((score, name, d))
    scored.sort(reverse=True)
    if not scored:
        print(f"  sin resultados en el vault para: {args.query}"); return 0
    print(f"  vault matches para '{args.query}':")
    for score, name, d in scored[: args.k]:
        print(f"  [{score:>3}] {name:<32} {d['description'][:70]}")
    print(f"\n  restaurar: skill_vault.py restore <name>")
    return 0


def cmd_restore(args) -> int:
    idx = _load_index()
    PRIMARY.mkdir(parents=True, exist_ok=True)
    for name in args.names:
        src = VAULT_DIR / name
        dst = PRIMARY / name
        if not src.exists():
            print(f"  ✗ {name}: no esta en el vault"); continue
        if dst.exists():
            print(f"  ⚠ {name}: ya existe en ~/.claude/skills/ — omitido"); continue
        shutil.move(str(src), str(dst))
        if name in idx["skills"]:
            idx["skills"][name]["restored_count"] = idx["skills"][name].get("restored_count", 0) + 1
            idx["skills"][name]["last_restored"] = _now()
            del idx["skills"][name]            # ya no esta en vault
        print(f"  ✓ {name} restaurada -> ~/.claude/skills/{name}")
    _save_index(idx)
    print("  NOTA: reinicia la sesion Claude Code (o /reload-plugins) para que la skill cargue.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="skill_vault")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("migrate"); m.add_argument("--keep-file", required=True); m.add_argument("--dry-run", action="store_true"); m.set_defaults(func=cmd_migrate)
    l = sub.add_parser("list"); l.add_argument("--active", action="store_true"); l.add_argument("--vaulted", action="store_true"); l.set_defaults(func=cmd_list)
    s = sub.add_parser("status"); s.set_defaults(func=cmd_status)
    se = sub.add_parser("search"); se.add_argument("query"); se.add_argument("-k", type=int, default=10); se.set_defaults(func=cmd_search)
    r = sub.add_parser("restore"); r.add_argument("names", nargs="+"); r.set_defaults(func=cmd_restore)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
