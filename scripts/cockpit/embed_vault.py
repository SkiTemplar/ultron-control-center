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

# Modelo de embeddings ya cacheado localmente — no consultar el HF Hub.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


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


_EXCLUDED_VAULT_DIRS = {"_archive", ".git", "node_modules", ".obsidian", ".trash"}


def walk_vault(root: Path) -> Iterable[Path]:
    """Yield all markdown files under root, sorted for deterministic order.

    Skips archive / VCS / editor trees so stale test fixtures and historical
    snapshots do not pollute semantic recall.
    """
    if not root.exists():
        return
    candidates: list[Path] = []
    for p in root.rglob("*.md"):
        if not p.is_file():
            continue
        rel_parts = {seg.lower() for seg in p.relative_to(root).parts}
        if rel_parts & _EXCLUDED_VAULT_DIRS:
            continue
        candidates.append(p)
    yield from sorted(candidates)


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


def _qdrant_healthy() -> bool:
    """Cheap reachability probe — does NOT load qdrant_client (heavy import).

    Returns True if /healthz answers 200 within 2s. We use a raw urllib call
    instead of qdrant_client so that failing fast doesn't pay the model+client
    initialization cost.
    """
    import urllib.request
    try:
        with urllib.request.urlopen(QDRANT_URL.rstrip("/") + "/healthz", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _qdrant_points_count(collection: str) -> int | None:
    """Return points_count for a collection, or None if unreachable / missing."""
    import urllib.request, json as _j
    try:
        with urllib.request.urlopen(
            QDRANT_URL.rstrip("/") + f"/collections/{collection}", timeout=2
        ) as r:
            data = _j.load(r)
        return int(data.get("result", {}).get("points_count", 0))
    except Exception:
        return None


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
    qdrant_unreachable: bool = False
    reconcile_forced: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# When Qdrant looks vacuous compared to what state believes it has uploaded,
# treat it as a silent desync (container reset, volume loss, etc.) and force
# a full rebuild. Threshold is permissive — even a small surviving fraction
# (e.g. partial recovery) still triggers a re-push, since the cost of a full
# rebuild is bounded (~17s for 308 files with model cached).
_DESYNC_STATE_MIN = 10        # only trigger if state claims >= N files
_DESYNC_RATIO = 0.5            # qdrant < 50% of state → presumed desync


def index_vault(*, full_rebuild: bool = False) -> IndexReport:
    import time
    start = time.perf_counter()

    # Pre-flight: bail out cleanly without touching state if Qdrant is down.
    # The previous behavior (let qdrant_client raise on first call) was OK in
    # principle, but the heavy `ensure_collection` → `get_collections` import
    # path tried to talk to Qdrant only AFTER paying client init cost; and
    # downstream the Stop hook treated the resulting non-zero exit as an
    # opaque failure rather than a known reachability issue.
    if not _qdrant_healthy():
        duration = time.perf_counter() - start
        return IndexReport(
            total_files=0, indexed=0, skipped=0, failed=0,
            duration_s=round(duration, 2),
            full_rebuild=full_rebuild,
            qdrant_unreachable=True,
        )

    ensure_collection()

    state = {} if full_rebuild else load_state()

    # Self-healing reconcile: if state file thinks Qdrant has been kept in
    # sync but the collection itself is (near-)empty, the state is lying.
    # This is exactly the failure mode we hit this morning — Qdrant went
    # down for days, embed_vault kept "ok"-ing because SHA1s matched a state
    # that no longer reflected reality. Force a full rebuild this run.
    reconcile_forced = False
    if not full_rebuild and len(state) >= _DESYNC_STATE_MIN:
        pts = _qdrant_points_count(COLLECTION)
        if pts is not None and pts < len(state) * _DESYNC_RATIO:
            full_rebuild = True
            reconcile_forced = True
            state = {}

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

    # v15.5.20: self-heal orphan Qdrant points. When `walk_vault` starts
    # skipping a path (file deleted from vault or now under _EXCLUDED_VAULT_DIRS),
    # the SHA1 cache drops it but the Qdrant point survives forever — surfacing
    # in semantic recall as ghost results. Diff prior `state` against the new
    # walk and delete the orphan IDs in one batched call. Best-effort: a
    # delete failure never blocks indexing.
    orphan_paths = set(state.keys()) - set(new_state.keys())
    if orphan_paths:
        try:
            from qdrant_client import models as _qmodels  # noqa: PLC0415
            client = _get_qdrant()
            orphan_ids = [_stable_point_id(p) for p in orphan_paths]
            client.delete(
                collection_name=COLLECTION,
                points_selector=_qmodels.PointIdsList(points=orphan_ids),
            )
        except Exception:  # noqa: BLE001 — best-effort cleanup, never blocks indexing
            pass

    save_state(new_state)

    duration = time.perf_counter() - start
    return IndexReport(
        total_files=total,
        indexed=indexed,
        skipped=skipped,
        failed=failed,
        duration_s=round(duration, 2),
        full_rebuild=full_rebuild,
        reconcile_forced=reconcile_forced,
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
    # Exit 2 communicates "Qdrant was unreachable, state is intact, retry later"
    # to the Stop hook — distinct from generic failure (1) and success (0).
    if report.qdrant_unreachable:
        return 2
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
