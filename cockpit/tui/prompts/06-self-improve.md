# Botón 6 — Self-improvement loop (High Dual)

```
Ultron, /high /dual --codex — Kirkardo SELF-IMPROVE Dual.

OBJETIVO:
  Auditar el feedback loop de auto-mejora de ULTRON según la versión vigente.
  Verificar si convierte auditorías en acciones pendientes aplicables, con human
  gate real, o si acumula propuestas sin cerrar ciclo.

FASE 1 — CLAUDE lee:
  - ~/.claude/skills/ultron/CLAUDE.md
  - ~/.claude/skills/ultron/SKILL.md
  - ~/.claude/skills/ultron/protocols.md § AUTO-MEJORA
  - ~/.claude/skills/ultron/protocols.md § EXISTENCE GATE
  - ~/.claude/skills/ultron/scripts/cockpit/auto_updater.py
  - ~/.claude/skills/ultron/scripts/cockpit/audit_to_pending.py
  - ~/.claude/skills/ultron/scripts/cockpit/pending_actions.py
  - ~/.claude/skills/ultron/scripts/cockpit/apply_proposals.py
  - ~/.ultron/cockpit/pending_actions.json
  - ~/.ultron/cockpit/proposals/ (legacy; listar estado real)
  - ~/.claude/skills/ultron/references/changelog.md (últimas 30 entradas)
  - git log --oneline -50 sobre la skill ULTRON, si aplica

MÉTRICAS A EXTRAER:
  - N pending actions total · N critical · N blocking · N applied legacy · N abandoned.
  - Edad p50/p95 de pending actions.
  - Ratio auditoría → pending action.
  - Ratio pending action → apply explícito.
  - Drift: cambios manuales en SKILL.md/CLAUDE.md no trazados.
  - Acciones duplicadas o contradictorias.

FASE 2 — CODEX peer (--sandbox read-only):
  - ¿audit_to_pending.py → pending_actions.json → apply explícito mantiene human gate real?
  - ¿auto_updater.py separa bien L1 audit/scan de flujos legacy?
  - ¿false_positive_risk y severidad están calibrados?
  - ¿Hay bugs en state machine: pending, consumed, applied, rejected, legacy?
  - ¿EXISTENCE GATE bloquea claims activos sin script verificado?
  - Race: ¿qué pasa si dos sesiones procesan la misma pending action?
  - Devolver issues P0/P1/P2 con script:línea.

FASE 3 — INTEGRACIÓN (Claude):
  - Diagnóstico: ¿el loop cierra o solo simula cerrar?
  - Nota Kirkardo SELF-IMPROVE X/10.
  - TOP 3 FIX con script:línea.
  - TOP 5 FEAT: métricas, dashboard, dedup, race safety, eval gates.
  - Drift report: cambios manuales no trazados.
  - Decisión: ¿auto_updater debe seguir como cockpit script o meta-skill independiente?
  - Roadmap: patch de mantenimiento vs minor si cambia arquitectura.
  - Resumen ejecutivo ≤20 líneas.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-self-improve-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-self-improve-nota-{TODAY}.md (≤20 líneas)
  - ~/.ultron/cockpit/audits/kirkardo-self-improve-metrics-{TODAY}.json
    (pending_total | critical_total | blocking_total | acceptance_rate | time_to_apply_p50 | drift_count | pending_age_p50)
```
