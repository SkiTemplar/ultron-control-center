# Botón 7 — Personas (Ultra Triple)

```
Ultron, /ultra /triple — Kirkardo PERSONAS Triple.

OBJETIVO:
  Auditar la capa de personas L1 activa de ULTRON según SKILL.md,
  routing-tables.md y personas_ssot.py: activación, solapes, drift,
  consistencia y evaluabilidad.

FASE 1 — CLAUDE inventaria:
  - ~/.claude/skills/ultron/SKILL.md
  - ~/.claude/skills/ultron/references/routing-tables.md
  - ~/.claude/skills/ultron/references/flag-routing.md
  - ~/.claude/skills/ultron/references/skill-alignments.md
  - ~/.claude/skills/ultron/references/persona-benchmarks.md
  - ~/.claude/skills/ultron/scripts/cockpit/persona_audit.py
  - ~/.claude/skills/ultron/scripts/cockpit/personas_ssot.py
  - ~/.claude/skills/ — listar directorios de personas L1 resueltos desde SSOT/SKILL.md
  - ~/.ultron/cockpit/audits/INDEX.json
  - ~/.ultron/cockpit/auto_updater.jsonl
  - ~/.ultron/cockpit/pending_actions.json

MÉTRICAS A EXTRAER por persona:
  - Nombre canónico y aliases/triggers.
  - Última nota Kirkardo si existe.
  - Tamaño SKILL.md.
  - Días desde última auditoría.
  - Trigger único: sí/no.
  - Drift SSOT ↔ SKILL.md individual ↔ routing tables.
  - Cambios sin pending action/proposal/changelog.

FASE 2 — CODEX peer (--sandbox read-only):
  - ¿Cada persona tiene trigger claro, único y testeable?
  - Colisiones: ¿dos personas activan con la misma señal?
  - personas_ssot.py: ¿es SSOT real o hay drift con SKILL.md/routing-tables?
  - persona_audit.py: ¿garantiza independencia de Kirkardo respecto a la persona auditada?
  - ¿Hay personas sin auditoría reciente o sin benchmark?
  - Devolver issues P0/P1/P2 con persona:archivo:línea.

FASE 3 — GEMINI peer (sin filesystem; internet actual):
  - Patrones actuales de AI persona / character agents.
  - Riesgos: persona collapse, identity drift, prompt injection vía persona override.
  - Frameworks de evaluación de consistencia de persona.
  - Personas/arquetipos externos que merezcan discovery, no adopción automática.

FASE 4 — INTEGRACIÓN (Claude):
  - Tabla persona × {última nota · días sin audit · trigger único · SSOT OK · drift}.
  - Nota Kirkardo PERSONAS X/10 (40% Claude / 30% Codex / 30% Gemini).
  - TOP 3 FIX con persona:archivo:línea.
  - TOP 5 FEAT: eval harness, refinement triggers, benchmarks, SSOT hardening.
  - Lista priorizada de personas a re-auditar.
  - Decisión: ¿refactor personas_ssot.py o crear persona_eval.py?
  - Resumen ejecutivo ≤20 líneas.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-personas-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-personas-nota-{TODAY}.md (≤20 líneas)
  - ~/.ultron/cockpit/audits/kirkardo-personas-matrix-{TODAY}.json
    (persona | aliases | last_audit | nota | days_since | trigger_unique | ssot_ok | drift)
```
