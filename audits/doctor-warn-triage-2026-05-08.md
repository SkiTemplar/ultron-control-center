# Doctor Warn Triage — 2026-05-08

Source: `~/.ultron/.tmp/doctor-weekly.json` (174 total findings, 173 warn, 1 info, 0 blocking).

## Bucket counts

- **real_bug:** 0
- **actionable_cleanup:** 4 (collapses to ~50 individual findings)
- **waived_but_persistent:** 166 (the entire `security:skill_scan` bucket)
- **expected_noise:** 1 (mcp:gemini:degraded)
- **informational:** 2 (deadwood:warn:summary, skill_truncation:over_threshold)

## TOP 5 actionable

| # | Finding ID | Bucket | Proposed fix | Effort |
|---|---|---|---|---|
| 1 | `alert:unacked_blocking_24h` (covers 47 stale alerts) | actionable_cleanup | Bulk-ack via `uv run python scripts/cockpit/alerts.py ack-all --older-than 24h`, or prune via the alerts bus admin command. Most are old `skill_sync_security` quarantine alerts now obsolete after this sprint's bulk-promote. | low |
| 2 | `security:provenance:missing_skill:my-synced-skill` | actionable_cleanup | Remove the dead key from `~/.ultron/skill-provenance.json` (skill: dict has `my-synced-skill` but no `~/.claude/skills/my-synced-skill/SKILL.md`). One JSON edit + atomic write. | trivial |
| 3 | `security:settings:hook_added` (×2: `skill_integrity_check.py`, `session-cleanup.ps1`) | actionable_cleanup | Re-snapshot `settings.json` baseline so the two legitimately-added hooks stop being flagged as drift. Run `doctor --fix` and accept the `settings_snapshot` action, or invoke `scripts/cockpit/settings_integrity.py snapshot` directly. | trivial |
| 4 | `security:skill_scan:*` (PI012 firing on persona preludes — 131 occurrences) | waived_but_persistent | Trust-source already downgrades these from quarantine to warn. To silence entirely, either (a) refine PI012 to skip frontmatter-described persona preludes, or (b) add a global PI012 waiver for skills with `kind: persona` or `kind: skill`. Both are wider-impact changes; recommend leaving as warn. | medium (deferred) |
| 5 | `security:skill_scan:*` (PI009 firing on declared-but-trusted bash/write/edit — 79 occurrences) | waived_but_persistent | Same as #4 — trust applied, downgrade already in place. Silencing entirely would require either marking the skill source `local` or per-skill waiver. Not worth the maintenance burden. | medium (deferred) |

## Detail per bucket

### actionable_cleanup (4 logical findings)

#### 4.1 `alert:unacked_blocking_24h` — 47 stale alerts
Detail excerpt: "Examples: a-2026-05-05-006 [skill_sync_security] Skill quarantined: bad -> ... pytest-of-USER / a-2026-05-05-015 [registry_sync] BLOCKED skill ...".
Most entries are pytest-fixture artifacts and pre-sprint quarantine alerts that no longer apply. Bulk-ack-all is safe; if individual review is preferred, the alerts bus has a list/inspect mode.

#### 4.2 `security:provenance:missing_skill:my-synced-skill`
Single orphan provenance key. Fork B's earlier cleanup operated on the manifest, missed this one entry that was only in `skill-provenance.json`. Patch: load JSON, `del skills["my-synced-skill"]`, atomic write.

#### 4.3 `security:settings:hook_added` (×2)
Two legitimate post-Genesis hooks (`skill_integrity_check.py` for PreToolUse Skill, `session-cleanup.ps1` for Stop) flagged because the `settings.json` baseline snapshot pre-dates them. The two hooks are documented (CLAUDE.md and v14.1.0 changelog), so the right fix is to re-baseline:
```
uv run python scripts/cockpit/settings_integrity.py snapshot --trigger=manual --user-authorized
```
or `doctor --fix` and accept the `settings_snapshot` action interactively.

### waived_but_persistent (166 — `security:skill_scan`)

Rule frequency:
- **PI012** `embedded_system_prompt` line 1: **131** skills. False-positive class — fires on persona preludes like "You are an X specialist". Trust-source downgrade keeps decision at `warn`, not `quarantine`. Per-skill waivers already cover the highest-risk cases (5 PowerShell experts + bulk-batch C 40 entries).
- **PI009** `untrusted_dangerous_tool`: **79** skills. Trust-source short-circuit silences when source is in `trusted_sources`; remaining 79 either have a non-trusted source slug in their provenance or no provenance entry at all. Likely the leftover plugin-namespaced or root skills that didn't get backfilled by today's bulk-promote.
- **PI006** `unknown_frontmatter_key`: 7 skills. Unknown keys like `model`, `tier`, `category` that aren't in the strict allowlist. Could relax the allowlist or waive per-skill.
- **PI004** `base64_blob`: 4 skills. Real findings — these skills include base64 in their content (likely embedded images or test fixtures). Worth a manual look, but trust-downgraded so non-blocking.

These are working-as-intended given the security model: trust-source downgrades quarantine→warn but does NOT silence the finding. USER gets visibility without operational impact. Three options to reduce the 166:
1. Accept the warn-noise (recommended — they're correctly classified).
2. Add severity threshold to doctor: only surface skill_scan warns above HIGH, not MEDIUM.
3. Refine PI012/PI009 to be aware of the trust-source context (skip rule when source is trusted, instead of "downgrade" pattern).

### expected_noise (1)

`mcp:gemini:degraded` — Gemini MCP is known-degraded (documented in MEMORY.md and plan section MCP). Fallback in place via `shared-duet.ps1`. No action needed.

### informational (2)

- `deadwood:warn:summary` — D17 detector surfacing the 10 deadwood warns. Working as designed.
- `skill_truncation:over_threshold` — D18 detector surfacing 705 catalog. The 705 is post-cleanup-but-before-rebuild — was 552 in this morning's smoke. Plugin namespace re-inflated to 291 (was 138). Likely the auto-discover step in sync-all re-imported some plugin entries. NOT a real bug, but worth noting that the catalog drifts upward without intervention.

## Patterns observed

1. **PI012 + persona preludes** drives most of the noise. The rule pattern is essentially "did the skill body start with 'You are an X...'?" which is exactly what every persona declares. The trust mechanism softens the impact (warn instead of quarantine), but the finding count remains. Refining PI012 to be persona-aware would eliminate ~131 warns in one move.
2. **Bulk-promote didn't fully reach plugin-namespace skills.** The 79 PI009 leftovers are mostly skills under `~/.claude/plugins/...` rather than `~/.claude/skills/`. Today's backfill targeted the root namespace.
3. **Stale alerts accumulate** because the alerts bus is append-only and there's no auto-prune. Worth wiring a retention rule (e.g. "auto-archive resolved alerts older than 14 days").
4. **Plugin catalog inflation** between sync-all runs (138 → 291) suggests an auto-discover that re-imports without checking if the plugin was deliberately removed. The `claude-code-workflows` removal wasn't undone — likely the inflation comes from other plugins refreshing.

## Recommendation

Yes — items #1, #2, #3 are worth fixing this session (≤5 min combined) because they remove ~50 surface findings from the doctor output and one of them (#3 settings drift) is genuinely confusing if left flagging.

Items #4 and #5 (PI012 / PI009 noise) are working as designed. Defer — refining PI012 to be persona-aware is a future detector improvement, not a current bug.

The `skill_truncation:over_threshold` finding showing 705 vs morning's 552 deserves a separate look: something is re-importing plugins. Worth a follow-up grep on auto-discover behaviour.
