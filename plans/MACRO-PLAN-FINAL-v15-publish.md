---
title: ULTRON — MACRO PLAN FINAL v15 → v16 (publish-ready)
status: ACTIVE — supersedes MEGA-PLAN-v15.md ordering for the public-release phase
schema_version: 1
date: 2026-05-16
authors: USER + Claude (Opus 4.7) strategist
fuente_unica: PLANS.json — administrar con `ultron plans <cmd>`
supersedes_ordering_of: ~/.ultron/plans/MEGA-PLAN-v15.md
---

# ULTRON — Macro Plan FINAL v15 (publish) → v16

Single, consolidated roadmap for the **public release of ULTRON** and the
work that follows. Composed after Fase 1 closed 9 Control Center bugs and
after USER's decision to publish the public repo *now*, prioritise
v15.7 anti-hallucination over v15.5 mobile, and absorb the 50+ Phase 2-9
feedback items.

> **Reglas que aplican a todo lo que viene:**
> 1. Cosas "personales" (news, gaming, tolkien, tío-gilito, finance-DB) son
>    **opt-in** vía installer toggles. No instalan por defecto.
> 2. Cosas "generales" (orchestrator, control-center, hooks, skills core,
>    Plans, Memory) instalan siempre.
> 3. Ningún ship sin secrets-scan limpio (`gitleaks` o equivalente) y sin
>    smoke-test post-install verde.
> 4. Atomic + backup-before-destroy: cada sprint cierra con
>    `ultron plans done <id>` + nota de acceptance.

---

## Sección 1 — ESTADO ACTUAL (PLANS.json snapshot 2026-05-16)

### 1.1 Tabla completa (orden cronológico de creación)

| ID | Title (abrev.) | Status | Priority | Effort (h) | Notes |
|----|----------------|--------|----------|------------|-------|
| `v15.0-installer` | GitHub release + installer (legacy item) | resolved | p3 | 10-14 | Superseded by `v15.2-public-release` |
| `v15.1-bus-foundation` | Cross-session bus MCP + mailbox + registry | open | p3 | 32-40 | Storage layer shipped (a6a2b0b, 25 tests); MCP server + registry pending |
| `v15.2-supervisor` | Supervisor daemon (queue → `claude -p`) | open | p3 | 24-32 | Depends on bus |
| `v15.3-pipeline` | DAG scheduler YAML pipelines | open | p3 | 24-32 | Depends on supervisor |
| `v15.4-overnight` | Overnight loop with kill-switches | open | p3 | 16-24 | Depends on supervisor + pipeline |
| `v15.5-mobile` | PWA mobile via Tailscale (legacy) | wontfix | p3 | 40-56 | Superseded by `v15.3-mobile-app`; also: Claude Code Web + Tailscale already cover the use case → see §4 |
| `arch-01-ssot` | SSOT (3 manifests → 1) | wontfix | p1 | 8-12 | Three manifests shipped public; refactor not justified |
| `ops-01-stop-pipeline` | Stop pipeline idempotente | wontfix | p1 | 6-10 | Already idempotent in practice |
| `fix-2-d3-hook-tests` | D3 security + hook test corpus | wontfix | p2 | 4-6 | Covered by triple audit |
| `fix-4-lifecycle-hooks` | Lifecycle hooks bounded + atomic | wontfix | p2 | 3-5 | Already bounded by design |
| `fix-5-feedback-loops` | Wire feedback loops (Codex #5) | wontfix | p2 | 2-4 | Replaced by Stats tab + KirkardoCard |
| `si-p1-b-auto-updater` | `auto_updater.py` L2/L3 + `--dangerously-skip-permissions` | **open** | p2 | 2-3 | `tauri-plugin-updater` in Cargo.toml but **NOT invoked from lib.rs**. In-flight |
| `scan-projects-claude-md` | Scanner heuristic for CLAUDE.md folders | deferred | p2 | 2-3 | Manual workaround OK |
| `gemini-mcp-rate-limit` | Gemini Pro MCP rate-limit fallback | deferred | p2 | 0-1 | `ultron gemini` CLI covers it |
| `ultron-skill-md-budget` | SKILL.md ULTRON > 3000 tokens | resolved | p2 | 1-2 | Closed by design (it's the master orchestrator) |
| `gemini-mcp-reinstall-and-debug` | Reinstall Gemini MCP | wontfix | p2 | 1-3 | Now via CLI subscription |
| `v15.7-anti-hallucination` | Semantic entropy + Janus + provenance | **wontfix→REOPEN** | p3 | 12-18 | **Reopen per USER 2026-05-16** as p1 post-publish. Spec is solid (`specs/v15.7-anti-hallucination.md`) |
| `ultron-arranque-ligero` | Reduce overhead 6k→2k tokens | resolved | p1 | 4-6 | Superseded by skill-vault; closed in 652d9a1 |
| `memoria-automatizada-qdrant` | Qdrant pipeline + recall + auto-MEMORY.md | resolved | p1 | 6-8 | Pipeline live (308 + 429 pts); RRF + auto-mejora open in §3 |
| `osint-digital-footprint` | Sherlock + holehe digital-footprint audit | wontfix | p2 | 2-4 | Out of scope for Control Center |
| `v15.2-public-release` | Installer + skill packs + persona-strip + GitHub | **resolved** | p1 | 20-32 | **Shipped in 652d9a1.** Sub-items still open: auto-updater, theme toggle, beta-tester smoke |
| `v15.1.2-plans-ai-brainstorm` | AI brainstorm + priority lanes + dreams-local | resolved | p2 | 4-8 | Shipped |
| `v15.1.3-personal-and-instructions` | Personal section + AI-create folders + Stats++ | resolved | p1 | 20-32 | Shipped in 85f91a9 |
| `v15.1.4-fixes-and-ui` | Per-project hotkeys + responsive UI + Logs removal | resolved | p1 | 8-12 | Shipped in 652d9a1 |
| `v15.1.5-memory-visual-codex-fallback` | Memory Qdrant 2D + Codex fallback + Activity timeline | resolved | p2 | 12-20 | Shipped in 652d9a1 |
| `v15.3-mobile-app` | Mobile companion via Tailscale/local server | open | p3 | 40-60 | Defer — see §4 |

### 1.2 Subtotales

| Status | Count |
|---|---|
| `open` (need action) | 6 (`v15.1-bus`, `v15.2-supervisor`, `v15.3-pipeline`, `v15.4-overnight`, `si-p1-b-auto-updater`, `v15.3-mobile-app`) |
| `deferred` | 2 |
| `resolved` | 8 |
| `wontfix` | 9 |
| `wontfix-but-reopen` (§2) | 1 (`v15.7-anti-hallucination`) |
| **Total tracked** | **26** |

> **No tracked in PLANS.json yet (gathered from current conversation):**
> ~50 Control Center feedback items grouped into Phase 2-9. These get IDs in
> §3 (Sprints B-H) and need to be added via `ultron plans add` once USER
> approves this macro plan.

---

## Sección 2 — RECLASIFICACIÓN

Re-priorise everything against the new four-tier scheme: **p0** publish-blockers ·
**p1** core value for new users · **p2** polish · **p3** deferred/next-gen.

### 2.1 p0 — Publish-blockers (must close before `git push --set-upstream origin main` on a public repo)

| ID / New ID | New pri | Old pri | Reason |
|---|---|---|---|
| `pub-01-secrets-scan` *(new)* | **p0** | — | Run `gitleaks` + manual grep on history before push. Public repo without this is reckless |
| `pub-02-license-readme-contrib` *(new)* | **p0** | — | LICENSE + README + CONTRIBUTING already present (per CHANGELOG `[15.2.0]`); just verify they render correctly on github.com pre-publish |
| `pub-03-installer-smoke` *(new)* | **p0** | — | Run `scripts/install.ps1` on a clean Windows 11 VM (or fresh user account) end-to-end; per RELEASE-CHECKLIST step 3 |
| `pub-04-changelog-final` *(new)* | **p0** | — | CHANGELOG `[15.2.0]` currently says "release candidate"; bump to final on tag |
| `pub-05-plans-ux-resolved-hole` *(new, Phase 1 leftover)* | **p0** | — | Tiny visible bug in Plans tab bottom hole. Cheap fix; embarrassing on first day public |
| `si-p1-b-auto-updater` | **p0** *(was p2)* | p2 | If we ship without invoking the updater plugin, every new user is stuck on v15.2.0 forever. Either wire it now or yank `tauri-plugin-updater` from Cargo.toml and ship without updater. **Decide before tag** |

### 2.2 p1 — Core value for new users (next 1-3 sprints after publish)

| ID / New ID | New pri | Old pri | Reason |
|---|---|---|---|
| `cc-phase2-notifications-rework` *(new)* | **p1** | — | Notifications tab redesign with Windows toast + events bus. Surfaces system health to users; replaces the Logs tab cleanly |
| `cc-phase3-plans-rework-stages` *(new)* | **p1** | — | Plans rework with explicit stages (DEV/TEST/QA/REV/RESOLVED). The Plans tab is *the* differentiator vs other LLM dashboards |
| `cc-phase4-memory-perms-graph` *(new)* | **p1** | — | Memory permissions + graph hardening. Memory tab is the second differentiator; bugs here scare new users off |
| `cc-phase5-personal-rework` *(new)* | **p1** | — | Personal tab rework. Must be opt-in by default for public; visible only when `personal_enabled=true` in installer toggles |
| `cc-phase6-dashboard-rework` *(new)* | **p1** | — | Home dashboard rework — first impression for new clones |
| `v15.7-anti-hallucination` (REOPEN) | **p1** *(was p3 wontfix)* | p3 | **Per USER 2026-05-16:** prioritise BEFORE mobile. Semantic entropy + Janus is the real moat vs other Claude dashboards. Spec already written (`specs/v15.7-anti-hallucination.md`) |
| `cost-tracking-multi-llm` *(new)* | **p1** | — | Modularidad multi-LLM (Claude/Codex/Gemini) + cost tracking. Critical for API-key users (the public audience). Today's `CostWatchdog.rs` only covers Anthropic |

### 2.3 p2 — Polish (after the p1 wave)

| ID / New ID | New pri | Old pri | Reason |
|---|---|---|---|
| `cc-phase7-settings-refactor` *(new)* | **p2** | — | Settings tab refactor. Functional today; polish only |
| `cc-phase8-misc-polish` *(new)* | **p2** | — | Catch-all bucket for the remainder of the 50+ feedback items not absorbed above |
| `cc-phase9-installer-toggles-feedback` *(new)* | **p2** | — | Round 2 of installer UX based on beta-tester feedback (post-publish) |
| `theme-toggle-light` *(new from Unreleased)* | **p2** | — | Light theme toggle. Hard-coded OLED today |
| `v15.1-bus-foundation` | **p2** *(was p3)* | p3 | Storage layer landed; complete the MCP server + registry to unlock supervisor + pipeline + overnight |
| `v15.2-supervisor` | **p2** | p3 | Unlocks autonomous task running. After bus |
| `scan-projects-claude-md` | **p2** | p2 | Keep deferred unless >5 CLAUDE.md folders appear |

### 2.4 p3 — Deferred / v16

| ID / New ID | New pri | Old pri | Reason |
|---|---|---|---|
| `v15.3-mobile-app` | **p3** | p3 | **Superseded by Claude Code Web + Tailscale.** Keep open as a v16 idea but stop counting it for v15 |
| `v15.5-mobile` (legacy) | **p3 wontfix** | p3 wontfix | Stays wontfix; same reason as v15.3-mobile |
| `v15.3-pipeline` | **p3** | p3 | Wait until bus + supervisor are stable |
| `v15.4-overnight` | **p3** | p3 | After pipeline |
| `gemini-mcp-rate-limit` | **p3** | p2 | CLI fallback is fine |
| `osint-digital-footprint` | **p3 wontfix** | p2 wontfix | Out of scope; revive as separate repo if ever |

---

## Sección 3 — SPRINTS (executable groupings)

Each sprint is 8-20 h. Dependencies declared. Sprints A-H form the **publish → polish → moat** arc.

---

### Sprint A — **Publish prep** (the next ~6-8 h; runs in parallel with everything else)

**Goal:** make the public push safe + boring.

| Item ID | Title | Effort |
|---|---|---|
| `pub-01-secrets-scan` | gitleaks scan on tree + history; quarantine any leak | 1 h |
| `pub-02-license-readme-contrib` | Verify LICENSE / README / CONTRIBUTING render on github.com preview | 0.5 h |
| `pub-03-installer-smoke` | `install.ps1` dry-run on fresh user account (or VM) | 1-2 h |
| `pub-04-changelog-final` | Strip "release candidate" suffix; finalize `[15.2.0]` | 0.25 h |
| `pub-05-plans-ux-resolved-hole` | Fix Plans bottom-hole visual bug | 1 h |
| `si-p1-b-auto-updater` *(p0 decision)* | Either wire `tauri-plugin-updater` from `lib.rs` OR yank it from Cargo.toml | 2-3 h |
| `pub-06-build-release-artifact` *(new)* | `npm run tauri build`; attach installer to GitHub Release | 1 h |

**Effort total:** 7-9 h.
**Depends on:** —
**DONE when:**
- `git log` clean of secrets;
- VM install works end-to-end;
- GitHub Release `v15.2.0` published with installer artifact;
- `main` branch pushed public.

---

### Sprint B — **Phase 2: Notifications rework**

**Goal:** replace ad-hoc UI errors and the removed Logs tab with a real
Notifications system fed by an events bus and Windows toasts.

| Item ID | Title | Effort |
|---|---|---|
| `cc-phase2-events-bus` | In-process events bus (Tauri side) + subscription API | 3 h |
| `cc-phase2-notifications-tab` | Notifications tab: sortable, filterable, severity badges | 3 h |
| `cc-phase2-toast-windows` | Wire `tauri-plugin-notification` → Windows toast on `severity>=warn` | 2 h |
| `cc-phase2-error-ingest` | Re-route `window.onerror` + Rust `tracing::error!` into the events bus | 2 h |
| `cc-phase2-tests` | Integration test: panic in cockpit → toast appears | 2 h |

**Effort total:** 12 h.
**Depends on:** Sprint A pushed public (otherwise we ship a half-feature).
**DONE when:** every UI error and every Stop-hook alert appears in Notifications + a desktop toast.

---

### Sprint C — **Phase 3: Plans rework (stages)**

**Goal:** make the Plans tab the canonical demo of ULTRON's planning value.
Today the lanes are status-only (open / in-progress / resolved). Add explicit
**stages** (DEV → TEST → QA → REV → RESOLVED) matching the protocol in
MEGA-PLAN-v15 § VI.

| Item ID | Title | Effort |
|---|---|---|
| `cc-phase3-stages-schema` | Add `stage` field to PLANS.json schema + migration | 2 h |
| `cc-phase3-kanban-stages` | Kanban with 5 columns per status, drag-to-advance | 4 h |
| `cc-phase3-stage-gates` | Acceptance criteria entry per stage; gate transitions | 3 h |
| `cc-phase3-ai-stage-suggest` | "Suggest next stage" button → Codex `/codex:review` | 3 h |
| `cc-phase3-archive-final` | When stage=RESOLVED + RES gate green → archive automatically | 2 h |

**Effort total:** 14 h.
**Depends on:** Sprint B (uses events bus to notify on stage transitions).
**DONE when:** a plan moves DEV → TEST → QA → REV → RESOLVED with gate checks on each step, all visible in the UI.

---

### Sprint D — **Phase 4-6: Memory + Personal + Dashboard rework**

Three closely-coupled feedback bundles. Ship together because they share
state (the user's profile fingerprint) and the events bus.

| Item ID | Title | Effort |
|---|---|---|
| `cc-phase4-memory-perms` | Per-collection read/write/delete permissions in Memory tab | 3 h |
| `cc-phase4-memory-graph-fix` | Memory graph hardening: fix UMAP edge cases, click→note, collection filter | 3 h |
| `cc-phase5-personal-rework` | Personal tab split UI v2 (auto-fingerprint left, free textarea right) | 4 h |
| `cc-phase5-personal-optin` | Hide Personal tab unless `features.personal_enabled=true` (installer toggle) | 1 h |
| `cc-phase6-dashboard-rework` | Home dashboard redesign: today's session count, plan velocity, top skills, alerts | 5 h |

**Effort total:** 16 h.
**Depends on:** Sprint C (Personal references Plans stages; dashboard reads from same events bus).
**DONE when:** Memory, Personal and Home each pass a self-review against the spec; no UI-error toasts firing during a 10-minute session.

---

### Sprint E — **Phase 7: Settings refactor**

**Goal:** Settings tab today is a JSON editor with Codex assist. Refactor into
typed sections (Models · Hooks · Capabilities · Theme · Features · Backups)
with form UI and a "show JSON" power-user toggle.

| Item ID | Title | Effort |
|---|---|---|
| `cc-phase7-settings-sections` | Section sidebar + form UI per section | 4 h |
| `cc-phase7-features-toggles` | Feature flags UI: News, Gaming, Tolkien, Tio Gilito, Finance, OSINT | 2 h |
| `cc-phase7-theme-toggle` | Light theme + system-theme follow | 3 h |
| `cc-phase7-backup-config` | Backups section: D:\ override, schedule, retention | 2 h |

**Effort total:** 11 h.
**Depends on:** Sprint D (uses the feature-flag plumbing for opt-in personals).
**DONE when:** every setting today reachable via JSON editor is also reachable via the typed form.

---

### Sprint F — **v15.7 Anti-hallucination layer** (the moat)

**Goal:** what nobody else has. Semantic entropy + Janus + provenance + execution
grounding routed by risk. Spec already written at
`~/.ultron/plans/specs/v15.7-anti-hallucination.md`.

| Item ID | Title | Effort |
|---|---|---|
| `v15.7-phase0-risk-classifier` | Extend `intent-dispatcher.py` with `risk_level` field | 3 h |
| `v15.7-phase1-semantic-entropy` | Probe with `n=3`, MPNet embeddings, variance threshold | 4 h |
| `v15.7-phase2-provenance` | Force `source_uri` + `extracted_by` in vault frontmatter; reconciliation loop | 3 h |
| `v15.7-phase3-janus-hook` | Cross-persona critique mapping (einstein→repo-evaluator etc.) | 4 h |
| `v15.7-phase4-exec-grounding` | PostToolUse hook: linter, imports, CLI flag verify, TDD enforce | 3 h |
| `v15.7-phase5-intent-gate` | Glue + table of decision (risk → which phases activate) | 3 h |
| `v15.7-acceptance-corpus` | Build 30-pair adversarial corpus; verify ≥90% classifier accuracy | 2 h |

**Effort total:** 22 h (slightly above 20h cap — split if needed).
**Depends on:** Sprint E (uses the typed Settings UI to expose toggles per phase).
**DONE when:** acceptance criteria from `specs/v15.7-anti-hallucination.md` all green; metrics published in Stats tab.

---

### Sprint G — **Multi-LLM modularity + cost tracking**

**Goal:** today's `CostWatchdog.rs` covers Anthropic only. Public users
typically pay for multiple providers. Ship a unified cost ledger and
modular provider plumbing.

| Item ID | Title | Effort |
|---|---|---|
| `cost-providers-abstraction` | Trait `LlmProvider` (Rust) + adapters: anthropic/openai/google | 4 h |
| `cost-ledger-unified` | `~/.ultron/metrics/cost-ledger.jsonl` schema + writer | 3 h |
| `cost-tab-multi-provider` | Stats tab: cost by provider, daily/weekly/monthly tabs | 3 h |
| `cost-watchdog-multi` | Watchdog supports per-provider budgets + 80% alert | 2 h |
| `cost-export-csv` | Export to CSV for billing reconciliation | 1 h |

**Effort total:** 13 h.
**Depends on:** Sprint F (so anti-hallucination retries are correctly attributed in the ledger).
**DONE when:** a 24h period shows totals split per provider with deltas matching each provider's own dashboard ±2%.

---

### Sprint H — **Phase 1-9 remaining + catch-all**

**Goal:** absorb everything that didn't fit into Sprints B-G. This is the
overflow bucket for the ~50 feedback items.

| Item ID | Title | Effort |
|---|---|---|
| `cc-phase1-residual` | Any leftovers from Phase 1's 9 bugs that resurfaced | 2 h |
| `cc-phase8-misc-polish` | UI nits: tooltips, keyboard shortcuts, copy edits | 4 h |
| `cc-phase9-installer-feedback` | Round 2 of installer UX based on first beta feedback | 4 h |
| `scan-projects-claude-md-revisit` | Re-evaluate if >5 folders exist by then | 1 h |
| `theme-toggle-light` | Shipped in Sprint E; verify polish | 1 h |
| `mobile-research-revisit` | Research-only: does Claude Code Web + Tailscale fully replace v15.3-mobile-app? Write decision doc | 2 h |

**Effort total:** 14 h.
**Depends on:** Sprints A-G all green.
**DONE when:** PLANS.json open count of Control-Center feedback items = 0.

---

### 3.X · Sprint summary table

| Sprint | Theme | Effort (h) | Depends on | Cumulative (h) |
|---|---|---|---|---|
| A | Publish prep | 7-9 | — | 7-9 |
| B | Phase 2 Notifications | 12 | A | 19-21 |
| C | Phase 3 Plans stages | 14 | B | 33-35 |
| D | Phase 4-6 Memory/Personal/Dashboard | 16 | C | 49-51 |
| E | Phase 7 Settings refactor | 11 | D | 60-62 |
| F | v15.7 Anti-hallucination | 22 | E | 82-84 |
| G | Multi-LLM cost tracking | 13 | F | 95-97 |
| H | Phase 1-9 catch-all | 14 | A-G | 109-111 |

**Grand total:** ~109-111 h (≈14 days at 8 h/day). Realistic over 4-6 calendar weeks with normal life cadence.

---

## Sección 4 — v16 (next gen)

Items explicitly **out of v15** but tracked for the next major.

| ID | Title | Why deferred |
|---|---|---|
| `v15.1-bus-foundation` | Cross-session bus full MCP + registry | Storage shipped; deferred until 3+ users actually request multi-session orchestration |
| `v15.2-supervisor` | Supervisor daemon | Depends on bus; same gating |
| `v15.3-pipeline` | DAG pipelines | After supervisor proves valuable |
| `v15.4-overnight` | Overnight loop | After supervisor + pipeline stable |
| `v15.3-mobile-app` | Mobile companion (revived) | Only if `mobile-research-revisit` in Sprint H concludes Claude Code Web is insufficient |
| `multi-os-support` *(new)* | macOS + Linux installers | Windows-only at v15.2; revisit once external beta testers ask for it |
| `plugin-marketplace` *(new)* | Third-party skill packs with signature verification | Requires `ultron-skills` repo to have ≥3 external contributors |
| `procedural-memory-L4` *(new)* | Heredado de MEGA-PLAN-v15 § III.1 (L4) | Out of scope for v15 entirely |
| `sleep-consolidation-L1-L2` | L1→L2 nightly consolidation pass | Same — own sprint in v16 |
| `repo-evaluator` *(persona)* | Kirkardo rework to `code-grader` | Non-trivial Spanish→English + de-personalization rewrite |
| `tio-gilito` *(persona)* | Personal finance — keep local always | Hard-bound to private DB schema |
| `tolkien` *(persona)* | Personal book project — keep local always | This *is* the book project |

---

## Sección 5 — CHECKLIST DE PUBLICACIÓN (do these in order)

> Tracking against `docs/RELEASE-CHECKLIST-v15.2.md` and the new p0 items in §2.1.

### Pre-flight (Sprint A items)

1. [ ] `gitleaks detect --source . --no-banner` → 0 findings.
2. [ ] `git log --all -p | grep -i -E "(api[_-]?key|secret|password|token|bearer|C:\\\\Users\\\\USER)"` → 0 hits on tracked content.
3. [ ] `grep -r "C:\\Users\\USER" src/ src-tauri/ scripts/ cockpit/ docs/` → 0 matches.
4. [ ] `LICENSE` present, MIT, "© 2026 USER SURNAME".
5. [ ] `README.md` renders correctly in the GitHub preview.
6. [ ] `CONTRIBUTING.md` present at repo root.
7. [ ] `.gitignore` excludes `personal/`, `cockpit/news/*.html`, `brain_index/`, `qdrant_storage/`, `qdrant-native/`, `_legacy/`, `archive/`, `backups/`, `multimodel/`, `telemetry/`, `metrics/`, `audits/`, `.tmp/`, `alerts.jsonl*`.

### Build

8. [ ] `cargo check --release` from `control-center/src-tauri/` clean.
9. [ ] `cargo clippy --all-targets --release` no warnings-as-errors.
10. [ ] `npx tsc --noEmit` from `control-center/` clean.
11. [ ] `uv run pytest` from repo root passes.
12. [ ] `npm run tauri build` produces installer artifact.

### Install

13. [ ] `scripts/install.ps1` dry-run on fresh Windows 11 user (or VM) succeeds.
14. [ ] Smoke test: doctor green + brain_index seed indexed + Control Center launches with all configured tabs.
15. [ ] One external beta tester confirms install on their machine.

### Auto-updater decision

16. [ ] **Decide:** wire `tauri-plugin-updater` from `lib.rs` (item `si-p1-b-auto-updater`) **or** remove the dependency from Cargo.toml. Do not ship a half-wired updater.

### Release artifacts

17. [ ] CHANGELOG `[15.2.0]` strip "release candidate" → final.
18. [ ] Plans UX bottom-hole fix shipped (`pub-05`).
19. [ ] Release notes drafted from `plans/specs/v15.2-public-release.md`.
20. [ ] Tag `v15.2.0` on `main`.
21. [ ] GitHub Release published with installer attached + notes pasted.
22. [ ] `git push --set-upstream origin main` (or whatever publishes the public branch).

### Post-publish

23. [ ] Issue templates enabled.
24. [ ] Discussions enabled, "first install" thread pinned.
25. [ ] Announcement drafted (no urgency; keep ready).

---

## Apéndice — Items NOT to publish (recommend `.gitignore` or `EXCLUDE`)

These are tracked elsewhere and should **not** ship in the public `ultron` repo
at v15.2.0. Most are already gitignored per the checklist; flagged here so
USER can sanity-check.

### Already excluded (verify `.gitignore` covers them)

- `personal/` — USER's personal style fingerprint, prompts archive.
- `cockpit/news/*.html` — generated ULTRON Times newsletters with personal commentary.
- `brain_index/` — local FTS5 SQLite of vault.
- `qdrant_storage/` + `qdrant-native/` — vector store binaries.
- `_legacy/`, `archive/`, `backups/`, `multimodel/`, `telemetry/`, `metrics/`, `audits/`, `.tmp/`.
- `alerts.jsonl*` — runtime hook signals.

### Personas to KEEP LOCAL (per `docs/personas-release-decision.md`)

- `tio-gilito` — hard-coded path to `~/CARRERA/PROYECTOS_PERSONALES/Bank/finanzas.db`, real EUR limits, KutxaBank reference. Even sanitised, nothing generic left.
- `tolkien` — bound to the unpublished novel *Imperio de los Once Grandes*; story bible, named characters, plot decisions DEC-001..DEC-014. *This is the book project itself.*
- `repo-evaluator` (Kirkardo) — UNIVERSITY assignments, Spanish-only, T9/T10 framing. Could ship as `code-grader` later after non-trivial rewrite — defer.
- `news-publisher` — ships as part of the `ultron` repo (templates + design system), **not** as a standalone skill in `ultron-skills`. Strip personal license header before publishing.

### Items in PLANS.json that are personal/experimental and should not be promoted to the public roadmap yet

- `osint-digital-footprint` — `wontfix`; if revived, separate repo.
- `v15.3-mobile-app` — keep open in PLANS.json but mark as v16 in public release notes; don't promise mobile in v15.2.
- `v15.1-bus-foundation` and downstream supervisor/pipeline/overnight — keep open but mention as "experimental" in public docs; full ship in v16.

### Feedback items still in conversation (not yet in PLANS.json)

The ~50 Control Center feedback items mentioned by the orchestrator are
currently outside `PLANS.json`. They are captured at sprint granularity in
§3 (Sprints B-H). Before starting Sprint B, run `ultron plans add` to give
each `cc-phase*` id a row, so progress tracking stays single-source-of-truth.

---

## Cierre

Plan vivo. Cuando un sprint cierra, `ultron plans done <id>` y nota acceptance.
Cuando un sprint produce nuevo feedback no anticipado, `ultron plans add` con
producer=`macro-plan-final-v15`. Cuando v15.2.0 esté en GitHub, este documento
se archiva a `_archive/` y abrimos `MACRO-PLAN-v16.md`.

*Documento final de la generación v15. Single source of execution truth from
publish through anti-hallucination ship.*
