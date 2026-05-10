# brain-index-chunks — S2-A Chunk-Level Retrieval

> Added in ULTRON v13.5.0 "ZTMSI Core" (S2 Sub-pilar A, 2026-05-05)

## Overview

S2-A extends `brain_index.py` with sub-note chunk indexing. Instead of retrieving entire notes, queries can now return the most relevant *paragraphs* from the vault — cutting retrieval token cost by ~10x on large notes.

---

## Schema Delta

### New table: `chunks_fts` (FTS5 virtual table)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,             -- full-text indexed chunk body
    note_id UNINDEXED,   -- FK → notes.id
    chunk_idx UNINDEXED, -- position within note (0-based)
    layer UNINDEXED,     -- mirrors notes.layer
    category UNINDEXED,  -- mirrors notes.category
    domain UNINDEXED,    -- mirrors notes.domain
    token_est UNINDEXED, -- len(content) // 4
    tokenize='unicode61 remove_diacritics 2'
);
```

### New column: `notes.token_est` (INTEGER NOT NULL DEFAULT 0)

Sum of all chunk `token_est` values for that note. Allows cheap cost estimation before loading content.

### Migration

Both additions are **idempotent** — `open_db()` applies them via `try/except OperationalError` so re-running on an existing DB is safe.

---

## Splitter Rules

The `split_into_chunks(text)` function processes a note body in four phases:

| Phase | Action |
|-------|--------|
| 1 — Segment | Split on `\n\n` (double newline = paragraph break) |
| 2 — Heading context | Prepend last seen `# Heading` to each block as context |
| 3 — Merge | Consecutive blocks with < 50 words are merged into one chunk |
| 4 — Split | Blocks > 300 words are split: first by `##` subheadings, then by ~250-word windows |

Each output chunk is a dict: `{"content": str, "chunk_idx": int, "token_est": int}` where `token_est = len(content) // 4`.

---

## Query Modes

### Default mode: `--mode notes` (back-compat)

Identical to pre-S2-A behavior. JSON schema is unchanged:

```json
{
  "query": "ue5",
  "matches": 3,
  "results": [
    {
      "id": 42,
      "path": "/home/.../.ultron-vault/10_KNOWLEDGE/cpp-ue5/actors.md",
      "layer": "L2-vault",
      "category": "knowledge",
      "domain": "cpp-ue5",
      "title": "UE5 Actor Lifecycle",
      "snippet": "«UE5» actor …",
      "rank": -1.234
    }
  ]
}
```

### New mode: `--mode chunks`

Returns per-chunk results ranked by BM25:

```bash
uv run python brain_index.py query "ue5 blueprints" --mode chunks --top 5
```

```json
{
  "query": "ue5 blueprints",
  "mode": "chunks",
  "matches": 5,
  "results": [
    {
      "note_path": "/home/.../.ultron-vault/10_KNOWLEDGE/cpp-ue5/blueprints.md",
      "chunk_idx": 2,
      "token_est": 87,
      "snippet": "«Blueprint» visual scripting …",
      "bm25": -2.456,
      "layer": "L2-vault",
      "category": "knowledge",
      "domain": "cpp-ue5"
    }
  ]
}
```

The `--top` flag controls K (default 8 for notes, default 5 for chunks when called via CLI).

### Via ultron.ps1

```powershell
ultron brain query "ue5 blueprints" --mode chunks --top 5
ultron index query "ue5 blueprints" --mode chunks --top 5  # S2-A alias
```

---

## Performance Targets

| Metric | Target | Measured |
|--------|--------|----------|
| `query --mode chunks` p50 | < 100ms | Benchmark in `test_brain_index_chunks.py::test_chunks_query_perf` |
| `query --mode notes` p50 | < 100ms | Same as pre-S2-A |
| Full build (626 notes) | < 60s | No regression target set |

---

## Migration Story

1. First `build` or `update` after S2-A deploys: `chunks_fts` is created + populated.
2. Subsequent `update` calls: only modified notes have their chunks rebuilt (DELETE + INSERT by `note_id`).
3. Pruned notes: their chunks are automatically deleted via `prune_missing`.
4. Re-running `build` on an existing DB: safe — `chunks_fts` is wiped and rebuilt from scratch (via DB delete + recreate pattern).
5. **Rolling back S2-A**: delete `~/.ultron/brain_index/index.db` and restore from `~/.ultron/backups/2026-05-05-1437-pre-S2-rebuild/`. The pre-S2-A `brain_index.py query "..."` (no `--mode`) still works on the restored DB.

---

## Session-init Staleness Check

`session-init.ps1` now checks `index.db.LastWriteTime` at startup. If older than 4 hours, it fires `brain_index.py update` as a **background process** with `-WindowStyle Hidden` — zero impact on session startup time.

---

## Files Modified (S2-A)

| File | Change |
|------|--------|
| `scripts/cockpit/brain_index.py` | Schema + splitter + chunk upsert + `--mode chunks` + stats |
| `scripts/cockpit/frontmatter_backfill.py` | Added `tags`, `token_est`, `layer` fields |
| `scripts/cockpit/ultron.ps1` | Added `index` alias subcommand |
| `~/.ultron/hooks/session-init.ps1` | Staleness check + background update |
| `tests/test_brain_index_chunks.py` | 6 new tests |
| `~/.ultron/docs/brain-index-chunks.md` | This document |
