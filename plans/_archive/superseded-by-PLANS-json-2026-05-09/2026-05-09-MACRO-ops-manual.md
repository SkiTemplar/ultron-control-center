---
title: ULTRON Macro Roadmap — Ops Manual (companion)
date: 2026-05-09
status: PLAN-AUTHORITATIVE
companion_to: 2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md
---

# ULTRON Roadmap — Operations Manual

> Documento companion del macro roadmap. Detalla:
> - Test cases enumerados (decenas por sprint)
> - Setup de entornos por sprint
> - Cleanup checklists entre fases
> - Sync entre sprints + ramas
> - AI-driven daily standup format
> - Plantillas de prompts de fork para cada situación específica

---

## CAPÍTULO 1 — Setup de entornos por sprint

Cada sprint trabaja en una rama git dedicada. Esto evita contaminación
del main durante exploración.

### Convenciones de branching

```
main                                 ← stable, ship-ready
└── sprint/v14.2-token-hunter        ← v14.2 work
└── sprint/v14.3-meta-prompter       ← v14.3 work
└── sprint/v14.4-perfect-memory      ← v14.4 work
└── sprint/v15.0-ultron-io           ← v15.0 work
```

### Setup pre-sprint (script reusable)

Cada sprint arranca con este script:

```powershell
# scripts/cockpit/sprint_init.ps1 (NEW — to be created in v14.2 Phase 0)
param([Parameter(Mandatory)][string]$SprintCode)

Push-Location "$env:USERPROFILE\.claude\skills\ultron"

# 1. Verify clean state
$st = git status --short
if ($st -and ($st -notmatch 'brain_config\.py')) {
    Write-Error "Working tree dirty: $st"
    exit 1
}

# 2. Pull latest main
git checkout main
git pull --ff-only

# 3. Create sprint branch
$branch = "sprint/$SprintCode"
git checkout -b $branch

# 4. Snapshot baseline metrics
uv run python scripts/cockpit/sprint_metrics.py snapshot --sprint $SprintCode --phase pre

# 5. Run baseline tests
uv run pytest tests/ -q

# 6. Doctor baseline
uv run python scripts/cockpit/doctor.py --quiet --json
Copy-Item "$env:USERPROFILE\.ultron\.tmp\doctor-weekly.json" `
          "$env:USERPROFILE\.ultron\metrics\sprint-$SprintCode-pre-doctor.json"

# 7. Deadwood baseline
uv run python scripts/cockpit/deadwood_scanner.py --json --report --quiet
Copy-Item "$env:USERPROFILE\.ultron\.tmp\deadwood.json" `
          "$env:USERPROFILE\.ultron\metrics\sprint-$SprintCode-pre-deadwood.json"

Write-Host "Sprint $SprintCode initialised on branch $branch" -ForegroundColor Green
Pop-Location
```

### Sprint metrics snapshot tool (script nuevo a crear)

```python
# scripts/cockpit/sprint_metrics.py (NEW)
"""Snapshot system metrics at sprint boundaries.

Usage:
    uv run python sprint_metrics.py snapshot --sprint v14.2 --phase pre
    uv run python sprint_metrics.py snapshot --sprint v14.2 --phase post
    uv run python sprint_metrics.py diff --sprint v14.2

Persists to ~/.ultron/metrics/sprint-<X>-{pre,post}.json.
"""
```

Métricas obligatorias en el snapshot (ver Anexo H del macro):
- tests counts (passing, total)
- doctor counts (blocking, warn, info)
- deadwood counts
- manifest counts
- skills filesystem
- token measurements
- cache hit rate (cuando v14.2 lo provee)
- p50/p95 latencies

### Cleanup entre fases (regla universal)

Después de cada fase y ANTES de la siguiente, ejecutar:

```powershell
# 1. Tests siguen verde
uv run pytest tests/ -q

# 2. Doctor no degradó
uv run python scripts/cockpit/doctor.py --quiet --json

# 3. Working tree consistente
git status --short  # solo el diff esperado de la fase

# 4. Limpiar tmp residuals
Remove-Item "$env:USERPROFILE\.ultron\.tmp\_*.py" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.ultron\.tmp\commit-*.txt" -ErrorAction SilentlyContinue
```

### Sync entre sprints

Cuando v14.X RESOLVED → merge a main → arrancar v14.(X+1):

```powershell
# 1. v14.X RESOLVED
git checkout main
git merge --no-ff sprint/v14.X-theme
git tag v14.X.0
git push origin main --tags

# 2. Snapshot post-sprint metrics
uv run python scripts/cockpit/sprint_metrics.py snapshot --sprint v14.X --phase post

# 3. v14.X+1 init
.\scripts\cockpit\sprint_init.ps1 -SprintCode "v14.Y-theme"
```

---

## CAPÍTULO 2 — Test cases enumerados por sprint

> Decenas de tests concretos por sprint, no genéricos. Cada test tiene
> nombre, fixture, expected behavior. Pueden ejecutarse standalone.

### Sprint v14.2 — Token Hunter (test plan detallado)

#### v14.2 Phase 0 — Baseline measurement (12 tests)

```python
# tests/test_token_baseline.py

class TestTokenMeasurement:
    def test_measures_context_md_in_isolation(self):
        # Verify token_baseline.py reports ONLY context.md tokens
        # when invoked with --block context

    def test_measures_memory_md_in_isolation(self):
        # Same for MEMORY.md

    def test_measures_claude_md_global(self):
        # Same for ~/.claude/CLAUDE.md

    def test_measures_skill_listing_full(self):
        # Skill listing in 'full' mode

    def test_measures_skill_listing_lazy(self):
        # Skill listing in 'lazy' mode (after Phase 1 lands)

    def test_total_equals_sum_of_blocks(self):
        # Sanity: total == sum of components

    def test_reproducible_across_runs(self):
        # x3 invocations with same input → same output

    def test_handles_missing_context_md(self):
        # When ~/.ultron/.tmp/context.md missing, report 0 not crash

    def test_handles_unicode_in_context(self):
        # Spanish accents, emoji, CJK

    def test_token_count_correlates_with_tiktoken(self):
        # Cross-check with tiktoken cl100k_base on 5 known prompts

    def test_writes_tsv_atomically(self):
        # Output uses tmp+os.replace

    def test_doctor_reads_baseline(self):
        # D22_TOKEN_BASELINE detector reads the latest snapshot
```

#### v14.2 Phase 1 — Lazy skill listing (15 tests)

```python
# tests/test_skill_lazy_loader.py

class TestLazySkillBuilder:
    def test_lazy_mode_outputs_one_line_per_skill(self):
        # 552 skills → ≤ 552 lines (cap 80 chars each)

    def test_lazy_mode_includes_name_tier_summary(self):
        # Each line: name + tier + 1-line desc

    def test_full_mode_unchanged_from_baseline(self):
        # mode=full produces byte-identical output to current behavior

    def test_lazy_under_token_budget(self):
        # Total tokens of lazy listing < 8k

    def test_full_over_lazy_token_count(self):
        # Sanity: full > lazy

    def test_handles_skill_with_no_description(self):
        # Edge: SKILL.md without description field

    def test_handles_skill_with_unicode_description(self):
        # ES accents, emoji

    def test_truncates_long_descriptions_to_80_chars(self):
        # Cap enforcement

    def test_includes_all_tier_levels(self):
        # L1, L2, L3 all surface

    def test_excludes_quarantined_skills(self):
        # security_status: quarantine_pending → not in output

class TestDispatcherLazyIntegration:
    def test_dispatcher_loads_full_desc_on_match(self):
        # Query matches a skill name → full description loaded on-demand

    def test_dispatcher_falls_back_to_full_on_lazy_corrupt(self):
        # If lazy.json corrupted, fallback to full mode

    def test_dispatcher_logs_warn_on_skill_missed(self):
        # If a skill SHOULD have matched but didn't due to lazy

    def test_golden_set_50_queries_accuracy(self):
        # Replay 50 historical queries, accuracy ≥ 95%

    def test_token_savings_reported_correctly(self):
        # Phase 0 baseline tool reports the delta
```

#### v14.2 Phase 2 — Prompt cache (8 tests)

```python
# tests/test_prompt_cache_audit.py

class TestPromptCacheBreakpoints:
    def test_intent_dispatcher_has_cache_at_static_block(self):
        # cache_control on the rules section

    def test_session_init_has_cache_breakpoint(self):
        # cache_control between header (stable) and body (volatile)

    def test_no_cache_control_on_volatile_blocks(self):
        # date stamps, dynamic content NOT cached

    def test_cache_config_yaml_loads_safely(self):
        # Malformed yaml → fallback to no-cache, no crash

class TestCacheHitRateInstrumentation:
    def test_records_cache_hit(self):
        # Mock API response with cache_read_input_tokens > 0 → recorded

    def test_records_cache_miss(self):
        # cache_read_input_tokens == 0 → recorded as miss

    def test_24h_aggregate_calculation(self):
        # Sliding 24h window aggregates correctly

    def test_doctor_d24_hit_rate_threshold(self):
        # D24_LOW_CACHE_HIT detector fires when hit rate < 50%
```

#### v14.2 Phase 3 — MEMORY.md dedup (6 tests)

```python
# tests/test_memory_dedupe.py

class TestMemoryDedupe:
    def test_detects_exact_duplicate(self):
        # Same line in MEMORY.md and context.md

    def test_detects_paraphrase(self):
        # Semantic dup with different wording (uses semantic comparison)

    def test_preserves_intentional_duplicates(self):
        # Lines marked with `[INTENTIONAL-DUP]` skipped

    def test_dry_run_does_not_modify(self):
        # --dry-run only prints diff

    def test_apply_creates_backup(self):
        # --apply backs up MEMORY.md.pre-dedupe

    def test_round_trip_idempotent(self):
        # Run twice → second is no-op
```

#### v14.2 Phase 4 — Tool description trim (4 tests)

```python
# tests/test_tool_desc_trim.py

class TestToolDescTrim:
    def test_trim_does_not_remove_critical_info(self):
        # Specific keywords ("MUST", "NEVER") preserved

    def test_baseline_20_tasks_still_pass(self):
        # 20 task fixtures still produce correct tool calls

    def test_token_savings_ge_2k(self):
        # Total trim ≥ 2000 tokens

    def test_diff_is_human_readable(self):
        # Trim output produces a markdown diff for REV
```

**v14.2 total tests:** 45 nuevos + 622 existentes = 667+

---

### Sprint v14.3 — Meta-Prompter (test plan detallado)

#### v14.3 Phase 0 — Corpus selection (3 tests)

```python
# tests/test_prompt_corpus.py

class TestPromptCorpusInventory:
    def test_inventory_finds_all_15_prompts(self):
        # 9 Kirkardo + 6 skills

    def test_classifies_by_traffic(self):
        # high/medium/low based on routing.jsonl frequency

    def test_outputs_inventory_md(self):
        # ~/.ultron/audits/prompt-corpus-v14.3.md exists with 15 entries
```

#### v14.3 Phase 1 — Meta-prompt template (10 tests)

```python
# tests/test_prompt_improver.py

class TestPromptImprover:
    def test_meta_prompt_template_is_well_formed(self):
        # No unescaped braces, valid markdown

    def test_improve_returns_string_not_none(self):
        # Sanity

    def test_improve_does_not_apply_changes(self):
        # original prompt file unchanged

    def test_improve_returns_diff(self):
        # Output includes (current, improved) tuple

    def test_handles_empty_sample_outputs(self):
        # No samples provided → still produces a generic improvement

    def test_handles_unicode_in_prompts(self):
        # ES accents in prompts

    def test_temperature_0_3_default(self):
        # Reproducibility: temp=0.3 baseline

    def test_caches_by_input_sha(self):
        # Same inputs → cached output, no API call

    def test_5_known_failure_modes_get_fixed(self):
        # 5 fixtures with known failure mode → improved version fixes ≥ 1

    def test_improved_prompt_passes_self_eval(self):
        # Phase 4 self-eval gives improved ≥ original
```

#### v14.3 Phase 2 — Loop semi-auto (8 tests)

```python
# tests/test_prompt_feedback_loop.py

class TestFeedbackCapture:
    def test_post_tool_use_hook_persists_signal(self):
        # PostToolUse fires → entry in prompt-feedback.jsonl

    def test_clipboard_pre_post_diff_captured(self):
        # User edited output → diff stored

    def test_pii_filter_removes_emails(self):
        # Emails in feedback → redacted

    def test_pii_filter_removes_credentials(self):
        # PAT-like strings → redacted

class TestLoopE2E:
    def test_n_feedbacks_trigger_meta_prompt(self):
        # After 10 feedback entries, meta-prompt invoked

    def test_no_auto_apply(self):
        # Anti-laundering: no commit/edit happens

    def test_diff_surfaced_to_user(self):
        # Diff written to ~/.ultron/.tmp/prompt-improvements-pending.md

    def test_user_approval_required(self):
        # `prompts apply` requires explicit Y from user
```

#### v14.3 Phase 3 — Versioning (5 tests)

```python
# tests/test_prompt_versioning.py

class TestPromptVersions:
    def test_iteration_field_default_is_1(self):
        # New prompts start at iteration: 1

    def test_apply_creates_new_iteration(self):
        # Prompt updated → iteration: 2 + superseded_by

    def test_versions_command_lists_history(self):
        # `ultron prompts versions <name>` shows iterations

    def test_diff_command_shows_iteration_diff(self):
        # `ultron prompts diff <name> 1 2` shows changes

    def test_old_iterations_archived(self):
        # iteration N-1 moved to ~/.ultron/.archive/prompts/
```

#### v14.3 Phase 4 — Self-eval (8 tests)

```python
# tests/test_prompt_eval.py

class TestPromptEval:
    def test_eval_returns_4_dimensions(self):
        # precision, conciseness, format, completeness

    def test_eval_scores_in_0_10_range(self):
        # Each dim 0-10 int

    def test_eval_correlates_with_human_07(self):
        # 30 human-labeled pairs, Spearman ≥ 0.7

    def test_eval_does_not_prefer_longer_outputs(self):
        # Bias check: 2 outputs same content but different length, scores ≤ 1 apart

    def test_eval_caches_by_sha1(self):
        # Same (prompt, output) hash → no re-call

    def test_eval_handles_empty_output(self):
        # Empty → all dims = 0, no crash

    def test_eval_handles_unicode_output(self):
        # ES content evaluated correctly

    def test_eval_reports_confidence(self):
        # Output includes confidence score (low if eval is uncertain)
```

#### v14.3 Phase 5 — TUI integration (4 tests)

```python
# tests/test_prompt_improver_tui.py (with pytest-mock)

class TestTUIButtons:
    def test_improve_button_id_in_kirkardo_row(self):
        # Each Kirkardo audit row has `prompt-improve-{N}` button

    def test_improve_button_invokes_improver(self):
        # Click → modal with diff

    def test_eval_button_id_in_kirkardo_row(self):
        # Same for `prompt-eval-{N}`

    def test_modal_shows_scorecard(self):
        # Eval modal displays 4 dims + confidence
```

**v14.3 total tests:** 38 nuevos

---

### Sprint v14.4 — Perfect Memory (test plan detallado)

#### v14.4 Phase 0 — Qdrant install (manual gate, 0 automated)

#### v14.4 Phase 1 — Embedding pipeline (12 tests)

```python
# tests/test_embed_vault.py

class TestEmbeddingGeneration:
    def test_embeds_single_note(self):
        # 1 note → 1 vector (384 dim for MiniLM)

    def test_embeds_chunks_not_full_notes(self):
        # Notes are split into chunks (matches FTS5 chunks)

    def test_idempotent_upsert(self):
        # Same content → same vector ID, no duplicates

    def test_detects_modified_notes(self):
        # mtime changed → re-embed

    def test_handles_unicode_es_content(self):
        # ES content embedded correctly

class TestQdrantIntegration:
    def test_collection_created_with_correct_dim(self):
        # ultron_vault collection has 384-dim vectors

    def test_metadata_includes_chunk_id(self):
        # Each point has {note_path, chunk_id, mtime}

    def test_query_returns_top_k(self):
        # query("X", top=5) returns 5 results

    def test_query_filter_by_path(self):
        # Filter by note_path glob

    def test_500_notes_embedded_under_5min(self):
        # Performance: 538 notes < 5 min

class TestEmbedPipelineCLI:
    def test_dry_run_no_qdrant_writes(self):
        # --dry-run only logs

    def test_apply_writes_to_qdrant(self):
        # --apply actually writes
```

#### v14.4 Phase 2 — Hybrid search (10 tests)

```python
# tests/test_hybrid_search.py

class TestRRF:
    def test_combines_fts5_and_semantic(self):
        # Both lists → fused list

    def test_handles_disjoint_results(self):
        # Result in only one source → still surfaces

    def test_handles_overlapping_results(self):
        # Same doc in both → boosted

    def test_k_parameter_60_default(self):
        # RRF k=60 standard

class TestHybridCLI:
    def test_hybrid_subcommand_exists(self):
        # `ultron deadwood help` lists hybrid? No — `ultron brain hybrid`

    def test_outputs_top_5_with_scores(self):
        # 5 results, each with FTS5 score + semantic score + RRF score

    def test_explains_provenance(self):
        # Each result tagged "fts5+semantic" or "fts5-only" or "semantic-only"

class TestHybridQuality:
    def test_recall_at_3_ge_08_on_golden_set(self):
        # 50 golden queries, recall@3 ≥ 0.8

    def test_beats_fts5_only_70_pct(self):
        # Pairwise blind eval, hybrid wins ≥ 70%

    def test_no_regression_on_keyword_queries(self):
        # FTS5-friendly queries still get top result
```

#### v14.4 Phase 3 — Auto-recall SessionStart (5 tests)

```python
# tests/test_session_auto_recall.py

class TestAutoRecall:
    def test_loads_last_query_from_routing_jsonl(self):
        # Latest query extracted

    def test_top_3_relevant_notes_in_context(self):
        # context.md gains a section "## Relevant from last session"

    def test_token_cap_200(self):
        # Auto-recall block ≤ 200 tokens

    def test_handles_empty_history(self):
        # No previous query → no auto-recall section

    def test_handles_qdrant_unavailable(self):
        # Qdrant down → graceful skip with warn
```

#### v14.4 Phase 4 — Dispatcher embeddings (10 tests)

```python
# tests/test_dispatcher_embeddings.py

class TestEmbeddingDispatcher:
    def test_query_to_embedding(self):
        # Sanity: query string → vector

    def test_knn_classifier_trained(self):
        # routing.jsonl fed → classifier exists

    def test_top_skill_returned(self):
        # Query → top skill prediction

    def test_confidence_score_in_output(self):
        # Result includes confidence

    def test_low_confidence_falls_back_to_regex(self):
        # confidence < 0.7 → regex dispatcher consulted

    def test_classifier_retrain_on_new_data(self):
        # New entries in routing.jsonl → classifier updates

    def test_no_personal_data_in_classifier(self):
        # Classifier params don't leak query content

class TestDispatcherAccuracy:
    def test_baseline_regex_recorded(self):
        # Pre-deploy accuracy measured

    def test_embedding_matches_or_beats_regex(self):
        # Embedding ≥ regex baseline

    def test_p95_latency_under_50ms(self):
        # Speed: ≤ 50ms p95 including embedding
```

#### v14.4 Phase 5 — Tests + RESOLVED (3 integration)

```python
# tests/test_v14_4_integration.py

class TestPerfectMemoryIntegration:
    def test_full_pipeline_e2e(self):
        # vault → embed → query hybrid → recall → dispatch

    def test_doctor_d21_drift_detector(self):
        # vault count != qdrant count → warn

    def test_sync_all_includes_embed_step(self):
        # sync-all step 9 (new): refresh embeddings if vault changed
```

**v14.4 total tests:** 40 nuevos

---

### Sprint v15.0 — ULTRON.io (test plan detallado)

#### v15.0 Phase 0 — Brief (0 automated, 1 review checklist)

#### v15.0 Phase 1 — Stack setup (2 tests)

```typescript
// __tests__/setup.test.ts (Vitest or Jest)

describe('Stack setup', () => {
  it('boots Next.js dev server', () => {
    // npm run dev exits 0
  })
  it('shadcn components import', () => {
    // import { Button } from '@/components/ui/button' compiles
  })
})
```

#### v15.0 Phase 2 — Core pages (8 tests)

```typescript
describe('Routes', () => {
  it('/ renders hero section', () => {})
  it('/manifesto renders 800-word content', () => {})
  it('/architecture renders interactive diagram', () => {})
  it('/sprints loads commits from /api/sprints', () => {})
  it('/numbers loads from /api/numbers (live)', () => {})
  it('/personas lists 18 personas', () => {})
  it('/blog lists ≥ 3 posts', () => {})
  it('/contact form posts to /api/contact', () => {})
})
```

#### v15.0 Phase 3 — Content (manual review, 0 automated)

#### v15.0 Phase 4 — Marketing (0 automated, 1 manual checklist)

#### v15.0 Phase 5 — Resolve (4 tests)

```typescript
describe('Lighthouse', () => {
  it('home page lighthouse ≥ 90', async () => {
    // CI run lighthouse-ci
  })
  it('mobile responsive at 375px', () => {})
  it('analytics endpoint privacy-respecting', () => {
    // No third-party trackers, only Plausible
  })
  it('contact form does not leak email', () => {
    // POST returns 200, email goes to webhook only
  })
})
```

**v15.0 total tests:** 14 nuevos (mucho menor; web es manual eval-heavy)

---

## CAPÍTULO 3 — Test totals

| Sprint | New tests | Cumulative |
|---|---|---|
| Pre-v14.2 baseline | — | 622 |
| v14.2 Token Hunter | +45 | 667 |
| v14.3 Meta-Prompter | +38 | 705 |
| v14.4 Perfect Memory | +40 | 745 |
| v15.0 ULTRON.io | +14 | 759 |
| **Total nuevos** | **+137** | **759** |

---

## CAPÍTULO 4 — Cleanup checklists

### Cleanup post-fase (cada DEV → TEST → QA → REV → RESOLVED)

```markdown
- [ ] git status: solo cambios esperados
- [ ] uv run pytest tests/: green
- [ ] doctor.py: 0 BLOCKING
- [ ] tmp residuals limpiados (~/.ultron/.tmp/_*.py removidos)
- [ ] commit-msg.txt removido tras commit
- [ ] memoria L0 (context.md) regenerada si MEMORY.md tocado
```

### Cleanup post-sprint (al RESOLVED final)

```markdown
- [ ] Branch sprint/v14.X-* mergeada a main vía --no-ff
- [ ] Tag v14.X.0 creado y pushed
- [ ] Changelog actualizado con tabla pre/post
- [ ] MEMORY.md actualizado con nuevos numbers
- [ ] CAPABILITIES doc actualizado
- [ ] sprint-metrics post snapshot persisted
- [ ] All risks marked open/mitigated/accepted
- [ ] Decision log updated
- [ ] backups antiguos compactados (>30 días → archive)
- [ ] news/ untracked si aplica → política decidida
```

### Cleanup catastrófico (sólo si algo se rompe)

Si un sprint queda en estado mixto (algunos commits, no merge, no tag):

```powershell
# Rollback completo a último tag conocido
git checkout main
git reset --hard v14.1.1
# (NUNCA force-push si ya estaba en remote)

# Restaurar backups si manifest/provenance corruptos
Copy-Item ~/.ultron/backups/skills.manifest.pre-bulkpromote.yaml `
          ~/.ultron/skills.manifest.yaml -Force
```

---

## CAPÍTULO 5 — AI-Driven Daily Standup

Cada día de sprint, el orchestrator ejecuta este flow:

### Morning standup (5 min)

```
Read: ~/.ultron/.tmp/context.md       (overall state)
Read: ~/.ultron/MEMORY.md              (orientation)
Read: ~/.ultron/plans/2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md
      (sprint authoritative spec)
Read: ~/.ultron/plans/2026-05-09-MACRO-ops-manual.md
      (this file — execution detail)

Read: ~/.ultron/metrics/sprint-current-pre.json  (baseline)
Read: ~/.ultron/decisions.yaml                   (decisions so far)

Output: standup brief
  - Estado actual: phase X / sprint Y
  - Bloqueos: <list>
  - Próxima tarea: <single action>
  - Riesgo nuevo: <if any>
```

### Mid-day check (cada 2-3 fases completas)

```
Run: uv run pytest tests/ -q          (sanity)
Run: ultron deadwood --quiet          (deadwood not regressing)
Run: ultron doctor --quiet --json     (doctor not regressing)

If any degradation: pause + report to user
Else: continue next phase
```

### End-of-day wrap (5 min)

```
Snapshot metrics: sprint_metrics.py snapshot --phase mid
Update decision log if new decisions
Update risk register if new risks
Commit checkpoint if a phase completed today
Update pickup file if USER will resume tomorrow
```

---

## CAPÍTULO 6 — Plantillas de prompts especializados

### Prompt para fork "investigador" (research phase)

```
ROLE: Senior research engineer for ULTRON sprint <X>.

TOPIC: <specific research question from the sprint plan>

SOURCES TO QUERY (in priority order):
1. Official Anthropic docs (https://docs.anthropic.com/...)
2. Official project repos (https://github.com/anthropics/...)
3. Engineering blogs (Anthropic, OpenAI, Cohere)
4. Recent papers (2024+, NOT 2022 or older)
5. Hacker News top discussions
6. Reddit r/LocalLLaMA, r/ClaudeCode

QUESTIONS TO ANSWER:
<3-5 specific questions>

OUTPUT:
- Markdown report at ~/.ultron/audits/research-<topic>-<date>.md
- For each question: answer + evidence (URL + quote) + confidence
- Recommendations: 1-2 paragraphs at end with concrete actions

CONSTRAINTS:
- Cite primary sources, not random blog posts
- If sources contradict, note the disagreement
- Confidence levels: HIGH (multiple primary sources agree), MEDIUM
  (one source or community consensus), LOW (speculation)
- Don't recommend without evidence
- Token budget: ≤ 80k input
```

### Prompt para fork "implementor" con specs detalladas

```
ROLE: Implementor for ULTRON sprint <X>, phase <Y>.

SPEC FILE: ~/.ultron/plans/2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md
SECTION: PART <N> Phase <M>

FULL CONTEXT:
- Working dir: ~/.claude/skills/ultron
- Branch: sprint/v14.X-theme (already created)
- Previous phase artifacts: <if any>

DELIVERABLES:
1. Code changes following the spec exactly
2. NO commit yet
3. Smoke run: <specific command>
4. Brief notes on any deviation from spec

CONSTRAINTS:
- Match existing patterns (use Read+Grep on similar files first)
- No new top-level dependencies without justification
- Atomic writes for any disk write
- Backups before destructive ops
- Full type hints on public APIs
- Pytest fixtures should mirror tests/test_*.py existing style

TIME BUDGET: <X hours>

REPORT BACK with:
- Files changed (list)
- Smoke test result
- Test cases needed for Phase TEST (list)
- Any blocker preventing Phase TEST kickoff
```

### Prompt para fork "test engineer"

```
ROLE: Test engineer for ULTRON sprint <X> phase <Y>.

DEV DIFF: just landed. Files: <list>
SPEC: <section ref in macro plan>

ACCEPTANCE CRITERIA TO COVER (from spec):
<copy the bullet list from the spec section>

TEST CASES TO IMPLEMENT (from ops manual):
<copy the test enumeration from CAPÍTULO 2>

DELIVERABLES:
1. tests/test_<feature>.py (new) following pytest conventions
2. Run: uv run pytest tests/test_<feature>.py -v
3. Confirm: 100% pass + suite global no regresa
4. Coverage ≥ 80% over the diff

CONSTRAINTS:
- Use existing fixtures from tests/fixtures/ when applicable
- Tests must be deterministic (seed any randomness)
- Each test < 1s ideally
- Clear test names (describe what's being asserted)

REPORT BACK with:
- Tests count + names
- Coverage % over the new code
- Any case from the enumeration that you SKIPPED (and why)
```

### Prompt para fork "QA reviewer"

(ya existe en macro plan Anexo C — unchanged)

### Prompt para fork "documentor" (RESOLVED phase)

```
ROLE: Documentor closing ULTRON sprint <X>.

INPUTS:
- Sprint diff (commits a..b)
- Test results
- QA report
- Decision log entries from this sprint
- Risk register entries from this sprint

DELIVERABLES:
1. Changelog entry in references/changelog.md
2. MEMORY.md update if numbers changed
3. CAPABILITIES.md cross-check + update if applicable
4. Backup tag old MEMORY.md before update
5. Pickup file for next session

CONSTRAINTS:
- Follow v14.0.0 / v14.1.0 changelog style
- Numbers in MEMORY.md must match reality (verify with sprint metrics)
- Backups: ~/.ultron/backups/<file>.pre-v14.X.<date>

OUTPUT:
- List of files modified
- Diff summary for each
- Verification: re-read each updated file once to catch inconsistencies
```

---

## CAPÍTULO 7 — Daily progress tracker

Persistir en `~/.ultron/.tmp/sprint-progress.md`:

```markdown
# Sprint v14.X Progress — <date>

## Today's session
- Phase: <DEV/TEST/QA/REV/RESOLVED>
- Sub-phase: <e.g. v14.2 Phase 1.2>
- Hours: <H>
- Forks dispatched: <N>
- Forks completed: <M>
- Tests added: <K>

## Blockers
- <list> or "none"

## Decisions made today
- <list referencing decision_id>

## Risks raised today
- <list referencing risk_id>

## Next session start point
- <single concrete action: "Resume at v14.2 Phase 1.3 — implement
  the dispatcher fallback path">
```

---

## CAPÍTULO 8 — Sync entre humano y AI

### Cuándo el AI DEBE pausar y preguntar a USER

| Trigger | Action |
|---|---|
| Cambio que afecta `.claude.json` | Stop, ask |
| Cambio que afecta `~/.claude/settings.json` | Stop, ask |
| Decisión que cambia el plan autoritativo | Stop, ask |
| BLOCKING finding en QA | Stop, present + ask |
| 3+ HIGH findings en QA | Stop, present + ask |
| Test suite regresa | Stop, fix or ask |
| Doctor sube de 0 BLOCKING | Stop, fix or ask |
| Cambio destructivo sin backup | Stop, add backup |
| Operación de red (push, deploy) | Stop unless durably authorized |
| API key needed que no está en Credential Manager | Stop, ask |

### Cuándo el AI puede AVANZAR sin preguntar

| Situation | Action |
|---|---|
| Phase DEV passes smoke + diff < 1500 LOC | Avanza a TEST |
| Phase TEST passes coverage + suite green | Avanza a QA |
| Phase QA produces 0 BLOCKING + ≤3 HIGH | Avanza a REV (presenta a usuario) |
| Phase REV approved | Avanza a RESOLVED |
| Phase RESOLVED produces commit + changelog | Sprint phase done |

---

## CAPÍTULO 9 — Auto-recovery patterns

Si algo falla, el AI sigue estos patterns en orden:

### Pattern 1: Test suite regresa

```
1. Identify failing test (pytest -x)
2. Read the test + the code under test
3. Hypothesis: ¿qué cambió en el último diff?
4. Single-fix attempt: minimal change to pass test
5. If pass + suite green → continue
6. If still failing after 3 attempts → escalate to user
```

### Pattern 2: Doctor regression (BLOCKING)

```
1. doctor --json → identify the new BLOCKING finding
2. Check: is it caused by this sprint's changes?
   - If YES: revert the change, find alternative
   - If NO: investigate as separate issue, log to backlog
3. Re-run doctor → confirm 0 BLOCKING
4. Continue
```

### Pattern 3: Fork crashes

```
1. Read fork's last error
2. If transient (rate limit, network) → retry with same prompt
3. If structural (bad prompt, unclear spec) → re-prompt with clarification
4. If 3rd attempt fails → escalate
```

### Pattern 4: Sprint blocks on user input

```
1. Document what's needed in pickup file
2. Snapshot current state (metrics, branch, uncommitted)
3. Stop new work
4. Surface to user with: "blocked on <X>. To unblock: <action>."
```

---

## CAPÍTULO 10 — Definition of Done (DoD) por sprint

### v14.2 Token Hunter — DoD

```
- [ ] Token reduction ≥ 30% (target: 50%) measurable
- [ ] All 45 new tests pass
- [ ] Suite global green
- [ ] D22, D23, D24 detectors implemented
- [ ] Cache hit rate ≥ 60% measured over 24h
- [ ] No BLOCKING in QA
- [ ] User approved (REV)
- [ ] Commit + tag v14.2.0 + changelog entry
- [ ] MEMORY.md baselines updated
```

### v14.3 Meta-Prompter — DoD

```
- [ ] ≥ 5 prompts mejorados con A/B verificado
- [ ] All 38 new tests pass
- [ ] Suite global green
- [ ] Loop feedback funcional, no auto-apply
- [ ] Eval skill correlación humano ≥ 0.7
- [ ] TUI buttons work
- [ ] No BLOCKING in QA
- [ ] User approved (REV)
- [ ] Commit + tag v14.3.0 + changelog entry
```

### v14.4 Perfect Memory — DoD

```
- [ ] Qdrant integrated (Path A o B per USER decision)
- [ ] All 538 vault notes indexed
- [ ] All 40 new tests pass
- [ ] Recall@3 ≥ 0.8 over golden set
- [ ] Hybrid > FTS5-only en ≥ 70% pairwise
- [ ] Auto-recall in SessionStart funcional
- [ ] Dispatcher with embeddings ≥ regex baseline
- [ ] No BLOCKING in QA
- [ ] User approved (REV)
- [ ] Commit + tag v14.4.0 + changelog entry
```

### v15.0 ULTRON.io — DoD

```
- [ ] Live on production domain
- [ ] Lighthouse ≥ 90 across all 4 categories
- [ ] Mobile responsive at 375/768/1024/1440
- [ ] All 14 new tests pass
- [ ] Plausible analytics installed (privacy-first)
- [ ] Contact form works (test email arrives)
- [ ] 8 routes all 200 with correct content
- [ ] Manifesto reviewed by USER (final voice ok)
- [ ] No BLOCKING in QA
- [ ] User approved (REV)
- [ ] Tag v15.0.0 + announce
```

---

## CAPÍTULO 11 — Estado del documento

Este ops manual es companion del macro roadmap. Cualquier desviación
durante ejecución debe loggearse en el Decision Log de la macro plan
(PART VI), no aquí.

Si el ops manual queda desactualizado vs reality:
1. Audit gap explícitamente en Decision Log
2. Update este doc en un commit `docs: ops-manual sync`
3. No silently rewrite — preserve audit trail

— Ops manual v1, sprint v14.2-v15.0. Saved 2026-05-09.
