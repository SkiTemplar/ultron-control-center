# Skill Listing Truncation Audit — 2026-05-07

> Source: plan `2026-05-06-kirkardo-genesis-14-audit.md` Section B.8 + Phase 6.
> Trigger: live system-reminder reported "434 descriptions dropped, 17%/1% of context".

## Inventory

| Namespace | Count | Path |
|---|---|---|
| root | 379 | `~/.claude/skills/` |
| plugin | 290 | `~/.claude/plugins/` |
| bundle | 35 | subdirs in `~/.claude/skills/` (ULTRON personas, agent-skills, superpowers, etc.) |
| **TOTAL** | **704** | |

`MEMORY.md` declared `skills:392`; reconciled to `704 (root=379 · plugin=290 · bundle=35)` in this session.

## Plugin source breakdown (290 plugin-namespace skills)

| Source | Skills | % of plugin total |
|---|---|---|
| `marketplaces/claude-code-workflows` | **152** | **52%** |
| `marketplaces/claude-plugins-official` | 28 | 10% |
| `marketplaces/addy-agent-skills` | 21 | 7% |
| `cache/addy-agent-skills` | 21 | 7% (DUPLICATE of marketplaces/) |
| `marketplaces/pensyve` | 15 | 5% |
| `cache/superpowers-marketplace` | 14 | 5% |
| `marketplaces/thedotmack` | 11 | 4% |
| `marketplaces/claude-code-plugins` | 10 | 3% |
| `cache/thedotmack` | 8 | 3% (DUPLICATE) |
| `superclaude` | 6 | 2% |
| `cache/claude-plugins-official` | 4 | 1% (DUPLICATE) |

## Truncation math

Harness `skillListingBudgetFraction` is at default `1%`. The system-reminder
quoted "434 descriptions dropped (17%/1% of context)" — meaning roughly 17%
of the listing got full descriptions and 83% got name-only. With 704 skills
that's ~120 skills with description, ~584 name-only.

To restore full coverage at 1%, the catalog must shrink to ~120 skills.
That requires removing ~580 skills, which is impractical via `/skills disable`.

Realistic options ordered by tokens-per-impact:

| Strategy | Tokens/session delta | Skills retained | Effort |
|---|---|---|---|
| **Status quo (1%, truncated)** | 0 | 704 visible (120 with descr) | none |
| **Remove `claude-code-workflows`** | 0 | 552 visible | 1 plugin uninstall |
| **Remove all `marketplaces/`** | 0 | ~430 visible | 6 plugin uninstalls |
| **Dedupe `cache/` overlap** | 0 | ~660 visible | manual cleanup of cache dir |
| **Bump `skillListingBudgetFraction` to 1.5%** | +~17k | 704 (~180 with descr) | 1 setting edit |
| **Bump fraction to 2%** | +~34k | 704 (~240 with descr) | 1 setting edit |

## Recommendation (token-efficient hybrid)

**Step 1 — Remove `claude-code-workflows` plugin.** Single biggest win.
152 skills gone, no token cost added per session, surface area drops 22%.
The plugin name suggests Anthropic's workflow templates; if USER's
ULTRON personas + intent-dispatcher already handle his workflows, this
plugin is mostly noise.

```
claude plugins remove claude-code-workflows
```

**Step 2 — Audit `cache/` dir.** Has duplicates of `marketplaces/`
(addy-agent-skills × 2, thedotmack × 2, claude-plugins-official × 2,
superpowers-marketplace exclusive). The cache might be lookup-only and
not contribute to the listing — verify before deleting.

**Step 3 — Decide the rest case by case.** With ~552 skills after step 1,
re-check truncation. If still bad: optionally bump fraction to 1.5%
(+~17k/session) or remove smaller marketplaces.

**Why NOT bump to 1% → 2% directly:** 34k tokens × every session burns
rate limits without addressing the underlying surface-area bloat. The
harness is signalling that the catalog is too big; the right fix is
shrinking the catalog, not paying tokens to mask the symptom.

## Detection going forward

A new doctor detector (`D18_SKILL_TRUNCATION`) is added in this same
phase. It reads `manifest.cache.json` skill count, compares against a
threshold (default 200), and emits a WARN finding when truncation is
likely to recur. This way regressions surface in `ultron sync-all` step 8
without requiring a full Claude session restart to notice the
system-reminder warning.

## Open decisions logged for future

The user delegated Q1/Q2 of plan section B.8 to the assistant on
2026-05-07 ("la mejor opción que creas, recuerda token efficiency").

## Action taken (2026-05-07, post-recommendation)

After the user authorised the assistant to execute the recommendation
("no puedes eliminar tú el plugin desde los directorios?"), the
`claude-code-workflows` marketplace was removed via filesystem delete:

| | Before | After |
|---|---|---|
| Plugin SKILL.md | 290 | 138 (-152) |
| Total skills | 704 | **552** |
| D18 finding | "exceeds 200" | "exceeds 200" (still warns, lower count) |

Backup: `~/.ultron/backups/claude-code-workflows-2026-05-07.zip` (2.2 MB
compressed). Recovery: `Expand-Archive` to the original location, or
`claude plugins install <repo>` to re-fetch a clean copy. No references
to `claude-code-workflows` were found in any `~/.claude/settings*.json`,
so no config cleanup was required.

Truncation will still occur at 552 skills + 1% budget; the next
candidate actions (cache/ dedupe, marketplaces/pensyve, etc.) sit
behind a smaller-impact threshold and can be revisited if warranted.
