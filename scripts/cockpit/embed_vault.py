"""ULTRON v14.6 PERFECT MEMORY — Phase 1 vault embedding pipeline.

Walks `~/.ultron-vault/` for markdown notes, embeds each with the multilingual
MPNet model (`paraphrase-multilingual-mpnet-base-v2`, 768-dim), and upserts
into a Qdrant collection `ultron_vault`. Indexing is incremental: per-file
SHA1 fingerprints persisted at `~/.ultron/.tmp/embed-vault-state.json`; only
changed files trigger embedding on subsequent runs.

CLI:
  embed_vault.py init                 # create collection if missing
  embed_vault.py index                # incremental sync (default)
  embed_vault.py index --full         # rebuild collection from scratch
  embed_vault.py query "<text>" [--top N]   # semantic search smoke
  embed_vault.py status               # collection size + last-run JSON

Configuration (env vars override):
  ULTRON_QDRANT_URL    default http://localhost:6333
  ULTRON_QDRANT_COLL   default ultron_vault
  ULTRON_VAULT_PATH    default ~/.ultron-vault
  ULTRON_EMBED_MODEL   default paraphrase-multilingual-mpnet-base-v2

Dependencies: qdrant-client + sentence-transformers (declared in pyproject).
First call to `_get_model()` downloads the MPNet weights (~470 MB) into
`~/.cache/huggingface/`. Subsequent runs use the cached copy.

Read-only on the source files. Writes only Qdrant points + the state file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Config ─────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


QDRANT_URL = os.environ.get("ULTRON_QDRANT_URL", "http://localhost:6333")
COLLECTION = os.environ.get("ULTRON_QDRANT_COLL", "ultron_vault")
EMBED_MODEL_NAME = os.environ.get(
    "ULTRON_EMBED_MODEL", "paraphrase-multilingual-mpnet-base-v2"
)
EMBED_DIM = 768  # MPNet base
DISTANCE = "Cosine"


def _vault_path() -> Path:
    return Path(os.environ.get("ULTRON_VAULT_PATH", str(_user_home() / ".ultron-vault")))


def _state_file() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "embed-vault-state.json"


# Cap so we never embed gigantic files; MPNet truncates internally at ~514
# tokens but reading 1MB+ files into RAM is wasteful and likely a sign of
# binary content that snuck in.
MAX_FILE_BYTES = 200_000


# ── Fingerprint + state ────────────────────────────────────────────────────────


@dataclass
class FileFingerprint:
    path: str
    sha1: str
    bytes: int
    mtime: float


def _sha1_of(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _stable_point_id(path: str) -> str:
    """Qdrant point id derived from absolute path. Stable across runs."""
    return hashlib.md5(path.encode("utf-8")).hexdigest()


def load_state() -> dict[str, dict[str, Any]]:
    p = _state_file()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("files", {})
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(files: dict[str, dict[str, Any]]) -> None:
    p = _state_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": EMBED_MODEL_NAME,
        "dim": EMBED_DIM,
        "collection": COLLECTION,
        "files": files,
    }
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


# ── Vault walker ───────────────────────────────────────────────────────────────


def walk_vault(root: Path) -> Iterable[Path]:
    """Yield all markdown files under root, sorted for deterministic order."""
    if not root.exists():
        return
    yield from sorted(p for p in root.rglob("*.md") if p.is_file())


def read_file(path: Path) -> str | None:
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > MAX_FILE_BYTES:
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def fingerprint(path: Path, content: str) -> FileFingerprint:
    return FileFingerprint(
        path=str(path),
        sha1=_sha1_of(content),
        bytes=len(content.encode("utf-8")),
        mtime=path.stat().st_mtime,
    )


# ── Lazy resources ─────────────────────────────────────────────────────────────


_MODEL = None


def _get_model():
    """Load the MPNet model lazily. Downloaded on first call (~470MB)."""
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer(EMBED_MODEL_NAME)
    return _MODEL


def _get_qdrant():
    from qdrant_client import QdrantClient
    return QdrantClient(url=QDRANT_URL)


def ensure_collection() -> dict[str, Any]:
    """Create the collection if missing. Idempotent."""
    from qdrant_client.http.models import Distance, VectorParams
    client = _get_qdrant()
    existing = {c.name for c in client.get_collections().collections}
    if COLLECTION in existing:
        return {"created": False, "name": COLLECTION}
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
    )
    return {"created": True, "name": COLLECTION}


# ── Embedding + upsert ─────────────────────────────────────────────────────────


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Return one 768-dim vector per input text."""
    if not texts:
        return []
    model = _get_model()
    vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return vectors.tolist() if hasattr(vectors, "tolist") else [list(v) for v in vectors]


def upsert_files(
    files: list[tuple[Path, str, FileFingerprint]],
    *,
    batch_size: int = 32,
) -> int:
    """Embed `files` and upsert points to Qdrant. Returns count upserted."""
    if not files:
        return 0
    from qdrant_client.http.models import PointStruct
    client = _get_qdrant()
    n = 0
    for batch_start in range(0, len(files), batch_size):
        batch = files[batch_start:batch_start + batch_size]
        texts = [content for _, content, _ in batch]
        vectors = embed_texts(texts)
        points = []
        for (path, content, fp), vec in zip(batch, vectors):
            payload = {
                "path": str(path),
                "sha1": fp.sha1,
                "bytes": fp.bytes,
                "mtime": fp.mtime,
                "preview": content[:240],
            }
            points.append(PointStruct(
                id=_stable_point_id(str(path)),
                vector=vec,
                payload=payload,
            ))
        client.upsert(collection_name=COLLECTION, points=points)
        n += len(batch)
    return n


# ── Main indexing flow ─────────────────────────────────────────────────────────


@dataclass
class IndexReport:
    total_files: int
    indexed: int
    skipped: int
    failed: int
    duration_s: float
    full_rebuild: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def index_vault(*, full_rebuild: bool = False) -> IndexReport:
    import time
    start = time.perf_counter()

    ensure_collection()

    state = {} if full_rebuild else load_state()
    new_state: dict[str, dict[str, Any]] = {}
    to_upsert: list[tuple[Path, str, FileFingerprint]] = []

    total = indexed = skipped = failed = 0
    for path in walk_vault(_vault_path()):
        total += 1
        content = read_file(path)
        if content is None:
            failed += 1
            continue
        fp = fingerprint(path, content)
        prior = state.get(str(path))
        if prior and prior.get("sha1") == fp.sha1 and not full_rebuild:
            skipped += 1
            new_state[str(path)] = prior
            continue
        to_upsert.append((path, content, fp))
        new_state[str(path)] = asdict(fp)

    if to_upsert:
        upserted = upsert_files(to_upsert)
        indexed = upserted
    save_state(new_state)

    duration = time.perf_counter() - start
    return IndexReport(
        total_files=total,
        indexed=indexed,
        skipped=skipped,
        failed=failed,
        duration_s=round(duration, 2),
        full_rebuild=full_rebuild,
    )


# ── Query (smoke test) ─────────────────────────────────────────────────────────


def query_top(text: str, *, top_n: int = 5) -> list[dict[str, Any]]:
    client = _get_qdrant()
    vec = embed_texts([text])[0]
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
            "path": payload.get("path", ""),
            "preview": payload.get("preview", ""),
        })
    return out


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_init(args: argparse.Namespace) -> int:
    out = ensure_collection()
    print(json.dumps(out, indent=2))
    return 0


def _cmd_index(args: argparse.Namespace) -> int:
    report = index_vault(full_rebuild=args.full)
    print(json.dumps(report.to_dict(), indent=2))
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    rows = query_top(args.text, top_n=args.top)
    print(json.dumps(rows, indent=2, ensure_ascii=False))
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    payload: dict[str, Any] = {
        "qdrant_url": QDRANT_URL,
        "collection": COLLECTION,
        "model": EMBED_MODEL_NAME,
        "dim": EMBED_DIM,
        "vault_path": str(_vault_path()),
        "state_file": str(_state_file()),
    }
    try:
        client = _get_qdrant()
        cols = {c.name for c in client.get_collections().collections}
        payload["collection_exists"] = COLLECTION in cols
        if COLLECTION in cols:
            info = client.get_collection(COLLECTION)
            payload["points_count"] = info.points_count
            payload["status"] = info.status.value if hasattr(info.status, "value") else str(info.status)
    except Exception as exc:  # broad: report and continue
        payload["qdrant_error"] = repr(exc)

    state_path = _state_file()
    payload["state_exists"] = state_path.exists()
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            payload["state_files_known"] = len(state.get("files", {}))
            payload["state_captured_at"] = state.get("captured_at")
        except (OSError, json.JSONDecodeError):
            payload["state_error"] = "unreadable"
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="embed_vault.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="ensure Qdrant collection exists")
    p_init.set_defaults(func=_cmd_init)

    p_idx = sub.add_parser("index", help="incremental embedding sync")
    p_idx.add_argument("--full", action="store_true", help="rebuild from scratch")
    p_idx.set_defaults(func=_cmd_index)

    p_q = sub.add_parser("query", help="semantic search smoke")
    p_q.add_argument("text")
    p_q.add_argument("--top", type=int, default=5)
    p_q.set_defaults(func=_cmd_query)

    p_st = sub.add_parser("status", help="collection + state info")
    p_st.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
