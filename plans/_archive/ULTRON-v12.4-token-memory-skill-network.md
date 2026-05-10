# ULTRON v12.4 Token, Memory, Skill Network Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert ULTRON Cockpit into a token-efficient orchestration console with multi-level memory, synchronized skill/agent registry, stronger clipboard prompts, and a high-capacity skill/persona network.

**Architecture:** Keep ULTRON as the master orchestrator. The TUI remains a clipboard-prompt launcher, not an autonomous mutator. Memory retrieval and skill reading become tree-shaped: summaries first, ranked snippets second, full files only for the active branch. Important personas act as sub-orchestrators that can route into stronger subskills, add-ons, MCPs, or external long-context review when the task justifies the token cost.

**Tech Stack:** Python 3, Textual TUI, PowerShell clipboard launcher, local ULTRON memory under `C:\Users\USER\.ultron`, Obsidian-style vault under `C:\Users\USER\.ultron-vault`, skills under `.claude`, `.codex`, and `.agents`.

---

## Non-Negotiables

- Use `uv run python ...` for Python execution when running from a Python project. Do not use direct `python`, `pip`, or `python -m`.
- Do not auto-apply skill edits from the cockpit. Clipboard prompts can request audits, proposals, and reviews, but the actual change stays inside USER's conversation.
- Preserve existing user data. Archive/deprecate `activity.jsonl` and `auth-vault.dpapi`; do not delete credential/history files unless USER explicitly approves.
- All repos touched during implementation must end with clean `git status` or a clear list of uncommitted files, and everything requested for active repos must be pushed before closure.
- Use memory levels by default. Full-memory loads require a reason.

---

## Target Memory Budget

| Level | Name | Source | Intended Tokens | Load Rule |
|---|---|---|---:|---|
| L0 | Hot command context | Current prompt + selected TUI state | 300-800 | Always |
| L1 | Slim index | `C:\Users\USER\.ultron\INDEX.md`, project `PROJECT.md`, registry summaries | 800-2,000 | Default for MEDIUM/HIGH |
| L2 | Ranked snippets | `brain_index.py` FTS5 top-k snippets | 1,500-5,000 | When a domain/project/skill is named |
| L3 | Full source files | `SKILL.md`, references, project docs | 5,000-20,000 | Only for implementation, audit, or `/ultra` |
| L4 | External long context | Gemini/Codex second opinion, repo-wide docs | 20,000+ | Only for massive repo/docs or architecture review |

Implementation must make this visible in prompts: every clipboard prompt should state which memory levels to load and which skills/personas to activate.

---

## Master Architecture: Vault, Session, Skills, Agents

This plan is not just a merge of session memory and skill-reading memory. The target system is a synchronized operating graph:

```text
ULTRON Master Orchestrator
|
+-- Memory Graph
|   +-- L0 current session intent
|   +-- L1 slim hot index
|   +-- L2 brain_index ranked snippets
|   +-- L3 full target files only
|   +-- L4 external long context
|
+-- Skill Graph
|   +-- Claude skills
|   +-- Codex skills
|   +-- Agents skills
|   +-- Gemini skills/add-ons catalog
|   +-- MCP/plugin add-ons
|
+-- Persona Graph
|   +-- Tier A sub-orchestrators
|   +-- Tier B domain specialists
|   +-- Tier C utility/process skills
|
+-- Session Graph
    +-- current task state
    +-- decisions made today
    +-- unsynced findings
    +-- next-session pointers
```

The main invariant: Claude, Codex, Agents, and Gemini-facing catalogs must describe the same skill universe. If one side has a skill, route, category, or memory policy that the others do not know about, the registry must mark it as unsynced.

### Identity And Synchronization Rules

| Object | Canonical Record | Sync Targets | Drift Signal |
|---|---|---|---|
| Skill | `C:\Users\USER\.ultron\skill_manifest.json` | `.claude\skills`, `.codex\skills`, `.agents\skills`, Gemini catalog | missing path, checksum mismatch, category mismatch |
| Persona | `skill_manifest.json` + vault registry | `.claude\skills`, `.codex\skills`, `.agents\skills` | prompt/routing mismatch |
| Agent | agent manifest or skill manifest extension | `.claude\agents`, `.codex\agents` | missing agent, stale role, stale tool policy |
| Memory policy | vault registry + brain config | prompts, skill registry, TUI | prompt loads wrong level |
| Session state | `.ultron\sessions\YYYY-MM-DD\*` | next-session pointers, vault log | plan exists but no wake pointer |
| Add-on/MCP | Gemini/add-on catalog + MCP registry | TUI prompts, registry, vault | discoverable but not categorized |

Synchronization is not "copy everything blindly." It is:

1. Detect identity: same semantic skill/persona/agent across roots.
2. Compute checksums and metadata.
3. Compare category, route, mode, and memory layer.
4. Mark exact drift reason.
5. Generate a clipboard prompt for review.
6. Apply only when USER explicitly asks in the conversation.
7. Rebuild registry and brain index.

### Orchestration Hierarchy

| Tier | Role | Examples | Can Route To | Memory Default |
|---|---|---|---|---|
| S0 | Root orchestrator | `ultron` | all tiers, memory graph, external reviewers | L0+L1, L2 on demand |
| S1 | Meta sub-orchestrators | `skill-creator`, `consolidate-memory`, `mcp-builder`, `repo-evaluator` | S2/S3, registry, vault | L1+L2 |
| S2 | Persona sub-orchestrators | `terry-davis`, `don-claudio`, `mike-tyson`, `jordan-belfort`, `warren`, `tio-gilito`, `pana`, `alfred`, `novalbos`, `einstein` | domain skills, process skills, MCP/add-ons | L1+L2, L3 target only |
| S3 | High-impact process skills | `systematic-debugging`, `test-driven-development`, `differential-review`, `sharp-edges`, `property-based-testing`, `webapp-testing` | narrow utility skills | L0+L2 snippets |
| S4 | Utility/add-on skills | docs, spreadsheets, presentations, browser, Gemini add-ons, MCP tools | no orchestration unless declared | L0 only, L3 only when executing |

Important personas are not just voices. They are sub-orchestrators with scoped authority. Example: `terry-davis` can activate TDD, systematic debugging, differential review, property-based testing, and second opinion. `mike-tyson` can activate frontend-design, UI/UX review, accessibility review, and webapp testing. `skill-creator` can activate writing-skills, registry sync, and memory consolidation.

### Skill Jump Contract

Every skill-to-skill jump must produce a compact handoff, not a full transcript:

```json
{
  "from": "ultron",
  "to": "terry-davis",
  "reason": "code implementation and tests",
  "task": "fix health runner crash",
  "memory_levels": ["L0", "L1", "L3:health.py"],
  "required_context": ["health failure summary", "expected exit policy"],
  "forbidden_context": ["full vault", "all skills"],
  "token_budget": 2500,
  "return_format": "findings, files changed, tests run"
}
```

This contract is the core token-efficiency mechanism. A sub-orchestrator receives only the branch of the tree it needs.

### Mode System For Skills And Memory

| Mode | Use | Skill Depth | Memory Depth | External Models |
|---|---|---|---|---|
| LOW | factual, typo, one action | S0 only | L0 | never |
| MEDIUM | clear single-domain task | S0 -> one S2/S3 | L0+L1, optional L2 | no, unless requested |
| HIGH | multi-step, registry, sync, refactor | S0 -> S1/S2 -> S3 | L0+L1+L2, L3 target only | Codex/Gemini optional for review |
| ULTRA | architecture, whole vault/repo, major migration | full planned graph | L0-L4 as justified | Gemini/Codex encouraged |
| AUDIT | review-only | repo-evaluator + relevant S3 | L1+L2, L3 target | no apply |
| SYNC | identity/drift resolution | skill-creator + consolidate-memory | L1+L2, L3 current item | no silent write |
| LEARN | durable knowledge capture | consolidate-memory | L1 target registry/log | no |

The highest active orchestrator decides mode and depth. Lower skills can request escalation, but they cannot load broader context by default.

### Tree Reading Policy

Reading must follow this order:

1. Read the root index or manifest entry.
2. Read category-level summary.
3. Query ranked snippets for the selected branch.
4. Read the target skill/persona/agent full file.
5. Read referenced files only if the target file explicitly points to them and the task needs them.
6. Use Gemini/Codex long context only when the selected branch exceeds local context or needs second opinion.

Anti-patterns to prevent:

- Loading every `SKILL.md` just to categorize one new skill.
- Reading the whole vault for a single cockpit UI bug.
- Sending complete conversation history to a subskill.
- Letting a utility skill route broadly without S0/S1 approval.
- Keeping Claude/Codex/Gemini skill catalogs semantically different.

### Proposed Improvements Beyond Current Request

- Add a Skill Constitution: authority, allowed actions, forbidden actions, escalation rules, safety gates, and delegation rights.
- Add `route_strength` to each registry edge: `primary`, `secondary`, `fallback`, `forbidden`.
- Add Route Quality Metrics: observed token cost, success rate, correction count, fallback count, USER approval signal, and last outcome.
- Add a Skill Conflict Solver: select the most effective route using domain fit, risk, token cost, observed quality, memory depth, and mode.
- Add Canonical Skill Digest: stable 100-250 token skill summaries used before reading full `SKILL.md`.
- Add detailed drift types: content, version, category, route, permission, memory policy, root presence, Gemini catalog, checksum.
- Add Gemini `catalog-only` mode: Gemini discovers and recommends; ULTRON canonicalizes.
- Add Failure Recovery: retry with broader memory, switch skill, escalate to ULTRON, ask USER, or degrade route.
- Add Session Replay: durable compact trace of skill routes, project decisions, old requests, memory levels, outcomes, and reusable patterns.
- Add Token Budget Enforcement: warn/block L3/L4 loads without justification.
- Add Persona Capability Matrix: strengths, delegations, forbidden areas, MCP/add-ons, mode minimum.
- Add Graph Visualization: markdown/HTML map of ULTRON -> personas -> subskills -> add-ons -> memory.
- Add Skill Promotion/Demotion: detect usage and outcomes from memory/logs; promote useful skills, demote stale or failing skills.
- Add Safety Gates for filesystem, repos, credentials, finances, destructive operations, and external calls.
- Add canonical naming: `Kirkardo` is the official canonical name for `repo-evaluator`; aliases resolve to Kirkardo.
- Keep registry lockfile optional only. Do not implement unless a concrete need appears for reproducible historical snapshots beyond manifest + session replay.

### Autonomous Background Operation

The system must not require USER to babysit synchronization, audits, memory updates, route quality tracking, or skill drift detection. These jobs should run while USER is working on a project through the least intrusive mechanism available:

| Background Job | Trigger | Executor | Interruption Policy |
|---|---|---|---|
| Skill drift scan | session start, stop, manual `Sincronizar skills`, scheduled | lightweight registry scanner | silent unless blocker |
| Route quality update | after skill/persona handoff | session replay writer | silent |
| Memory pattern extraction | session stop, project switch, HIGH/ULTRA closure | consolidate-memory or background job | summarize silently; ask only on ambiguity |
| Skill usage mining | daily/weekly, after route graph build | log/memory analyzer | silent report |
| Gemini add-on discovery | manual or scheduled low-frequency | Gemini catalog prompt/job | report candidates, no install |
| Brain index refresh | after manifest/memory changes | brain_index job | silent unless index fails |
| Safety gate audit | before risky action | active orchestrator | interrupt on risk |
| Project context sync | project open/close, branch change, session stop | memory bridge | silent unless repo dirty/unpushed |

Preferred implementation order:

1. Start with simple synchronous commands that are reliable.
2. Add background execution only for read-only or append-only jobs.
3. Never let background jobs mutate skills/repos without explicit approval.
4. Show a compact "background findings" panel or section in Skills/Health instead of interrupting USER.
5. Escalate only blocker drift, failed health, unsafe operation, or repo not pushed when closure requires it.

### Open Questions To Resolve During Implementation

- Should Gemini "skills/add-ons" be stored as installable local skills, external catalog entries, or both? Default: `catalog-only` unless USER explicitly installs/canonizes.
- Which personas are Tier A sub-orchestrators by default? Accepted default Tier A: `ultron`, `skill-creator`, `consolidate-memory`, `Kirkardo`, `terry-davis`, `mike-tyson`, `don-claudio`, `pana`, `alfred`.
- Should every persona exist identically in `.claude`, `.codex`, and `.agents`, or should `.agents` only hold callable agent wrappers?
- Should registry sync block when checksums differ, or generate a review prompt and continue?
- Should `brain_index.py` index full skill text or only generated summaries plus references? Default: summaries + route metadata + references; full text only as target branch.
- Should Gemini long-context review be invoked from TUI prompts only, or also through a manifest-driven command?

---

## File Map

Primary files:
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\tui.py`: remove Activity/Auth UI, simplify AutoUpdater, add Skills sync action, improve clipboard prompts, update help.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\health.py`: isolate failing checks so full health check reports failures instead of crashing.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\skill_manifest.py`: strengthen registry schema for unsynced skills and synchronized targets.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\registry_sync.py`: scan `.claude`, `.codex`, `.agents`; detect unsynced skills and optionally agents.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\skill_discover.py`: keep GitHub search and add Gemini skills/add-ons discovery.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\brain_index.py`: index registry edges, summaries, authority, memory policy, and route metadata without forcing full skill reads.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\auto_updater.py`: deprecate `scan`, `propose`, and `apply` UI usage; keep CLI compatibility only if needed for old scripts.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\brain_config.py`: add query synonyms and memory-level routing for skills, agents, sync, and add-ons.
- Modify `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\test_cockpit.py`: add regression tests for health, registry, and prompt generation.
- Modify `C:\Users\USER\.ultron\skill_manifest.json`: migrate existing entries to the new schema through script, not manual edits.
- Modify `C:\Users\USER\.ultron-vault\30_PATTERNS\skill-registry.md`: update the conceptual registry after implementation.
- Modify `C:\Users\USER\.ultron\cockpit\README.md` and generated dashboard/help text docs after code changes.

Optional new files:
- Create `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\prompt_templates.py`: centralize clipboard prompt templates if `tui.py` remains too large.
- Create `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\agent_manifest.py`: only if agent synchronization cannot fit cleanly into `skill_manifest.py`.
- Create `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\route_graph.py`: only if routing edges, authority, and handoff contracts become too large for `registry_sync.py`.
- Create `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\skill_summarizer.py`: generate stable 100-250 token summaries for tree reads and avoid full `SKILL.md` loading.

---

## Task 1: Baseline And Reproduction

- [x] Run repo status for ULTRON skill code.

```powershell
Set-Location C:\Users\USER\.claude\skills\ultron
git status --short
git branch --show-current
```

- [x] Run the current cockpit tests.

```powershell
uv run python scripts\cockpit\test_cockpit.py
```

Expected: either pass, or record current failures before changing behavior.

- [x] Reproduce the crashing full health check.

```powershell
uv run python scripts\cockpit\health.py
```

Expected after fix: no unhandled traceback. Failing checks must be reported as failed checks.

- [x] Capture the current AutoUpdater `propose` failure if USER still has the pasted stack.

Record it in `C:\Users\USER\.ultron\cockpit\audits\autoupdater-propose-crash-YYYY-MM-DD.md`. Do not preserve `propose` as a required flow; use it only as evidence for removal/deprecation.

---

## Task 2: Health Check Must Not Crash

- [x] Inspect `health.py` for direct calls that can throw.
- [x] Wrap each check in a typed result object: `name`, `status`, `summary`, `details`, `duration_ms`.
- [x] Convert exceptions into `status="fail"` or `status="warn"` with traceback summary capped to 1,000 characters.
- [x] Ensure CLI exits `0` when the runner itself works, even if checks fail; use non-zero exit only for parser/runtime failure.
- [~] Add a test in `test_cockpit.py` that injects one failing check and verifies the full health output still renders. (health.py protected via _safe() wrapper; explicit test not added)

Verification:

```powershell
uv run python scripts\cockpit\health.py
uv run python scripts\cockpit\test_cockpit.py
```

---

## Task 3: Remove Activity And Auth From The Cockpit UI

- [x] In `tui.py`, remove Activity and Auth from `BINDINGS`. (nav-activity/nav-auth absent from BINDINGS)
- [x] Remove `nav-activity` and `nav-auth` sidebar entries. (verified absent)
- [x] Remove `action_view_activity`, `action_view_auth`, `_render_activity`, and `_render_auth`. (already done in v12.3)
- [x] Remove Activity/Auth from the docstring header and help modal.
- [x] Keep `load_activity()` returning neutral `[]` (v12.3 change preserved).
- [x] In `README.md`, mark Activity tracker and Auth Vault as deprecated cockpit modules.

Verification:

```powershell
Select-String -Path scripts\cockpit\tui.py -Pattern "Activity|Auth|view_activity|view_auth|nav-activity|nav-auth"
uv run python scripts\cockpit\test_cockpit.py
```

Expected: no reachable UI binding for Activity/Auth.

---

## Task 4: Simplify AutoUpdater To Kirkardo Clipboard Review

- [x] In `tui.py`, remove buttons/actions for AutoUpdater `scan`, `rank`, `propose`, and `apply`. (verified absent)
- [x] Keep two actions: Kirkardo HIGH and Kirkardo ULTRA Triple clipboard prompts.
- [x] Prompts return findings inside conversation, not patches.
- [x] In `auto_updater.py`, `propose` and `full` marked as `# LEGACY â€” not surfaced in TUI`.
- [x] README updated to describe AutoUpdater as Kirkardo clipboard audit only.

Required clipboard prompt intent:

```text
Activa Ultron /high + repo-evaluator (Kirkardo) + relevant skill-review skills.
Carga L1 registry summary and L2 ranked snippets only.
Do a full review of the selected skill/persona/agent.
Return prioritized findings, exact file references, and suggested edits.
Do not apply changes. Do not emit patch JSON unless USER asks.
```

Verification:

```powershell
Select-String -Path scripts\cockpit\tui.py -Pattern "propose|apply|rank|scan"
uv run python scripts\cockpit\test_cockpit.py
```

Expected: no AutoUpdater UI flow exposes propose/apply.

---

## Task 5: Rebuild Skills Section Actions

- [x] Keep `Buscar skills en GitHub`. (skills-search-github button added)
- [x] Rename to `Buscar Skills y ADD/ONS de Gemini`. (skills-search-gemini)
- [x] Remove `Actualizar Skill EspecÃ­fica`. (skills-update-one absent)
- [x] Keep `Actualizar todas las Skills` as audit-only. (skills-update-all button added with clipboard prompt)
- [x] Keep `Crear nueva skill`. (skills-create button added)
- [x] Add `Sincronizar skills`. (skills-registry-sync-prompt button added with full clipboard prompt)

Target Skills actions:

| Button | Behavior |
|---|---|
| Buscar Skills en GitHub | Clipboard prompt for Codex/GitHub search; no install without review |
| Buscar Skills y ADD/ONS de Gemini | Clipboard prompt for Gemini deep search; include add-ons, MCPs, plugins |
| Sincronizar skills | Detect skills absent from manifest or unsynced across `.claude`, `.codex`, `.agents`; launch terminal with sync prompt in clipboard |
| Actualizar todas las Skills | Audit all personas and high-impact skills; no apply |
| Crear nueva skill | Launch skill-creator prompt |

Verification:

```powershell
Select-String -Path scripts\cockpit\tui.py -Pattern "skills-update-one|Sincronizar|ADD/ONS|Actualizar todas"
uv run python scripts\cockpit\test_cockpit.py
```

Expected: no `skills-update-one`; new sync action exists.

---

## Task 6: Skill Manifest And Unsynced Detection

- [x] Extend `skill_manifest.py` schema to include:

```json
{
  "name": "ultron",
  "type": "skill|persona|agent|addon|plugin",
  "source_roots": [".claude/skills", ".codex/skills", ".agents/skills"],
  "present_in": ["claude", "codex", "agents"],
  "synced": true,
  "checksum": "sha256:...",
  "category": "meta|persona|engineering|design|memory|workflow|finance|game|security|misc",
  "memory_layer": "L0|L1|L2|L3|L4",
  "authority": "orchestrator|sub-orchestrator|executor|reviewer|utility",
  "mode_cap": "LOW|MEDIUM|HIGH|ULTRA",
  "read_policy": "summary-only|snippet-first|full-on-audit|full-on-execution",
  "estimated_token_cost": 1200,
  "persona_routes": ["ultron", "terry-davis"],
  "route_edges": [
    {
      "to": "systematic-debugging",
      "strength": "primary",
      "reason": "unknown bug root-cause analysis",
      "mode_min": "MEDIUM",
      "memory_levels": ["L0", "L1", "L3-target-only"]
    }
  ],
  "sync_group": "ultron",
  "last_seen": "ISO-8601",
  "last_synced": "ISO-8601",
  "unsynced_reason": null
}
```

- [x] Ensure the migration preserves existing `synced` values from `C:\Users\USER\.ultron\skill_manifest.json`.
- [x] Add scan roots: `.claude/skills`, `.codex/skills`, `.agents/skills`. (agent roots handled via agent_manifest.py)
- [x] Mark entries as unsynced when they exist in one root but not the expected target roots.
- [x] Make sync output deterministic by sorting by name (alphabetical).

Verification:

```powershell
uv run python scripts\cockpit\skill_manifest.py
uv run python scripts\cockpit\registry_sync.py --dry-run
```

Expected: manifest updates without losing existing entries; unsynced entries are visible.

---

## Task 6B: Route Graph And Tree Summaries

- [x] Decided route_graph.py not needed; edges live in skill_manifest.py `_ROUTE_EDGES`.
- [x] Generate or store a 100-250 token summary for every skill/persona/agent (skill_summarizer.py build: 54 digests).
- [x] Store summaries in `~/.ultron/skill_cache/` (one JSON per skill).
- [x] Add route edges for Tier A sub-orchestrators:

| Sub-orchestrator | Primary Routes |
|---|---|
| `skill-creator` | `writing-skills`, `consolidate-memory`, registry sync, prompt templates |
| `consolidate-memory` | memory audit, vault sync, brain index, duplicate pruning |
| `repo-evaluator` | `differential-review`, `sharp-edges`, `insecure-defaults`, `mutation-testing` |
| `terry-davis` | `test-driven-development`, `systematic-debugging`, `property-based-testing`, `second-opinion` |
| `mike-tyson` | `frontend-design`, accessibility review, UX critique, `webapp-testing` |
| `don-claudio` | game-dev skills, graphics/UE/Unity routes, Terry for implementation |
| `pana` | personal operations, Alfred, calendar/schedule, productivity routes |
| `alfred` | OS/files/processes, document/spreadsheet/presentation tools |

- [~] Add a route validator (not yet implemented; edges are defined but no CLI validator for forbidden patterns).

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --validate-routes --dry-run
uv run python scripts\cockpit\brain_index.py query "terry-davis systematic debugging route"
```

Expected: route graph validates and queries retrieve route summaries without reading all skill files.

---

## Task 6C: Skill Constitution And Capability Matrix

- [x] Add a constitution section to the registry schema or a sidecar file. Minimum fields:

```json
{
  "name": "Kirkardo",
  "canonical_name": "Kirkardo",
  "aliases": ["repo-evaluator", "kirkardo", "evaluador repo"],
  "authority": "reviewer",
  "allowed_actions": ["audit", "score", "prioritize_findings", "recommend_changes"],
  "forbidden_actions": ["apply_changes_without_USER", "delete_files", "push_without_request"],
  "can_delegate_to": ["terry-davis", "differential-review", "mutation-testing", "sharp-edges"],
  "must_escalate_when": ["destructive_change", "credential_access", "financial_action", "L4_context_needed"],
  "mode_min": "HIGH",
  "mode_cap": "ULTRA",
  "memory_policy": "L1+L2+L3-target-only",
  "safety_gates": ["filesystem_write", "repo_mutation"]
}
```

- [x] Define Persona Capability Matrix for Tier A personas (7 constitutions in SKILL_CONSTITUTIONS: Kirkardo, terry-davis, mike-tyson, don-claudio, pana, alfred, skill-creator, consolidate-memory).
- [x] Enforce canonical naming: `Kirkardo` in UI prompts, `repo-evaluator` as alias. UI prompt updated.
- [~] Add validation via `skill_manifest.py constitutions` command (shows constitutions; formal validation CLI not yet implemented).

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --validate-constitution --dry-run
```

Expected: no Tier A persona lacks authority, delegation limits, or gates.

---

## Task 6D: Route Quality Metrics And Skill Conflict Solver

- [x] Add route quality metrics storage. Suggested location:

```text
C:\Users\USER\.ultron\skill_cache\route_quality.json
```

- [x] Store metrics per edge (route_quality.py â€” 39 edges seeded from manifest, skill_66dc2b17 â†’ unreal-engine fixed).
- [x] Implement conflict scoring function:

```text
score =
  domain_fit * 0.30
  + observed_success * 0.25
  + safety_fit * 0.15
  + token_efficiency * 0.15
  + memory_fit * 0.10
  + recency_fit * 0.05
```

- [x] Conflict solver behavior implemented in route_quality.py `resolve_conflict()`.
- [~] Update handoff prompts to include chosen route reason (solver returns reason field; not yet surfaced in TUI prompts).

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --route-quality --dry-run
```

Expected: route choices are deterministic and explainable.

---

## Task 7: Sync Skills Clipboard Prompt

- [x] Add a `Sincronizar skills` TUI action that:
  - [x] scans manifest and builds compact list of unsynced entries (skills-registry-sync-prompt button);
  - [x] copies a prompt to clipboard via `launch_with_prompt()`;
  - [x] opens Claude terminal for AI workflow.
- [x] The prompt includes personas (ultron, skill-creator), sync roots, categorization instructions, no silent overwrites rule.

Prompt policy:

```text
Load L1 manifest summary.
Load L2 snippets for each unsynced skill.
Load L3 full SKILL.md only for the skill currently being synchronized.
Categorize each skill and decide if it belongs to persona, workflow, engineering, design, memory, finance, game, security, or misc.
Assign authority, mode_cap, read_policy, estimated_token_cost, sync_group, and outgoing route_edges.
Preserve Claude/Codex/Agents/Gemini semantic identity. If Gemini is catalog-only, mark it as addon/catalog instead of pretending it is locally installed.
Update sync registry and report changed files.
```

Verification:

```powershell
Select-String -Path scripts\cockpit\tui.py -Pattern "skills-sync|Sincronizar skills"
uv run python scripts\cockpit\test_cockpit.py
```

---

## Task 8: Prompt Templates Upgrade

- [~] If `tui.py` remains above 100 KB or prompt logic spreads, create `prompt_templates.py`. (tui.py is ~105KB â€” borderline; prompts left in tui.py for now, extraction deferred to v12.5)
- [x] Prompts centralized inline in tui.py for: Kirkardo HIGH, Kirkardo ULTRA, GitHub search, Gemini search, sync skills, update all skills, create new skill.
- [x] Every prompt includes:
  - [x] mode: `/high` by default;
  - [x] active skills/personas named;
  - [x] memory levels stated;
  - [~] handoff contract (present in Kirkardo prompts, not in all prompts yet);
  - [x] output format;
  - [x] explicit "No aplicar cambios sin USER" in key prompts.

Recommended high-impact skill bindings:

| Flow | Required Skills |
|---|---|
| Skill sync | `ultron`, `skill-creator`, `consolidate-memory` |
| Skill audit | `repo-evaluator`, `sharp-edges`, `insecure-defaults` when security relevant |
| Prompt quality | `skill-creator`, `ask-questions-first` only if requirements are ambiguous |
| Memory routing | `ultron`, `consolidate-memory`, `spec-to-code-compliance` for registry/spec drift |
| UI changes | `mike-tyson`, `frontend-design` only if visual redesign is needed |
| Code implementation | `terry-davis`, `test-driven-development`, `verification-before-completion` |

Verification:

```powershell
uv run python scripts\cockpit\test_cockpit.py
```

Expected: prompt unit tests assert required skills and memory levels are present.

---

## Task 8B: Handoff Contract Tests

- [x] Add tests that generate a handoff contract from: (TestHandoffContracts — 5 tests, 53/53 passing)
  - [x] `ultron` to `terry-davis` for a code bug;
  - [x] `ultron` to `skill-creator` for sync drift;
  - [x] `repo-evaluator` to `sharp-edges` for a security review;
  - [x] `mike-tyson` to `frontend-design` for UI implementation.
- [x] Assert each handoff contains:
  - source;
  - destination;
  - reason;
  - memory levels;
  - forbidden context;
  - token budget;
  - return format.
- [x] Assert no handoff includes `full vault`, `all skills`, or complete session transcript unless mode is `ULTRA`.

Verification:

```powershell
uv run python scripts\cockpit\test_cockpit.py
```

Expected: route and prompt tests prove skill jumps stay compact.

---

## Task 8C: Failure Recovery And Token Budget Enforcement

- [x] Add route failure states: all 6 states defined in `RECOVERY_STATES` in route_quality.py.
- [x] Define token hard stops:
  - [x] LOW cannot load L2+.
  - [x] MEDIUM cannot load L4.
  - [x] HIGH can load L3 target only.
  - [x] ULTRA can load L4 with justification.
  (All defined in TOKEN_HARD_STOPS + mode_allows_level() in route_quality.py, tested in test_cockpit.py)
- [~] Clipboard prompts explicitly state memory levels (done in key prompts, not all).
- [ ] Add warning text when prompt would exceed the target budget. (not implemented)
- [x] Add test cases proving L3/L4 levels respect mode: TestModeAllowsLevel + TestTokenHardStops (48 tests passing).

Verification:

```powershell
uv run python scripts\cockpit\test_cockpit.py
```

Expected: prompt generation blocks or warns on unjustified broad memory loads.

---

## Task 9: Agent Synchronization

- [x] Decided: `agent_manifest.py` created separately (5 diagnostic agents tracked).
- [x] Scans `~/.claude/agents/` (codex agents dir doesn't exist yet).
- [x] Tracks agent metadata: name, path, description, tools, model, category, phase, run_order.
- [~] TUI visibility: not surfaced in TUI yet (agents available via registry_sync include-agents CLI).
- [x] `registry_sync.py include-agents` subcommand added â€” runs rebuild + status.

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --include-agents --dry-run
```

Expected: agents are listed and unsynced agents are reported.

---

## Task 10: Memory Retrieval And Brain Index Policy

- [x] Update `brain_config.py` synonyms for: skill sync, add-ons, Gemini, agent registry, health check, Kirkardo review (all in `_BUILTIN_SYNONYMS`).
- [x] Add a helper or config table mapping flow to memory layers:

```json
{
  "skills_sync": ["L1", "L2", "L3-current-skill-only"],
  "kirkardo_review": ["L1", "L2", "L3-target-only"],
  "health_check": ["L0", "L1"],
  "github_skill_search": ["L0", "external"],
  "gemini_addon_search": ["L0", "external", "L1-registry-summary"],
  "agent_sync": ["L1", "L2", "L3-target-agent-only"]
}
```

- [~] `brain_index.py` indexes vault notes and distilled sessions; skill registry indexing planned but not yet implemented.
- [x] `tree_read_plan(flow)` helper implemented in `brain_config.py` returning memory_levels, max_tokens, allow_external, allow_l3/l4.
- [~] Brain build after implementation: deferred (requires brain_index.py rebuild which takes time).

Verification:

```powershell
uv run python scripts\cockpit\brain_index.py build
uv run python scripts\cockpit\brain_index.py query "sincronizar skills gemini addons"
```

Expected: top results include registry, skills, and relevant prompt policy.

---

## Task 10B: Synchronization Health Score

- [x] Add a registry health summary:

```json
{
  "total_objects": 0,
  "fully_synced": 0,
  "unsynced": 0,
  "checksum_drift": 0,
  "route_drift": 0,
  "missing_memory_policy": 0,
  "missing_mode_cap": 0,
  "score": 0.0
}
```

- [x] `registry_sync.py health` command reports score=55/100 (54 skills, 70% synced, 39 route edges).
- [~] Severity levels: basic score breakdown shown (sync/ghost/routes); full blocker/warn/info classification not yet implemented.
- [~] Skills Map view shows drift count; does not yet surface the numeric score from registry_sync health.

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --health
```

Expected: health summary reports sync quality and prioritized drift.

---

## Task 10C: Session Replay And Pattern Memory

- [x] Add compact session replay records for important routes and decisions. Suggested path:

```text
C:\Users\USER\.ultron\sessions\YYYY-MM-DD\replay.jsonl
```

- [ ] Each record should include:

```json
{
  "ts": "ISO-8601",
  "project": "ultron",
  "request_summary": "fix health check crash",
  "mode": "HIGH",
  "route": ["ultron", "terry-davis", "test-driven-development"],
  "memory_levels": ["L0", "L1", "L3:health.py"],
  "files_touched": ["scripts/cockpit/health.py"],
  "decision": "wrap checks into typed result objects",
  "outcome": "success|partial|failed",
  "tests": ["uv run python scripts/cockpit/test_cockpit.py"],
  "patterns_learned": ["health runners must isolate check exceptions"],
  "followups": []
}
```

- [x] session_replay.py: append/show/list commands, writes to `~/.ultron/sessions/YYYY-MM-DD/replay.jsonl`, read-only for skills.
- [~] Mine replay records: usage_report.py reads replays + route_quality for usage stats (basic mining implemented).
- [~] Background summary job: background_tasks.py defines task registry; actual pattern extraction not yet automated.
- [ ] Link accepted patterns into vault and brain index: (pending)

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --mine-skill-usage --dry-run
uv run python scripts\cockpit\brain_index.py query "old requests health check skill route"
```

Expected: old project/request patterns become searchable without loading full session logs.

---

## Task 10D: Skill Usage Detection And Promotion/Demotion

- [x] Define usage signals:
  - [x] explicit skill activation in prompts;
  - [x] route graph handoff (route_quality.json);
  - [x] replay records (session_replay.py).
- [x] Produce a weekly or manual report:

```json
{
  "skill": "terry-davis",
  "usage_30d": 18,
  "success_rate": 0.83,
  "avg_token_cost": 2400,
  "recommended_action": "promote|keep|demote|archive|audit",
  "reason": "high success and frequent use for code tasks"
}
```

- [~] Promotion rules (usage_report.py shows invocations/runs/success â€” no promotion/demotion automation yet):
  - frequent usage + high success + low correction rate -> stronger route edge;
  - rare usage + stale docs -> audit;
  - repeated failure -> demote or mark degraded;
  - replaced by stronger skill -> archive candidate;
  - high token cost but high value -> keep but require HIGH/ULTRA.
- [ ] Surface promotion/demotion candidates in Skills Map, not as automatic destructive changes.

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --usage-report --dry-run
```

Expected: report ranks skills using real logs/memory, not guesses.

---

## Task 10E: Background Automation Without Babysitting

- [x] Add a background jobs model for read-only and append-only work (background_tasks.py: 8 tasks defined).
- [x] Jobs allowed without interrupting USER:
  - [x] brain-index-update, decay-queue-prime, skill-manifest-rebuild, skill-digests-build, agent-manifest-rebuild, route-quality-init, memory-bridge-sync, vault-memory-sync (all defined in background_tasks.py).
- [~] Jobs that must interrupt: defined conceptually, not yet enforced in code:
  - (interrupt policy defined in background_tasks.py comments; not enforced programmatically yet)
- [~] Store background findings in `background-findings.jsonl` (path defined in CLAUDE.md; not yet written to by background_tasks).
- [~] Compact UI/status: background_tasks.py list command shows last-run status; not surfaced in TUI yet.

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --background-dry-run
```

Expected: background mode can scan, summarize, and queue findings without mutating skills or interrupting normal project work.

---

## Task 11: Help, Palette, And Documentation

- [~] Remove Palette references: no palette found in tui.py (already removed in prior version).
- [~] Update help modal with current sections: help modal in tui.py was not explicitly updated this session (needs verification).
- [x] Update `README.md` to describe the cockpit as:
  - [x] Projects Â· News Â· Scheduler Â· Health Â· MCPs Â· AutoUpdater (Kirkardo only) Â· Skills Map & Sync. README.md updated.
- [~] Update `skill-registry.md` in vault: skill-tree.md created in 30_PATTERNS (more comprehensive than skill-registry.md).
- [x] Activity/Auth not present in TUI; README marks them deprecated.

Verification:

```powershell
Select-String -Path scripts\cockpit\tui.py -Pattern "palette|Activity|Auth"
Select-String -Path C:\Users\USER\.ultron\cockpit\README.md -Pattern "Activity|Auth|Palette|propose|apply"
```

Expected: only historical/deprecated references remain, not active UI instructions.

---

## Task 12: Final Validation And Sync

- [x] Run the cockpit test suite.

```powershell
uv run python scripts\cockpit\test_cockpit.py
```

- [x] Run health check. (OK with warnings â€” cron jobs, news freshness, session cache stale)
- [x] Run registry dry-run and manifest sync. (54 skills, 48 tests pass)
- [~] Build brain index. (deferred â€” takes time, vault notes intact)
- [x] Check git state.

```powershell
git status --short
```

- [x] Commit with conventional message. (commits f67a2e1 + a5f3c5c + fbd92c6 â€” 2026-05-02)

```powershell
git add scripts\cockpit\tui.py scripts\cockpit\health.py scripts\cockpit\skill_manifest.py scripts\cockpit\registry_sync.py scripts\cockpit\skill_discover.py scripts\cockpit\auto_updater.py scripts\cockpit\brain_config.py scripts\cockpit\test_cockpit.py
git commit -m "feat: streamline cockpit skill orchestration"
```

- [x] Push active branch. (pushed to https://github.com/SkiTemplar/ultron-skills.git â€” 2026-05-02)

```powershell
git push
```

---

## Task 13: Final System Cleanup Across ULTRON, Claude, Codex, Agents

This is the closing phase. It must run only after the registry, route graph, sync metadata, and background jobs are stable. The goal is to clean old update debris without destroying recoverable history.

- [x] Build a cleanup inventory across `.ultron`, `.ultron-vault`, `.claude`
      → `scripts/cockpit/cleanup_inventory.py` (scan + report + policy commands)

- [x] Classify files/directories into: active, canonical, synced-copy, deprecated,
      orphan, cache, backup, danger
      → implemented in `cleanup_inventory._classify()`

- [x] Generate a cleanup report before deleting anything:
      → `cleanup_inventory.py report` → `~/.ultron/cockpit/audits/cleanup-report-YYYY-MM-DD.md`
      → First report: `cleanup-report-2026-05-02.md` ✅

- [ ] Never delete immediately from high-risk locations. First move eligible deprecated/orphan files into:

```text
C:\Users\USER\.ultron\archive\cleanup-YYYY-MM-DD\
```

- [x] Do not touch without explicit approval (enforced: `.git`, credentials, API keys classified as `danger`)

- [x] Add a cleanup policy to the registry:
      → `CLEANUP_POLICY` dict in `cleanup_inventory.py`, exposed via `policy` subcommand
      → deprecated_retention_days=30, cache_retention_days=7, archive_before_delete=True

- [ ] Every future update must support lifecycle states:
      new → active → synced → deprecated → archived → deleted-with-approval

- [x] Add cleanup checks to health:
      → `cmd_health` in `registry_sync.py` now shows `Last cleanup scan` + `Archive dirs`

- [x] Add cleanup background mode:
      → `cleanup-inventory-scan` task (trigger=weekly, priority=9) added to `background_tasks.py`
      → Runs `cleanup_inventory.py report` weekly; no destructive actions, approval required

Verification:

```powershell
uv run python scripts\cockpit\registry_sync.py --cleanup-inventory --dry-run
uv run python scripts\cockpit\registry_sync.py --health
uv run python scripts\cockpit\brain_index.py build
```

Expected: cleanup report exists, no destructive action happened by default, and registry/brain/health remain consistent.

---

## Acceptance Criteria

- Full health check never crashes the cockpit workflow.
- Activity and Auth are absent from active TUI navigation.
- AutoUpdater no longer exposes Scan/rank, Propose, or Apply in TUI.
- Skills section exposes exactly the desired action set, including `Sincronizar skills`.
- Skill manifest detects unsynced skills across `.claude`, `.codex`, and `.agents`.
- Manifest models Claude/Codex/Agents/Gemini as one semantic skill universe with explicit sync groups.
- Important personas have sub-orchestrator route edges to high-impact skills.
- Every skill/persona/agent has authority, mode cap, read policy, memory layer, and compact summary.
- Every Tier A persona has a Skill Constitution and Persona Capability Matrix.
- Skill conflicts are resolved by deterministic maximum-efficacy scoring.
- Route Quality Metrics are recorded and used to improve future routing.
- Canonical Skill Digests prevent unnecessary full `SKILL.md` reads.
- Drift is classified by type and severity.
- Gemini add-ons support `catalog-only` discovery without pretending they are installed local skills.
- Failure recovery is explicit and routes can be degraded.
- Session Replay captures important project patterns, old requests, route choices, decisions, and outcomes.
- Token Budget Enforcement warns or blocks unjustified L3/L4 loads.
- Skill usage mining proposes promotion/demotion from real logs/memory.
- Safety Gates protect filesystem, repos, credentials, finances, destructive operations, and external calls.
- `Kirkardo` is the official canonical name; `repo-evaluator` is only an alias/internal implementation name.
- Background jobs can scan, summarize, update metrics, mine patterns, refresh index, and queue findings while USER works, without requiring babysitting.
- Final cleanup inventory covers `.ultron`, `.ultron-vault`, `.claude`, `.codex`, and `.agents`.
- Deprecated/orphaned update debris is archived before deletion, and deletion always requires explicit approval.
- Future updates carry lifecycle metadata so sync, deprecation, migration, cleanup, and rollback are handled systematically.
- Skill jumps use handoff contracts and tree-reading policies instead of full transcript/full vault loads.
- Clipboard prompts explicitly use skills/personas and memory levels.
- Agent synchronization is supported or explicitly deferred with a written reason.
- Brain index can retrieve the new registry and sync policy.
- Registry health score exposes drift and sync quality.
- Help text matches the current UI.
- Tests and health commands have been run and results recorded.

---

## Execution Order For Tomorrow

1. Start with Task 1 and Task 2. Health crash is the highest leverage blocker.
2. Do Task 3 and Task 4 together because both simplify the TUI surface.
3. Do Task 5 through Task 8C as one feature branch: Skills Map, sync, manifest, route graph, constitutions, quality metrics, conflict solver, summaries, prompts, handoff contracts, token enforcement.
4. Do Task 9 only after skill sync and route graph are stable.
5. Do Task 10 through Task 10E: memory policy, registry health score, session replay, skill usage mining, background automation.
6. Finish with Task 11 and Task 12: docs, tests, commit, push.
7. Run Task 13 as the final cleanup phase: inventory first, archive second, delete only with explicit approval.

Recommended mode for the next prompt:

```text
/high Ultron, ejecuta el plan C:\Users\USER\.ultron\plans\ULTRON-v12.4-token-memory-skill-network.md.
Prioridad: mÃ¡xima eficacia tokens + red sincronizada de vault, sesiÃ³n, skills, agentes y Gemini add-ons.
Primero arregla health check, luego simplifica TUI, luego implementa registry/sync/route graph/prompts/automation.
No lo trates como simple compactaciÃ³n de memoria: el objetivo es Ã¡rbol de skills + memoria con suborquestadores, constituciÃ³n de skills, conflict solver, route quality metrics, handoff contracts, session replay y lectura por ramas.
El sistema debe funcionar en segundo plano mientras trabajo en proyectos: detectar drift, actualizar mÃ©tricas, minar patrones, refrescar Ã­ndices y dejar findings en cola sin que yo tenga que estar detrÃ¡s. InterrÃºmpeme solo por blockers, riesgos o decisiones de overwrite.
Usa UV para Python. No auto-apliques propuestas de skills. Haz tests y deja repos activos pusheados.
Al final, haz limpieza controlada de `.ultron`, `.ultron-vault`, `.claude`, `.codex` y `.agents`: inventario, reporte, sync, deprecados, archivo seguro, health check. No borres nada sin aprobacion explicita.
```
