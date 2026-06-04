# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
gen_golden.py - Golden-set generator for ULTRON memory recall evals (OLA C).

READ-ONLY. Never writes to brain.db. Opens the SQLite SoT with
``mode=ro`` (and immutable as a hard fallback) so it physically cannot
mutate the database.

What it does
------------
1. Reads ``memory_items`` where ``status='active'`` from ~/.ultron/brain.db.
2. Stratified sampling by ``type`` (proportional, deterministic) so every
   memory type is represented in proportion to its population.
3. Derives a natural-language query for each sampled item from its
   title / summary / content / tags (best available text), normalised.
4. Fixes ``expect_ids = [canonical_id]`` (the item's own ``id``).
5. SECURITY GATE: filters out any row whose text trips a secret pattern
   (sk-/gho_/ghp_/AKIA/-----BEGIN ...). Such rows never enter the dataset,
   so we never leak a secret into golden_set.json.
6. Emits ``golden_set.json`` with a stable schema.

Run
---
    uv run python gen_golden.py
    uv run python gen_golden.py --target 100 --out golden_set.json

Determinism
-----------
A fixed ``SEED`` (overridable with ``--seed``) drives all sampling. The
same brain.db + same seed => byte-identical golden_set.json (aside from
``generated_at`` and ``source_git_sha`` which are environment facts and
can be pinned/ignored when diffing).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

SCHEMA_VERSION = 1
SEED = 20260604  # FIXED deterministic seed

DEFAULT_DB = Path.home() / ".ultron" / "brain.db"
DEFAULT_OUT = Path(__file__).resolve().parent / "golden_set.json"

# Target number of positives. The whole active set (~942 eligible) is small
# enough that we sample the full eligible population by default, which both
# exceeds the >=100 requirement and gives the most stable eval signal.
DEFAULT_TARGET = 942

MIN_QUERY_LEN = 8          # below this the derived text is too thin to be a query
MAX_QUERY_LEN = 160        # truncate over-long derived queries

# Secret detection. Conservative, anchored patterns. A single hit on a row's
# combined text removes that row from the eligible pool entirely.
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),            # OpenAI-style
    re.compile(r"gho_[A-Za-z0-9]{20,}"),             # GitHub OAuth token
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),             # GitHub PAT
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),     # GitHub fine-grained PAT
    re.compile(r"AKIA[0-9A-Z]{12,}"),                # AWS access key id
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),  # PEM private key
    re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),    # Slack token
]

# Map raw memory_items.type -> eval category taxonomy used by SPEC-GOLDEN-SET.
TYPE_TO_CATEGORY = {
    "fact": "factual",
    "decision": "decision",
    "task": "task",
    "constraint": "constraint",
    "persona": "persona",
    "temporal": "temporal",
    "file": "file",
    "project": "project",
    # ULTRON-specific types observed in brain.db:
    "error_resolution": "factual",
    "codebase_fact": "file",
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def git_sha(repo: Path) -> str:
    """Best-effort short+long git sha of the repo containing the DB cockpit."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return "unknown"


def open_ro(db_path: Path) -> sqlite3.Connection:
    """Open the DB strictly read-only. Tries mode=ro, falls back to immutable."""
    uri = f"file:{db_path.as_posix()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError:
        uri = f"file:{db_path.as_posix()}?immutable=1"
        conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    # Hard guard: refuse any write attempt at the connection layer.
    conn.execute("PRAGMA query_only = ON")
    return conn


def has_secret(text: str) -> bool:
    return any(p.search(text) for p in SECRET_PATTERNS)


def clean_text(value: str | None) -> str:
    """Normalise to NFC, repair stray mojibake, collapse whitespace."""
    if not value:
        return ""
    s = str(value)
    # brain.db has a few rows stored as latin-1-decoded-as-utf8 mojibake
    # (e.g. 'arquitect�nicos'). Replacement chars are dropped; we do not
    # try to recover the original byte since the query only needs to be
    # representative, not perfect.
    s = s.replace("�", "")
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        val = json.loads(raw)
        if isinstance(val, list):
            return [str(t) for t in val]
    except Exception:
        pass
    return []


# Generic tags that add no discriminative signal to a derived query.
_NOISE_TAGS = {
    "general",
    "imported_vault",
    "imported_sessions",
    "imported_kg",
    "claude-platform",
    "heuristic",
}


def derive_query(row: sqlite3.Row) -> str:
    """
    Build a natural-language query from the best available text.

    Priority: title > summary > content. Optionally append the most
    informative (non-noise) tag to disambiguate near-duplicate summaries.
    """
    base = (
        clean_text(row["title"])
        or clean_text(row["summary"])
        or clean_text(row["content"])
    )
    if not base:
        return ""

    tags = [t for t in parse_tags(row["tags"]) if t not in _NOISE_TAGS]
    # Append at most one discriminative tag if the base text is short.
    if tags and len(base) < 60:
        tag = tags[0].replace("-", " ").replace("_", " ").strip()
        if tag and tag.lower() not in base.lower():
            base = f"{base} ({tag})"

    if len(base) > MAX_QUERY_LEN:
        base = base[:MAX_QUERY_LEN].rsplit(" ", 1)[0]
    return base.strip()


# --------------------------------------------------------------------------- #
# Sampling
# --------------------------------------------------------------------------- #

def stratified_sample(
    by_type: dict[str, list[dict]], target: int, rng: random.Random
) -> list[dict]:
    """
    Proportional stratified sampling across types, deterministic given rng.

    Each stratum is shuffled with the seeded rng, then we take a proportional
    quota. Remainders are distributed to the largest strata first so the total
    lands exactly on min(target, total_available).
    """
    total = sum(len(v) for v in by_type.values())
    take_total = min(target, total)
    if take_total == total:
        # Full census: deterministic ordering by type then by id.
        out: list[dict] = []
        for t in sorted(by_type):
            out.extend(sorted(by_type[t], key=lambda r: r["expect_ids"][0]))
        return out

    # Proportional quotas (floor), then hand out the remainder.
    quotas: dict[str, int] = {}
    fractional: list[tuple[float, str]] = []
    for t, items in by_type.items():
        exact = len(items) / total * take_total
        q = int(exact)
        quotas[t] = min(q, len(items))
        fractional.append((exact - q, t))

    assigned = sum(quotas.values())
    remainder = take_total - assigned
    # Largest fractional part first; tie-break by type name for determinism.
    fractional.sort(key=lambda x: (-x[0], x[1]))
    i = 0
    while remainder > 0 and fractional:
        _, t = fractional[i % len(fractional)]
        if quotas[t] < len(by_type[t]):
            quotas[t] += 1
            remainder -= 1
        i += 1
        if i > len(fractional) * 64:  # safety against pathological loop
            break

    out = []
    for t in sorted(by_type):
        items = sorted(by_type[t], key=lambda r: r["expect_ids"][0])
        rng.shuffle(items)
        out.extend(items[: quotas[t]])
    out.sort(key=lambda r: r["expect_ids"][0])
    return out


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def build(db_path: Path, target: int, seed: int) -> dict:
    rng = random.Random(seed)
    conn = open_ro(db_path)
    try:
        rows = conn.execute(
            """
            SELECT id, type, scope, project_id, title, summary, content, tags
            FROM memory_items
            WHERE status = 'active'
            """
        ).fetchall()
    finally:
        conn.close()

    total_active = len(rows)
    stats = {
        "total_active": total_active,
        "secret_filtered": 0,
        "empty_query_filtered": 0,
        "short_query_filtered": 0,
        "eligible": 0,
    }

    by_type: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        # SECURITY GATE: evaluate the combined text BEFORE doing anything else.
        blob = " ".join(
            str(r[k] or "")
            for k in ("title", "summary", "content", "tags")
        )
        if has_secret(blob):
            stats["secret_filtered"] += 1
            continue

        query = derive_query(r)
        if not query:
            stats["empty_query_filtered"] += 1
            continue
        if len(query) < MIN_QUERY_LEN:
            stats["short_query_filtered"] += 1
            continue

        # Final paranoia: the derived query itself must not carry a secret.
        if has_secret(query):
            stats["secret_filtered"] += 1
            continue

        raw_type = r["type"] or "fact"
        category = TYPE_TO_CATEGORY.get(raw_type, "factual")
        by_type[raw_type].append(
            {
                "id": f"gs-{r['id']}",
                "query": query,
                "category": category,
                "type": raw_type,
                "scope": r["scope"],
                "project_id": r["project_id"],
                "expect_ids": [r["id"]],
            }
        )

    stats["eligible"] = sum(len(v) for v in by_type.values())
    sampled = stratified_sample(by_type, target, rng)

    cat_dist = Counter(p["category"] for p in sampled)
    type_dist = Counter(p["type"] for p in sampled)

    return {
        "schema": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_git_sha": git_sha(db_path.parent / "cockpit" / "memory-rework"),
        "source_db": str(db_path),
        "seed": seed,
        "sampling": "stratified_by_type_proportional_deterministic",
        "stats": {
            **stats,
            "positives": len(sampled),
            "category_distribution": dict(sorted(cat_dist.items())),
            "type_distribution": dict(sorted(type_dist.items())),
        },
        "positives": [
            # Persist only the canonical eval fields (strip internal type/scope
            # helpers we used for stratification but keep them too: useful for
            # per-category slicing in the harness).
            {
                "id": p["id"],
                "query": p["query"],
                "category": p["category"],
                "type": p["type"],
                "scope": p["scope"],
                "project_id": p["project_id"],
                "expect_ids": p["expect_ids"],
            }
            for p in sampled
        ],
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Generate the memory recall golden set.")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to brain.db (read-only).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output golden_set.json path.")
    ap.add_argument("--target", type=int, default=DEFAULT_TARGET, help="Max positives to emit.")
    ap.add_argument("--seed", type=int, default=SEED, help="Deterministic RNG seed.")
    args = ap.parse_args(argv)

    if not args.db.exists():
        print(f"ERROR: brain.db not found at {args.db}", file=sys.stderr)
        return 2

    dataset = build(args.db, args.target, args.seed)

    # Final guard before writing: no secret may appear anywhere in the output.
    serialized = json.dumps(dataset, ensure_ascii=False, indent=2)
    if has_secret(serialized):
        print("FATAL: secret pattern detected in serialized dataset; aborting.", file=sys.stderr)
        return 3

    args.out.write_text(serialized + "\n", encoding="utf-8")

    s = dataset["stats"]
    print(f"OK wrote {args.out}")
    print(f"  total_active        : {s['total_active']}")
    print(f"  secret_filtered     : {s['secret_filtered']}")
    print(f"  short/empty_filtered: {s['short_query_filtered'] + s['empty_query_filtered']}")
    print(f"  eligible            : {s['eligible']}")
    print(f"  positives           : {s['positives']}")
    print(f"  category_dist       : {s['category_distribution']}")
    print(f"  type_dist           : {s['type_distribution']}")
    if s["positives"] < 100:
        print(f"WARNING: only {s['positives']} positives (<100). "
              "brain.db eligible pool is smaller than 100 after filtering.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
