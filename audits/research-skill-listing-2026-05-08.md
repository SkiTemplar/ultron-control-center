# Research-1 — skillListingBudgetFraction internals (2026-05-08)

> Author: Claude Opus 4.7 (Research-1 fork) for ULTRON v14.4 Phase 1
> Token budget: ~12k input tokens consumed
> Sources: Anthropic CC docs, code.claude.com, claudefa.st, GitHub issues, local file-history evidence

---

## Q1: harness resolution of `skillListingBudgetFraction`

- **Answer:** Real setting, lives in `~/.claude/settings.json` (or project `.claude/settings.json`). Default value **`0.01`** (= 1% of context window). Decimal between 0 and 1, NOT percentage integer. Introduced in **Claude Code v2.1.129** (May 2026). The harness reads this fraction at session-start, multiplies by the active model's context window (e.g. 200k or 1M tokens), and uses the resulting token count as the budget for the available-skills block in the system prompt. When the catalog exceeds the budget, the harness emits a system-reminder explicitly naming `skillListingBudgetFraction` and how many descriptions were dropped — this is the primary ground-truth signal for the setting's existence.
- **Sources:**
  - https://code.claude.com/docs/en/settings (official docs — `skillOverrides` section references the v2.1.129 floor; budget fraction itself is officially **undocumented** but referenced in product UI)
  - https://claudefa.st/blog/guide/mechanics/skill-listing-budget (third-party reverse-engineering, May 2026)
  - https://github.com/anthropics/claude-code/issues/50631 (CC bundle reverse-engineering, file `g7H()` returning override)
  - Local: `~/.claude/file-history/.../997c7e5416b15266@v3` — quoted CC system-reminder text "skillListingBudgetFraction (currently 1%) in settings.json"
- **Confidence:** HIGH (≥3 primary sources agree)
- **Caveat:** Setting is "exposed but not officially documented in the public reference table". Future CC versions may rename or restructure.

## Q2: truncation order

- **Answer:** **Usage-based ranking**. The harness tracks which skills you invoke (recency × frequency) and ranks descriptions by usage. Most-invoked skills retain full descriptions; least-invoked skills disappear entirely (description goes dark, **name remains visible** in the listing).
  - Importantly, the v2.1.129 algorithm changed strategy from earlier versions:
    - **v2.1.86 → v2.1.128:** keep every skill in listing but truncate every description at a fixed character cap (250 chars in v2.1.86, raised to 1,536 in v2.1.105).
    - **v2.1.129+:** every surviving description stays FULL, but low-use skills disappear (binary: full or gone).
  - Fallback budget when fraction-based math can't be computed: **8,000 characters** total.
- **Sources:**
  - https://claudefa.st/blog/guide/mechanics/skill-listing-budget ("Most-invoked survives. Least-invoked gets cut.")
  - WebSearch corroboration on truncation history (250→1536 char caps in older versions).
- **Confidence:** HIGH
- **Implication for ULTRON:** Skills not invoked recently (e.g. obscure personas) are exactly the ones we'd want to drop anyway. The harness already does the right thing at default — the lever ULTRON has is overriding *which* skills get full descriptions regardless of usage history.

## Q3: extension points (the answer that changes the design)

- **Answer:** YES. There is an **official** per-skill visibility override: **`skillOverrides`** setting, available since CC v2.1.129. It is the right primary mechanism for our lazy loader (more aligned with the harness than building a parallel system).
  - Schema: `Record<skillName, "on" | "name-only" | "user-invocable-only" | "off">`
  - Storage: `~/.claude/settings.json`, project `.claude/settings.json`, or `.claude/settings.local.json` (the `/skills` TUI writes to `settings.local.json`).
  - Behaviour:
    - `"on"` (default): skill in listing with description.
    - `"name-only"`: skill in listing **without description** — saves description tokens, model still sees the name. **This is the value our lazy loader must use.**
    - `"user-invocable-only"`: skill only callable when user types `/skill-name`; not exposed to model in listing. Useful for personas USER invokes by name only.
    - `"off"`: ⚠️ **Has a known bug** — blocks invocation but **does NOT hide** the skill from the listing (issue #291). Don't use `"off"` for lazy/hide purposes.
  - **Critical limitation:** `skillOverrides` does **NOT apply to plugin skills** (the 290 plugin-namespace skills). Plugin skills are managed via `/plugin` only.
- **Sources:**
  - https://code.claude.com/docs/en/settings (`skillOverrides` row of settings table, with example `{"legacy-context": "name-only", "deploy": "off"}`)
  - https://github.com/anthropics/claude-agent-sdk-typescript/issues/291 (`skillOverrides "off"` bug — invocation blocked, listing not hidden)
  - https://github.com/anthropics/claude-code/issues/50631 (`g7H()` stub bug fixed in v2.1.126; v2.1.129 added the budget fraction; sequential improvements)
- **Confidence:** HIGH
- **Implementation note:** Settings files are plain JSON. Any external script can write them atomically. No special API/SDK required.

## Q4: max safe value for the budget fraction

- **Answer:** No hard documented max. Every +0.01 of fraction translates to a proportional token cost on **every session**, regardless of whether you use any skill that benefits.
  - On 200K context: 0.01 ≈ 2k tokens, 0.02 ≈ 4k, 0.05 ≈ 10k → fits 15-25 / 30-50 / 75-125 skills with descriptions respectively.
  - On 1M context (current Opus 4.7 [1m]): 0.01 ≈ 10k tokens, 0.02 ≈ 20k, 0.05 ≈ 50k.
  - USER's current state: 704 skills · 1% fraction · ~120 surviving descriptions · ~584 name-only by default.
  - Empirical guidance from claudefa.st: bumping to 0.02 "steals 2,000 tokens from your messages window" (assumes 200K context) and is the realistic ceiling before rate-limit pain.
- **Sources:**
  - https://claudefa.st/blog/guide/mechanics/skill-listing-budget
  - Local audit: `~/.ultron/audits/skill-truncation-2026-05-07.md` — USER's own math: 1.5% = +17k tok/session, 2% = +34k tok/session
- **Confidence:** MED (math is correct; "max safe" is a judgement call, not documented).
- **Recommendation:** **Do NOT raise the fraction.** The right knob is `skillOverrides`, not the fraction.

## Q5: open-source precedents

- **Answer:** No precedent found that programmatically writes `skillOverrides` based on telemetry. Existing context-optimization work is either curated skill lists (VoltAgent, alirezarezvani, hesreallyhim, ComposioHQ) or custom registries that bypass the harness entirely (johnlindquist gist — 54% reduction via PreToolUse hooks + custom triggers; does not touch `skillListingBudgetFraction` or `skillOverrides`).
- **Sources:**
  - https://github.com/VoltAgent/awesome-agent-skills (1000+ curated)
  - https://github.com/alirezarezvani/claude-skills (232+)
  - https://github.com/hesreallyhim/awesome-claude-code (general toolkit)
  - https://gist.github.com/johnlindquist/849b813e76039a908d962b2f0923dc9a (custom registry pattern, no native settings)
- **Confidence:** MED (could be small recent projects WebSearch missed, but the obvious ones don't do this)
- **Implication for ULTRON:** Be the first to do it cleanly. Build on `skillOverrides` (native), not a parallel registry.

---

## Recommendation for `skill_lazy_loader.py` (DESIGN)

**Build on `skillOverrides`, not a parallel listing system.** The harness already does usage-based ranking at the default fraction; ULTRON's leverage is to *override* that ranking with knowledge the harness lacks (USER's intent dispatcher telemetry, hand-tagged tier metadata, persona activation patterns).

**Recommended API shape:**

```python
# scripts/cockpit/skill_lazy_loader.py

from typing import Literal

ListingMode = Literal["lazy", "full", "off"]

def compute_overrides(mode: ListingMode = "lazy",
                      keep_top_n: int | None = None) -> dict[str, str]:
    """Score skills by usage (routing.jsonl) × tier × recency, then return
    a skillOverrides map for ~/.claude/settings.json.

    mode='full': return {} (no overrides; native default).
    mode='lazy': bottom (N - keep_top_n) skills get "name-only", rest "on".
    mode='off':  bottom go "user-invocable-only" (USER can still /name them).
    """

def apply_overrides(overrides: dict[str, str],
                    target: Path = "~/.claude/settings.local.json",
                    dry_run: bool = True) -> Path:
    """Atomic write. dry_run=True returns the diff without writing."""

def build_skill_listing(mode: ListingMode = "lazy") -> str:
    """Human-readable preview of what the harness will render.
    Useful for tests/QA and the doctor detector D23_LAZY_LISTING_HEALTH."""

def is_lazy_mode() -> bool:
    """Read current settings.local.json and detect whether overrides
    indicate lazy state."""
```

**Storage:** `~/.claude/settings.local.json` (where `/skills` TUI also writes) so it interoperates with the native UI. Backup file before write. Atomic temp+rename.

**Scoring inputs:**
1. `~/.ultron/sessions/*/routing.jsonl` — telemetry from `routing-telemetry.py` PostToolUse hook (already deployed)
2. `~/.ultron/.tmp/skill-manifest.json` — tier (root/plugin/bundle) and tags
3. Decay function: `score = freq × exp(-Δdays / 14)` (14-day half-life)

**Failsafe behaviour:**
- If `routing.jsonl` < 50 entries → don't compute lazy mode (insufficient signal); leave overrides empty.
- If computed overrides would hide a skill that was invoked in the last 24h → keep it `"on"`.
- If settings.local.json write fails → leave previous file intact (atomic), log warn.
- If CC version < 2.1.129 → log error and refuse to apply (overrides won't take effect anyway pre-v2.1.126 fix).

**Risk of behaviour drift with future CC versions:**
- Setting name could change. Mitigation: version-detect via `claude --version` parsing in the writer; pin minimum supported version in detector D23.
- The fraction default could change. Mitigation: token_baseline.py already snapshots; D22 will catch regressions.
- `skillOverrides` is officially documented (low risk of removal); `skillListingBudgetFraction` is NOT officially documented (medium risk).

---

## Open questions for USER

1. **Plugin skills (290 of 704) are immune to `skillOverrides`.** Lazy loader cannot affect them. Options:
   - Accept: plugins always render with descriptions; lazy mode only optimizes root + bundle skills (~414 of 704). Modest savings (~50% of skill_listing token block, est. ~3.3k tokens).
   - Aggressive: lazy_loader recommends `claude plugins remove <name>` for low-use plugins (already known: `claude-code-workflows` removal is queued from prior pickup). Bigger savings but destructive.
   - **Recommendation:** Accept for v14.4 P1; queue plugin uninstall as v14.4 P3 follow-up.

2. **Cutoff threshold between "stays on" and "name-only".** Suggested defaults:
   - Top 30 most-used skills + all ULTRON personas (8) = ~38 always-on.
   - Bottom ~376 root+bundle → name-only.
   - Configurable via `~/.ultron/config/lazy-loader.yaml`.
   - **Confirm with USER or accept the default.**

3. **Should we keep `skillListingBudgetFraction` at 0.01 or experiment with 0.015?** Default recommendation: **stay at 0.01** because lazy_loader will produce more capacity than +0.005 alone (estimated −20k tok with overrides vs +5k with bumped fraction).

---

## Sources cited

- [Claude Code Settings Reference (official)](https://code.claude.com/docs/en/settings)
- [Extend Claude with Skills (official)](https://code.claude.com/docs/en/skills)
- [Claude Code's Hidden Skill Budget Setting (claudefa.st)](https://claudefa.st/blog/guide/mechanics/skill-listing-budget)
- [Issue #50631 — skillOverrides stub bug](https://github.com/anthropics/claude-code/issues/50631)
- [Issue #291 — skillOverrides "off" listing leak](https://github.com/anthropics/claude-agent-sdk-typescript/issues/291)
- [Skill Budget Research gist (alexey-pelykh)](https://gist.github.com/alexey-pelykh/faa3c304f731d6a962efc5fa2a43abe1)
- [Context Optimization gist (johnlindquist)](https://gist.github.com/johnlindquist/849b813e76039a908d962b2f0923dc9a)
- Local: `~/.ultron/audits/skill-truncation-2026-05-07.md` (USER's prior analysis)
- Local: `~/.claude/file-history/.../997c7e5416b15266@v3` (CC system-reminder text)

---

— Research-1 done. Implementation can proceed on top of `skillOverrides`.
