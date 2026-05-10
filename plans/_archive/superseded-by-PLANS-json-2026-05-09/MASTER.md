---
title: ULTRON MASTER plan — single entry point
date: 2026-05-08
status: ACTIVE — consolidated view of macro plan + open work
---

# ULTRON MASTER — single source of truth

> **Si vienes a esta carpeta, empieza aquí.** Este es el plan consolidado.
> Los archivos antiguos (sprints completados, drafts pre-Genesis, continuaciones)
> viven en `_archive/`. Los detalles tácticos vivos están en los 5 docs MACRO-*.

## Estado actual del macro plan v14.x → v15.0

| Sprint | Status | Commit |
|---|---|---|
| **v14.0 GENESIS base** | ✅ shipped | (history pre-2026-05) |
| **v14.1 DEADWOOD polish** | ✅ shipped | series ending `44f815b` |
| **v14.2 news + audits** | ✅ shipped | `dcd9f5e` |
| **v14.3 Hiper Plans skill** | ✅ shipped | `fc5c46a` |
| **v14.4 TOKEN HUNTER** | ✅ RESOLVED — 23,817 tok saved + 96.6% cache hit rate | `8cb89d2`..`72f5915` (+ `c298470` version bump) |
| **v14.5 META-PROMPTER** | ✅ RESOLVED — improver + feedback hook + registry + eval + CLI | `1396da5` |
| **v14.7 BACKUP-WATCH** | ✅ RESOLVED — weekly robocopy + D25 + Task Scheduler | `f1b3e82` |
| **v14.6 PERFECT MEMORY** | ✅ RESOLVED — Qdrant Docker + MPNet 768d + hybrid RRF · 265 notas en 51s · CLI `ultron recall` | `ec48b94` |
| **v15.0 ULTRON.io** | 🟡 NEXT — web pública profesional ES (~10d, último sprint del macro plan) | — |

**Numbering note:** v14.6 y v14.7 están intercambiados respecto al macro plan original — v14.7 (BACKUP-WATCH) shipped antes que v14.6 (PERFECT MEMORY) por petición del usuario para asegurar la data antes de seguir con sprints largos.

## Decisiones abiertas

| ID | Decisión | Default | Bloquea |
|---|---|---|---|
| **D-MCP-3** | Qdrant Path A (Docker local) vs B (Cloud free tier) | A Docker | v14.6 PERFECT MEMORY |
| D-MCP-2 | Windows-MCP install | No install (single-maintainer risk) | nada |
| B.8 Q3 | `skillListingBudgetFraction` 1%→1.5% | Mantener 1% | nada (D24 monitoriza) |

## Sistemas live (instrumentación + métricas)

- **Token budgets:** `ultron doctor --token-audit` 2026-05-09 = 1262/1500 PASS (context.md 239, MEMORY.md 389, CLAUDE.md 634). Estaba over-budget en mayo, ya corregido.
- **Cache hit rate:** D24 detector. Snapshot 2026-05-08: 96.76% sobre 18,332 turns / 14d, verdict PASS.
- **Skill listing:** `skill_lazy_loader` aplicado: 19 on / 361 name-only. Restore via `skill_lazy_loader.py restore`.
- **Backup:** `UltronBackup-Weekly` Task Scheduler entry, lunes 09:00. D25 detector activo (>7d warn / >30d blocking).
- **Prompt improvement:** `ultron prompts improve|registry|eval|feedback ...` CLI. PostToolUse hook capturando samples a `~/.ultron/.tmp/prompt-feedback.jsonl`.

## Next pickup

**Opción 1 — v14.6 PERFECT MEMORY:** decidir D-MCP-3 (Qdrant Docker vs Cloud), ejecutar Phase 0 install, luego embedding pipeline → hybrid search. Ver `2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md` PART IV. Spec docs: `qdrant-mcp-install-steps.md`.

**Opción 2 — v15.0 ULTRON.io:** web pública profesional ES. Ver macro roadmap PART V. Sin bloqueos, paralelo a v14.6.

**Opción 3 — Validación post-hoc de v14.5 acceptance gates:**
- ≥5 prompts mejorados con A/B real (requiere live Claude calls + manual A/B labeling)
- 30 prompt+output pairs etiquetados para correlation ≥0.7

**Opción 4 — Polish:**
- TUI buttons para v14.5 META-PROMPTER (Mejorar / Eval) — deferred al shipping inicial
- Reducir context_md para salir del D22 over-budget (currently 485 tok > 400)
- ~~v14.5 prompt-history/ en backup exclusion review~~ — RESUELTO 2026-05-09: el dir aún no existe en disco. Cuando se cree, queda cubierto por el mirror de `.ultron/` sin exclusión específica (no contiene secretos, solo historial de prompts mejorados). Si crece >100 MB, añadir exclusión por tamaño.

## Conventions

- **Carpetas-contenedoras del cockpit:** si una carpeta NO tiene un PROJECT_MARKER (`package.json`, `*.uproject`, etc.) pero sí un `CLAUDE.md` o un README humano, debe registrarse manualmente con `ultron projects add` o editando `projects.json` con `status: "manual"` (el scan respeta entradas manuales). Añadir `CLAUDE.md` a `PROJECT_MARKERS` rompería el descenso en carpetas que contienen sub-proyectos NPM.

## Live spec docs en este directorio

```
2026-05-09-MACRO-INDEX.md                    ← entry point para tactical work
2026-05-09-MACRO-roadmap-v14.2-to-v15.0.md   ← spec autoritativa por sprint
2026-05-09-MACRO-ops-manual.md               ← test cases por phase (137 nuevos)
2026-05-09-MACRO-brainstorm-and-risks.md     ← alternativas, decision log, 15 risks
2026-05-09-MACRO-execution-prompts.md        ← prompts ready-to-fork por phase
2026-05-09-pickup.md                         ← último handover (puede estar desactualizado tras este sprint)
qdrant-mcp-install-steps.md                  ← spec install para v14.6 P0 (HUMAN-GATE)
_archive/                                    ← 23 planes históricos (Genesis-14, sprints v10-v13, continuaciones)
```

## Comandos clave (cheat sheet)

```powershell
# Estado del sistema
ultron status                                    # text dashboard
ultron doctor [--quiet|--json|--health-check]    # diagnostics + D22/D24/D25
uv run pytest tests/ -q                          # 697 pass + 22 skip baseline

# Token + cache
uv run python scripts/cockpit/token_baseline.py budget
uv run python scripts/cockpit/skill_lazy_loader.py status
uv run python scripts/cockpit/cache_telemetry.py budget

# Backup
& ~/.ultron/scripts/backup/weekly-backup.ps1 -Status        # last run JSON
& ~/.ultron/scripts/backup/weekly-backup.ps1 -DryRun         # preview
& ~/.ultron/scripts/backup/install-backup-scheduler.ps1 -Status

# Prompts (META-PROMPTER)
ultron prompts improve preview <prompt-path> --dump          # render meta-prompt
ultron prompts registry init <path>                          # add versioning
ultron prompts eval cache-stats                              # judge cache size

# Memory + brain
uv run python scripts/cockpit/memory_dedupe.py status        # dup count vs CLAUDE/context
uv run python scripts/cockpit/brain_index.py query "<topic>"
```

## Filosofía global (3 reglas inalterables)

1. **No custom ML training.** Modelos pre-entrenados aplicados quirúrgicamente.
2. **No auto-laundering.** Todo merge/deploy/install requiere human gate. (`prompt_improver` ships proposals, never auto-applies.)
3. **Atomic + backup-before-destroy.** Toda operación riesgosa tiene rollback documentado.

---

*MASTER.md regenerado 2026-05-08 tras sprints v14.4 + v14.5 + v14.7 RESOLVED.*
