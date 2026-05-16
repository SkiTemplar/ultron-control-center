"""ULTRON v15.2 — Agents catalog embedding pipeline.

Walks `~/.claude/agents/*.md` files, extracts the YAML frontmatter
(name, description, model, tools) plus a leading body excerpt, embeds via
sentence-transformers, and upserts to a dedicated Qdrant collection
`ultron_agents`. The collection is the foundation for semantic agent
selection (e.g. routing a brief to the right specialist) and is useful
standalone via `embed_agents.py query "<text>"` to find which agent best
matches a free-form description.

Design choices (parallel to embed_skills.py):
  * Separate collection from `ultron_skills` and `ultron_vault` because
    payload schema differs (agents carry name/model/tools; skills carry
    name/tags/tier).
  * Same model as the rest of ULTRON's Qdrant fleet
    (paraphrase-multilingual-mpnet-base-v2, 768d) so every collection
    shares the same vector space.
  * Incremental sync via per-agent SHA1 of the embedding fragment, stored
    in `~/.ultron/.tmp/embed-agents-state.json`.

CLI:
  embed_agents.py init                 # create ultron_agents collection
  embed_agents.py index [--full]       # incremental sync (default)
  embed_agents.py query "<text>" [--top N]   # semantic agent match
  embed_agents.py status               # collection size + state
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
COLLECTION = os.environ.get("ULTRON_AGENTS_COLL", "ultron_agents")
EMBED_MODEL_NAME = os.environ.get(
    "ULTRON_EMBED_MODEL", "paraphrase-multilingual-mpnet-base-v2"
)
EMBED_DIM = 768
MAX_DESC_CHARS = 6000
BODY_EXCERPT_CHARS = 500


def _local_agents_dir() -> Path:
    return _user_home() / ".claude" / "agents"


def _state_file() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "embed-agents-state.json"


# ── Frontmatter parsing ────────────────────────────────────────────────────────


_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


@dataclass
class AgentMeta:
    name: str
    description: str
    body_excerpt: str
    model: str
    tools: list[str]
    version: str
    path: str
    embed_sha1: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description[:1500],  # cap for payload size
            "body_excerpt": self.body_excerpt[:1000],
            "model": self.model,
            "tools": self.tools,
            "version": self.version,
            "path": self.path,
            "embed_sha1": self.embed_sha1,
            "indexed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Minimal YAML parse — sufficient for agent .md frontmatter shape.

    Returns (frontmatter_dict, body_text). If no frontmatter, returns ({}, text).
    """
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    fm_text = m.group(1)
    body = m.group(2)
    try:
        import yaml
        data = yaml.safe_load(fm_text)
        return (data if isinstance(data, dict) else {}), body
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
    return out, body


def _normalize_tools(raw: Any) -> list[str]:
    """tools can be a YAML list, a comma-separated string, or missing."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    return []


def extract_agent_meta(path: Path) -> AgentMeta | None:
    """Read an agent .md and return its embedding-ready metadata."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fm, body = _parse_frontmatter(text)
    if not fm:
        return None
    name = str(fm.get("name") or path.stem).strip()
    desc = str(fm.get("description") or "").strip()
    if not desc:
        return None
    desc = desc[:MAX_DESC_CHARS]
    body_excerpt = body.strip()[:BODY_EXCERPT_CHARS]
    model = str(fm.get("model") or "").strip()
    tools = _normalize_tools(fm.get("tools"))
    version = str(fm.get("version") or "").strip()
    # SHA over the exact text we embed → stable across irrelevant edits.
    embed_basis = f"{name}\n{desc}\n{body_excerpt}"
    return AgentMeta(
        name=name,
        description=desc,
        body_excerpt=body_excerpt,
        model=model,
        tools=tools,
        version=version,
        path=str(path),
        embed_sha1=hashlib.sha1(embed_basis.encode("utf-8")).hexdigest()[:16],
    )


# ── Agent discovery ───────────────────────────────────────────────────────────


def walk_local_agents() -> Iterable[Path]:
    root = _local_agents_dir()
    if not root.exists():
        return
    for f in sorted(root.iterdir()):
        if not f.is_file():
            continue
        if f.suffix.lower() != ".md":
            continue
        if f.name.startswith("."):
            continue
        yield f


# ── State + Qdrant client ─────────────────────────────────────────────────────


def load_state() -> dict[str, dict[str, Any]]:
    f = _state_file()
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("agents", {})
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(agents: dict[str, dict[str, Any]]) -> None:
    f = _state_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": EMBED_MODEL_NAME,
        "dim": EMBED_DIM,
        "collection": COLLECTION,
        "agents": agents,
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


def _stable_point_id(name: str) -> str:
    """Qdrant point id derived from agent name. Stable across runs."""
    h = hashlib.md5(f"agent::{name}".encode("utf-8")).hexdigest()
    return h


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    model = _get_model()
    vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return vectors.tolist() if hasattr(vectors, "tolist") else [list(v) for v in vectors]


def upsert_agents(metas: list[AgentMeta], *, batch_size: int = 32) -> int:
    if not metas:
        return 0
    from qdrant_client.http.models import PointStruct
    client = _get_qdrant()
    n = 0
    for i in range(0, len(metas), batch_size):
        batch = metas[i:i + batch_size]
        # Embed text = name + description + body excerpt. Body adds signal
        # the frontmatter description sometimes lacks (e.g. concrete tools,
        # heuristics, examples) so semantic queries land on the right agent.
        texts = [
            f"{m.name}\n{m.description}\n{m.body_excerpt}"
            for m in batch
        ]
        vectors = embed_texts(texts)
        points = []
        for m, vec in zip(batch, vectors):
            points.append(PointStruct(
                id=_stable_point_id(m.name),
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
    indexed: int
    skipped: int
    failed: int
    duration_s: float
    full_rebuild: bool
    rebuilt: bool = False
    qdrant_unreachable: bool = False
    reconcile_forced: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Same self-healing thresholds as embed_vault / embed_skills.
_DESYNC_STATE_MIN = 10
_DESYNC_RATIO = 0.5


def index_agents(*, full_rebuild: bool = False, rebuild: bool = False) -> IndexReport:
    import time
    start = time.perf_counter()

    # Pre-flight: bail out cleanly without touching state if Qdrant is down.
    if not _qdrant_healthy():
        return IndexReport(
            total_local=0,
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
    # force a full rebuild this run.
    reconcile_forced = False
    if not full_rebuild and len(state) >= _DESYNC_STATE_MIN:
        pts = _qdrant_points_count(COLLECTION)
        if pts is not None and pts < len(state) * _DESYNC_RATIO:
            full_rebuild = True
            reconcile_forced = True
            state = {}
    new_state: dict[str, dict[str, Any]] = {}
    to_upsert: list[AgentMeta] = []
    failed = skipped = 0
    total_local = 0

    for path in walk_local_agents():
        total_local += 1
        meta = extract_agent_meta(path)
        if meta is None:
            failed += 1
            continue
        key = meta.name
        prior = state.get(key)
        if prior and prior.get("embed_sha1") == meta.embed_sha1 and not full_rebuild:
            skipped += 1
            new_state[key] = prior
            continue
        to_upsert.append(meta)
        new_state[key] = {"embed_sha1": meta.embed_sha1, "path": meta.path}

    indexed = upsert_agents(to_upsert) if to_upsert else 0
    save_state(new_state)

    return IndexReport(
        total_local=total_local,
        indexed=indexed,
        skipped=skipped,
        failed=failed,
        duration_s=round(time.perf_counter() - start, 2),
        full_rebuild=full_rebuild,
        rebuilt=rebuild,
        reconcile_forced=reconcile_forced,
    )


def query_agents(query: str, top_n: int = 5) -> list[dict[str, Any]]:
    """Semantic agent search. Importable from other ULTRON modules.

    Example:
        from embed_agents import query_agents
        hits = query_agents("review architecture for SOLID violations", top_n=3)
    """
    client = _get_qdrant()
    vec = embed_texts([query])[0]
    results = client.query_points(
        collection_name=COLLECTION,
        query=vec,
        limit=top_n,
        with_payload=True,
    ).points
    out = []
    for r in results:
        payload = r.payload or {}
        out.append({
            "score": round(float(r.score), 4),
            "name": payload.get("name", ""),
            "model": payload.get("model", ""),
            "tools": payload.get("tools", []),
            "version": payload.get("version", ""),
            "path": payload.get("path", ""),
            "description": payload.get("description", "")[:200],
        })
    return out


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_init(args: argparse.Namespace) -> int:
    print(json.dumps(ensure_collection(), indent=2))
    return 0


def _cmd_index(args: argparse.Namespace) -> int:
    report = index_agents(full_rebuild=args.full, rebuild=args.rebuild)
    print(json.dumps(report.to_dict(), indent=2))
    # Exit 2 → Qdrant unreachable; state untouched, retry next session.
    if report.qdrant_unreachable:
        return 2
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    rows = query_agents(args.text, top_n=args.top)
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
            payload["state_agents_known"] = len(data.get("agents", {}))
            payload["state_captured_at"] = data.get("captured_at")
        except (OSError, json.JSONDecodeError):
            payload["state_error"] = "unreadable"
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="embed_agents.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="ensure ultron_agents Qdrant collection")
    p_init.set_defaults(func=_cmd_init)

    p_idx = sub.add_parser("index", help="incremental sync agents → Qdrant")
    p_idx.add_argument("--full", action="store_true", help="re-embed todo (ignora state cache)")
    p_idx.add_argument("--rebuild", action="store_true", help="borra la colección y la reconstruye (purga huérfanos)")
    p_idx.set_defaults(func=_cmd_index)

    p_q = sub.add_parser("query", help="semantic agent match")
    p_q.add_argument("text")
    p_q.add_argument("-k", "--top", type=int, default=5)
    p_q.set_defaults(func=_cmd_query)

    p_s = sub.add_parser("status", help="collection + state info")
    p_s.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
