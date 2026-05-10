# Research-2 — Prompt cache SOTA (2026-05-08)

> Author: Worker fork (Research-2) for ULTRON v14.4 Phase 2.
> Sources: docs.anthropic.com (redirected to platform.claude.com), code.claude.com,
> GitHub anthropics/claude-code issues, Sealos/AICC/AgentsRoom 2026 telemetry blogs.

---

## Q1: TTL / extended caching

- **Answer:** Two TTLs available at the API layer — **default 5 minutes** (`{"cache_control": {"type": "ephemeral"}}`) and **extended 1 hour** at 2× base input price (`{"cache_control": {"type": "ephemeral", "ttl": "1h"}}`). Cache reads are 0.1× regardless of TTL; 5m writes are 1.25×, 1h writes are 2×. **No per-block TTL difference between tools/system/messages.** Claude Code clients **cannot override TTL** — the harness sets cache_control internally and the value has fluctuated server-side without user control. Issue [#46829](https://github.com/anthropics/claude-code/issues/46829) documents a March 2026 silent regression from 1h→5m default that cost a single user $949 in 4 months and was closed "not planned". As of May 2026 the behavior is **server-side only** and there is no documented setting in `~/.claude/settings.json` to force 1h.
- **Sources:**
  - https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (TTL reference)
  - https://github.com/anthropics/claude-code/issues/46829 (regression timeline + mitigation absence)
- **Confidence:** HIGH (multiple primary sources agree; the regression issue is canonical evidence the client has zero TTL control).

## Q2: Breakpoints supported

- **Answer:** **Up to 4 explicit `cache_control` breakpoints per request**, plus 1 implicit slot used by automatic caching (`cache_control` at the top-level request, not nested in a block). If 4 explicit breakpoints already exist, automatic caching returns **HTTP 400**. **No cost penalty per breakpoint** — billing is based purely on cached vs uncached content size. Hierarchy is fixed: `tools → system → messages`. Lookback window for prefix matching is **20 blocks**. Minimum cacheable prompt: **4096 tokens** for Opus 4.5+ / Sonnet 4.6+ / Haiku 4.5; below this, caching silently no-ops.
- **Sources:**
  - https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (sections "Cache Breakpoints", "Minimum Cacheable Prompt Length")
- **Confidence:** HIGH

## Q3: Hit-rate measurement from response

- **Answer:** Cache metrics live in **`response.usage`** with these exact paths:
  - `response.usage.cache_read_input_tokens` — tokens served from cache
  - `response.usage.cache_creation_input_tokens` — tokens written to cache this turn
  - `response.usage.input_tokens` — uncached tokens after the last breakpoint
  - `response.usage.cache_creation.ephemeral_5m_input_tokens` — 5m-tier writes
  - `response.usage.cache_creation.ephemeral_1h_input_tokens` — 1h-tier writes
  - Total = `cache_read + cache_creation + input_tokens`

  **Claude Code does NOT surface these to hook scripts via env var or hook output.** No `CLAUDE_*` env carries usage data. However the harness writes per-call records to **`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`** with `usage` objects per message — these contain `cache_read`/`cache_creation`/`cache_write` fields. ULTRON can scan those JSONLs as the **best proxy** without an API key.

  Alternative: enable **`CLAUDE_CODE_ENABLE_TELEMETRY=1`** + `OTEL_METRICS_EXPORTER=otlp|prometheus|console` to export real-time metrics including `claude_code.api.cache_*`. Default export interval 60s for metrics, 5s for logs.
- **Sources:**
  - https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (response schema)
  - https://code.claude.com/docs/en/monitoring-usage (OTel env vars + metric names)
  - https://sealos.io/blog/claude-code-metrics/ (real-world JSONL inspection 2026)
  - https://agentsroom.dev/features/claude-code-token-usage (61:1 cache-read:input ratio benchmark)
- **Confidence:** HIGH

## Q4: Recommended patterns 2025-2026

- **Answer:** Anthropic's canonical guidance:
  - **Order: tools → system → messages** (immutable hierarchy).
  - **Place `cache_control` on the LAST static block** before any volatile content — never on changing content (timestamps, user input, dynamic context).
  - For multi-turn conversations: use **automatic caching** (top-level `cache_control` arg) — the harness moves the breakpoint forward automatically.
  - **Pre-warming**: `max_tokens: 0` with explicit `cache_control` on system writes the cache without spending output tokens.
  - For tools: cache definitions by placing `cache_control` on the **last tool**.

  **For Claude Code hook output specifically** — docs ([code.claude.com/hooks](https://code.claude.com/docs/en/hooks)) state hook output is wrapped in a **system-reminder** and **inserted at the point where the hook fires**. Placement varies by event:
  - SessionStart/Setup/SubagentStart → "at the start of the conversation, before the first prompt"
  - UserPromptSubmit/UserPromptExpansion → "alongside the submitted prompt" (joins user message stream)
  - PreToolUse/PostToolUse → "next to the tool result"

  **No documentation states hook output is cached separately or that ordering between hooks affects cache hit.** Multiple hooks for the same event run in parallel, identical handlers are deduplicated by command string / URL. Hook output is therefore part of the **messages** layer (not system) for UserPromptSubmit and PostToolUse — meaning every hook firing potentially churns the messages cache prefix.
- **Sources:**
  - https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (stable-first patterns)
  - https://code.claude.com/docs/en/hooks (hook output placement)
- **Confidence:** HIGH for API patterns, MED for hook-specific behavior (no explicit hook+cache documentation, inferred from message-layer placement).

## Q5: Edge cases / pitfalls

- **Answer:** Cache invalidation cascades down the hierarchy:

  | Change | Tools | System | Messages |
  |---|---|---|---|
  | Tool definitions | ✘ | ✘ | ✘ |
  | Web search toggle | ✓ | ✘ | ✘ |
  | Citations toggle | ✓ | ✘ | ✘ |
  | `speed` setting | ✓ | ✘ | ✘ |
  | `tool_choice` | ✓ | ✓ | ✘ |
  | Images (any) | ✓ | ✓ | ✘ |
  | Thinking params | ✓ | ✓ | ✘ |
  | System prompt drift | ✓ | ✘ | ✘ |
  | User message change | ✓ | ✓ | ✘ (after change) |
  | **Skill description change** | ✓ | ✘ | ✘ (one-shot for ULTRON Phase 1 apply) |

  **For ULTRON specifically:**
  - **skillOverrides we just applied (Phase 1)** = one-time system-prompt drift → first session post-apply has system+messages cache miss; subsequent sessions cache normally.
  - **MEMORY.md / context.md churn** between sessions = system prompt drift (because they're loaded into the system context block) → degrades hit rate.
  - **routing.jsonl appends** between hook fires within a session don't directly invalidate (different file) BUT if a hook reads those files and their content surfaces in stdout, the system reminder content changes → messages drift.
  - **Thinking blocks** are cached automatically on Opus 4.5+/Sonnet 4.6+ but stripped on older Haiku models — ULTRON runs on Opus 4.7 [1m] so this is fine.
  - **Below 4096 tokens** caching silently no-ops. ULTRON's tiny hook outputs (<1k tok each) are well below the threshold and never cache individually — only in combination with the stable system prompt.

- **Sources:**
  - https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching (invalidation table)
  - https://github.com/anthropics/claude-code/issues/46829 (real-world cache miss patterns)
- **Confidence:** HIGH

---

## Recommendation for ULTRON v14.4 P2

**`cache_telemetry.py` should READ THE HARNESS JSONL LOGS, not try to instrument hooks.** The Claude Code harness writes per-message `usage` objects to `~/.claude/projects/<project-slug>/<session-uuid>.jsonl` — this is the authoritative source. Concrete fields to extract per record:
- `usage.cache_read_input_tokens`
- `usage.cache_creation_input_tokens` (split: `usage.cache_creation.ephemeral_5m_input_tokens`, `usage.cache_creation.ephemeral_1h_input_tokens`)
- `usage.input_tokens`
- `usage.output_tokens`
- `timestamp` / `requestId` / `model`

Aggregate per session and over a sliding 24h window:
- `cache_hit_rate = sum(cache_read) / sum(cache_read + cache_creation + input_tokens)`
- `cache_creation_to_read_ratio` (Anthropic benchmark: healthy ≥ 30:1, observed 61:1)
- `tokens_saved = cache_read × 0.9` (vs uncached cost)

**`cache-config.yaml` should be DECLARATIVE INTENT, not enforcement.** Document which content blocks ULTRON considers stable (CLAUDE.md global, MEMORY.md hot section, manifest cache hash) and which are volatile (context.md, routing.jsonl recent slice). The file becomes a contract: refactors that violate the stability claim require a config update + a cache-miss expectation in tests.

**3 concrete refactor suggestions for hook output ordering:**
1. **session-init.ps1** — emit stable session id + working dir FIRST, then context.md primer (which churns daily). Currently mixed.
2. **intent-dispatcher.py** — banner format `[ULTRON·{pct}%] skill={id} | ctx={path} ({tokens}tok) | via={source}` includes `pct` and `tokens` which churn per-query → consider stripping to `[ULTRON] skill={id} via={source}` and putting numerics in a separate optional debug line.
3. **MEMORY.md hot-section pinning** — Phase 3 dedup target (2,125 → ≤1,000 tok). Each token cut at this layer compounds across every session.
4. **OPTIONAL** — add `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=otlp` for live monitoring; ULTRON's doctor.py D24 detector can read OTLP push or fall back to JSONL scan.
5. **Phase 1 follow-up** — skillOverrides changes invalidate system cache once; document this in CHANGELOG so the post-apply cache-miss is expected.

---

## Open questions for USER

1. **Telemetry mode:** Enable `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTel local Prometheus, or stick with JSONL scan? OTel is real-time but adds a Prometheus/OTLP collector dependency. JSONL scan is zero-dep but lags by minutes. **Recommendation: JSONL scan for v14.4, defer OTel to v14.6 PERFECT MEMORY where Qdrant infrastructure already lands.**
2. **TTL bug stance:** Issue #46829 cost users hundreds in March 2026 with no fix from Anthropic. Should ULTRON's D24 detector raise BLOCKING if hit rate < 30% (red flag for TTL regression) so USER can react fast? **Recommendation: yes, BLOCKING < 30% hit rate, WARN < 60%, PASS ≥ 60%.**
3. **Acceptance gate impossible to verify in-session:** Phase 2 acceptance is "≥60% over 24h real sessions". This requires waiting. Either ship Phase 2 with telemetry-only and validate post-hoc, or block commit on synthetic validation. **Recommendation: ship telemetry, validate 24h later.**

— Research-2 done. Implementation can proceed on top of JSONL parsing + OTel-as-future-option.
