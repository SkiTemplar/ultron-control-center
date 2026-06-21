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
import logging
import os
import re
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

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
            # entity='skill' namespaces this collection from agents/vault notes
            # stored in the same Qdrant instance. Queries can filter on entity
            # to avoid cross-contamination.
            "entity": "skill",
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


def _parse_frontmatter(text: str, *, _source_hint: str = "") -> dict[str, Any]:
    """Minimal YAML parse — sufficient for SKILL.md frontmatter shape.

    Args:
        text: Full file contents (frontmatter fences included).
        _source_hint: Optional path string used in WARN logs.

    Returns:
        Parsed frontmatter as a plain dict. Returns ``{}`` on any failure
        (including malformed YAML) after logging a WARN so callers can
        surface the issue without crashing.
    """
    m = _FM_RE.match(text)
    if not m:
        return {}
    fm_text = m.group(1)
    try:
        import yaml
        try:
            data = yaml.safe_load(fm_text)
            return data if isinstance(data, dict) else {}
        except Exception as yaml_exc:
            hint = f" ({_source_hint})" if _source_hint else ""
            logger.warning(
                "WARN: YAML parse error en frontmatter%s: %s — usando fallback stdlib",
                hint,
                yaml_exc,
            )
            # Fall through to stdlib parser below.
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
        logger.warning("WARN: no se pudo leer %s — omitida", path)
        return None
    fm = _parse_frontmatter(text, _source_hint=str(path))
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


def _qdrant_healthy() -> bool:
    """Cheap /healthz probe — see embed_vault._qdrant_healthy for rationale."""
    import urllib.request
    try:
        with urllib.request.urlopen(QDRANT_URL.rstrip("/") + "/healthz", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _qdrant_points_count(collection: str) -> int | None:
    import urllib.request, json as _j
    try:
        with urllib.request.urlopen(
            QDRANT_URL.rstrip("/") + f"/collections/{collection}", timeout=2
        ) as r:
            data = _j.load(r)
        return int(data.get("result", {}).get("points_count", 0))
    except Exception:
        return None


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
            # a graphics-focused persona even if its tags omit those keywords.
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
    qdrant_unreachable: bool = False
    reconcile_forced: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Same self-healing thresholds as embed_vault — see comment there.
_DESYNC_STATE_MIN = 10
_DESYNC_RATIO = 0.5


def index_skills(*, full_rebuild: bool = False, rebuild: bool = False) -> IndexReport:
    import time
    start = time.perf_counter()

    # Pre-flight: bail out cleanly without touching state if Qdrant is down.
    if not _qdrant_healthy():
        return IndexReport(
            total_local=0, total_plugin=0, total_vaulted=0,
            indexed=0, skipped=0, failed=0,
            duration_s=round(time.perf_counter() - start, 2),
            full_rebuild=full_rebuild, rebuilt=rebuild,
            qdrant_unreachable=True,
        )

    ensure_collection(rebuild=rebuild)
    if rebuild:
        full_rebuild = True          # colección nueva → re-embeber todo

    state = {} if full_rebuild else load_state()

    # Self-healing reconcile: if state claims sync but Qdrant is empty,
    # force a full rebuild this run. See embed_vault for full rationale.
    reconcile_forced = False
    if not full_rebuild and len(state) >= _DESYNC_STATE_MIN:
        pts = _qdrant_points_count(COLLECTION)
        if pts is not None and pts < len(state) * _DESYNC_RATIO:
            logger.warning(
                "WARN: self-heal divergencia detectada — state=%d skills, Qdrant=%d puntos "
                "(ratio %.2f < %.2f) — forzando full rebuild",
                len(state),
                pts,
                pts / len(state) if state else 0,
                _DESYNC_RATIO,
            )
            full_rebuild = True
            reconcile_forced = True
            state = {}
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
        reconcile_forced=reconcile_forced,
    )


# Tier ordering for reranking: lower number = higher priority.
_TIER_RANK: dict[str, int] = {
    "L1": 0, "L2": 1, "L3": 2,
    "core": 0, "advanced": 1, "experimental": 2,
}
_TIER_RANK_DEFAULT = 9  # unknown tiers rank last


def _rerank(
    results: list[dict[str, Any]],
    *,
    top_n: int,
    alpha_semantic: float = 0.85,
    alpha_tier: float = 0.10,
    alpha_freshness: float = 0.05,
) -> list[dict[str, Any]]:
    """Post-query reranking by (semantic score, tier priority, freshness).

    The final score is a weighted combination:
      final = alpha_semantic * cosine_score
            + alpha_tier     * (1 - tier_rank / 10)    # normalised 0..1
            + alpha_freshness * freshness_norm          # normalised 0..1

    Args:
        results: Raw Qdrant hit dicts with 'score', 'tier', 'indexed_at'.
        top_n: Maximum number of results to return.
        alpha_semantic: Weight for the raw cosine similarity score.
        alpha_tier: Weight for the tier-priority bonus.
        alpha_freshness: Weight for the recency bonus.

    Returns:
        Reranked list of dicts, truncated to top_n, with 'rerank_score' added.
    """
    if not results:
        return results

    # Parse indexed_at timestamps for freshness calculation.
    now_ts = datetime.now(timezone.utc).timestamp()
    ONE_YEAR_S = 365 * 24 * 3600
    for r in results:
        try:
            ia = r.get("indexed_at", "")
            if ia:
                ts = datetime.fromisoformat(ia).timestamp()
                age_s = max(0.0, now_ts - ts)
            else:
                age_s = ONE_YEAR_S
        except (ValueError, TypeError):
            age_s = ONE_YEAR_S
        r["_age_s"] = age_s

    max_age = max(r["_age_s"] for r in results) or 1.0

    for r in results:
        tier_val = _TIER_RANK.get(r.get("tier", ""), _TIER_RANK_DEFAULT)
        tier_score = max(0.0, 1.0 - tier_val / 10.0)
        freshness_score = 1.0 - r["_age_s"] / max_age
        r["rerank_score"] = round(
            alpha_semantic * r["score"]
            + alpha_tier * tier_score
            + alpha_freshness * freshness_score,
            4,
        )

    results.sort(key=lambda r: r["rerank_score"], reverse=True)
    for r in results:
        r.pop("_age_s", None)
    return results[:top_n]


def query_skills(
    text: str,
    *,
    top_n: int = 5,
    state: str | None = None,
    rerank: bool = True,
) -> list[dict[str, Any]]:
    """Semantic skill search with optional tier/freshness reranking.

    Args:
        text: Free-form query string.
        top_n: Number of results to return.
        state: Optional filter — "active", "vaulted", or "plugin".
        rerank: If True (default), apply tier+freshness reranking.

    Returns:
        List of matching skill dicts sorted by (rerank_score if rerank else score).
    """
    from qdrant_client.http.models import Filter, FieldCondition, MatchValue
    client = _get_qdrant()
    vec = embed_texts([text])[0]

    # Always restrict to entity='skill' to avoid cross-contamination with
    # agents or vault notes that may share the same Qdrant instance.
    must_conditions = [FieldCondition(key="entity", match=MatchValue(value="skill"))]
    if state:
        must_conditions.append(
            FieldCondition(key="state", match=MatchValue(value=state))
        )
    qfilter = Filter(must=must_conditions)

    # Fetch extra candidates if reranking so we have enough to reorder.
    fetch_n = top_n * 3 if rerank else top_n
    results = client.query_points(
        collection_name=COLLECTION,
        query=vec,
        limit=fetch_n,
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
            "indexed_at": payload.get("indexed_at", ""),
        })

    return _rerank(out, top_n=top_n) if rerank else out[:top_n]


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_init(args: argparse.Namespace) -> int:
    print(json.dumps(ensure_collection(), indent=2))
    return 0


def _cmd_index(args: argparse.Namespace) -> int:
    report = index_skills(full_rebuild=args.full, rebuild=args.rebuild)
    print(json.dumps(report.to_dict(), indent=2))
    # Exit 2 → Qdrant unreachable; state untouched, retry next session.
    if report.qdrant_unreachable:
        return 2
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    rows = query_skills(args.text, top_n=args.top, state=args.state, rerank=not args.no_rerank)
    print(json.dumps(rows, indent=2, ensure_ascii=False))
    return 0


def _cmd_batch_query(args: argparse.Namespace) -> int:
    """Read a JSON array of query strings from stdin, return a JSON object.

    Input (stdin):
        ["query text 1", "query text 2", ...]

    Output (stdout):
        {
          "query text 1": [{"name": "...", "score": ..., ...}, ...],
          "query text 2": [...],
          ...
        }

    All queries are embedded in a single model load, which is ~10-12x faster
    than calling `embed_skills.py query` once per prompt on Windows (the main
    bottleneck is sentence-transformers model cold-start, not the Qdrant round-trip).
    """
    try:
        raw = sys.stdin.read()
        queries: list[str] = json.loads(raw)
        if not isinstance(queries, list) or not all(isinstance(q, str) for q in queries):
            raise ValueError("stdin must be a JSON array of strings")
    except (json.JSONDecodeError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1

    # Load model and Qdrant client once for all queries.
    _get_model()   # warm the model cache before looping
    results: dict[str, list[dict[str, Any]]] = {}
    for text in queries:
        try:
            rows = query_skills(
                text[:500],
                top_n=args.top,
                state=args.state,
                rerank=not args.no_rerank,
            )
            results[text] = rows
        except Exception as exc:
            results[text] = []
            logger.warning("WARN: batch_query failed for %r: %s", text[:60], exc)

    print(json.dumps(results, indent=2, ensure_ascii=False))
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
    p_q.add_argument("--no-rerank", action="store_true", help="desactiva reranking por tier/freshness")
    p_q.set_defaults(func=_cmd_query)

    p_bq = sub.add_parser(
        "batch_query",
        help="embed many prompts in one model load (stdin=JSON array, stdout=JSON object)",
    )
    p_bq.add_argument("--top", type=int, default=3)
    p_bq.add_argument(
        "--state", choices=["active", "vaulted", "plugin"], default=None,
        help="filtra por estado",
    )
    p_bq.add_argument("--no-rerank", action="store_true", help="desactiva reranking")
    p_bq.set_defaults(func=_cmd_batch_query)

    p_s = sub.add_parser("status", help="collection + state info")
    p_s.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
