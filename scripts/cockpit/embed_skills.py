"""ULTRON v14.8 P3 — Skills catalog embedding pipeline.

Walks `~/.claude/skills/<name>/SKILL.md` files, extracts the YAML frontmatter
description (the same string the harness uses to decide when to invoke a
skill), embeds it via sentence-transformers, and upserts to a dedicated
Qdrant collection `ultron_skills`. The collection is the foundation for
P4 — semantic skill detection in `intent-dispatcher.py` — but is also
useful standalone via `embed_skills.py query "<text>"` to find which skill
best matches a free-form description.

Design choices:
  * Separate collection from `ultron_vault` because payload schema differs
    (skills carry name/tags/tier; notes carry path/preview only) and queries
    are routed differently (skill match vs vault recall).
  * Same model as v14.6 (paraphrase-multilingual-mpnet-base-v2, 768d) so
    every Qdrant collection ULTRON ships uses the same vector space.
  * Incremental sync via per-skill SHA1 of the description fragment, stored
    in `~/.ultron/.tmp/embed-skills-state.json`. Re-indexing 380 skills
    on a no-op run takes <1s; full cold rebuild ~30-60s.

Plugin skills (under `~/.claude/plugins/cache/.../skills/`) are included
when their SKILL.md exists. They get a `kind=plugin` tag in payload.

CLI:
  embed_skills.py init                 # create ultron_skills collection
  embed_skills.py index [--full]       # incremental sync (default)
  embed_skills.py query "<text>" [--top N]   # semantic skill match
  embed_skills.py status               # collection size + state
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# Modelo de embeddings ya cacheado localmente — no consultar el HF Hub
# (evita el warning "unauthenticated requests" que PowerShell trata como error).
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def _user_home() -> Path:
    return Path.home()


# ── Configuration ─────────────────────────────────────────────────────────────

QDRANT_URL = os.environ.get("ULTRON_QDRANT_URL", "http://localhost:6333")
COLLECTION = os.environ.get("ULTRON_SKILLS_COLL", "ultron_skills")
EMBED_MODEL_NAME = os.environ.get(
    "ULTRON_EMBED_MODEL", "paraphrase-multilingual-mpnet-base-v2"
)
EMBED_DIM = 768
MAX_DESC_CHARS = 6000


def _local_skills_dir() -> Path:
    return _user_home() / ".claude" / "skills"


def _plugins_root() -> Path:
    return _user_home() / ".claude" / "plugins" / "cache"


def _vault_dir() -> Path:
    return _user_home() / ".ultron" / "skill-vault"


# kind -> state en el payload (active = cargada en contexto; vaulted = en el vault; plugin = de un plugin)
_KIND_STATE = {"local": "active", "plugin": "plugin", "vaulted": "vaulted"}


def _state_file() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "embed-skills-state.json"


# ── Frontmatter parsing ────────────────────────────────────────────────────────


_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


@dataclass
class SkillMeta:
    name: str
    description: str
    tags: list[str]
    tier: str
    kind: str           # "local" or "plugin"
    path: str
    desc_sha1: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description[:1500],  # cap for payload size
            "tags": self.tags,
            "tier": self.tier,
            "kind": self.kind,
            "state": _KIND_STATE.get(self.kind, self.kind),
            "path": self.path,
            "desc_sha1": self.desc_sha1,
            "indexed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }


def _parse_frontmatter(text: str) -> dict[str, Any]:
    """Minimal YAML parse — sufficient for SKILL.md frontmatter shape."""
    m = _FM_RE.match(text)
    if not m:
        return {}
    fm_text = m.group(1)
    try:
        import yaml
        data = yaml.safe_load(fm_text)
        return data if isinstance(data, dict) else {}
    except ImportError:
        pass
    # Stdlib fallback: line-by-line key:value
    out: dict[str, Any] = {}
    current_key: str | None = None
    multiline_buf: list[str] = []
    for line in fm_text.splitlines():
        if not line.strip():
            continue
        if line.startswith(" ") or line.startswith("\t"):
            if current_key:
                multiline_buf.append(line.strip())
            continue
        if current_key and multiline_buf:
            out[current_key] = " ".join(multiline_buf)
            multiline_buf = []
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if value == ">" or value == "|":
            current_key = key.strip()
        else:
            current_key = None
            v = value.strip().strip('"').strip("'")
            if v.startswith("[") and v.endswith("]"):
                # simple list parse
                try:
                    out[key.strip()] = [
                        x.strip().strip('"').strip("'")
                        for x in v[1:-1].split(",") if x.strip()
                    ]
                except Exception:
                    out[key.strip()] = v
            else:
                out[key.strip()] = v
    if current_key and multiline_buf:
        out[current_key] = " ".join(multiline_buf)
    return out


def extract_skill_meta(path: Path, kind: str) -> SkillMeta | None:
    """Read a SKILL.md and return its embedding-ready metadata."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fm = _parse_frontmatter(text)
    if not fm:
        return None
    name = str(fm.get("name") or path.parent.name).strip()
    desc = str(fm.get("description") or "").strip()
    if not desc:
        return None
    desc = desc[:MAX_DESC_CHARS]
    tags = fm.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    tags = [str(t).strip() for t in tags if str(t).strip()]
    tier = str(fm.get("tier") or fm.get("layer") or "").strip()
    return SkillMeta(
        name=name,
        description=desc,
        tags=tags,
        tier=tier,
        kind=kind,
        path=str(path),
        desc_sha1=hashlib.sha1(desc.encode("utf-8")).hexdigest()[:16],
    )


# ── Skill discovery ───────────────────────────────────────────────────────────


def walk_local_skills() -> Iterable[Path]:
    root = _local_skills_dir()
    if not root.exists():
        return
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        skill_md = d / "SKILL.md"
        if skill_md.exists():
            yield skill_md


def walk_plugin_skills() -> Iterable[Path]:
    """Plugin SKILL.md files live a few levels deep under plugins/cache/."""
    root = _plugins_root()
    if not root.exists():
        return
    yield from sorted(root.rglob("SKILL.md"))


def walk_vaulted_skills() -> Iterable[Path]:
    """Skills movidas al vault (v15.0b) — no cargan en contexto pero sí se indexan."""
    root = _vault_dir()
    if not root.exists():
        return
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        skill_md = d / "SKILL.md"
        if skill_md.exists():
            yield skill_md


# ── State + Qdrant client ─────────────────────────────────────────────────────


def load_state() -> dict[str, dict[str, Any]]:
    f = _state_file()
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("skills", {})
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(skills: dict[str, dict[str, Any]]) -> None:
    f = _state_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": EMBED_MODEL_NAME,
        "dim": EMBED_DIM,
        "collection": COLLECTION,
        "skills": skills,
    }
    tmp = f.with_suffix(f.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(f)


_MODEL = None


def _get_model():
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer(EMBED_MODEL_NAME)
    return _MODEL


def _get_qdrant():
    from qdrant_client import QdrantClient
    return QdrantClient(url=QDRANT_URL)


def ensure_collection(*, rebuild: bool = False) -> dict[str, Any]:
    from qdrant_client.http.models import Distance, VectorParams
    client = _get_qdrant()
    existing = {c.name for c in client.get_collections().collections}
    if COLLECTION in existing and rebuild:
        client.delete_collection(collection_name=COLLECTION)
        existing.discard(COLLECTION)
    if COLLECTION in existing:
        return {"created": False, "name": COLLECTION}
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
    )
    return {"created": True, "name": COLLECTION}


def _stable_point_id(name: str, kind: str) -> str:
    """Qdrant point id derived from (kind, name). Stable across runs."""
    h = hashlib.md5(f"{kind}::{name}".encode("utf-8")).hexdigest()
    return h


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    model = _get_model()
    vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return vectors.tolist() if hasattr(vectors, "tolist") else [list(v) for v in vectors]


def upsert_skills(metas: list[SkillMeta], *, batch_size: int = 32) -> int:
    if not metas:
        return 0
    from qdrant_client.http.models import PointStruct
    client = _get_qdrant()
    n = 0
    for i in range(0, len(metas), batch_size):
        batch = metas[i:i + batch_size]
        texts = [
            # Combine name + description + tags so query "C++ shaders" can match
            # `novalbos` (description discusses C++ + shaders) even if tags omit it.
            f"{m.name}. {m.description} {' '.join(m.tags)}"
            for m in batch
        ]
        vectors = embed_texts(texts)
        points = []
        for m, vec in zip(batch, vectors):
            points.append(PointStruct(
                id=_stable_point_id(m.name, m.kind),
                vector=vec,
                payload=m.to_payload(),
            ))
        client.upsert(collection_name=COLLECTION, points=points)
        n += len(batch)
    return n


# ── Public API ────────────────────────────────────────────────────────────────


@dataclass
class IndexReport:
    total_local: int
    total_plugin: int
    indexed: int
    skipped: int
    failed: int
    duration_s: float
    full_rebuild: bool
    total_vaulted: int = 0
    rebuilt: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def index_skills(*, full_rebuild: bool = False, rebuild: bool = False) -> IndexReport:
    import time
    start = time.perf_counter()
    ensure_collection(rebuild=rebuild)
    if rebuild:
        full_rebuild = True          # colección nueva → re-embeber todo

    state = {} if full_rebuild else load_state()
    new_state: dict[str, dict[str, Any]] = {}
    to_upsert: list[SkillMeta] = []
    failed = skipped = 0
    total_local = total_plugin = total_vaulted = 0

    for path in walk_local_skills():
        total_local += 1
        meta = extract_skill_meta(path, kind="local")
        if meta is None:
            failed += 1
            continue
        key = f"{meta.kind}::{meta.name}"
        prior = state.get(key)
        if prior and prior.get("desc_sha1") == meta.desc_sha1 and not full_rebuild:
            skipped += 1
            new_state[key] = prior
            continue
        to_upsert.append(meta)
        new_state[key] = {"desc_sha1": meta.desc_sha1, "path": meta.path}

    for path in walk_plugin_skills():
        total_plugin += 1
        meta = extract_skill_meta(path, kind="plugin")
        if meta is None:
            failed += 1
            continue
        key = f"{meta.kind}::{meta.name}"
        prior = state.get(key)
        if prior and prior.get("desc_sha1") == meta.desc_sha1 and not full_rebuild:
            skipped += 1
            new_state[key] = prior
            continue
        to_upsert.append(meta)
        new_state[key] = {"desc_sha1": meta.desc_sha1, "path": meta.path}

    for path in walk_vaulted_skills():
        total_vaulted += 1
        meta = extract_skill_meta(path, kind="vaulted")
        if meta is None:
            failed += 1
            continue
        key = f"{meta.kind}::{meta.name}"
        prior = state.get(key)
        if prior and prior.get("desc_sha1") == meta.desc_sha1 and not full_rebuild:
            skipped += 1
            new_state[key] = prior
            continue
        to_upsert.append(meta)
        new_state[key] = {"desc_sha1": meta.desc_sha1, "path": meta.path}

    indexed = upsert_skills(to_upsert) if to_upsert else 0
    save_state(new_state)

    return IndexReport(
        total_local=total_local,
        total_plugin=total_plugin,
        total_vaulted=total_vaulted,
        indexed=indexed,
        skipped=skipped,
        failed=failed,
        duration_s=round(time.perf_counter() - start, 2),
        full_rebuild=full_rebuild,
        rebuilt=rebuild,
    )


def query_skills(text: str, *, top_n: int = 5, state: str | None = None) -> list[dict[str, Any]]:
    client = _get_qdrant()
    vec = embed_texts([text])[0]
    qfilter = None
    if state:
        from qdrant_client.http.models import Filter, FieldCondition, MatchValue
        qfilter = Filter(must=[FieldCondition(key="state", match=MatchValue(value=state))])
    results = client.query_points(
        collection_name=COLLECTION,
        query=vec,
        limit=top_n,
        with_payload=True,
        query_filter=qfilter,
    ).points
    out = []
    for r in results:
        payload = r.payload or {}
        out.append({
            "score": round(float(r.score), 4),
            "name": payload.get("name", ""),
            "kind": payload.get("kind", ""),
            "state": payload.get("state", ""),
            "tier": payload.get("tier", ""),
            "tags": payload.get("tags", []),
            "description": payload.get("description", "")[:200],
        })
    return out


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_init(args: argparse.Namespace) -> int:
    print(json.dumps(ensure_collection(), indent=2))
    return 0


def _cmd_index(args: argparse.Namespace) -> int:
    report = index_skills(full_rebuild=args.full, rebuild=args.rebuild)
    print(json.dumps(report.to_dict(), indent=2))
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    rows = query_skills(args.text, top_n=args.top, state=args.state)
    print(json.dumps(rows, indent=2, ensure_ascii=False))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    payload: dict[str, Any] = {
        "qdrant_url": QDRANT_URL,
        "collection": COLLECTION,
        "model": EMBED_MODEL_NAME,
        "dim": EMBED_DIM,
        "state_file": str(_state_file()),
    }
    try:
        client = _get_qdrant()
        cols = {c.name for c in client.get_collections().collections}
        payload["collection_exists"] = COLLECTION in cols
        if COLLECTION in cols:
            info = client.get_collection(COLLECTION)
            payload["points_count"] = info.points_count
    except Exception as exc:
        payload["qdrant_error"] = repr(exc)[:120]

    state_path = _state_file()
    payload["state_exists"] = state_path.exists()
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            payload["state_skills_known"] = len(data.get("skills", {}))
            payload["state_captured_at"] = data.get("captured_at")
        except (OSError, json.JSONDecodeError):
            payload["state_error"] = "unreadable"
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="embed_skills.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="ensure ultron_skills Qdrant collection")
    p_init.set_defaults(func=_cmd_init)

    p_idx = sub.add_parser("index", help="incremental sync skills → Qdrant")
    p_idx.add_argument("--full", action="store_true", help="re-embed todo (ignora state cache)")
    p_idx.add_argument("--rebuild", action="store_true", help="borra la colección y la reconstruye (purga huérfanos)")
    p_idx.set_defaults(func=_cmd_index)

    p_q = sub.add_parser("query", help="semantic skill match")
    p_q.add_argument("text")
    p_q.add_argument("--top", type=int, default=5)
    p_q.add_argument("--state", choices=["active", "vaulted", "plugin"], default=None, help="filtra por estado")
    p_q.set_defaults(func=_cmd_query)

    p_s = sub.add_parser("status", help="collection + state info")
    p_s.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
