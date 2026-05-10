# Plans Audit — 2026-05-08

> Audit of 21 plans in `C:\Users\USER\.ultron\plans\` against current
> reality. Today's release is v14.1.1; v14.0.0 GENESIS shipped 2026-05-06
> closing S0-S5. Genesis-14 audit (2026-05-06) ran Phases 0-7 across
> 11 commits over 2026-05-07/08.

## Summary table

| File | Date | Bucket | Open items |
|---|---|---|---|
| `INSTRUCCIONES.md` | 2026-05-03 | META | n/a (user instructions) |
| `cleanup-report-2026-05-02.md` | 2026-05-02 | CLOSED | n/a (historical inventory) |
| `ULTRON-v11.2.0-fixes-memory.md` | pre-v12 | SUPERSEDED | absorbed → v12.4 → v14 |
| `ULTRON-v12.4-token-memory-skill-network.md` | pre-v13 | SUPERSEDED | absorbed → v13.x → v14 |
| `ULTRON-v12.6-cron-resurrection-changelog.md` | 2026-05-03 | CLOSED | per master plan §sprints |
| `ULTRON-v13.0-arch-01-ssot.md` | 2026-05-03 | SUPERSEDED | BLUEPRINT, absorbed by v14 master |
| `ULTRON-v13.0-truth-boundary-blueprint.md` | 2026-05-03 | SUPERSEDED | BLUEPRINT, absorbed by v14 master |
| `ULTRON-v14.0-reactive-plane-outline.md` | 2026-05-03 | SUPERSEDED | HORIZON-only outline, absorbed into v14 master |
| `ULTRON-roadmap-to-9.5-2026-05-03.md` | 2026-05-03 | SUPERSEDED | sprints absorbed into v14 master |
| `CONTINUACION-2026-05-03.md` | 2026-05-03 | CLOSED | handoff doc (historical) |
| `CONTINUACION-2-2026-05-03.md` | 2026-05-03 | CLOSED | handoff doc |
| `CONTINUACION-3-2026-05-03.md` | 2026-05-03 | CLOSED | handoff doc |
| `CONTINUACION-4-SPRINT3-DONE-2026-05-03.md` | 2026-05-03 | CLOSED | Sprint 3 DONE; pending listed (2.FIX3.2 cosmetic, 4.*) absorbed by v14 |
| `CONTINUACION-FINAL-2026-05-03.md` | 2026-05-03 | CLOSED | "0 acciones pendientes"; absorbed by v14 |
| `2026-05-04-sprint-0-cleanup.md` | 2026-05-04 | CLOSED | S0 DONE per master |
| `2026-05-04-ultron-v14-overhaul-master.md` | 2026-05-04 | SUPERSEDED | → v3 → MASTER-DEFINITIVO |
| `2026-05-04-ultron-v14-overhaul-master-v3.md` | 2026-05-04 | SUPERSEDED | → MASTER-DEFINITIVO |
| `2026-05-04-sprint-1-silent-alerts.md` | 2026-05-04 | SUPERSEDED | explicit banner; spec absorbed |
| `ULTRON-v14-MASTER-DEFINITIVO.md` | 2026-05-05 v4.6 | CLOSED | S0-S5 ALL DONE → v14.0.0 GENESIS shipped 2026-05-06 |
| `2026-05-06-kirkardo-genesis-14-audit.md` | 2026-05-06 | PARTIALLY_OPEN | D-MCP-2, D-MCP-3, residual code-review items (see below) |
| `finance-tio-gilito-2026.md` | 2026-05-06 | OPEN | 3 substantive items, separate domain (NOT ULTRON) |

## OPEN plans (full detail)

### `finance-tio-gilito-2026.md`

Status header: "pendiente · Inicio previsto: semana 2026-05-12".
Domain: Tío Gilito personal-finance Streamlit dashboard
(`C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Bank\finanzas\`).
**Not** a ULTRON-engineering plan; flagged here per the audit directive
but no ULTRON-style fixes proposed.

Open items (verbatim from §"Lo que falta", lines 33-35):
- **Reembolsos en dashboard** — `es_reembolso` column already exists
  in DB; verify dashboard uses it correctly: KPI "Ingresos reales"
  excluding `WHERE es_reembolso=1`, columna "↩" en historial,
  checkbox toggle in `data_editor`.
- **Sync KutxaBank** — `sync_kutxabank.py` exists; verify end-to-end
  import → categorise → save flow.
- **Auto-categorización** — `db-protocols.md` defines keyword rules
  (mercadona→🛒, netflix→📱); verify code applies them automatically
  during sync.

By-decided-at-start (§lines 37-39):
- "Qué más quiere USER mejorar esta semana".

Recommendation: pick up only when USER explicitly asks (Tío Gilito
domain session). Out of scope for an ULTRON polish loop.

## PARTIALLY_OPEN plans (full detail)

### `2026-05-06-kirkardo-genesis-14-audit.md`

Phases 0-7 + 4.5 closed across 11 commits 2026-05-07/08
(see `git log --oneline` `9b91494..fe4df04`). Section G decision
log items still open:

- **D-MCP-2** — Windows-MCP install/decision. Audit doc flagged
  single-maintainer risk. No commit applied.
- **D-MCP-3** — Qdrant local-vs-cloud for semantic memory. No commit
  applied.
- **B.8 Q3** — temporary skill listing budget bump (1.5%/2%) in
  exploration sessions. Implicitly closed today via `claude-code-workflows`
  removal but the explicit Q3 decision is unanswered.
- **B.7** — `scripts/cockpit/news/` untracked dir + `.gitignore`
  policy never decided.
- **Code review backlog** (commit `fe4df04` message): 4 MEDIUM + 5 LOW
  items not applied. Notable:
  - M5 — dual `Finding` dataclasses (deadwood + doctor) sharing a name
  - M6 — `tests/fixtures/deadwood-corpus.md:10` stale w.r.t. Phase 2
    sentinel suppression
  - DST window-math test missing (test_usage_reset.py)
  - Non-dict deadwood JSON entries test missing
  - Unparseable health.py edge case test missing
- **Plugin re-inflation** — observed today: catalog 552 → 705 because
  `claude-code-workflows` re-fetched from `.claude.json`. The proper
  removal (`claude plugins remove claude-code-workflows`) was deferred
  to user.
- **Section H** of master plan (`ULTRON-GENESIS-CAPABILITIES.md` cross-check)
  — closed today by Polish-2 fork (audit doc updated, 11 drifts fixed,
  backup at `~/.ultron/backups/ULTRON-GENESIS-CAPABILITIES.pre-audit-2026-05-08.md`).

## SUPERSEDED chain

```
ULTRON-v11.2.0
   └→ ULTRON-v12.4 (memory + skill network)
        └→ ULTRON-v12.6 cron-resurrection (changelog only)
             └→ kirkardo-roadmap-to-9.5 (5-sprint plan)
                  ├─ ULTRON-v13.0-arch-01-ssot (BLUEPRINT)
                  ├─ ULTRON-v13.0-truth-boundary (BLUEPRINT)
                  └→ 2026-05-04-ultron-v14-overhaul-master
                       ├─ -v3 (revision)
                       └→ ULTRON-v14-MASTER-DEFINITIVO v4.6 (DONE)
                            └→ 2026-05-06-kirkardo-genesis-14-audit (PARTIALLY_OPEN)

ULTRON-v14.0-reactive-plane-outline (HORIZON, never scheduled)

CONTINUACION-{1..4-SPRINT3-DONE, FINAL} — handoff snapshots; all
"pending" items in those have been overtaken by master v4.6 work.

2026-05-04-sprint-0-cleanup → S0 DONE
2026-05-04-sprint-1-silent-alerts → SUPERSEDED banner
```

## Recommendation for USER

1. **Nothing ULTRON-engineering substantive remains to pick up.** The
   v14.0.0 GENESIS release closed the master plan and the v14.1.1
   audit follow-up closed Phases 0-7 + Phase 4.5. Status: ship-ready.

2. **D-MCP-2 (Windows-MCP) and D-MCP-3 (Qdrant)** — small,
   contained MCP install decisions from Section I of the Genesis-14
   audit. Each is ~20 min if you decide to install, otherwise mark
   declined. Lowest-effort actionable items.

3. **`claude plugins remove claude-code-workflows`** — single command,
   shrinks catalog from 705 → ~553 permanently (today's filesystem
   delete was overridden because the plugin entry stayed in
   `.claude.json`). User action only — irreversible without re-fetch.

4. **`finance-tio-gilito-2026.md`** is its own domain. If USER
   wants to spend the remaining token budget there, it has 3 concrete
   open items (reembolsos KPI, KutxaBank sync verify, auto-categorise).
   Mention but do NOT propose ULTRON-style execution unless asked.

5. **Code-review backlog** in `fe4df04` commit message — the 4 MEDIUM
   + 5 LOW items are filed for follow-up but none are user-visible.
   Pick up only if a future polish session explicitly targets them.

Bucket counts: META=1 · CLOSED=8 · SUPERSEDED=10 · PARTIALLY_OPEN=1 ·
OPEN=1 (separate domain).
