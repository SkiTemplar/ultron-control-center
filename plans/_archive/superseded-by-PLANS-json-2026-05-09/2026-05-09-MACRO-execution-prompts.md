---
title: ULTRON Macro Roadmap — Execution Prompts (ready-to-fork)
date: 2026-05-09
status: PLAN-AUTHORITATIVE
companion_to: 2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md
---

# Execution Prompts — ready-to-fork por fase

> Documento de "ejecución". Cada fase de cada sprint tiene aquí los
> prompts EXACTOS para entregar a un sub-agent.
>
> Uso: copy-paste el bloque correspondiente al `Agent` tool con el
> `subagent_type` indicado (o sin él para fork).

---

## ÍNDICE

```
v14.2 TOKEN HUNTER
  - Phase 0: Research-1, Research-2, Research-3, DEV-baseline, TEST-baseline, QA-baseline
  - Phase 1: DEV-lazy, TEST-lazy, QA-lazy
  - Phase 2: DEV-cache, TEST-cache, QA-cache
  - Phase 3: DEV-dedupe, TEST-dedupe
  - Phase 4: DEV-trim, TEST-trim
  - Phase 5: Smoke + RESOLVED

v14.3 META-PROMPTER
  - Phase 0: Research-4, Research-5, DEV-corpus
  - Phase 1: DEV-improver, TEST-improver, QA-improver
  - Phase 2: DEV-loop, TEST-loop, QA-privacy
  - Phase 3: DEV-versioning
  - Phase 4: DEV-eval, TEST-eval, QA-bias
  - Phase 5: DEV-tui, TEST-tui

v14.4 PERFECT MEMORY
  - Phase 0: HUMAN-GATE Qdrant install
  - Phase 1: Research-6, Research-7, Research-8, DEV-embed, TEST-embed
  - Phase 2: DEV-hybrid, TEST-hybrid
  - Phase 3: DEV-recall
  - Phase 4: DEV-dispatcher-emb, TEST-dispatcher-emb
  - Phase 5: Integration tests

v15.0 ULTRON.io
  - Phase 0: HUMAN brief
  - Phase 1: DEV-stack
  - Phase 2: DEV-pages
  - Phase 3: DEV-content
  - Phase 4: DEV-marketing
  - Phase 5: DEV-resolve

GENERIC PROMPTS (re-used)
  - Documentor (closes RESOLVED)
  - QA reviewer (independent)
  - Researcher (web-search-enabled)
```

---

# v14.2 TOKEN HUNTER — prompts

## v14.2 P0 Research-1: skillListingBudgetFraction internals

```
ROLE: Research engineer. Investigate Claude Code skill listing internals.

GOAL: produce reference for v14.2 implementation phase.

QUESTIONS:
1. ¿Cómo el harness de Claude Code resuelve skillListingBudgetFraction
   internamente? ¿Hay setting documentado oficialmente para name-only
   listing?
2. ¿Cuál es el orden de truncation: alfabético, por uso, custom?
3. ¿Existe una API oficial para que un script externo afecte el listing?
4. ¿Cuál es el max safe value para no degradar?
5. ¿Hay precedentes de wrappers (open source) que modifiquen el behavior?

SOURCES TO QUERY (in priority):
- https://docs.anthropic.com/claude-code (todo el sub-tree)
- https://github.com/anthropics/claude-code (changelog + docs/ + src/)
- https://github.com/anthropics/claude-code/issues (search "skill listing")
- HN: "claude code skills truncation"
- Reddit r/ClaudeCode: search same

OUTPUT:
~/.ultron/audits/research-skill-listing-2026-05-XX.md
- For each question: answer, primary source URL, confidence (HIGH/MED/LOW)
- Implementation recommendation: 1-2 paragraphs at end
- Open questions for user (if any source disagreement)

CONSTRAINTS:
- Cite primary sources
- Confidence HIGH only with multiple primary sources agreeing
- Token budget ≤ 50k input
- Time budget: 1 hour wall-clock
```

## v14.2 P0 Research-2: prompt caching state-of-the-art

```
ROLE: Research engineer. Investigate Anthropic prompt caching best practices.

GOAL: producer reference for v14.2 Phase 2 cache audit.

QUESTIONS:
1. ¿Cuál es el TTL real del cache en 2026? (5 min documentado;
   ¿hay extended caching?)
2. ¿Cuántos cache_control breakpoints soporta el API?
3. ¿Cómo se mide cache hit rate desde la response?
4. ¿Hay patrones recomendados para hooks (system-prompt + tool definitions
   en first cacheable block)?
5. ¿Hay edge cases conocidos (e.g. tool injection invalidates cache)?

SOURCES:
- https://docs.anthropic.com/claude/docs/prompt-caching
- Anthropic engineering blog
- anthropic-cookbook GitHub repo
- Recent (2025+) benchmark blog posts (search "anthropic cache hit rate")

OUTPUT: ~/.ultron/audits/research-prompt-cache-2026-05-XX.md (same format)

CONSTRAINTS: same as Research-1
```

## v14.2 P0 Research-3: token measurement tools

```
ROLE: Research engineer. Find local token counting tools for Claude.

QUESTIONS:
1. ¿Hay un tokenizer local oficial de Anthropic (post-2024)?
2. ¿Cuán cerca está tiktoken cl100k_base de Anthropic real?
3. ¿Hay paquetes Python que contemos sin call al API?
4. ¿Qué hacen OpenAI/Cohere/Mistral en este espacio?

SOURCES:
- pypi.org search "anthropic tokenizer"
- github search "claude tokenizer"
- HN/Reddit recent

OUTPUT: ~/.ultron/audits/research-token-measurement-2026-05-XX.md

CONSTRAINTS: same
```

## v14.2 P0 DEV-baseline: token_baseline.py

```
ROLE: Implementor for ULTRON sprint v14.2 Phase 0.
SPEC: scripts/cockpit/token_baseline.py (NEW)

GOAL: medidor reproducible de tokens en cada bloque que el harness
inyecta al SessionStart.

INPUTS to use:
- ~/.ultron/.tmp/context.md
- ~/.ultron/MEMORY.md
- ~/.claude/CLAUDE.md (global)
- skill listing (output del harness — research how)
- tool descriptions (idem)

OUTPUTS:
- TSV: ~/.ultron/audits/token-baseline-<date>.tsv
  Columns: block_name, bytes, chars, tokens_estimated, tokens_method
- JSON: ~/.ultron/.tmp/token-baseline.json (for downstream consumption)

LIBRARIES allowed:
- tiktoken (cl100k_base) — best approximation we have for Claude
- Standard library

API (Python):
def measure_block(name: str, content: str) -> dict:
    return {"bytes": ..., "chars": ..., "tokens": ..., "method": "tiktoken-cl100k"}

def measure_session_start() -> list[dict]:
    """Returns list of block measurements for current SessionStart."""

CLI:
python token_baseline.py snapshot              # write TSV + JSON
python token_baseline.py diff <baseline.json>  # compare current vs baseline
python token_baseline.py budget                # show per-block budget vs actual

CONSTRAINTS:
- Atomic writes
- Reproducible (run x3 same input → same output ± 2%)
- No API calls (offline-only)
- pyproject.toml: add tiktoken if not present (uv add tiktoken)
- Tests pytest tests/test_token_baseline.py (12 cases per ops manual)

REPORT BACK:
- Files created/modified
- Test cases enumerated for Phase TEST
- Known limitations (e.g. tiktoken vs Claude actual divergence)
```

## v14.2 P0 TEST-baseline

```
ROLE: Test engineer for ULTRON v14.2 Phase 0.

DEV DIFF: scripts/cockpit/token_baseline.py (just landed)

ACCEPTANCE (from spec):
- Reproducible (x3 same → ± 2%)
- 5 blocks measured
- TSV output consumable
- D22_TOKEN_BASELINE detector reads it

TEST CASES (from ops manual CAPÍTULO 2):
1. test_measures_context_md_in_isolation
2. test_measures_memory_md_in_isolation
3. test_measures_claude_md_global
4. test_measures_skill_listing_full
5. test_measures_skill_listing_lazy (skip until Phase 1 lands)
6. test_total_equals_sum_of_blocks
7. test_reproducible_across_runs
8. test_handles_missing_context_md
9. test_handles_unicode_in_context
10. test_token_count_correlates_with_tiktoken
11. test_writes_tsv_atomically
12. test_doctor_reads_baseline (skip until D22 lands)

DELIVER:
tests/test_token_baseline.py with cases 1-4, 6-11 implemented.
Skip 5 and 12 with `pytest.skip("waits for v14.2 Phase 1/Phase 5")`.
Coverage ≥ 80% on token_baseline.py.

REPORT: count, coverage, any test you marked SKIP.
```

## v14.2 P0 QA-baseline

```
ROLE: agent-skills:code-reviewer. Independent review of v14.2 P0 diff.

DIFF: scripts/cockpit/token_baseline.py + tests/test_token_baseline.py

REVIEW DIMENSIONS:
1. Correctness — does measure_block actually count tokens correctly?
2. Robustness — handles missing files, encoding errors, OS perms?
3. Tests — coverage gaps? edge cases skipped without justification?
4. Architecture — does it bolt cleanly into existing cockpit/?

OUTPUT: ~/.ultron/audits/qa-v14.2-p0-baseline-<date>.md

EXIT: 0 BLOCKING + ≤ 3 HIGH or fail.
```

## v14.2 P1 DEV-lazy: skill_lazy_loader.py

```
ROLE: Implementor for v14.2 Phase 1.
SPEC: PART II Phase 1 of macro plan + research findings from R1.

GOAL: build_skill_listing(mode="lazy"|"full") con fallback automático.

DESIGN (from spec):
- mode="lazy": name + tier + 1-line summary (cap 80 chars)
- mode="full": baseline behavior (current ~552 skills full description)
- Hook UserPromptSubmit: dispatcher decides cuándo cargar full description
- Storage: ~/.ultron/.tmp/skill-listing-mode.json (which mode active)
- Fallback: lazy.json corrupted → fall back to full

API:
def build_skill_listing(mode: str = "lazy") -> str: ...
def get_skill_full_description(name: str) -> str | None: ...
def is_lazy_mode() -> bool: ...

CONSTRAINTS:
- Backwards compatible: if config absent, behaves as full (no behavior change)
- Atomic writes
- Tests: tests/test_skill_lazy_loader.py — 15 cases per ops manual
- Document deviations (e.g. if cap 80 doesn't fit some skills, what happens?)

REPORT: files created, smoke test result, test cases enumerated.
```

## v14.2 P1 TEST-lazy

```
ROLE: Test engineer for v14.2 Phase 1.

DEV: just landed.

CASES (from ops manual):
TestLazySkillBuilder:
1-10 (10 cases on builder behavior)

TestDispatcherLazyIntegration:
11-15 (5 integration cases including 50-query golden set)

GOLDEN SET PREP:
- Read last ~/.ultron/sessions/*/routing.jsonl
- Pick 50 distinct queries (diverse, not duplicates)
- Persist as tests/fixtures/dispatcher-golden-50.jsonl
- Each entry: {query, expected_skill}

ACCEPTANCE:
- 100% pass on cases 1-10
- ≥ 95% accuracy on case 14 (golden set)

DELIVER + REPORT.
```

## v14.2 P1 QA-lazy

```
ROLE: agent-skills:code-reviewer for v14.2 P1 diff.

EXTRA FOCUS:
- Token savings claim — verify the delta (should be ≥ 20k)
- Fallback path — does it actually trigger on corrupted lazy.json?
- Race conditions — UserPromptSubmit hook + dispatcher concurrent?

OUTPUT: qa-v14.2-p1-lazy-<date>.md
EXIT: 0 BLOCKING + ≤ 3 HIGH.
```

## v14.2 P2 DEV-cache

```
ROLE: Implementor for v14.2 Phase 2 (prompt cache audit).
SPEC: PART II Phase 2 of macro plan + Research-2.

DELIVERABLES:
1. Audit of 12 hooks: cuál es cacheable, dónde poner cache_control
2. Refactor 2-3 hook scripts to put stable blocks first
3. New: ~/.ultron/cockpit/cache-config.yaml (declarative breakpoints)
4. New script: scripts/cockpit/cache_telemetry.py — records hit rate

TESTS: tests/test_prompt_cache_audit.py — 8 cases per ops manual.

CONSTRAINTS:
- No regression on cold-start latency
- Each cache_control with inline justification comment
- Mock the API for tests (don't burn real cache)

REPORT: hooks audited, breakpoints added, est. hit rate improvement.
```

## v14.2 P2 TEST-cache

```
ROLE: Test engineer.

CASES:
- 4 cases on cache breakpoint placement
- 4 cases on telemetry instrumentation

INTEGRATION:
- Run a mock 24h aggregate, verify D24 detector fires/doesn't correctly

DELIVER + REPORT.
```

## v14.2 P3 DEV-dedupe

```
ROLE: Implementor for v14.2 Phase 3 (MEMORY.md dedup).

SPEC: tool nuevo `ultron memory dedupe [--apply|--dry-run]`

DESIGN:
- Read MEMORY.md, context.md, ~/.claude/CLAUDE.md
- Detect: exact duplicates + paraphrases (using brain_index FTS5
  similarity + simple heuristics — NO Qdrant yet, that's v14.4)
- Emit: diff of proposed dedupe
- --apply: backup to ~/.ultron/backups/MEMORY.md.pre-dedupe; apply

FALLBACK PATTERN:
- Lines marked `[INTENTIONAL-DUP]` are skipped
- User can force keep with this marker

TESTS: tests/test_memory_dedupe.py — 6 cases.

ULTRON.PS1 wire:
ultron memory dedupe → Invoke-Py "memory_dedupe.py" $Rest

REPORT.
```

## v14.2 P3 TEST-dedupe + P4 DEV-trim + P4 TEST-trim

(Pattern is the same. Spec en macro plan + cases en ops manual.)

## v14.2 P5 — Smoke + RESOLVED prompt

```
ROLE: Documentor for v14.2 RESOLVED.

INPUTS:
- All commits from sprint v14.2 (git log sprint/v14.2-token-hunter ^main)
- Test results
- QA reports
- Decision log entries
- Pre/post sprint metrics

DELIVERABLES:
1. references/changelog.md — new v14.2.0 "TOKEN HUNTER" entry
   (style: match v14.1.1)
   Include pre/post tokens table
2. MEMORY.md — update token baseline references, tests count
3. Decision log: mark D01 (lazy listing) as "verified-effective"
4. Risk register: close R01-R04 with status (mitigated/realized/etc.)
5. Pickup file: ~/.ultron/plans/<next-date>-pickup.md

VERIFICATION:
- Re-read each modified file once
- Re-run uv run pytest tests/ -q (suite must be green)
- Re-run doctor (no BLOCKING)

REPORT: files modified, verifications passed, ready for tag v14.2.0.
```

---

# v14.3 META-PROMPTER — prompts

## v14.3 P0 Research-4: Anthropic prompt-improvement cookbook

```
ROLE: Research engineer.

QUESTIONS:
1. ¿Cuál es el state-of-the-art en meta-prompting 2026?
2. ¿Anthropic ha publicado patrones específicos?
3. ¿Cómo evita LLM-as-judge bias hacia outputs largos?
4. ¿Pairwise vs scalar rating — cuál tiene mejor signal?
5. ¿Constitutional AI / self-refine techniques actuales?

SOURCES:
- https://docs.anthropic.com/claude/docs/prompt-engineering
- https://github.com/anthropics/anthropic-cookbook
- arXiv recent papers (2024+) "self-refine", "constitutional AI",
  "LLM-as-judge"
- Lilian Weng blog (lilianweng.github.io)

OUTPUT: research-meta-prompts-2026-05-XX.md
```

## v14.3 P0 Research-5: Pairwise eval methodology

```
ROLE: Research engineer.

QUESTIONS:
1. ¿Cómo Chatbot Arena (LMSys) evalúa prompts pairwise?
2. ¿Qué % de bias se reporta en LLM-as-judge papers?
3. ¿Cuántas evaluations son necesarias para significancia (n=10? 30?)?
4. ¿Hay calibration techniques para reducir bias?

SOURCES:
- LMSys blog
- "MT-Bench" paper
- "Judge LM" papers
- Reasonable.ly blog (Karpathy / Le Cun mentions)

OUTPUT: research-pairwise-eval-2026-05-XX.md
```

## v14.3 P0 DEV-corpus: prompt inventory

```
ROLE: Implementor.

DELIVERABLE: ~/.ultron/audits/prompt-corpus-v14.3.md

INVENTORY:
- 9 Kirkardo prompts: scripts/cockpit/tui/prompts/01..09-*.md
- 6 skills clipboard prompts: scripts/cockpit/tui/prompts/skills-*.md
- 3 newsletter editions (rendered from template)
- ~5 inline mini-prompts in tui.py (todavía hay algunos:
  search "launch_with_prompt" si encuentras)

For each: name, location, traffic class (high/med/low based on
~/.ultron/sessions/*/routing.jsonl frequency).

REPORT.
```

## v14.3 P1 DEV-improver: prompt_improver.py

```
ROLE: Implementor for v14.3 Phase 1.

SPEC: scripts/cockpit/prompt_improver.py + skill prompt-improver

CORE FUNCTION:
def improve_prompt(
    current_prompt: str,
    sample_outputs: list[str],
    user_edits: list[tuple[str, str]],  # (was, became)
    failure_modes: list[str],
) -> tuple[str, str]:  # (improved_prompt, diff_markdown)
    """Calls Claude with meta-prompt template, returns improved
    version + diff. Does NOT apply automatically."""

META-PROMPT TEMPLATE (use research-4 findings):
- ROLE: senior prompt engineer
- INPUTS: current_prompt + samples + edits + failure_modes
- INSTRUCTIONS: identify weakness, propose minimal change, preserve voice
- OUTPUT: improved_prompt + 1-paragraph reasoning

CACHING: by sha1 of (current_prompt + samples). Skip API call if cached.
Cache: ~/.ultron/.tmp/prompt-improver-cache.json

TESTS: tests/test_prompt_improver.py — 10 cases per ops manual.

CONSTRAINTS:
- Anti-laundering: no auto-apply, only diff
- Temperature 0.3 default (reproducibility)
- Token budget per call ≤ 8k input

REPORT.
```

## v14.3 P1 TEST-improver, P1 QA-improver, P2 DEV-loop, P2 TEST-loop, P2 QA-privacy, P3 DEV-versioning, P4 DEV-eval, P4 TEST-eval, P4 QA-bias, P5 DEV-tui, P5 TEST-tui

(Mismo patrón. Cada uno: spec en macro, cases en ops manual, prompt
estructura como las anteriores.)

---

# v14.4 PERFECT MEMORY — prompts

## v14.4 P0 — HUMAN-GATE

User installs Qdrant per `~/.ultron/plans/qdrant-mcp-install-steps.md`.
No prompt para AI. Sprint bloqueado hasta este gate cierre.

## v14.4 P1 Research-6: vector store benchmarks

```
ROLE: Research engineer.

QUESTIONS:
1. ¿Qdrant 2026 vs Chroma vs pgvector vs Weaviate — performance?
2. ¿HNSW vs IVF para datasets pequeños (~10k vectors)?
3. ¿Qdrant payload filters performance impact?
4. ¿RAM footprint estimado para 10k vectors @ 384 dim?

SOURCES:
- ann-benchmarks.com
- Qdrant docs benchmarks page
- pgvector vs alternatives blog posts 2025+

OUTPUT: research-vector-stores-2026-05-XX.md
```

## v14.4 P1 Research-7: embedding models for ES

```
ROLE: Research engineer.

QUESTIONS:
1. ¿MiniLM-L6 vs MPNet-base — calidad para ES?
2. ¿E5-multilingual scoreboards 2026?
3. ¿BGE-base-multi vs BAAI alternatives?
4. ¿Quantization: int8 quality drop tolerable?

SOURCES:
- MTEB leaderboard (huggingface.co/spaces/mteb/leaderboard)
- BGE / E5 papers
- sentence-transformers docs

OUTPUT: research-embeddings-2026-05-XX.md
```

## v14.4 P1 Research-8: hybrid retrieval

```
ROLE: Research engineer.

QUESTIONS:
1. ¿Reciprocal Rank Fusion vs alternative fusion methods?
2. ¿Score normalization: min-max, z-score, percentile?
3. ¿Cuándo BM25 alone wins vs hybrid?
4. ¿k=60 RRF default — confirmed best in 2026?

SOURCES:
- Pinecone blog hybrid search
- Elastic hybrid retrieval docs
- arXiv "hybrid retrieval" 2024+

OUTPUT: research-hybrid-search-2026-05-XX.md
```

## v14.4 P1 DEV-embed: embed_vault.py

```
ROLE: Implementor for v14.4 Phase 1.
SPEC: scripts/cockpit/embed_vault.py

API:
def embed_chunk(text: str, model: str = "all-MiniLM-L6-v2") -> list[float]:
    """Returns 384-dim vector."""

def upsert_vault(qdrant_url: str = "http://localhost:6333",
                  collection: str = "ultron_vault",
                  dry_run: bool = False) -> dict:
    """Walks vault, embeds chunks, upserts to Qdrant. Idempotent."""

CHUNKS:
- Match the existing FTS5 chunks (read brain_index.py for chunking logic)
- Each chunk → one Qdrant point with payload:
  {note_path, chunk_id, mtime_iso, text_preview (first 200 chars)}

DETECTION:
- Compare chunk_id mtime vs Qdrant existing point payload.mtime
- Re-embed only if newer

DEPENDENCIES:
- sentence-transformers (uv add sentence-transformers)
- qdrant-client (uv add qdrant-client)

CLI:
python embed_vault.py upsert --dry-run    # log only
python embed_vault.py upsert              # actually push
python embed_vault.py status              # how many indexed vs vault

TESTS: tests/test_embed_vault.py — 12 cases per ops manual.

CONSTRAINTS:
- 538 notas < 5 min upsert
- Atomic / idempotent
- No API call to OpenAI/Cohere
- Test fixtures use small synthetic vault

REPORT.
```

## v14.4 P1 TEST-embed, P2 DEV-hybrid, P2 TEST-hybrid, P3 DEV-recall, P4 DEV-dispatcher-emb, P4 TEST-dispatcher-emb, P5 Integration

(Mismo patrón. Cada uno consulta macro plan + ops manual.)

---

# v15.0 ULTRON.io — prompts

## v15.0 P0 — HUMAN BRIEF

(no prompt for AI; user-driven content brief)

## v15.0 P1 DEV-stack

```
ROLE: Implementor for v15.0 Phase 1.

WORKING DIR (NEW):
~/.claude/skills/ultron-web/ (separado del skill repo)

DELIVERABLES:
- npx create-next-app@latest ultron-web --typescript --tailwind --eslint --app
- npx shadcn@latest init (default theme)
- Basic structure: app/, components/, public/
- README.md with dev/build/deploy instructions
- .gitignore from create-next-app default
- Push to GitHub repo (private initially, decision in P4)

CONSTRAINTS:
- Stack: Next.js 15 + Tailwind + shadcn/ui (no other CSS)
- TypeScript strict mode on
- ESLint + Prettier configured
- No external deps yet (dependencies will be added per page)

REPORT.
```

## v15.0 P2 DEV-pages

```
ROLE: Implementor for v15.0 Phase 2.

USE SKILLS:
- ui-ux-pro-max for layout
- frontend-design for components

PAGES (8):
1. / — Hero "ULTRON: tu cockpit personal de IA"
2. /manifesto — Filosofía 800 palabras
3. /architecture — Diagrama interactivo (Mermaid o D3)
4. /sprints — Cronología v11→v14.4
5. /numbers — Live metrics from /api/numbers
6. /personas — 18 personas listadas
7. /blog — 3 posts (Genesis, Deadwood, Token Hunter)
8. /contact — Form posting to /api/contact

API ROUTES:
- /api/numbers → reads ~/.ultron/audits/*.json (read via local script, not exposed if private)
- /api/contact → sends email via Resend / SES / similar

CONSTRAINTS:
- Mobile responsive (375 / 768 / 1024 / 1440)
- Lighthouse ≥ 90 each page
- No third-party trackers
- Plausible analytics only (privacy-first)

REPORT.
```

## v15.0 P3 DEV-content, P4 DEV-marketing, P5 DEV-resolve

(Patrón estándar.)

---

# GENERIC PROMPTS (re-usables)

## QA-reviewer (genérico)

```
ROLE: agent-skills:code-reviewer.

INPUTS:
- DIFF: <commits a..b>
- SPEC: <macro-plan section ref>

REVIEW DIMENSIONS (apply all 7):
1. Correctness — bugs, off-by-one, wrong defaults
2. Robustness — error handling, validation, missing inputs
3. Security — injection, traversal, secrets, untrusted input
4. Performance — O(n²), N+1, sync I/O in hot paths
5. Tests — coverage gaps, false-positive risk
6. Architecture — SOLID violations, coupling
7. Style/docs — comments why-not-what, naming

OUTPUT: ~/.ultron/audits/qa-<sprint>-<feature>-<date>.md

Severity buckets: BLOCKING, HIGH, MEDIUM, LOW.

EXIT CRITERIA:
- 0 BLOCKING (else fail, return to DEV)
- HIGH ≤ 3 (else triage)
```

## Documentor (genérico, RESOLVED phase)

```
ROLE: Documentor closing sprint <X>.

INPUTS:
- All sprint commits (git log sprint/v14.X-* ^main)
- Test results (final pytest output)
- QA reports
- Decision log entries from this sprint
- Risk register entries (status updated)
- Pre/post sprint metrics

DELIVERABLES:
1. references/changelog.md — new vNN.NN.0 entry
   (style: match the most recent entry)
2. MEMORY.md — update relevant numbers
3. CAPABILITIES.md cross-check
4. Backups of pre-update files
5. Pickup file for next session

VERIFICATION (do it, don't claim it):
- Re-read each modified file
- Re-run uv run pytest tests/ -q
- Re-run ultron doctor --quiet --json

REPORT: changes made, verifications passed.
```

## Researcher (genérico, web-search-enabled)

```
ROLE: Senior research engineer for ULTRON sprint <X>.

TOPIC: <single specific question>

PRIORITY (order):
1. Primary docs (anthropic.com/docs, github.com/anthropics)
2. Recent papers (2024+)
3. Engineering blogs (Anthropic, OpenAI, Cohere)
4. HN top discussions (recent)
5. Reddit r/ClaudeCode, r/LocalLLaMA

OUTPUT FORMAT:
~/.ultron/audits/research-<topic>-<date>.md

Per question:
- Question: <restate>
- Answer: <2-3 sentences>
- Evidence: <URL + quote, max 200 chars>
- Confidence: HIGH (multiple primary sources agree) / MEDIUM (one
  source) / LOW (speculation/community consensus)

End with:
- Recommendations: 1-2 paragraphs concrete actions
- Open questions for user: <if any>

CONSTRAINTS:
- Cite primary, not bloggers
- Note disagreements between sources
- Don't recommend without evidence
- Token budget ≤ 80k input
- Time budget: 1 hour wall-clock
```

---

# Cómo invocar estos prompts

Each prompt block above is ready to paste into the Agent tool. Pattern:

```
Agent({
  description: "<3-5 words>",
  subagent_type: "agent-skills:code-reviewer",  // ONLY for QA prompts
  prompt: "<paste the block here>"
})
```

For DEV/TEST/Documentor/Researcher: omit `subagent_type` (regular fork).
For QA: use `subagent_type: "agent-skills:code-reviewer"`.

---

— Execution prompts companion. Saved 2026-05-09 (madrugada).
Plan se considera ejecutable starting con v14.2 P0 Research-1.
