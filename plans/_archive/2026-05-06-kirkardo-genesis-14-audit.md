---
title: Kirkardo Genesis-14 Master Audit Plan
date: 2026-05-06
status: PLAN-ONLY (no execution authorized yet)
mode: HIGH
authors: Claude (Opus 4.7) + USER
schema_version: 1
---

# Kirkardo Genesis-14 — Master Audit Plan

> **Scope:** post-Genesis 14 deep audit of `~/.claude/skills/ultron/`, `~/.ultron/`, hooks pipeline, prompts, token-saving infrastructure, and documentation drift. Find every error, design fragment-level detection, propose execution roadmap. **Zero code changes** until user validates findings.

> **Trigger:** user-reported `ultron` PowerShell command parse error, plus broader concern that cockpit retains stale verbiage ("ask", "u" autoupdate sidebar, etc.) and doc drift after Genesis-14 rename.

> **Deliverables of THIS plan:**
> 1. Concrete error catalog (Section B)
> 2. Detection automation design — fragment-level (Section C)
> 3. Validation criteria per detector (Section D)
> 4. Execution roadmap, phased (Section E)
> 5. Sync-chain integration (Section F)

---

## A. Pre-flight: BLOCKING parse error

`scripts/cockpit/ultron.ps1` does not parse on PS5.1 because the file is UTF-8 **without BOM**. PS5.1 falls back to cp1252 and chokes on:

| Line | Glyph | Context |
|---|---|---|
| 38 | `—` `→` | Comment in `Invoke-Py` |
| 264 | `—` | News HTML hint message |
| 268-269 | `⚽` | Football edition labels |
| 270-271 | `🚀` | Space edition labels |
| 276 | `—` | News digest fallback message |
| 419 | `—` | `sync` comment |
| 465-469 | `·` | sync-all summary (3 times) |
| 954 | `—` | `index` alias comment |

The file's own line 493 already documents the constraint:
> `# NOTE: ASCII-only strings here -- ultron.ps1 has no UTF-8 BOM so PS5.1 parses it as cp1252; non-ASCII (em-dash etc.) breaks the parser.`

**Fix candidates (validate one):**
1. **Add UTF-8 BOM** (3 bytes EF BB BF) — preserves all Unicode glyphs, single-byte change. *Recommended.*
2. Strip non-ASCII to closest ASCII (`—` → `--`, `·` → `-`, `⚽🚀` → tags `[FB]`/`[SP]`) — preserves cp1252 contract.
3. Migrate to PS7 (which is UTF-8 by default) — biggest scope, breaks if user invokes via PS5.1.

> **Status:** task #1 holds this. Not auto-applied per user "nada de ejecución".

---

## B. Concrete error catalog (this exploration)

### B.1 Cockpit dispatch surface (`ultron.ps1`)

Switch cases identified: **51 top-level commands**.

**Stubbed-out / removed but still in dispatch + help:**

| Cmd | Dispatch line | Status | Help still mentions? |
|---|---|---|---|
| `auth` | 566 | `removed in v12.5`, exit 1 | Yes (line 72) |
| `usage` | 673 | `removed in v12.5`, exit 1 | Yes (line 100) |
| `limits` | 876 | `removed in v12.5`, exit 1 | Yes (line 124) |
| `telemetry` | 1045 | `removed in v12.5`, exit 1 | Not in help (good) |
| `schedule list/edit/chat` | 382-388 | inline removed branches | Mentioned in nested help (370-373) but unreachable |

**Live commands that may be obsolete (need behavior probe):**

| Cmd | Concern |
|---|---|
| `ask` (line 663) | Help line 91 says "v11.1" — still valid? `quick_ask.py` exists. Probe required. |
| `audit list/run` (line 701) | Help line 101-103 says Kirkardo via `persona_audit.py`. Live but TUI moved to dedicated buttons. Two entry points — consolidate or document. |
| `notes` (line 550) | `project_notes.py` exists. Probe behavior. |
| `runstate` (line 601) | Renamed from `status` (comment line 602). Verify TUI/help both use new name. |
| `manifest` (top-level, line 394) | Duplicates `skills manifest`. Help (line 80 region absent). Aliasing — keep or unify. |

### B.2 TUI surface (`tui.py`, 2628 lines)

- **22 button handlers** (`if/elif bid ==`) in dispatch loop
- **37 `id="..."`** declarations on widgets
- **Gap:** 37 button ids vs 22 handlers — not all handlers visible in regex; possible orphan ids OR consolidated handlers
- **Sidebar items not yet audited** — user mentioned old "u" (autoupdate) and "ask" buttons. Need full button inventory.

### B.3 Clipboard prompts inventory (the user's complaint)

| Zone | Location | Lines | Quality concern |
|---|---|---|---|
| News Tech | tui.py:1158-1182 | 25 | Inline string. No ROLE / OUTPUT_SCHEMA structure. Mixes Spanish/English. Hardcoded date format. |
| News Football | tui.py:1189-1209 | 21 | Same shape as News Tech, partial duplication. |
| News Space | tui.py:1216-1236 | 21 | Same shape. **3-way duplication** — should template. |
| Skills sync-prompt | tui.py:2191-... (truncated read) | ~40 | Inline. Could be a template file. |
| Kirkardo audits 01-09 | `cockpit/tui/prompts/*.md` | **MISSING** | `Glob` returns empty. AUDIT_PROMPTS_DIR doesn't exist. **9 prompts unrooted** (lines 489-499 in tui.py). |
| Autoupdater | `auto_updater.py` `cmd_propose`, `cmd_full` | flagged "LEGACY — not surfaced in TUI (v12.4: Kirkardo clipboard prompts only)" | TUI uses Kirkardo prompts but those don't exist on disk. **Loop broken.** |
| Health | `health.py` | none | No clipboard prompt. User asked about this — confirm if needed. |
| News HTML generator standalone | `news_html_generator.py:416-444` | 30 | `copy_to_clipboard` works. Prompt construction is in same file. |

**Bug (BLOCKING):** Kirkardo TUI buttons load prompts from `COCKPIT_DIR / "tui" / "prompts" / "01-memoria.md"` etc. The directory does not exist. Either (a) the buttons silently no-op, or (b) `_load_audit_prompt` returns `None` and downstream renders an error. To verify in execution phase.

### B.4 Documentation drift

**`CLAUDE.md` (project, `skills/ultron/CLAUDE.md`) declares:**
- 5 power modes ✓
- intent-dispatcher with 0.58 ms p95 ✓
- 11 prompt-injection rules ✓
- 9 hooks ✗ (settings.json shows 11 hook entries, including `skill_integrity_check.py` for Skill matcher and `session-cleanup.ps1` — both undocumented)
- Memory L0/L1/L2/L3 ✓
- Cockpit "central command, ~50 subcommands" — actual count = **51 ✓**

**`changelog.md` v14.0.0 entry:**
- Lists 392 skills (22 wellknown + 370 auto-discovered) — verify against `manifest.cache.json`
- Says brain index has 626 notes / ~10K chunks. context.md (line 24) says 654. **Drift: +28 notes since changelog was written.**

**`health.py:EXPECTED_SCRIPTS` (line 44-64):**
- Lists ~22 scripts. Actual cockpit dir has ~80 `.py` files.
- Missing from list (sample): `agent_manifest.py`, `audit_silent_exec.py`, `background_tasks.py`, `changelog_registry.py`, `dispatcher_audit.py`, `intent_dispatcher.py`, `route_quality.py`, `route_quality_aggregator.py`, `routing_decide.py`, `secrets_manager.py`, `session_replay.py`, `setup_github_token.py`, `shadow_review.py`, `skill_finder.py`, `skill_graph.py`, `skill_summarizer.py`, `hook_input_validator.py`, `mcp_allowlist.py`, `mcp_broker.py`, `mcp_creator.py`, `secrets_scanner.py`, `silent_exec.py`, `skill_provenance.py`, `settings_integrity.py`, `path_traversal_guard.py`.
- This means `ultron health` underreports coverage.

### B.5 Deprecated-marker density (current state)

`grep -i "removed in v|DEPRECATED|LEGACY|TODO.*remove|_OLD\b|_DEAD\b"` across cockpit:

| File | Hits | Notes |
|---|---|---|
| `skill_manifest.py` | 65 | Highest. Likely many in docstrings about v12.4 compat. Audit needed. |
| `personas_ssot.py` | 18 | Suspicious volume — possible dead persona definitions. |
| `ultron.ps1` | 15 | Five stub branches + comments. |
| `doctor.py` | 14 | Mostly explanatory; likely fine. |
| `registry_sync.py` | 9 | Audit. |
| `cleanup_inventory.py` | 6 | This file IS the cleanup detector. Self-references. |
| `auto_updater.py` | 5 | Two explicit `# LEGACY — not surfaced in TUI`. |
| `tui.py` | 5 | Audit. |
| `secrets_manager.py` | 3 | Audit. |
| Other 9 files | 2 each | Spot-check. |

Total: **155 occurrences in 18 files**. Not all are dead — many are docstrings explaining version history. The detector must distinguish.

### B.6 Hooks pipeline reality

`~/.claude/settings.json` registers:

| Event | Matcher | Script | Status |
|---|---|---|---|
| SessionStart | * | `~/.ultron/hooks/session-init.ps1` | exists ✓ |
| PreToolUse | `Read\|Glob\|Grep\|WebFetch\|WebSearch` | `auto-approve-readonly.py` | exists ✓ |
| PreToolUse | `Bash` | `block-dangerous-bash.py` | exists ✓ |
| PreToolUse | `mcp__.*` | `mcp-resilience.py` | exists ✓ |
| PreToolUse | `Skill` | `skill_integrity_check.py` | exists ✓, **undocumented** |
| PostToolUse | `Skill\|Agent` | `routing-telemetry.py` | exists ✓ |
| PostToolUse | `Read` | `track-knowledge-reads.py` | exists ✓ |
| Stop | * | `session-log.py` | exists ✓ |
| Stop | * | `stop-memory-sync.ps1` | exists ✓ |
| Stop | * | `session-cleanup.ps1` | exists ✓, **undocumented** |
| UserPromptSubmit | * | `mode-trigger.py` | exists ✓ |
| UserPromptSubmit | * | `intent-dispatcher.py` | exists ✓ |

Hooks dir contents (verified):
- `~/.claude/skills/ultron/hooks/` → 9 Python hooks + README.md ✓
- `~/.ultron/hooks/` → `session-init.ps1`, `stop-memory-sync.ps1`, `session-cleanup.ps1`, `push-async.log`, `stop-memory-sync.log` ✓

**Concerns:**
- 11 hooks wired, CLAUDE.md says "9 hooks". Doc drift.
- `skill_integrity_check.py` is post-Genesis. Not in changelog or capabilities reference.
- No tests visible for the new hooks.
- `session-cleanup.ps1` purpose undocumented.
- `mode-trigger.py` and `intent-dispatcher.py` both fire on UserPromptSubmit — order matters. Verify ordering and idempotency.

### B.7 News folder (untracked)

`scripts/cockpit/news/` exists, contains today's `newsletter-2026-05-06-space.html`, untracked in git. Per `.gitignore` policy not yet checked.

### B.8 Skill listing truncation (NEW — surfaced 2026-05-07)

**Symptom (live in current session):**
```
Skill listing will be truncated
434 descriptions dropped (full descriptions kept for most-used skills) (17%/1% of context)
Run /skills to disable some, or raise skillListingBudgetFraction (currently 1%) in settings.json
Opting in would cost ~34k tokens for skills every session and uses rate limits faster
```

**Root cause:** Total registered skills now exceeds the harness budget. With `skillListingBudgetFraction = 1%` (default), only ~17% of skills get full descriptions in the system prompt — the remaining 434 are present by name only, so the model sees them as available but cannot reason about when to use them. Triggering by name still works; triggering by intent silently degrades.

**Inventory snapshot (2026-05-07):**
- MEMORY.md declares `skills:392`
- system-reminder enumerates ~520+ skill names (post-Genesis growth, includes plugin: prefixes, bundle skills like `superpowers:*`, `agent-skills:*`, `pr-review-toolkit:*`, `commit-commands:*`, plus 17 ULTRON personas)
- Truncation hits at ~17% coverage → ~88 skills get full descriptions, ~434 skills are name-only

**Impact tiers:**
| Tier | Examples | Effect |
|---|---|---|
| TIER-1 (always wanted) | ulton, terry-davis, alfred, einstein, warren, novalbos, don-claudio, pana, tio-gilito, mike-tyson, tolkien, kirkardo (repo-evaluator), manolo-lama, jordan-belfort, shannon, obliteratus | MUST stay full-described |
| TIER-2 (project-active) | claude-api, supabase, supabase-postgres, mcp-builder, frontend-design, debugging skills, ue5-dev, android-kotlin, nextjs-developer | Should stay full when relevant project is active |
| TIER-3 (archive) | language-pro skills not in active stack, niche academic skills (astropy, biopython, etc.), unused vendor SDKs | Candidates for `/skills disable` |

**Trade-off matrix:**
| Action | Token cost / session | Pros | Cons |
|---|---|---|---|
| Stay at 1% (current) | 0 extra (truncated) | Cheap | 434 skills invisible to intent-router |
| Raise to 2% | +~34k | Full skill graph visible | Burns rate limits faster, slower start-of-session |
| Raise to 1.5% | +~17k (estimated) | Middle ground | Still partial truncation |
| `/skills disable` TIER-3 (~150 skills) | 0 extra, no truncation | Cheapest, surgical | Manual curation, drift over time |
| Hybrid: disable + raise to 1.5% | +~17k, no truncation | Safest | Maintenance overhead |

**Recommended (proposal):**
- `/skills disable` audit pass: TIER-3 candidates (vendor SDKs not in any active project, deep-academic toolkits, language-pro skills outside USER's stack). Target: drop ~150 skills.
- Keep `skillListingBudgetFraction = 1%` (don't burn 34k/session).
- Re-run skill_manifest.py after disable pass; verify no truncation warning.
- Add detector D18_SKILL_TRUNCATION to `doctor.py` that reads `skills` count vs harness fraction, warns when truncation would re-occur.

**Open questions (require user decision):**
- Q1: Which TIER-3 categories to disable? (academic toolkits / language-pro / vendor SDKs / something else)
- Q2: Acceptable to lose name-level discoverability for disabled skills? (re-enable on demand via `/skills enable <name>`)
- Q3: Increase budget temporarily during exploration sessions, drop back to 1% for routine work?

**Related drift:** MEMORY.md says `skills:392`. The system-reminder shows ~520+ entries (Genesis growth or namespace inflation from `plugin:skill` and `bundle:skill` forms). Counter must be reconciled — see Phase 5.

---

## C. Detection automation design — fragment-level

User requirement: *"no solo archivos deprecados, sino partes interiores de archivos deprecados mediante keys, o lo que sea, valida tu la mejor solucion"*.

Existing tooling:
- `cleanup_inventory.py` — **file-level only**, classifies by name/extension. Misses fragments.
- `doctor.py` — config-level + filesystem invariants. Misses fragments.
- No dedicated fragment scanner.

### C.1 Approach evaluation

| Strategy | Pros | Cons | Fit |
|---|---|---|---|
| **A. Sentinel markers (RFC)** | Explicit, grep-able, multi-language, machine + human readable | Requires manual annotation upfront | ★★★★★ for new code |
| **B. Heuristic regex** | Auto-classify, zero manual work | False positives in docstrings | ★★★★ for legacy |
| **C. Cross-reference graph** | Catches structural drift (case → script, button → handler) | Per-language parsers needed | ★★★★★ for dispatch |
| **D. Behavioral smoke** | Real evidence, zero false positives | Side effects, slow | ★★★ as final gate |
| **E. AST dead-code** | Catches unused functions, imports | Heavy, language-specific | ★★ optional |

**Recommended:** combine A + B + C + D in a single tool `deadwood_scanner.py`. AST-based (E) deferred until the simpler stack is in place.

### C.2 Sentinel marker spec (proposal)

```
# @ULTRON-DEPRECATED:14.0.0
#   reason: auth_vault.py removed in v12.5 cockpit reorg
#   replaced-by: Windows Credential Manager (cmdkey)
#   remove-after: 2026-08-01
#   owner: USER
"auth" {
    Write-Host "ultron auth: removed in v12.5" -ForegroundColor Yellow
    exit 1
}
# @ULTRON-DEPRECATED-END
```

Rules:
- Single-line comment prefix per language (`#` in PS / Python / YAML, `//` in JS, `--` in SQL)
- Open marker: `@ULTRON-DEPRECATED:<version>` followed by k/v fields
- Close marker: `@ULTRON-DEPRECATED-END`
- Required fields: `reason`, `replaced-by`, `remove-after` (ISO date)
- Optional: `owner`, `severity` (`info|warn|blocking`)
- Block content between markers is the deprecated fragment — scanner reports its line range.
- Once `remove-after < today`: scanner promotes severity → `blocking`.

### C.3 Scanner architecture (`deadwood_scanner.py`)

Path: `~/.claude/skills/ultron/scripts/cockpit/deadwood_scanner.py`.

```
Stage 1 — Marker scan
  • Walk ~/.claude/skills/ultron, ~/.ultron, ~/.ultron-vault
  • Skip cache dirs (__pycache__, .git, .venv, node_modules)
  • Multi-language regex for sentinel start/end pairs
  • Validate field presence + remove-after parsing
  • Emit: list[DeprecatedBlock] with file, line range, version, severity

Stage 2 — Heuristic scan
  • Regex patterns (compiled once):
    - r"(?i)removed in v\d+\.\d+(\.\d+)?"
    - r"\bDEPRECATED\b(?!.*INFO)"        # excludes "DEPRECATED INFO" header
    - r"\bLEGACY\b\s*[—-]"
    - r"^\s*#\s*TODO.*\b(remove|delete|drop)\b"
    - r"\b_(OLD|DEAD|UNUSED)\b"
  • Per-line classification
  • Confidence: HIGH (sentinel) / MED (regex) / LOW (single-word match)
  • Suppress matches inside docstrings (heuristic: triple-quoted span)

Stage 3 — Cross-reference graph
  • Parse ultron.ps1: switch cases via regex `^\s*"(\w[\w-]*)"\s*\{`
  • Parse Show-Help: extract command names from Write-Host strings
  • Parse settings.json: hook script paths
  • Parse tui.py: button ids and handlers (regex-based, no full AST)
  • Parse skill_manifest cache: declared skills vs disk
  • Parse health.py:EXPECTED_SCRIPTS vs disk
  • Detect:
    - SwitchCase → script not on disk
    - HelpEntry → no SwitchCase
    - SwitchCase → not in HelpEntries
    - HookPath → file missing
    - ButtonId → no handler / handler → no button
    - ManifestSkill → no SKILL.md / SKILL.md → no manifest entry
    - EXPECTED_SCRIPTS gap (declared vs actual)

Stage 4 — Behavioral smoke (opt-in `--smoke`)
  • Run `powershell -File ultron.ps1 <cmd> --help` for each switch case
  • Capture exit + stderr regex `removed in v\d`
  • Tag commands as STUB-CONFIRMED, LIVE, or ERROR

Stage 5 — Report
  • Markdown to ~/.ultron/audits/deadwood-<DATE>.md
  • Sections: BLOCKING, WARN, INFO + per-file detail
  • JSON dump to ~/.ultron/.tmp/deadwood.json (consumed by doctor.py)
  • Exit codes: 0 clean, 1 warn, 2 blocking (matches doctor convention)

Stage 6 — Doctor integration
  • New detector D17_DEADWOOD in doctor.py
  • Reads ~/.ultron/.tmp/deadwood.json (≤24h freshness)
  • Surfaces top 5 blocking findings
  • `ultron doctor --fix` can offer "delete sentinel block" interactively
```

Estimated implementation: **~600 LOC pure stdlib** (no PyYAML hard dep), patterned after `cleanup_inventory.py` + `doctor.py`.

### C.4 Cross-reference table (sample, what scanner WOULD output)

Run mentally for the current codebase:

| Edge | Source | Target | Status |
|---|---|---|---|
| switch case `auth` | ultron.ps1:566 | (no script — pure stub) | STUB ✓ explicit |
| switch case `usage` | ultron.ps1:673 | (no script — pure stub) | STUB ✓ explicit |
| help entry `auth` | ultron.ps1:72 | switch case `auth` | LIVE-BUT-STUB → drop from help? |
| help entry `audit list/run` | ultron.ps1:101-103 | switch case `audit` (line 701) | LIVE ✓ |
| switch case `manifest` | ultron.ps1:394 | switch case `skills` `manifest` (line 771) | DUPLICATE — collapse? |
| TUI button `09-prompt-clipboard.md` | tui.py:498 | `cockpit/tui/prompts/09-...md` | **MISSING FILE** ✗ |
| EXPECTED_SCRIPTS | health.py:44-64 | actual disk | 25+ scripts uncovered |
| changelog `626 notes` | changelog.md:17 | brain_index actual count 654 | DRIFT (+28) |

---

## D. Validation criteria

For each detector to be accepted:

| Detector | Acceptance criterion |
|---|---|
| Sentinel scanner | Detect 100% of explicitly tagged blocks. Zero false positives. |
| Heuristic regex | ≥90% precision on hand-labeled corpus of 50 known-deprecated lines. ≤10% recall loss tolerated. |
| Cross-reference graph | Re-run before/after a no-op refactor → byte-identical output (idempotent). |
| Behavioral smoke | Each `removed in v\d` stub correctly classified STUB-CONFIRMED. Live cmd misclassification = blocking bug. |
| Doctor integration | `ultron doctor --json` output schema-validates with new D17 entries. |

Test corpus: hand-labeled 50-line gold-standard file under `~/.claude/skills/ultron/tests/fixtures/deadwood-corpus.md`.

---

## E. Execution roadmap (NOT EXECUTED — for review)

Phases ordered to fail fast on the smallest deliverable.

### Phase 0 — Unblock (15 min)
- [ ] Add UTF-8 BOM to `ultron.ps1` (Section A)
- [ ] Verify with `Tokenize-PSScript` and `ultron help`
- [ ] Commit: `fix(ultron): UTF-8 BOM unblocks PS5.1 parser`

### Phase 1 — Build the scanner (3-4 h)
- [ ] Author `cockpit/deadwood_scanner.py` per Section C.3
- [ ] Hand-label `tests/fixtures/deadwood-corpus.md`
- [ ] Pytest: `tests/test_deadwood_scanner.py`
- [ ] First run, capture baseline `~/.ultron/audits/deadwood-baseline.md`

### Phase 2 — Annotate known dead branches (1-2 h)
Add sentinels to confirmed stubs:
- `ultron.ps1` cases: `auth`, `usage`, `limits`, `telemetry`, `schedule list/edit/chat`
- `auto_updater.py` cmd_propose/cmd_full
- Help text entries that reference removed cmds

### Phase 3 — Doctor integration (30 min)
- [ ] Add `D17_DEADWOOD` to `doctor.py`
- [ ] Wire into `sync-all` step 8 (or replace step 7's smoke)
- [ ] Update `references/changelog.md` v14.1.0 entry

### Phase 4 — Clipboard prompts repair (2 h)
- [ ] Create `cockpit/tui/prompts/01-memoria.md` … `09-prompt-clipboard.md` (9 files, ~500 tokens each)
- [ ] Refactor news prompts (3) into shared template `cockpit/templates/newsletter.md.tmpl`
- [ ] Re-shape every clipboard prompt to ROLE / INPUTS / OUTPUT / CONSTRAINTS
- [ ] Fix `_load_audit_prompt` fallback (currently returns None silently)

### Phase 5 — Doc drift (1 h)
- [ ] `health.py:EXPECTED_SCRIPTS` regen from disk + curated allowlist
- [ ] `CLAUDE.md` (project) hooks count → 11
- [ ] `references/changelog.md` add entry for `skill_integrity_check`, `session-cleanup`
- [ ] `ULTRON-GENESIS-CAPABILITIES.md` cross-check (out of scope of this plan, separate doc audit)

### Phase 6 — Token-saving verification (30 min → revised 1 h)
- [ ] Measure intent-dispatcher p95 on last 24h `routing.jsonl`
- [ ] Verify auto-approve-readonly fires (count entries in session log)
- [ ] Brain index: `time uv run python brain_index.py query test --top 3` should return < 50 ms
- [ ] L0 `context.md` token count: `wc -w ~/.ultron/.tmp/context.md` ≤ 400 (currently ~280, fine)
- [ ] **NEW (B.8):** Skill listing truncation audit
  - Inventory current skill count by namespace (root, plugin:, bundle:)
  - Build TIER-3 disable candidate list
  - Run `/skills disable` for approved candidates
  - Re-verify no truncation warning in next session
  - Author detector `D18_SKILL_TRUNCATION` in `doctor.py`
  - Reconcile MEMORY.md `skills:392` counter with actual harness count

### Phase 7 — Smoke (30 min)
- [ ] `deadwood_scanner.py --smoke` against full surface
- [ ] `ultron doctor` → expect WARN at most
- [ ] `ultron sync-all` → expect green
- [ ] Final commit `feat(genesis-14.1): deadwood scanner + drift fixes`

**Total estimated effort:** 8-10 h. Spread across 2-3 sessions.

---

## F. Sync-chain integration

Once the scanner is live, weave it into existing pipelines so detection stays current without manual runs:

1. **`sync-all` step 8** — append `deadwood_scanner --quiet` after `doctor --quiet`. ≤5s typical.
2. **Stop hook (HIGH+ only)** — run `deadwood_scanner --quiet --json`, append delta to `alerts.jsonl` if NEW blocking findings.
3. **Weekly auto-doctor** — full `--smoke` run, output report to `audits/deadwood-weekly-<date>.md`.
4. **CI guardrail** — pre-commit hook in skill repo: block commit if it adds new lines that match heuristics without a sentinel.

Telemetry: `~/.ultron/.tmp/deadwood-history.jsonl`, append-only, atomic. Used to track regression (count over time).

---

## G. Decisions log (2026-05-07)

| Question | Decision | Implication |
|---|---|---|
| BOM fix timing | **Park with rest of plan** | `ultron` PS command stays broken until execution session. Phase 0 must run before any other phase. |
| Sentinel marker syntax | **Defer to implementation time** | Scanner author chooses C.2 vs JSDoc-style vs hybrid based on language coverage at build time. |
| Phase 4 scope | **EXPAND: all clipboard prompts across cockpit** | Not just the 9 Kirkardo. Inventory must cover: News (3), Health (currently none, design needed), MCP, Kirkardo (9), Scheduler, Skills sync, Autoupdate, plus any clipboard launcher in TUI. Estimated effort revised: **5-7 h** (was 2 h). New sub-task: full grep for `Set-Clipboard|pyperclip|launch_with_prompt` to enumerate every prompt site before authoring. |
| Smoke runner | **No restrictions — full fingerprint authorized** | Stage 4 of scanner can invoke every dispatch case including side-effecting ones. No blocklist needed. |
| Doc drift policy | **(unanswered — defer to Phase 5)** | Default: regen from disk + curated allowlist hybrid. Decide at execution time. |
| Skill listing budget (B.8) | **(unanswered — pending user decision Q1/Q2/Q3)** | Default proposal: disable ~150 TIER-3 + keep 1% fraction. Locked in Phase 6. |
| MCP gap-fill (Section I) | **(pending D-MCP-1/2/3)** | Default install order: GitHub → Context7 → KG-Memory + Qdrant → Firecrawl → image-gen. Each needs `mcp_allowlist.py` whitelist + `mcp_health_check.py` probe before adoption. |

### Phase 4 — REVISED scope

Cover every clipboard prompt site, not only Kirkardo. Audit pass before authoring:

```
grep -rEn "Set-Clipboard|pyperclip|launch_with_prompt|copy_to_clipboard" \
  ~/.claude/skills/ultron/scripts/cockpit/
```

Expected sites (from current exploration):
- `tui.py` — News × 3, Skills sync, Kirkardo × 9, possibly more buttons in autoupdate/scheduler view
- `news_html_generator.py` — newsletter generator standalone
- `auto_updater.py` — Kirkardo trigger
- `persona_audit.py` — possibly clipboard fallback
- `skill_manifest.py` — sync-prompt
- `mcp_creator.py` — MCP scaffold prompt
- (search will surface the rest)

Each prompt rewritten to ROLE / INPUTS / OUTPUT / CONSTRAINTS.

For sites that don't have a prompt yet (e.g. `health.py` has none — user flagged it), design from scratch.

---

## H. Appendix — files inventoried

- Read: `ultron.ps1` (1126 lines), `health.py` (head 80), `cleanup_inventory.py` (full 238), `doctor.py` (head 100), `tui.py` (sections 485-540, 1110-1240, 2160-2210), `~/.claude/settings.json` (full), `references/changelog.md` (head 60), `~/.ultron/.tmp/context.md` (full)
- Globbed: `scripts/cockpit/tui/**/*.md` (empty), `scripts/cockpit/**/prompts/**/*.md` (empty)
- Grepped: deprecated markers (155 hits / 18 files), switch cases (51), TUI button ids (37), TUI handlers (22), Show-Help Write-Host lines (221)

---

## I. MCP exploration (2026-05-07)

> Cutoff: research conducted 2026-05-07. Already-connected MCPs (Figma, Supabase, Gmail, Google Calendar/Drive, Notion, Spotify, Tripadvisor, Trivago, Booking.com, Kiwi.com, Uber Eats, Vercel, Lastminute, Railway, Playwright, Gemini-degraded, claude-in-chrome) excluded from candidate set.

### I.1 Gap-fill MCPs for ULTRON

| MCP | Categoría | Cubre gap | Fuente | Install | Riesgo |
|---|---|---|---|---|---|
| GitHub MCP (official) | Git/Repos | Terry Davis: PRs, issues, repo CRUD, code search a nivel GitHub (no en local) | [github/github-mcp-server](https://github.com/github/github-mcp-server) | Go binary / hosted remote | low |
| Git MCP (Anthropic ref) | Git ops local | Operaciones git locales (status/diff/commit/log/checkout). Complemento a GitHub MCP | [modelcontextprotocol/servers/src/git](https://github.com/modelcontextprotocol/servers/tree/main/src/git) | `uvx mcp-server-git` | low (pin ≥2025.12.18 — 3 CVEs parcheadas) |
| Windows-MCP | Windows admin | Alfred: registry, shell PowerShell, processes, files. No hay MCP oficial Windows mejor | [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | `claude mcp add windows-mcp ... powershell.exe` | med (single-maintainer, comunidad — sandbox o confirmaciones obligatorias) |
| Qdrant MCP (official) | Vector store | Memoria semántica para ULTRON brain (complemento a SQLite FTS5 — embeddings reales para búsqueda conceptual) | [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) | `uvx mcp-server-qdrant` o Docker local | low |
| Knowledge Graph Memory (Anthropic) | Memoria persistente | Grafo entidad-relación cross-session — plug directo para L2 de ULTRON sin reescribir vault | [modelcontextprotocol/servers (memory)](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | `npx @modelcontextprotocol/server-memory` | low |
| Firecrawl MCP | Web scraping | Anti-bot + JS render + extract estructurado. Alfred/Einstein: lo que Playwright no hace fácil | [firecrawl/firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server) | `npx firecrawl-mcp` | med (API key paid, no self-host gratis full features) |
| image-gen-mcp (multi-model) | Image gen | Sustituto a Gemini-degraded para imagen: Imagen-4 + GPT-Image + DALL-E vía un MCP | [lansespirit/image-gen-mcp](https://github.com/lansespirit/image-gen-mcp) | npm/Docker, requiere OpenAI/Gemini API keys | med (community, no oficial) |
| Filesystem MCP (Anthropic ref) | FS sandbox | Alfred: roots-based access controlado. Más seguro que dejar Bash libre | [modelcontextprotocol/servers (filesystem)](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | `npx @modelcontextprotocol/server-filesystem` | low (parcheado tras CVE-2025-53109/53110 — verificar versión) |

**Justificaciones cortas:**
- *GitHub MCP (official):* La ausencia de operación PR/issue desde Claude Code es el gap más obvio dado el flujo Terry Davis + Kirkardo de evaluar repos.
- *Git MCP (Anthropic ref):* No-push by design (seguro); cubre el 80% de tareas git locales sin exposición de credenciales.
- *Windows-MCP:* Único candidato real para registry/services en Win11; auditar antes de dar permisos elevados a Alfred.
- *Qdrant MCP:* FTS5 hace lexical bien, pero "buscar notas con concepto X aunque uses sinónimos" pide embeddings.
- *Knowledge Graph Memory:* Aporta entidades/aristas que el vault markdown no estructura nativamente.
- *Firecrawl:* Einstein necesita extraer papers detrás de Cloudflare; Playwright no resuelve anti-bot.
- *image-gen-mcp:* Mientras Gemini está degraded, este MCP da redundancia multi-proveedor en una sola interfaz.
- *Filesystem (Anthropic):* Convierte llamadas Bash a operaciones filesystem auditables; reduce superficie de ataque vs `rm` libre.

### I.2 General-utility MCPs (high signal)

| MCP | Para qué sirve | Por qué es notable | Fuente |
|---|---|---|---|
| Context7 | Docs actualizados de 9000+ libs en contexto | Resuelve "Claude usa API obsoleta" para libs cambiantes (Next.js, Supabase, etc.) | [upstash/context7](https://github.com/upstash/context7) |
| Sequential Thinking | Razonamiento estructurado paso-a-paso | MCP oficial reference, gratis, mejora tareas multi-step sin coste de API | [modelcontextprotocol/servers (sequentialthinking)](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) |
| Fetch (Anthropic ref) | URL → markdown chunked | Reemplaza WebFetch propio con caché y `start_index` para páginas largas | [modelcontextprotocol/servers (fetch)](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) |
| Brave Search MCP | Búsqueda web con índice independiente | Plan gratis decente, no Google-dependiente | [Brave Search API](https://brave.com/search/api/) |
| Tavily MCP | Search optimizado para agentes | Diseñado específicamente para LLMs; mejor relevancia que search genérico | [tavily.com](https://tavily.com/) |
| Exa MCP | Semantic search ("WebWalker 81%") | Cuando no sabes términos exactos; complemento a Brave/Tavily | [exa.ai](https://exa.ai/) |
| Slack MCP (official) | Mensajes/canales/canvas Slack | GA con OAuth, Anthropic-partnered | [docs.slack.dev/ai/slack-mcp-server](https://docs.slack.dev/ai/slack-mcp-server/) |
| Linear MCP (official remote) | Issue tracking | Endpoint remoto oficial, no necesita API key local | [linear.app/changelog](https://linear.app/changelog) |
| Stripe MCP (official) | Subscripciones, invoices, customers | Oficial, security-controlled | [stripe.com/docs](https://docs.stripe.com/agents/mcp) |
| Sentry MCP | Error tracking + debugging instrumentado | 50M req/mes, observability sobre el propio MCP, oficial | [blog.sentry.io](https://blog.sentry.io/introducing-mcp-server-monitoring/) |

### I.3 MCP que NO recomiendo

- **Discord MCP (community):** No hay oficial; 5 forks fragmentados (2-134 tools). Esperar a oficial.
- **mcp-server-git <2025.12.18:** 3 CVEs (flag injection, path traversal). Solo versiones parcheadas.
- **Filesystem MCP sin actualizar:** EscapeRoute (CVE-2025-53109/53110) rompe sandbox. Verificar release post-julio 2025.
- **MCPs single-maintainer con <100 stars sin tests:** Riesgo supply-chain alto; `mcp_allowlist.py` debería bloquear por default.
- **"image-gen-mcp" forks no canonicalizados:** >10 implementaciones casi-idénticas; elegir solo una mantenida (lansespirit).

### I.4 Recomendación de instalación (orden)

1. **GitHub MCP (official)** — Cero coste, oficial, gap obvio. **Requiere:** PAT de GitHub.
2. **Context7** — Inmediato para stack moderno. **No requiere API key** (Upstash hosted, free tier).
3. **Knowledge Graph Memory + Qdrant MCP** *(par)* — A/B test sobre el vault. **Qdrant requiere:** Docker local o Qdrant Cloud (free tier).
4. **Firecrawl MCP** — Cuando aparezca primer caso real de scraping con anti-bot. **Requiere:** API key Firecrawl.
5. **image-gen-mcp** — Sustituto de Gemini para imagen, post-validación. **Requiere:** OpenAI y/o Google AI Studio API keys.

**Pre-instalación obligatoria:** verificar que `mcp_allowlist.py` permite los nuevos servers, y añadir `mcp_health_check.py` probes para cada uno antes de marcar como green.

### I.5 Decisión pendiente (require user input)

- D-MCP-1: ¿Instalar GitHub MCP en esta misma sesión tras Phase 0, o diferir?
- D-MCP-2: ¿Aceptar Windows-MCP con su nivel de riesgo (single-maintainer)? Si no, Alfred sigue dependiendo de PowerShell directo.
- D-MCP-3: Memoria semántica — ¿Qdrant local (Docker) o Qdrant Cloud free tier?

---

## J. 2026-05-08 Follow-up findings (post Genesis-14.1)

> **Trigger:** USER flags TUI con texto/comandos antiguos, sistema de News con alertas que se han quedado pocho, pide eliminar las ediciones de fútbol y espacio, profundizar la edición IA/Tech, y repasar que todo compile.

### J.1 Plan progress matrix (commits desde parking)

| Phase | Status | Commit |
|---|---|---|
| 0 — UTF-8 BOM | ✅ done | `9b91494` |
| 1 — deadwood scanner stages 1-3 | ✅ done | `ea294b6` |
| 2 — sentinels en stubs | ✅ done | `a22387d` |
| 3 — doctor D17 + sync-all | ✅ done | `c8c1682` |
| 4 — clipboard prompts (Kirkardo + news) | ✅ done | `5173017` |
| 4.5 — ULTRA mode + Phase 4.5 reshape | ✅ done | `501fa42` |
| 5 — doc drift fixes | ✅ done | `cded4e4` |
| 6 — token-saving + D18 truncation | ✅ done | `f57e4a1` |
| 7 — smoke + sprint complete | ✅ done | `171c994` |
| Code review backlog | ✅ done | `fe4df04` + `44f815b` |
| Polish (deadwood subcmd + docs) | ✅ done | `c4c8b9e` + `4d99589` |
| **D-MCP-1 (GitHub MCP)** | ✅ partial — `github-pat` MCP wired | `4d99589` |
| **D-MCP-2 (Windows-MCP)** | 🟡 pending decision | — |
| **D-MCP-3 (Qdrant local vs cloud)** | 🟡 pending decision | — |
| **B.8 Q1/Q2/Q3 (skill truncation curation)** | 🟡 D18 detector live; curation list pending | — |

### J.2 News system reduction (3 → 1 deepened)

**Surface inventory (verified 2026-05-08):**

| Layer | File | Lines | What needs removal |
|---|---|---|---|
| Newsletter editions config | `news_html_generator.py:NEWSLETTER_EDITIONS` | 490-557 | drop `football` + `space` keys |
| Newsletter CLI examples | `news_html_generator.py` | 14-23, 480-485 | drop `--section space` / `--section football` examples |
| TUI editions list | `tui.py:_render_news → _EDITIONS` | 1374-1378 | reduce to 1 entry (tech/AI) |
| TUI handlers | `tui.py:_do_create_football_newsletter` + `_do_create_space_newsletter` | 1429-1445 | delete both (handlers + bindings if any) |
| TUI button ids | `tui.py:1376-1377` | — | `news-create-football`, `news-create-space` button ids → remove from dispatch |
| PS digest status | `ultron.ps1:262-268` | — | drop football/space "edition status" lines (after BOM applied, glyphs render fine; just delete logic) |
| PS help text | `ultron.ps1:80` (`news [new|create]`) | — | keep but verify wording |
| Stray HTMLs in repo | `scripts/cockpit/news/newsletter-2026-05-06-space.html` + `newsletter-2026-05-08.html` | — | move/delete (see J.6) |

**Tech/AI deepening:**
- Current `tech` edition (lines 491-515 of `news_html_generator.py`) sources: arxiv, HuggingFace, TechCrunch, The Verge, Hacker News. `min_news: 15`.
- Rebrand label/header from "Tech/AI" → **"AI/Tech"** (or final name TBD — see DJ-2)
- Expand sources to cover both AI **and** general Tech (cloud platforms, security advisories, framework releases, dev tooling). Candidates: GitHub Blog, Cloudflare Blog, AWS What's New, MDN Blog, Mozilla Hacks, Vercel Blog, JetBrains releases, Microsoft DevBlogs, security advisories (CVE digest, GitHub Advisory DB), regulator announcements (FTC/EU AI Act).
- Raise `min_news: 15 → 20-25` (final number → DJ-3).
- Add subsections: **AI Research** · **AI Industry** · **Tech Platforms** · **Security/Regulation** · **Dev Tooling**.

### J.3 News alerts pipeline repair

**State (verified):**
- `~/.ultron/cockpit/news/ALERTS.md` exists on disk.
- Read by `tui.py:1271-1276` (count) + 1332-1342 (inline render).
- Format expected: `- ` line prefix per alert (regex hardcoded).
- No documented writer — likely populated by `news_html_generator.py` audit-flags step (`audit-flags-{date}.md`) but **that's a separate file**, not appended to ALERTS.md.

**Symptoms to disambiguate (require user input → DJ-4):**
- (a) Alertas viejas no se purgan (acumulación stale)
- (b) Alertas nuevas no se escriben (writer roto)
- (c) Formato drift — alertas existen pero parser no las matchea
- (d) Display fuera de lugar (sección que no se renderiza, o se renderiza con datos basura)
- (e) Confusión con `audit-flags-{date}.md` (otro fichero del pipeline)

**Repair stub (a aplicar tras DJ-4):**
- Define writer path único: `cockpit_base.py:NEWS_ALERTS` ya es SSOT. Cualquier appender debe usarlo.
- Añadir TTL: alertas >7 días se mueven a `news/ALERTS.archive.md` y se purgan del activo.
- Validar formato en write-time (regex `^- ` enforced).
- Surface en TUI: si `alerts_count == 0` no mostrar la sección (actualmente solo se muestra si hay alerts, ✓ ya correcto).

### J.4 TUI staleness sweep (broader than news)

**Method:** grep sistemático de strings de UI + comparar con dispatch real.

**Targets identificados (manual hasta ahora):**
| Sitio | Concern |
|---|---|
| `tui.py:1374-1387` _EDITIONS | 3 editions hardcoded — J.2 |
| `tui.py:1185` "[b]⌬ News[/b]" | Verify post-J.2 que el render no rompe si _EDITIONS queda con 1 |
| `tui.py:888` " 2 ⌬ News" sidebar | OK conceptualmente |
| `ultron.ps1:80` help "news [new|create]" | Wording: ¿`new` o `create` o solo `new`? |
| `ultron.ps1:262-273` Show-News status | Football/Space status post-J.2 cleanup |
| `tui.py:LAYER1_PERSONAS` (1461-1465) | 14 personas declaradas — verificar que coincide con disk + manifest |
| `tui.py:LAYER2_CATEGORIES` (1466-1489) | Curated set; comprobar que ninguna entry apunta a skill desinstalada |

**Systematic scan (a ejecutar en Phase 8d):**
```
grep -rEn "v1[0-3]\." scripts/cockpit/      # references to old versions
grep -rEn "ask\b|autoupdate|\bu\b" scripts/cockpit/tui.py
grep -rEn "Set-Clipboard|launch_with_prompt|copy_to_clipboard" scripts/cockpit/
```
Cualquier hit que mencione una key/comando ya removed-in-vX → candidato para sentinel o eliminación.

### J.5 Compilation gate (verify everything compiles)

**Targets, en orden:**

1. **PS5.1 parse:** `Get-Content -Raw ultron.ps1 | [scriptblock]::Create({...})` — must not throw. Tokenize check via existing `tools/check-ps-parse.ps1` if presente, sino inline.
2. **Python syntax:** `uv run python -m py_compile scripts/cockpit/tui.py scripts/cockpit/news_html_generator.py scripts/cockpit/cockpit_base.py scripts/cockpit/brain_config.py`.
3. **Doctor:** `ultron doctor --quiet` → exit 0 / 1 (warn allowed); 2 (blocking) = stop.
4. **Sync-all:** `ultron sync-all` → green (≤1 warn).
5. **TUI smoke:** launch `ultron tui`, navigate to News view, verify no exceptions in textual log.
6. **Deadwood scanner:** `ultron deadwood --quiet --json` → diff vs baseline; new BLOCKING = stop.
7. **Pytest** (si hay tests touchdown): `uv run pytest tests/test_tui_news.py tests/test_news_html_generator.py` (si existen — sino crear smoke tests mínimos).

### J.6 Stray files + working-tree cleanup

| Path | Issue | Action |
|---|---|---|
| `scripts/cockpit/news/newsletter-2026-05-06-space.html` | Generated to wrong CWD (debería estar en `~/.ultron/cockpit/news/`) | Move o delete; añadir `scripts/cockpit/news/` al `.gitignore` para evitar reincidencia |
| `scripts/cockpit/news/newsletter-2026-05-08.html` | Idem | Idem |
| `scripts/cockpit/brain_config.py` | 1 línea modificada (LF→CRLF aviso de git) | Revisar diff: si es trivial commit; si es accidental revert |

---

## K. Phase 8 — News reduction + compile gate sprint

> Ordered to fail fast. ETA: 2-3 h. **NO CODE CHANGES until DJ-1..DJ-4 resolved.**

### Phase 8a — Football/Space removal (45 min)
- [ ] `news_html_generator.py`: drop `football` + `space` keys del NEWSLETTER_EDITIONS dict.
- [ ] `news_html_generator.py`: drop CLI usage examples + argparser support para `--section space|football` (mantener `--section tech` como default y validar que no haya otros valores).
- [ ] `tui.py`: reduce `_EDITIONS` a 1 entry; delete `_do_create_football_newsletter` + `_do_create_space_newsletter` + sus button id handlers.
- [ ] `ultron.ps1:262-268`: drop football/space status messages dentro de Show-News.
- [ ] Mark archived (sentinel): wrap los handlers eliminados con `@ULTRON-DEPRECATED:14.2.0` si se prefiere soft-hide (vs hard delete). DJ-1 decide.

### Phase 8b — Tech/AI edition deepening (30 min)
- [ ] `news_html_generator.py`: rebrand label/header (DJ-2).
- [ ] Expand `sources` string + add subsections: AI Research / AI Industry / Tech Platforms / Security/Regulation / Dev Tooling.
- [ ] Raise `min_news` (DJ-3).
- [ ] Update `templates/newsletter.md.tmpl` si el cambio requiere nuevos placeholders.

### Phase 8c — Alerts pipeline repair (45 min, depende de DJ-4)
- [ ] Diagnose: leer ALERTS.md actual + tail audit-flags-*.md más recientes.
- [ ] Fix según síntoma confirmado (a/b/c/d/e).
- [ ] TTL: añadir purger a `~/.ultron/cockpit/news/` housekeeping (mover >7d a `ALERTS.archive.md`).
- [ ] Test: append fake alert → verify TUI render → wait → verify purge.

### Phase 8d — TUI staleness sweep (30 min)
- [ ] Run greps de J.4.
- [ ] Para cada hit: clasificar (eliminar / actualizar / dejar con sentinel).
- [ ] Verificar `LAYER1_PERSONAS` + `LAYER2_CATEGORIES` contra disk real.

### Phase 8e — Compile gate (15-20 min)
- [ ] Ejecutar checklist J.5 en orden 1→7.
- [ ] Cualquier fallo en pasos 1-3 → stop, reporta, no avanza a sync-all.
- [ ] Si todo verde: `ultron deadwood --quiet --json` → diff baseline.

### Phase 8f — Stray cleanup + commit (15 min)
- [ ] J.6 actions (mover/borrar HTMLs, añadir `.gitignore`).
- [ ] Decidir sobre `brain_config.py` working-tree change (DJ-5 si es no trivial).
- [ ] Commit: `feat(genesis-14.2): news reduction (3→1 AI/Tech) + alerts repair + TUI sweep`
- [ ] Update `references/changelog.md` con entrada v14.2.0.
- [ ] Update `MEMORY.md` parked plan pointer → status: COMPLETE.

---

## L. Decisions log (2026-05-08) — RESOLVED

| ID | Question | Decision | Implication |
|---|---|---|---|
| **DJ-1** | Football/Space code paths: hard delete o sentinel-soft-hide? | **Hard delete** | Eliminar handlers + edition configs + button ids + status lines. Sin sentinel. Si USER los quiere de vuelta en el futuro = reescritura. |
| **DJ-2** | Etiqueta final del newsletter superviviente | **Tech/AI (current)** | Mantener label como está; no rebrand. `tech` key en NEWSLETTER_EDITIONS sin tocar. Solo profundizar contenido. |
| **DJ-3** | Profundización scope | **All dimensions** — más fuentes, más artículos, menos repetición | Subir `min_news` (15→25), expandir `sources`, añadir subsections (AI Research / AI Industry / Tech Platforms / Security & Regulation / Dev Tooling), deeper article-level analysis, **mejorar dedup logic** (J.3.bis abajo). |
| **DJ-4** | Alertas pochas: síntoma | **(a) staleness — alertas viejas no se purgan + falta clear/TTL** | Phase 8c añade purger con TTL configurable + clear command. No es format drift ni writer roto; el pipeline funciona pero sin housekeeping. |
| **DJ-5** | `brain_config.py` working-tree change | Pendiente — inspect diff manual en Phase 8f | 1 línea LF→CRLF; probable que sea solo line-ending normalization. Decide al commit. |

### J.3.bis — Dedup mejorado (consecuencia de DJ-3)

`news_html_generator.py:170-180` ya tiene `_recent_urls()` para evitar repetir URLs entre newsletters recientes. **Mejoras a aplicar:**
- Aumentar ventana lookback (actual: scan reciente sin límite explícito → limitar/ampliar a últimos 7 días).
- Añadir dedup por **título normalizado** (no solo URL): muchas fuentes reescriben URLs pero misma noticia.
- Añadir dedup por **canonical domain + slug** para cubrir mirrors (techcrunch.com/2026/... vs techcrunch.com/?p=...).
- Surface en logs: `[dedup] dropped N items, kept M` para que el usuario vea el efecto.

### J.3.ter — Alerts TTL/clear system (consecuencia de DJ-4)

| Componente | Acción |
|---|---|
| `cockpit_base.py` | Añadir constante `NEWS_ALERTS_ARCHIVE = NEWS_DIR / "ALERTS.archive.md"` + `NEWS_ALERTS_TTL_DAYS = 7` |
| Nuevo `cockpit/news_alerts.py` | Funciones: `purge_stale(ttl_days)` · `clear_all()` · `archive_then_clear()` · `read_active()` con timestamp parsing |
| `ultron.ps1` | Subcomando `ultron news clear-alerts` (manual purge) |
| TUI | Botón "🧹 Clear stale alerts" en el header de sección 3b ALERTS |
| Stop hook (HIGH+) o sync-all step | Llamar `purge_stale()` automático tras cada digest run |
| Format ALERTS.md | Cada línea: `- [YYYY-MM-DD] message` (parser fall-back a sin-fecha = stale 0d) |

---

*End of plan. Updated 2026-05-08 with Section J (follow-up findings), K (Phase 8 sprint), L (DJ-1..5 decisions RESOLVED). Phase 8 ready to execute pending USER's go-ahead. Phase 0-7 confirmados aplicados via commits 9b91494→44f815b.*
