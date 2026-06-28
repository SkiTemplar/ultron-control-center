---
name: ultron
description: Master orchestrator for the ULTRON system. Routes requests across memory layers, skill packs, hooks, and the AI Router (primary→fallback chain). Loads on every Ultron session via the SessionStart hook. Customize this file for your own workflows — the shipped version is a minimal starting template.
---

# ULTRON — Master Orchestrator

This is the **template** version of the `ultron` skill. It defines the
baseline routing and protocol surface that ULTRON expects on every session.
You are encouraged to fork and extend it for your own work.

## Session wake-up protocol

On every `SessionStart`, ULTRON:

1. Reads `~/.ultron/.tmp/context.md` (L0 hot context, capped at ~400 tokens).
2. Reads `~/.ultron/SYSTEM-MAP.md` if present (system layout pointers).
3. Surfaces any `[BLOCKING]` items.
4. Optionally reads `~/.ultron/MEMORY.md` for deeper orientation.

## Modes

- **LOW** — single-shot, no delegation, response under 50 words.
- **MEDIUM** — default. Single-domain tasks, may delegate to a specialist skill.
- **HIGH** — multi-domain, parallel agents allowed, deep planning.
- **ULTRA** — critical architecture work, full triple-LLM review allowed.

## Memory layers

| Layer | Path | Purpose |
|-------|------|---------|
| L0 | `~/.ultron/.tmp/context.md` | pinned session primer |
| L1 | `~/.ultron/brain_index/index.db` | SQLite FTS5 over chunked vault |
| L2 | `~/.ultron-vault/` | curated markdown corpus |
| L3 | remote git (optional) | off-machine mirror of L2 |

Plus a Qdrant collection `ultron_vault` for semantic recall.

## Dispatch

When the user prompt matches a registered skill trigger (defined in
`~/.claude/skills/<name>/SKILL.md` frontmatter `description`), invoke that
skill via the `Skill` tool. Otherwise handle the request directly under the
active mode.

## Customize

This file is yours. Edit freely. Common extensions:

- Add domain-specific routing rules (e.g. "if user mentions UE5 → delegate to gamedev-engineer").
- Pin your own preferred response style.
- Hook into vault/brain layers with custom queries.
- Add your own session opening rituals.

Examples and the full original orchestrator design live in the project's
documentation. Treat this as a starting point, not a destination.
